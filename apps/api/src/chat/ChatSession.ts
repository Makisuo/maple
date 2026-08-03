/**
 * `ChatSession` — the durable transcript, one Durable Object per `"<orgId>:<tabId>"`.
 *
 * Replaces Flue's `FlueMapleChatAgent` + `FlueRegistry` SQLite Durable Objects. The DO owns four
 * things:
 *
 *   1. **Ordering.** It assigns every event a monotonic `seq`. That is what makes the client
 *      transport resumable by construction: reconnect is `?cursor=<last seq you saw>`, not a
 *      heuristic about whether you missed something.
 *   2. **The event log**, in SQLite, replayed on reconnect and folded into a transcript on cold
 *      load. Both roles replay, so a conversation opened on another device is complete.
 *   3. **Turn lifecycle** — at most one turn in flight, abortable, and self-healing.
 *   4. **Running the turn.** The turn executes *here*, under `ctx.waitUntil` on the DO's own
 *      request context, not in whichever request asked for it.
 *
 * That last point is the load-bearing one. A turn is a multi-second model stream plus N tool
 * calls; the `POST /messages` request that starts it answers in milliseconds. Forking the turn off
 * that request and returning meant Cloudflare was free to cancel it the moment the response was
 * written — and the autonomous path was worse, since cron ticks run under `runScheduledEffect`,
 * which disposes the Effect runtime as soon as the tick's program settles. A Durable Object owns
 * its own lifetime, so hosting the turn here is what actually makes it survive. It also removes
 * every cross-process hop: appending an event is a method call, not a stub RPC.
 *
 * Startup-CPU note (Cloudflare error 10021): this class is exported from `worker.ts`, whose module
 * scope Cloudflare evaluates during upload validation. It must therefore import nothing from the
 * app service graph at module scope — hence `@maple/domain/chat-session` types being the only
 * import, and `./turn-runner` (which pulls in the whole graph) arriving through a dynamic import
 * inside the method that needs it, exactly as `worker.ts` does for the route graph.
 */
import { DurableObject } from "cloudflare:workers"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
	type ChatMessage,
	type ChatToolCall,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"

/** SQLite row shapes. `SqlStorage.exec` requires an index signature on its row type. */
interface EventRow extends Record<string, SqlStorageValue> {
	readonly seq: number
	readonly created_at: number
	readonly payload: string
}
interface CursorRow extends Record<string, SqlStorageValue> {
	readonly seq: number | null
}
interface SessionRow extends Record<string, SqlStorageValue> {
	readonly running: number
	readonly running_since: number | null
	readonly running_message_id: string | null
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
	running INTEGER NOT NULL DEFAULT 0,
	running_since INTEGER,
	running_message_id TEXT
);
INSERT OR IGNORE INTO session (id, running) VALUES (1, 0);
`

/**
 * How long a client's live tail waits for new events before returning empty. Cloudflare caps a
 * request at a few minutes; 25s keeps the poll well inside that and inside typical proxy idle
 * timeouts, while being long enough that an idle conversation costs almost nothing.
 */
const TAIL_TIMEOUT_MS = 25_000

/**
 * Poll interval while tailing. Fine-grained while a turn is streaming so tokens feel live, then
 * backed off once the conversation is idle — an idle tab used to cost 625 SQL reads per
 * reconnect for events that were never going to arrive.
 */
const TAIL_POLL_ACTIVE_MS = 40
const TAIL_POLL_IDLE_MS = 500

/**
 * How long a claimed turn may go without finishing before the claim is treated as abandoned.
 *
 * Without this, any way of losing the turn — isolate eviction, an unhandled defect, a deploy
 * mid-stream — leaves `running = 1` forever: `beginTurn` returns `undefined`, the route 409s every
 * message, and the conversation is wedged with no recovery but a manual abort. 15 minutes matches
 * the `diagnosis_timeout` ceiling the triage path already uses.
 */
const TURN_STALE_MS = 15 * 60 * 1000

export class ChatSession extends DurableObject<Record<string, unknown>> {
	private readonly sql: SqlStorage

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env)
		this.sql = ctx.storage.sql
		this.sql.exec(SCHEMA)
		// Sessions created before the watchdog columns existed (local dev only — the class has
		// never been deployed) would otherwise fail every read against `session`.
		for (const column of ["running_since INTEGER", "running_message_id TEXT"]) {
			try {
				this.sql.exec(`ALTER TABLE session ADD COLUMN ${column}`)
			} catch {
				// Already present.
			}
		}
	}

	/** Highest assigned seq, i.e. the cursor a client that has read everything holds. */
	cursor(): number {
		const row = this.sql.exec<CursorRow>("SELECT MAX(seq) AS seq FROM events").one()
		return row.seq ?? 0
	}

	private sessionRow(): SessionRow {
		return this.sql
			.exec<SessionRow>(
				"SELECT running, running_since, running_message_id FROM session WHERE id = 1",
			)
			.one()
	}

	/**
	 * Whether a turn holds the slot *right now*.
	 *
	 * Expiring a stale claim here rather than in a separate sweep means every caller — `beginTurn`,
	 * `tail`, the turn's own between-step check — agrees on the answer without needing an alarm to
	 * have fired first.
	 */
	private isRunning(): boolean {
		const row = this.sessionRow()
		if (row.running !== 1) return false
		if (row.running_since !== null && Date.now() - row.running_since > TURN_STALE_MS) {
			const messageId = row.running_message_id
			this.clearRunning()
			if (messageId !== null) {
				this.append({
					type: "turn-end",
					messageId,
					reason: "error",
					error: "The turn stopped responding and was abandoned.",
				})
			}
			return false
		}
		return true
	}

	private clearRunning(): void {
		this.sql.exec(
			"UPDATE session SET running = 0, running_since = NULL, running_message_id = NULL WHERE id = 1",
		)
	}

	/** The message id of the turn currently holding the slot, if any. */
	private runningMessageId(): string | undefined {
		return this.sessionRow().running_message_id ?? undefined
	}

	/** Append one event and return the seq it was assigned. */
	append(event: ChatEventInput): number {
		this.sql.exec(
			"INSERT INTO events (created_at, payload) VALUES (?, ?)",
			Date.now(),
			encodeChatEventPayload(event),
		)
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
		return rows.map((row) => decodeChatEventPayload(row.payload, row.seq))
	}

	/**
	 * Wait for events after `cursor`, up to `TAIL_TIMEOUT_MS`.
	 *
	 * A poll rather than a subscription: Durable Object storage has no change feed, and the reader
	 * is a different request from the turn that writes.
	 *
	 * It holds the connection for the full window even when nothing is running. Returning early on
	 * an idle conversation looks like a saving, but the route reads an empty batch as "stream over"
	 * and closes the response — so every idle tab reconnected in a tight loop, and a client that
	 * opened the stream a moment *before* posting its message missed the entire turn.
	 */
	async tail(cursor: number): Promise<ReadonlyArray<ChatEvent>> {
		const deadline = Date.now() + TAIL_TIMEOUT_MS
		for (;;) {
			const events = this.since(cursor)
			if (events.length > 0) return events
			if (Date.now() >= deadline) return []
			await scheduler.wait(this.isRunning() ? TAIL_POLL_ACTIVE_MS : TAIL_POLL_IDLE_MS)
		}
	}

	/**
	 * Claim the turn slot, record the user's message, and start the turn.
	 *
	 * Returns `undefined` when a turn is already running — the client's composer is disabled during
	 * a turn, but two tabs on the same conversation are one session, so the DO is where that has to
	 * be enforced.
	 *
	 * `tenant` is the caller's *resolved* identity, passed in rather than re-derived here: the DO
	 * has no auth context of its own, and the route has already matched the session's org against
	 * the caller's before it gets this far.
	 */
	beginTurn(input: {
		/** `"<orgId>:<tabId>"`. A DO cannot recover its own name, and the turn needs it for mode. */
		readonly sessionId: string
		readonly messageId: string
		readonly text: string
		readonly tenant: ChatTurnTenantEncoded
	}): { cursor: number; messageId: string } | undefined {
		if (this.isRunning()) return undefined
		const cursor = this.cursor()
		// The assistant's message needs an id of its OWN. Reusing the user's meant `history()` found
		// the user message when opening the assistant one, so every text delta was appended to the
		// user's own bubble — "Say PONG" came back as "Say PONGPING" — and the client folded it the
		// same way, since it keys the optimistic user message on exactly this id.
		const turnId = crypto.randomUUID()
		this.sql.exec(
			"UPDATE session SET running = 1, running_since = ?, running_message_id = ? WHERE id = 1",
			Date.now(),
			turnId,
		)
		this.append({ type: "user-message", id: input.messageId, text: input.text })
		// `waitUntil` on the DO's own context: the turn is now this object's work, and it outlives
		// whatever request asked for it.
		this.ctx.waitUntil(this.runTurn(input.sessionId, turnId, input.tenant))
		return { cursor, messageId: input.messageId }
	}

	/**
	 * Whether `messageId` still holds the slot. The turn calls this between steps so an abort takes
	 * effect promptly, and so a turn that has already been superseded stops writing.
	 */
	holdsTurn(messageId: string): boolean {
		return this.isRunning() && this.runningMessageId() === messageId
	}

	/**
	 * Release the slot, but only if `messageId` still owns it.
	 *
	 * The compare-and-clear matters: an aborted turn keeps draining its in-flight model call for a
	 * while, and a plain `running = 0` from that straggler would release a *newer* turn's claim.
	 */
	endTurn(messageId: string): void {
		if (this.runningMessageId() !== messageId) return
		this.clearRunning()
	}

	/**
	 * Abort the running turn.
	 *
	 * The DO cannot synchronously cancel the fiber, so it clears the claim and records the terminal
	 * event against the message that actually holds it — the turn notices via `holdsTurn` at its
	 * next step and stops. Taking the message id from the session rather than the caller is what
	 * makes the emitted `turn-end` land on the assistant message the client is rendering; a
	 * caller-supplied id named a message that never existed, so no client ever cleared its
	 * streaming state.
	 */
	abort(): void {
		if (!this.isRunning()) return
		const messageId = this.runningMessageId()
		this.clearRunning()
		if (messageId !== undefined) {
			this.append({ type: "turn-end", messageId, reason: "aborted" })
		}
	}

	running(): boolean {
		return this.isRunning()
	}

	/**
	 * Drive one turn to completion, appending events as they are produced.
	 *
	 * Everything heavy — the Effect runtime, the service graph, `@maple/llm` — is behind this
	 * dynamic import so none of it is evaluated at module scope. Failures are recorded as a
	 * terminal event rather than thrown: the log is what the client reads, so a turn that dies
	 * silently is indistinguishable from one that hung.
	 */
	private async runTurn(
		sessionId: string,
		messageId: string,
		tenant: ChatTurnTenantEncoded,
	): Promise<void> {
		try {
			const { runChatSessionTurn } = await import("./turn-runner")
			await runChatSessionTurn({ session: this, sessionId, env: this.env, messageId, tenant })
		} catch (cause) {
			if (this.holdsTurn(messageId)) {
				this.append({
					type: "turn-end",
					messageId,
					reason: "error",
					error: cause instanceof Error ? cause.message : "The chat turn failed to start.",
				})
			}
		} finally {
			this.endTurn(messageId)
		}
	}

	/**
	 * Fold the whole log into a transcript.
	 *
	 * Deriving rather than storing messages keeps one source of truth: an event log that replays
	 * identically on every device. Text deltas concatenate; tool calls attach to the assistant
	 * message that issued them and are completed in place by their result.
	 */
	history(): ReadonlyArray<ChatMessage> {
		// A mutable mirror of `ChatMessage`. The fold concatenates deltas and completes tool calls
		// in place; building it against the readonly wire type would force a copy per delta, which
		// is exactly the shape that used to desynchronise `byId` from `messages`.
		type Draft = {
			id: string
			role: ChatMessage["role"]
			text: string
			toolCalls: Array<ChatToolCall>
			createdAt: number
		}
		const messages: Array<Draft> = []
		const byId = new Map<string, Draft>()

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
			const event = decodeChatEventPayload(row.payload, row.seq)
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
					// Mutate in place. Replacing the array slot with a copy left `byId` pointing at
					// an object no longer in `messages`, so the *next* delta opened a brand-new
					// assistant message — a 400-token reply folded into ~400 one-token messages, in
					// what the browser rendered and in what the model was replayed on the next turn.
					const message = openAssistant(event.messageId, row.created_at)
					message.text += event.text
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
					const index = message.toolCalls.findIndex((call) => call.id === event.callId)
					if (index >= 0) {
						message.toolCalls[index] = {
							...message.toolCalls[index],
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
