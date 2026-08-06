/**
 * The in-turn pruner.
 *
 * The properties that matter: it protects the recent steps, it never silently shortens a payload
 * without saying so, and it does nothing at all when there is nothing worth reclaiming.
 */
import { LLM, Message, ToolResultPart, type LLMRequest, type Model } from "@maple/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { assert, describe, it } from "vitest"
import { estimateTokens, isNearContextLimit, pruneToolResults } from "./context-budget"

const MODEL: Model = CloudflareWorkersAI.configure({ accountId: "t", apiKey: "t" }).model("@cf/test/model")

/**
 * Default size clears `PRUNE_MIN_RECLAIM_TOKENS` (20k tokens ≈ 80k chars) from a single pruned
 * step, so a test does not have to stack steps just to get past the threshold.
 */
const big = (marker: string, chars = 100_000) => marker + "x".repeat(chars)

/** One step: an assistant turn plus the tool result it produced. */
const step = (marker: string, chars?: number): ReadonlyArray<Message> => [
	Message.assistant(`calling ${marker}`),
	Message.tool(ToolResultPart.make({ id: marker, name: "search_traces", result: big(marker, chars) })),
]

const requestOf = (messages: ReadonlyArray<Message>): LLMRequest =>
	LLM.request({ model: MODEL, system: "s", messages: [...messages] })

const toolTexts = (request: LLMRequest): ReadonlyArray<string> =>
	request.messages
		.filter((message) => message.role === "tool")
		.flatMap((message) => message.content)
		.map((part) => (part.type === "tool-result" ? String(part.result.value) : ""))

describe("pruneToolResults", () => {
	it("truncates old tool output and leaves the last two steps intact", () => {
		const request = requestOf([...step("a"), ...step("b"), ...step("c"), ...step("d")])
		const pruned = pruneToolResults(request)

		const texts = toolTexts(pruned)
		assert.lengthOf(texts, 4)
		// The two oldest lost their tails; the two the model is still reasoning about did not.
		assert.isBelow(texts[0]!.length, 3_000)
		assert.isBelow(texts[1]!.length, 3_000)
		assert.equal(texts[2], big("c"))
		assert.equal(texts[3], big("d"))
	})

	it("tells the model what it dropped instead of quietly shortening the payload", () => {
		// A tool result that silently loses its tail is indistinguishable from a tool that returned
		// less than it did — which is how a model concludes "there were only 3 traces".
		const pruned = pruneToolResults(requestOf([...step("a"), ...step("b"), ...step("c")]))

		assert.include(toolTexts(pruned)[0]!, "truncated")
		assert.include(toolTexts(pruned)[0]!, "characters omitted")
	})

	it("keeps the surviving prefix, so the excerpt is the start of the real output", () => {
		const pruned = pruneToolResults(requestOf([...step("a"), ...step("b"), ...step("c")]))

		assert.isTrue(toolTexts(pruned)[0]!.startsWith("a"))
	})

	it("returns the request unchanged when there is nothing worth reclaiming", () => {
		// Identity, not just equality: a short turn must pay nothing, so callers can apply this
		// unconditionally.
		const request = requestOf([...step("a", 10), ...step("b", 10), ...step("c", 10)])
		assert.strictEqual(pruneToolResults(request), request)
	})

	it("returns the request unchanged when every step is still protected", () => {
		const request = requestOf([...step("a"), ...step("b")])
		assert.strictEqual(pruneToolResults(request), request)
	})

	it("leaves user and assistant messages alone", () => {
		const request = requestOf([
			Message.user("why is checkout slow?"),
			...step("a"),
			...step("b"),
			...step("c"),
		])
		const pruned = pruneToolResults(request)

		const spoken = pruned.messages.filter((message) => message.role !== "tool")
		assert.deepEqual(
			spoken.map((message) =>
				message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			),
			["why is checkout slow?", "calling a", "calling b", "calling c"],
		)
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

describe("estimateTokens", () => {
	it("is a rough chars-per-token estimate, used only to size a prune", () => {
		assert.equal(estimateTokens(""), 0)
		assert.equal(estimateTokens("abcd"), 1)
		assert.equal(estimateTokens("abcde"), 2)
	})
})
