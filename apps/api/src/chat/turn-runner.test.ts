/**
 * `toLlmMessages` — what a new turn actually replays to the model.
 *
 * This is where a long conversation either keeps its beginning or loses it. The head-drop is the
 * fallback and must stay byte-for-byte what it was; the compaction path is the improvement.
 *
 * Plus `meterTurn`: what an attended turn bills, and the one case where it bills nothing.
 */
import type { ChatMessage } from "@maple/domain/chat-session"
import { OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { assert, describe, it } from "vitest"
import { makeTurnUsage } from "./loop"
import { meterTurn, toLlmMessages } from "./turn-runner"

let seq = 0

const message = (role: "user" | "assistant", text: string, toolCalls: unknown[] = []): ChatMessage =>
	({
		id: `m${(seq += 1)}`,
		role,
		text,
		toolCalls,
		createdAt: seq,
		startSeq: seq,
	}) as ChatMessage

const textOf = (messages: ReadonlyArray<{ content: ReadonlyArray<unknown> }>) =>
	messages.map((m) => m.content.map((part) => (part as { text?: string }).text ?? "").join(""))

describe("toLlmMessages without a compaction", () => {
	it("replays the conversation in order", () => {
		seq = 0
		const replayed = toLlmMessages([
			message("user", "why is checkout slow?"),
			message("assistant", "Looking."),
			message("user", "and payments?"),
		])

		assert.deepEqual(textOf(replayed), ["why is checkout slow?", "Looking.", "and payments?"])
		assert.deepEqual(
			replayed.map((m) => m.role),
			["user", "assistant", "user"],
		)
	})

	it("drops messages with no text, so a pure tool turn is not replayed as an empty one", () => {
		seq = 0
		const replayed = toLlmMessages([
			message("user", "check it"),
			message("assistant", "", [{ id: "c1" }]),
			message("assistant", "Done."),
		])

		assert.deepEqual(textOf(replayed), ["check it", "Done."])
	})

	it("drops from the head when the transcript exceeds the message cap", () => {
		seq = 0
		const history = Array.from({ length: 50 }, (_, i) => message("user", `turn ${i}`))
		const replayed = toLlmMessages(history)

		assert.lengthOf(replayed, 40)
		// The tail is what the next turn needs; the head is what a human skimming would skip.
		assert.equal(textOf(replayed)[39], "turn 49")
	})

	it("keeps one message even when it alone blows the character budget", () => {
		// The `kept.length > 0` guard: otherwise a single pasted stack trace replays as *nothing*,
		// and the model answers the next question with no context at all.
		seq = 0
		const replayed = toLlmMessages([message("user", "x".repeat(80_000))])

		assert.lengthOf(replayed, 1)
	})
})

describe("toLlmMessages with a compaction", () => {
	it("replaces the head with its summary instead of dropping it", () => {
		seq = 0
		const history = [
			message("user", "why is checkout slow?"),
			message("assistant", "p99 is 4.2s, trace abc123."),
			message("user", "and payments?"),
			message("assistant", "Payments is fine."),
		]
		const replayed = toLlmMessages(history, {
			summary: "The user asked about checkout; p99 was 4.2s in trace abc123.",
			throughSeq: history[1]!.startSeq,
		})

		const texts = textOf(replayed)
		assert.lengthOf(replayed, 3)
		assert.include(texts[0], "Summary of the earlier part")
		assert.include(texts[0], "trace abc123")
		// Everything at or before the split point is gone; everything after is verbatim.
		assert.deepEqual(texts.slice(1), ["and payments?", "Payments is fine."])
	})

	it("carries the summary as a user turn, not a fabricated assistant one", () => {
		// A synthetic assistant message would assert the model said something it did not, and
		// several protocols dislike a conversation opening on an assistant turn.
		seq = 0
		const history = [message("user", "old"), message("user", "new")]
		const replayed = toLlmMessages(history, { summary: "s", throughSeq: history[0]!.startSeq })

		assert.equal(replayed[0]?.role, "user")
	})

	it("still bounds the tail, because a compaction can be arbitrarily stale", () => {
		seq = 0
		const history = Array.from({ length: 60 }, (_, i) => message("user", `turn ${i}`))
		const replayed = toLlmMessages(history, { summary: "s", throughSeq: 0 })

		// One summary plus the capped tail — not sixty-one messages.
		assert.lengthOf(replayed, 41)
	})

	it("replays everything when the compaction predates the whole transcript", () => {
		seq = 0
		const history = [message("user", "a"), message("user", "b")]
		const replayed = toLlmMessages(history, { summary: "s", throughSeq: 0 })

		assert.deepEqual(textOf(replayed).slice(1), ["a", "b"])
	})
})

/**
 * `trackTokenUsage` posts to Autumn through the bare global `fetch` — promise-land,
 * not Effect's HttpClient — so stubbing the global is the seam. Nothing else in this
 * file fetches.
 */
const stubAutumnFetch = () => {
	const realFetch = globalThis.fetch
	const calls: Array<Record<string, unknown>> = []
	const signals: Array<AbortSignal | null | undefined> = []
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		// SAFETY: the tracker under test always POSTs a JSON object body; the assertions
		// below fail loudly if that ever stops holding.
		calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
		signals.push(init?.signal)
		return new Response("{}", { status: 200 })
	}) as typeof fetch
	return { calls, signals, restore: () => void (globalThis.fetch = realFetch) }
}

const AUTUMN_ENV = { AUTUMN_SECRET_KEY: "autumn-sk", AUTUMN_API_URL: "https://autumn.test" }
const TURN = { env: AUTUMN_ENV, sessionId: "org_1:sess-1", messageId: "turn-1" }
const orgId = Schema.decodeSync(OrgId)("org_1")

describe("meterTurn", () => {
	it("bills the turn's input and output against the org, keyed on the turn", async () => {
		const autumn = stubAutumnFetch()
		try {
			await meterTurn(TURN, orgId, { ...makeTurnUsage(), input: 1200, output: 340 })

			assert.deepEqual(
				new Map(autumn.calls.map((call) => [call.feature_id, call])),
				new Map([
					[
						"ai_input_tokens",
						{
							customer_id: "org_1",
							feature_id: "ai_input_tokens",
							value: 1200,
							// The source segment is what keeps a chat turn from colliding with a
							// triage run that happens to key on the same id.
							idempotency_key: "org_1:sess-1:turn-1:chat:input",
						},
					],
					[
						"ai_output_tokens",
						{
							customer_id: "org_1",
							feature_id: "ai_output_tokens",
							value: 340,
							idempotency_key: "org_1:sess-1:turn-1:chat:output",
						},
					],
				]),
			)
			// Bounded, because this is awaited while the session's turn slot is still
			// held — see `TRACK_TIMEOUT_MS`.
			for (const signal of autumn.signals) assert.instanceOf(signal, AbortSignal)
		} finally {
			autumn.restore()
		}
	})

	it("bills nothing for a turn that spent nothing", async () => {
		const autumn = stubAutumnFetch()
		try {
			await meterTurn(TURN, orgId, makeTurnUsage())

			assert.lengthOf(autumn.calls, 0)
		} finally {
			autumn.restore()
		}
	})
})
