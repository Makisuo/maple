// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
/**
 * `ChatSession` — the durable transcript, against real SQLite.
 *
 * Everything here pins a defect that shipped green: the class typechecked, the branch's suite
 * passed, and chat was still broken end to end. The fold test in particular would have caught the
 * headline one on the first run.
 */
import { assert, beforeEach, describe, it } from "vitest"
import { encodeChatTurnTenant, type ChatTurnTenant } from "@maple/domain/chat-session"
import { ChatSession } from "./ChatSession"
import { installSchedulerWait, makeFakeDurableObjectState } from "../../test/chat/fake-do-state"

installSchedulerWait()

// Encoded, because that is what actually crosses the Durable Object boundary: RPC serializes with
// structured clone, which refuses class instances.
const TENANT = encodeChatTurnTenant({
	orgId: "org_test" as ChatTurnTenant["orgId"],
	userId: "user_test" as ChatTurnTenant["userId"],
	roles: [],
	authMode: "self_hosted",
})

/**
 * A session whose turn never starts.
 *
 * `beginTurn` schedules the real turn through `ctx.waitUntil`, and the real turn dynamic-imports
 * the whole app service graph. These tests are about storage, ordering and the mutex, so the
 * scheduled promise is collected and dropped — which is also what lets a test assert on the state
 * `beginTurn` leaves behind, mid-turn, without racing it.
 */
const makeSession = () => {
	const state = makeFakeDurableObjectState()
	const session = new ChatSession(state as DurableObjectState, {})
	/** The id the session minted for the in-flight turn — deliberately not the user message's. */
	const turnId = (): string | undefined =>
		(
			state.storage.sql.exec("SELECT running_message_id FROM session WHERE id = 1").toArray()[0] as
				| { running_message_id: string | null }
				| undefined
		)?.running_message_id ?? undefined
	return { session, state, turnId }
}

interface ChatSessionWaiterHarness {
	readonly waiters: Set<() => void>
	readonly waitForAppend: (timeoutMs: number) => Promise<boolean>
}

const waiterHarness = (session: ChatSession): ChatSessionWaiterHarness => {
	// SAFETY: this test intentionally exercises ChatSession's private waiter lifecycle; the
	// interface mirrors the two members declared by ChatSession and never escapes the test.
	return session as ChatSessionWaiterHarness
}

describe("ChatSession.history", () => {
	it("folds a streamed turn into ONE assistant message", () => {
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "why is checkout slow?" })
		session.append({ type: "turn-start", messageId: "a1" })
		for (const chunk of ["Check", "ing ", "the ", "traces", "."]) {
			session.append({ type: "text-delta", messageId: "a1", text: chunk })
		}
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const history = session.history()

		// The regression: each delta after the first used to open a brand-new assistant message,
		// because the fold replaced the array slot and then looked the *old* object up again.
		assert.lengthOf(history, 2)
		assert.deepEqual(
			history.map((m) => m.role),
			["user", "assistant"],
		)
		assert.equal(history[1]?.text, "Checking the traces.")
	})

	it("attaches a tool result to the call that issued it", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "Looking." })
		session.append({
			type: "tool-call",
			messageId: "a1",
			callId: "c1",
			name: "find_slow_traces",
			input: { service: "checkout" },
		})
		session.append({ type: "tool-result", messageId: "a1", callId: "c1", output: "3 traces" })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const history = session.history()

		assert.lengthOf(history, 1)
		const message = history[0]!
		assert.equal(message.text, "Looking.")
		assert.lengthOf(message.toolCalls, 1)
		assert.equal(message.toolCalls[0]?.id, "c1")
		// Dropped silently when the deltas had already shredded the message it belonged to.
		assert.equal(message.toolCalls[0]?.output, "3 traces")
	})

	it("keeps an approval-gated call marked as proposed and without output", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({
			type: "tool-call",
			messageId: "a1",
			callId: "c1",
			name: "create_alert_rule",
			input: { name: "p95" },
			proposed: true,
		})
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const call = session.history()[0]?.toolCalls[0]
		assert.equal(call?.proposed, true)
		assert.equal(call?.output, undefined)
	})

	it("retracts the text of a step that failed and was retried", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "Hello wo" })
		session.append({
			type: "turn-retry",
			messageId: "a1",
			attempt: 2,
			retractChars: 8,
			reason: "Transport",
			delayMs: 1_000,
		})
		session.append({ type: "text-delta", messageId: "a1", text: "Hello world." })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		// Without the retraction the transcript reads "Hello woHello world." — permanently, since
		// the fold concatenates and the log is durable.
		assert.equal(session.history()[0]?.text, "Hello world.")
	})

	it("clamps an over-retraction instead of producing a negative slice", () => {
		// `Stream.takeWhile(holdsTurn)` can drop appends between a delta and the retraction that
		// accounts for it, so `retractChars` legitimately exceeds what landed.
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "hi" })
		session.append({
			type: "turn-retry",
			messageId: "a1",
			attempt: 2,
			retractChars: 999,
			reason: "Transport",
			delayMs: 1_000,
		})

		assert.equal(session.history()[0]?.text, "")
	})

	it("retracts only from the message that retried", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "first turn" })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })
		session.append({ type: "turn-start", messageId: "a2" })
		session.append({ type: "text-delta", messageId: "a2", text: "second" })
		session.append({
			type: "turn-retry",
			messageId: "a2",
			attempt: 2,
			retractChars: 6,
			reason: "Transport",
			delayMs: 1_000,
		})

		const history = session.history()
		assert.equal(history[0]?.text, "first turn")
		assert.equal(history[1]?.text, "")
	})

	it("interleaves text around a tool call within one message", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "First. " })
		session.append({ type: "tool-call", messageId: "a1", callId: "c1", name: "t", input: {} })
		session.append({ type: "tool-result", messageId: "a1", callId: "c1", output: "ok" })
		session.append({ type: "text-delta", messageId: "a1", text: "Done." })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const history = session.history()
		assert.lengthOf(history, 1)
		assert.equal(history[0]?.text, "First. Done.")
		assert.lengthOf(history[0]?.toolCalls ?? [], 1)
	})
})

describe("ChatSession cursor and replay", () => {
	it("assigns a monotonic seq and replays only what follows a cursor", () => {
		const { session } = makeSession()
		const first = session.append({ type: "turn-start", messageId: "a1" })
		const second = session.append({ type: "text-delta", messageId: "a1", text: "hi" })

		assert.equal(first, 1)
		assert.equal(second, 2)
		assert.equal(session.cursor(), 2)

		const tail = session.since(1)
		assert.lengthOf(tail, 1)
		assert.equal(tail[0]?.seq, 2)
		assert.equal(tail[0]?.type, "text-delta")
	})

	it("replays the whole log from cursor 0 with no gap", () => {
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "hello" })
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const all = session.since(0)
		assert.deepEqual(
			all.map((event) => event.seq),
			[1, 2, 3],
		)
	})
})

describe("ChatSession turn mutex", () => {
	let clock: number
	beforeEach(() => {
		clock = Date.now()
	})

	it("admits one turn and refuses a second", () => {
		const { session } = makeSession()
		const first = session.beginTurn({
			sessionId: "org_test:tab",
			messageId: "m1",
			text: "one",
			tenant: TENANT,
		})
		const second = session.beginTurn({
			sessionId: "org_test:tab",
			messageId: "m2",
			text: "two",
			tenant: TENANT,
		})

		assert.isDefined(first)
		// Two tabs are one conversation, so the DO is where this has to hold.
		assert.isUndefined(second)
		assert.isTrue(session.running())
	})

	it("gives the assistant turn an id distinct from the user message", () => {
		const { session } = makeSession()
		const claimed = session.beginTurn({
			sessionId: "org_test:tab",
			messageId: "u1",
			text: "Say PONG",
			tenant: TENANT,
		})
		// Simulate what the turn emits, using the id the session actually handed it.
		assert.isFalse(session.holdsTurn("u1"), "the user's message id must not own the turn")

		const events = session.since(0)
		const userMessage = events.find((event) => event.type === "user-message")
		assert.equal(userMessage?.type === "user-message" ? userMessage.id : undefined, claimed?.messageId)

		// The regression, caught only end-to-end: reusing the user's id meant `openAssistant` found
		// the *user* message, so every delta appended to the user's own bubble — "Say PONG" came
		// back as "Say PONGPING". The unit tests missed it because they used distinct ids by hand.
		session.append({ type: "turn-start", messageId: "u1" })
		session.append({ type: "text-delta", messageId: "u1", text: "PING" })
		const collided = session.history()
		assert.equal(
			collided.find((message) => message.role === "user")?.text,
			"Say PONGPING",
			"this is the shape the bug produced; the fix is that the turn never uses this id",
		)
	})

	it("records the user message and returns the cursor BEFORE it", () => {
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u0", text: "earlier" })

		const claimed = session.beginTurn({
			sessionId: "org_test:tab",
			messageId: "m1",
			text: "hello",
			tenant: TENANT,
		})

		// The client tails from this cursor; if it pointed *after* the user message the send's own
		// events would be missed.
		assert.equal(claimed?.cursor, 1)
		assert.equal(session.history().at(-1)?.text, "hello")
	})

	it("abort ends the turn against the message that actually holds it", () => {
		const { session, turnId } = makeSession()
		session.beginTurn({ sessionId: "org_test:tab", messageId: "m1", text: "hi", tenant: TENANT })
		const turn = turnId()

		session.abort()

		assert.isFalse(session.running())
		const last = session.since(0).at(-1)
		assert.equal(last?.type, "turn-end")
		// The route used to pass a fresh uuid here, so the terminal event named a message that had
		// never existed and no client ever cleared its streaming state.
		assert.equal(last?.type === "turn-end" ? last.messageId : undefined, turn)
		assert.equal(last?.type === "turn-end" ? last.reason : undefined, "aborted")
	})

	it("a straggler cannot release a newer turn's claim", () => {
		const { session, turnId } = makeSession()
		session.beginTurn({ sessionId: "org_test:tab", messageId: "m1", text: "one", tenant: TENANT })
		const first = turnId()!
		session.abort()
		session.beginTurn({ sessionId: "org_test:tab", messageId: "m2", text: "two", tenant: TENANT })
		const second = turnId()!

		// The aborted turn keeps draining and eventually calls `endTurn` for its own message.
		session.endTurn(first)

		assert.notEqual(first, second)
		assert.isTrue(session.running(), "the second turn still owns the slot")
		assert.isTrue(session.holdsTurn(second))
		assert.isFalse(session.holdsTurn(first))
	})

	it("expires an abandoned claim instead of wedging the conversation forever", () => {
		const { session, state, turnId } = makeSession()
		session.beginTurn({ sessionId: "org_test:tab", messageId: "m1", text: "hi", tenant: TENANT })
		const turn = turnId()

		// Simulate the turn vanishing (isolate eviction, a defect, a deploy mid-stream) by ageing
		// its claim past the staleness ceiling.
		state.storage.sql.exec("UPDATE session SET running_since = ? WHERE id = 1", clock - 16 * 60 * 1000)

		assert.isFalse(session.running(), "a stale claim is not running")
		const reclaimed = session.beginTurn({
			sessionId: "org_test:tab",
			messageId: "m2",
			text: "retry",
			tenant: TENANT,
		})
		assert.isDefined(reclaimed, "the conversation recovers on its own")

		// And the abandoned turn is closed out in the log, so a client isn't left streaming.
		const abandoned = session
			.since(0)
			.find((event) => event.type === "turn-end" && event.messageId === turn)
		assert.isDefined(abandoned)
	})
})

describe("ChatSession.subscribe", () => {
	/** Read the whole subscription, which ends at `turn-end`. */
	const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		let text = ""
		for (;;) {
			const { value, done } = await reader.read()
			if (done) return text
			text += decoder.decode(value, { stream: true })
		}
	}

	/** Frames as `[seq, event]` pairs, skipping the leading `retry:` hint. */
	const framesOf = (text: string): Array<{ seq: number; type: string }> =>
		text
			.split("\n\n")
			.filter((frame) => frame.startsWith("id:"))
			.map((frame) => {
				const data = frame
					.split("\n")
					.find((line) => line.startsWith("data:"))!
					.slice(5)
					.trimStart()
				const event = JSON.parse(data) as { seq: number; type: string }
				return { seq: event.seq, type: event.type }
			})

	it("replays from the cursor as SSE frames and closes on turn-end", async () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "hi" })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const text = await drain(session.subscribe(1))

		// The `retry:` hint is what keeps a browser's own reconnect logic from hammering the DO.
		assert.isTrue(text.startsWith("retry: 1000\n\n"))
		assert.deepEqual(framesOf(text), [
			{ seq: 2, type: "text-delta" },
			{ seq: 3, type: "turn-end" },
		])
	})

	it("pushes an event that lands AFTER the subscription, without waiting out a poll", async () => {
		const { session } = makeSession()
		const stream = session.subscribe(0)
		const collected = drain(stream)

		// The regression this pins: `tail` slept 40ms between SELECTs, so nothing could reach a
		// reader faster than that no matter how fast the model produced it. A push has no floor.
		const started = Date.now()
		await new Promise((resolve) => setTimeout(resolve, 0))
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const frames = framesOf(await collected)
		assert.deepEqual(
			frames.map((frame) => frame.type),
			["turn-start", "turn-end"],
		)
		assert.isBelow(Date.now() - started, 40, "a push must not pay the old poll interval")
	})

	it("stays open on an idle conversation rather than closing instantly", async () => {
		const { session } = makeSession()
		// Closing on "nothing pending" made the route read the stream as finished, so every idle tab
		// reconnected in a tight loop — and a client that opened the stream just before posting
		// missed the whole turn.
		const stream = session.subscribe(0)
		const outcome = await Promise.race([
			drain(stream).then(() => "closed" as const),
			new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 300)),
		])

		assert.equal(outcome, "still-open")
	})

	it("removes a timed-out waiter before the next idle reconnect", async () => {
		const { session } = makeSession()
		const harness = waiterHarness(session)

		for (let reconnect = 0; reconnect < 3; reconnect++) {
			assert.isFalse(await harness.waitForAppend.call(session, 0))
			assert.equal(harness.waiters.size, 0)
		}
	})
})

describe("ChatSession.history — sub-agent transcripts", () => {
	/** The parent announces the `task` call before the sub-agent's own events arrive. */
	const withTask = (session: ReturnType<typeof makeSession>["session"], callId = "t1") => {
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({
			type: "tool-call",
			messageId: "a1",
			callId,
			name: "task",
			input: { subagent_type: "explore", description: "trace checkout latency" },
		})
	}

	const ref = (callId = "t1") => ({ id: callId, agent: "explore", parentMessageId: "a1" }) as const

	it("nests a sub-agent's turn under the tool call that started it", () => {
		const { session } = makeSession()
		withTask(session)
		session.append({ type: "turn-start", messageId: "c1", task: ref() })
		session.append({ type: "text-delta", messageId: "c1", text: "p99 is 4.2s in ", task: ref() })
		session.append({ type: "text-delta", messageId: "c1", text: "checkout-api.", task: ref() })
		session.append({
			type: "tool-call",
			messageId: "c1",
			callId: "x1",
			name: "search_traces",
			input: {},
			task: ref(),
		})
		session.append({
			type: "tool-result",
			messageId: "c1",
			callId: "x1",
			output: "40k rows",
			task: ref(),
		})
		session.append({ type: "turn-end", messageId: "c1", reason: "stop", task: ref() })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })

		const history = session.history()

		// One top-level assistant message, not one per sub-agent event.
		assert.lengthOf(history, 1)
		const task = history[0]?.toolCalls[0]?.task
		assert.equal(task?.agent, "explore")
		assert.equal(task?.status, "completed")
		assert.lengthOf(task?.messages ?? [], 1)
		assert.equal(task?.messages[0]?.text, "p99 is 4.2s in checkout-api.")
		// The child's own tool call rides in the nested transcript, not the parent's.
		assert.equal(task?.messages[0]?.toolCalls[0]?.output, "40k rows")
		assert.lengthOf(history[0]!.toolCalls, 1)
	})

	it("shows a sub-agent still running before its turn ends", () => {
		const { session } = makeSession()
		withTask(session)
		session.append({ type: "turn-start", messageId: "c1", task: ref() })
		session.append({ type: "text-delta", messageId: "c1", text: "looking", task: ref() })

		assert.equal(session.history()[0]?.toolCalls[0]?.task?.status, "running")
	})

	it("carries a failed sub-agent's status through", () => {
		const { session } = makeSession()
		withTask(session)
		session.append({ type: "turn-start", messageId: "c1", task: ref() })
		session.append({ type: "turn-end", messageId: "c1", reason: "error", error: "boom", task: ref() })

		assert.equal(session.history()[0]?.toolCalls[0]?.task?.status, "error")
	})

	it("drops an orphaned sub-agent event rather than corrupting the transcript", () => {
		// Deny by default. A child event whose parent message or tool call is missing must not
		// materialise a stray top-level assistant message — that is what would leak into both the
		// browser and the next turn's replay.
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "hi" })
		session.append({
			type: "text-delta",
			messageId: "c1",
			text: "orphan",
			task: { id: "nope", agent: "explore", parentMessageId: "a-missing" },
		})

		const history = session.history()
		assert.lengthOf(history, 1)
		assert.equal(history[0]?.role, "user")
	})

	it("keeps two sibling sub-agents' transcripts apart", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		for (const callId of ["t1", "t2"]) {
			session.append({ type: "tool-call", messageId: "a1", callId, name: "task", input: {} })
		}
		session.append({ type: "text-delta", messageId: "c1", text: "first", task: ref("t1") })
		session.append({ type: "text-delta", messageId: "c2", text: "second", task: ref("t2") })

		const calls = session.history()[0]!.toolCalls
		assert.equal(calls[0]?.task?.messages[0]?.text, "first")
		assert.equal(calls[1]?.task?.messages[0]?.text, "second")
	})

	it("retracts inside a sub-agent transcript, not the parent's", () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "parent text" })
		session.append({ type: "tool-call", messageId: "a1", callId: "t1", name: "task", input: {} })
		session.append({ type: "text-delta", messageId: "c1", text: "partial", task: ref() })
		session.append({
			type: "turn-retry",
			messageId: "c1",
			attempt: 2,
			retractChars: 7,
			reason: "Transport",
			delayMs: 1_000,
			task: ref(),
		})
		session.append({ type: "text-delta", messageId: "c1", text: "the answer", task: ref() })

		const message = session.history()[0]!
		assert.equal(message.text, "parent text")
		assert.equal(message.toolCalls[0]?.task?.messages[0]?.text, "the answer")
	})
})

describe("ChatSession compaction", () => {
	it("is inert for display — the user still sees what they actually said", () => {
		// This is where Maple diverges from opencode. There, the transcript and the model input are
		// the same list, so compaction reorders what the user sees. Here they are different things.
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "why is checkout slow?" })
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "p99 is 4.2s." })
		session.append({ type: "turn-end", messageId: "a1", reason: "stop" })
		session.append({
			type: "compaction",
			messageId: "a1",
			summary: "checkout p99 was 4.2s",
			throughSeq: 4,
		})

		const history = session.history()
		assert.lengthOf(history, 2)
		assert.equal(history[0]?.text, "why is checkout slow?")
		assert.equal(history[1]?.text, "p99 is 4.2s.")
	})

	it("returns the most recent compaction, not the first", () => {
		const { session } = makeSession()
		session.append({ type: "compaction", messageId: "a1", summary: "older", throughSeq: 1 })
		session.append({ type: "user-message", id: "u1", text: "more" })
		session.append({ type: "compaction", messageId: "a2", summary: "newer", throughSeq: 2 })

		assert.deepEqual(session.compaction(), { summary: "newer", throughSeq: 2 })
	})

	it("reports no compaction on a fresh conversation", () => {
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "hi" })

		assert.isUndefined(session.compaction())
	})

	it("stamps every message with the seq that opened it", () => {
		// `toLlmMessages` splits the transcript on this. `createdAt` cannot do the job: it is a
		// non-unique wall clock denominated in milliseconds, not in event sequence.
		const { session } = makeSession()
		session.append({ type: "user-message", id: "u1", text: "one" })
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({ type: "text-delta", messageId: "a1", text: "two" })
		session.append({ type: "user-message", id: "u2", text: "three" })

		const seqs = session.history().map((message) => message.startSeq)
		assert.deepEqual(seqs, [1, 2, 4])
		// Monotonic, so the split is well defined.
		assert.deepEqual(
			[...seqs].sort((a, b) => a - b),
			seqs,
		)
	})
})
