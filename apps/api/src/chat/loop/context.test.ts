/**
 * The overflow fallback.
 *
 * The properties that matter: it protects the recent steps, it never leaves the transcript
 * incoherent (an orphaned tool result, or a tool call whose answer vanished), it spends prose last,
 * and it says so plainly when it has nothing left to give.
 *
 * What it must *not* do is edit a message. That is the whole reason it replaced the in-turn pruner —
 * see the module header — so "never rewrites a surviving message" is load-bearing, not incidental.
 */
import { LLM, Message, ToolResultPart, type LLMRequest, type LanguageModel } from "@opencode-ai/ai"
import { CloudflareWorkersAI } from "@opencode-ai/ai/providers/cloudflare"
import { assert, describe, it } from "vitest"
import { dropOldestToolStep, isNearContextLimit } from "./context"

const MODEL: LanguageModel = CloudflareWorkersAI.configure({ accountId: "t", apiKey: "t" }).model(
	"@cf/test/model",
)

/** One step: an assistant turn plus the tool result it produced. */
const step = (marker: string): ReadonlyArray<Message> => [
	Message.assistant(`calling ${marker}`),
	Message.tool(ToolResultPart.make({ id: marker, name: "search_traces", result: `result ${marker}` })),
]

const requestOf = (messages: ReadonlyArray<Message>): LLMRequest =>
	LLM.request({ model: MODEL, system: "s", messages: [...messages] })

const spoken = (request: LLMRequest): ReadonlyArray<string> =>
	request.messages.map((message) =>
		message.content
			.map((part) =>
				part.type === "text"
					? part.text
					: part.type === "tool-result"
						? String(part.result.value)
						: "",
			)
			.join(""),
	)

describe("dropOldestToolStep", () => {
	it("drops the oldest step whole — assistant and its results together", () => {
		const dropped = dropOldestToolStep(requestOf([...step("a"), ...step("b"), ...step("c")]))

		// "calling a" leaves with "result a". A transcript holding one without the other is a tool
		// call with no answer, or an answer to nothing.
		assert.deepEqual(spoken(dropped), ["calling b", "result b", "calling c", "result c"])
	})

	it("drops one step per call, so the caller controls how much it gives up", () => {
		const once = dropOldestToolStep(requestOf([...step("a"), ...step("b"), ...step("c"), ...step("d")]))
		assert.deepEqual(spoken(once), [
			"calling b",
			"result b",
			"calling c",
			"result c",
			"calling d",
			"result d",
		])
	})

	it("takes every result belonging to a step, not just the first", () => {
		const fanOut = requestOf([
			Message.assistant("calling a"),
			Message.tool(ToolResultPart.make({ id: "a1", name: "search_traces", result: "r1" })),
			Message.tool(ToolResultPart.make({ id: "a2", name: "search_logs", result: "r2" })),
			...step("b"),
			...step("c"),
		])

		assert.deepEqual(spoken(dropOldestToolStep(fanOut)), [
			"calling b",
			"result b",
			"calling c",
			"result c",
		])
	})

	it("spends tool payloads before conversation, so the model keeps knowing what was asked", () => {
		const request = requestOf([
			Message.user("why is checkout slow?"),
			Message.assistant("let me look"),
			...step("a"),
			...step("b"),
			...step("c"),
		])

		// The prose assistant turn has no results to reclaim — dropping it would cost memory and buy
		// nothing, so the first *tool-calling* step goes instead.
		assert.deepEqual(spoken(dropOldestToolStep(request)), [
			"why is checkout slow?",
			"let me look",
			"calling b",
			"result b",
			"calling c",
			"result c",
		])
	})

	it("returns the request unchanged when only the protected steps are left", () => {
		// Identity, not equality: this is the caller's signal that there is nothing left to give, and
		// `turn.ts` ends the turn on it rather than retrying an identical request.
		const request = requestOf([...step("a"), ...step("b")])
		assert.strictEqual(dropOldestToolStep(request), request)
	})

	it("returns the request unchanged when there are no tool steps at all", () => {
		const request = requestOf([
			Message.user("hello"),
			Message.assistant("hi"),
			Message.user("still there?"),
			Message.assistant("yes"),
		])
		assert.strictEqual(dropOldestToolStep(request), request)
	})

	it("never rewrites a surviving message", () => {
		// The point of the whole module: a survivor comes through byte-for-byte. An edited message
		// diverges the cached prefix exactly the way the in-turn pruner this replaced did, so
		// "shorter" is only safe when it means "fewer messages", never "smaller messages".
		const request = requestOf([...step("a"), ...step("b"), ...step("c")])
		const dropped = dropOldestToolStep(request)

		assert.deepEqual([...dropped.messages], request.messages.slice(2))
	})
})

describe("isNearContextLimit", () => {
	it("fires once the input is within the reply's headroom of the window", () => {
		assert.isTrue(isNearContextLimit(112_000, { context: 128_000, output: 16_000 }))
		assert.isFalse(isNearContextLimit(90_000, { context: 128_000, output: 16_000 }))
	})

	it("caps the reserve so a huge max-output does not make every turn look full", () => {
		// Reserve is `min(20k, output)`: a model advertising 128k completion tokens against a
		// 1.05M window must not be treated as overflowing at 922k.
		assert.isFalse(isNearContextLimit(922_000, { context: 1_050_000, output: 128_000 }))
		assert.isTrue(isNearContextLimit(1_040_000, { context: 1_050_000, output: 128_000 }))
	})

	it("says no when the model declares no window, rather than guessing", () => {
		assert.isFalse(isNearContextLimit(10_000_000, {}))
	})
})
