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
	const session = new ChatSession(state as unknown as DurableObjectState, {})
	/** The id the session minted for the in-flight turn — deliberately not the user message's. */
	const turnId = (): string | undefined =>
		(
			state.storage.sql
				.exec("SELECT running_message_id FROM session WHERE id = 1")
				.toArray()[0] as { running_message_id: string | null } | undefined
		)?.running_message_id ?? undefined
	return { session, state, turnId }
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
		state.storage.sql.exec(
			"UPDATE session SET running_since = ? WHERE id = 1",
			clock - 16 * 60 * 1000,
		)

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

describe("ChatSession.tail", () => {
	it("returns pending events immediately", async () => {
		const { session } = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })

		const batch = await session.tail(0)

		assert.lengthOf(batch, 1)
		assert.equal(batch[0]?.seq, 1)
	})

	it("holds the poll open on an idle conversation rather than closing instantly", async () => {
		const { session } = makeSession()
		// Nothing pending, nothing running. Returning `[]` straight away made the route read the
		// stream as finished and close it, so every idle tab reconnected in a tight loop — and a
		// client that opened the stream just before posting missed the whole turn.
		const started = Date.now()
		const batch = await Promise.race([
			session.tail(0),
			new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 600)),
		])

		assert.equal(batch, "still-open")
		assert.isAtLeast(Date.now() - started, 500)
	})
})
