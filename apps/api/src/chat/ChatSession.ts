/**
 * `ChatSession` — the durable transcript, one Durable Object per `"<orgId>:<tabId>"`.
 *
 * Replaces Flue's `FlueMapleChatAgent` + `FlueRegistry` SQLite Durable Objects. The DO owns three
 * things and nothing else:
 *
 *   1. **Ordering.** It assigns every event a monotonic `seq`. That is what makes the client
 *      transport resumable by construction: reconnect is `?cursor=<last seq you saw>`, not a
 *      heuristic about whether you missed something.
 *   2. **The event log**, in SQLite, replayed on reconnect and folded into a transcript on cold
 *      load. Both roles replay, so a conversation opened on another device is complete.
 *   3. **Turn lifecycle** — at most one turn in flight, abortable.
 *
 * It deliberately owns *no* model logic: the turn itself is `./agent.ts`, driven by the caller
 * (the HTTP route) which has the Effect runtime. The DO is storage plus a mutex.
 *
 * Startup-CPU note (Cloudflare error 10021): this class is exported from `worker.ts`, whose module
 * scope Cloudflare evaluates during upload validation. It must therefore import nothing from the
 * app service graph at module scope — hence the `@maple/domain/chat-session` types being the only
 * import, and the turn runner arriving as a callback.
 */
import { DurableObject } from "cloudflare:workers"
import type { ChatEvent, ChatEventInput, ChatMessage, ChatToolCall } from "@maple/domain/chat-session"

/** SQLite row shapes. `SqlStorage.exec` requires an index signature on its row type. */
interface EventRow extends Record<string, SqlStorageValue> {
	readonly seq: number
	readonly created_at: number
	readonly payload: string
}
interface CursorRow extends Record<string, SqlStorageValue> {
	readonly seq: number | null
}
interface RunningRow extends Record<string, SqlStorageValue> {
	readonly running: number
}

/** Rows the DO writes. `payload` is the encoded `ChatEvent` minus its `seq`, which is the key. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	running INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO session (id, running) VALUES (1, 0);
`

/**
 * How long a client's live tail waits for new events before returning empty. Cloudflare caps a
 * request at a few minutes; 25s keeps the poll well inside that and inside typical proxy idle
 * timeouts, while being long enough that an idle conversation costs almost nothing.
 */
const TAIL_TIMEOUT_MS = 25_000

/** Poll interval while tailing. Fine-grained enough that token streaming still feels live. */
const TAIL_POLL_MS = 40

export class ChatSession extends DurableObject<Record<string, unknown>> {
	private readonly sql: SqlStorage

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env)
		this.sql = ctx.storage.sql
		this.sql.exec(SCHEMA)
	}

	/** Highest assigned seq, i.e. the cursor a client that has read everything holds. */
	cursor(): number {
		const row = this.sql.exec<CursorRow>("SELECT MAX(seq) AS seq FROM events").one()
		return row.seq ?? 0
	}

	private isRunning(): boolean {
		const row = this.sql.exec<RunningRow>("SELECT running FROM session WHERE id = 1").one()
		return row.running === 1
	}

	private setRunning(running: boolean): void {
		this.sql.exec("UPDATE session SET running = ? WHERE id = 1", running ? 1 : 0)
	}

	/** Append one event and return the seq it was assigned. */
	append(event: ChatEventInput): number {
		this.sql.exec("INSERT INTO events (created_at, payload) VALUES (?, ?)", Date.now(), JSON.stringify(event))
		return this.cursor()
	}

	/** Every event after `cursor`, oldest first. */
	since(cursor: number): ReadonlyArray<ChatEvent> {
		const rows = this.sql
			.exec<EventRow>(
				"SELECT seq, created_at, payload FROM events WHERE seq > ? ORDER BY seq ASC",
				cursor,
			)
			.toArray()
		return rows.map((row) => ({ ...(JSON.parse(row.payload) as ChatEventInput), seq: row.seq }) as ChatEvent)
	}

	/**
	 * Wait for events after `cursor`, up to `TAIL_TIMEOUT_MS`.
	 *
	 * A poll rather than a subscription: the writer is a *different* request (the one running the
	 * turn), so there is no in-isolate emitter both sides share, and Durable Object storage has no
	 * change feed. At 40ms the poll is a SQLite index lookup on a table the DO already has hot.
	 */
	async tail(cursor: number): Promise<ReadonlyArray<ChatEvent>> {
		const deadline = Date.now() + TAIL_TIMEOUT_MS
		for (;;) {
			const events = this.since(cursor)
			if (events.length > 0) return events
			// Nothing pending and nothing running: the client is caught up on a settled
			// conversation, so return immediately rather than holding the connection for 25s.
			if (!this.isRunning()) return []
			if (Date.now() >= deadline) return []
			await scheduler.wait(TAIL_POLL_MS)
		}
	}

	/**
	 * Claim the turn slot and record the user's message.
	 *
	 * Returns `undefined` when a turn is already running — the client's composer is disabled during
	 * a turn, but two tabs on the same conversation are one session, so the DO is where that has to
	 * be enforced.
	 */
	beginTurn(messageId: string, text: string): { cursor: number; messageId: string } | undefined {
		if (this.isRunning()) return undefined
		const cursor = this.cursor()
		this.setRunning(true)
		this.append({ type: "user-message", id: messageId, text })
		return { cursor, messageId }
	}

	/** Release the turn slot. Idempotent — an abort and a natural end can race. */
	endTurn(): void {
		this.setRunning(false)
	}

	/**
	 * Abort a running turn.
	 *
	 * The DO cannot cancel the fiber (it lives in the request that started the turn); it flips the
	 * flag and records the terminal event, and the turn runner checks `running` between steps. The
	 * client therefore sees the turn end promptly even though the in-flight model call is still
	 * draining.
	 */
	abort(messageId: string): void {
		if (!this.isRunning()) return
		this.setRunning(false)
		this.append({ type: "turn-end", messageId, reason: "aborted" })
	}

	running(): boolean {
		return this.isRunning()
	}

	/**
	 * Fold the whole log into a transcript.
	 *
	 * Deriving rather than storing messages keeps one source of truth: an event log that replays
	 * identically on every device. Text deltas concatenate; tool calls attach to the assistant
	 * message that issued them and are completed in place by their result.
	 */
	history(): ReadonlyArray<ChatMessage> {
		const messages: Array<ChatMessage & { toolCalls: Array<ChatToolCall> }> = []
		const byId = new Map<string, ChatMessage & { toolCalls: Array<ChatToolCall> }>()

		const openAssistant = (id: string, createdAt: number) => {
			const existing = byId.get(id)
			if (existing) return existing
			const message = {
				id,
				role: "assistant" as const,
				text: "",
				toolCalls: [] as Array<ChatToolCall>,
				createdAt,
			}
			byId.set(id, message)
			messages.push(message)
			return message
		}

		const rows = this.sql
			.exec<EventRow>("SELECT seq, created_at, payload FROM events ORDER BY seq ASC")
			.toArray()

		for (const row of rows) {
			const event = JSON.parse(row.payload) as ChatEventInput
			switch (event.type) {
				case "user-message": {
					const message = {
						id: event.id,
						role: "user" as const,
						text: event.text,
						toolCalls: [] as Array<ChatToolCall>,
						createdAt: row.created_at,
					}
					byId.set(event.id, message)
					messages.push(message)
					break
				}
				case "turn-start":
					openAssistant(event.messageId, row.created_at)
					break
				case "text-delta": {
					const message = openAssistant(event.messageId, row.created_at)
					messages[messages.indexOf(message)] = { ...message, text: message.text + event.text }
					byId.set(event.messageId, messages[messages.indexOf(message)]!)
					break
				}
				case "tool-call": {
					const message = openAssistant(event.messageId, row.created_at)
					message.toolCalls.push({
						id: event.callId,
						name: event.name,
						input: event.input,
						...(event.proposed === true ? { proposed: true } : {}),
					} as ChatToolCall)
					break
				}
				case "tool-result": {
					const message = openAssistant(event.messageId, row.created_at)
					const call = message.toolCalls.find((candidate) => candidate.id === event.callId)
					if (call) {
						message.toolCalls[message.toolCalls.indexOf(call)] = {
							...call,
							output: event.output,
							...(event.isError === true ? { isError: true } : {}),
						} as ChatToolCall
					}
					break
				}
				case "turn-end":
					break
			}
		}

		return messages
	}
}
