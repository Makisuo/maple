/**
 * Keeping a turn inside the model's context window.
 *
 * Two different growth problems hide behind "the conversation got too long", and they want
 * different fixes:
 *
 *   - **In-turn.** `runStep` rebuilds the request as `[...messages, assistant, ...toolResults]` for
 *     up to `MAX_STEPS` steps at `TOOL_CONCURRENCY = 4`, and Maple's MCP tools return warehouse rows
 *     and trace payloads. This is where the tokens actually are, and it is what walks a single
 *     investigation into the wall.
 *   - **Cross-turn.** `toLlmMessages` in `turn-runner.ts` replays the transcript, but it already
 *     drops tool messages entirely and keeps only text, so it is comparatively small.
 *
 * This module handles the first, and does it without a model call, a wire change, or any
 * persistence: old tool output is replaced by a truncated prefix plus an explicit marker. The model
 * is *told* what was dropped rather than silently handed a shorter payload, because a tool result
 * that quietly loses its tail is indistinguishable from a tool that returned less than it did.
 */
import { LLM, Message, ToolResultPart, type LLMRequest, type ToolResultValue } from "@maple/llm"

/**
 * Rough tokens-per-character. There is no tokenizer in a Worker isolate, and shipping one would
 * cost more startup CPU than the estimate is worth.
 *
 * This is only ever used to decide *whether a prune is worth doing*. The authoritative number — the
 * one the trigger reads — is the provider's own `usage.inputTokens` from the previous step.
 */
const CHARS_PER_TOKEN = 4

export const tokensFromChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

export const estimateTokens = (text: string): number => tokensFromChars(text.length)

/**
 * How many of the most recent steps keep their tool output verbatim.
 *
 * The model is usually still reasoning about the last step or two; truncating those is what makes a
 * pruner feel like amnesia rather than housekeeping.
 */
const PROTECT_RECENT_STEPS = 2

/** How much of an old tool result survives. */
const PRUNE_TOOL_RESULT_CHARS = 2_000

/**
 * Don't bother unless the prune buys real headroom. A turn that would reclaim a few hundred tokens
 * pays the rebuild cost and the fidelity cost for nothing.
 */
const PRUNE_MIN_RECLAIM_TOKENS = 20_000

/** Headroom kept free for the model's own reply when deciding whether the input still fits. */
const RESERVE_CEILING_TOKENS = 20_000

/**
 * Whether an observed input-token count is close enough to the wall to act on.
 *
 * `undefined` limits mean "we don't know this model's window" — in which case the honest answer is
 * no, rather than a guess that could prune a turn that had plenty of room.
 */
export const isNearContextLimit = (
	inputTokens: number,
	limits: { readonly context?: number; readonly output?: number },
): boolean => {
	if (limits.context === undefined) return false
	const reserved = Math.min(RESERVE_CEILING_TOKENS, limits.output ?? RESERVE_CEILING_TOKENS)
	return inputTokens >= limits.context - reserved
}

const MARKER = (omitted: number) => `\n\n…[truncated, ${omitted} characters omitted]`

/** Render a tool result as the text the model would see, for measuring and truncating. */
const resultText = (result: ToolResultValue): string =>
	typeof result.value === "string" ? result.value : JSON.stringify(result.value)

/**
 * Truncate one tool result, or return `undefined` if it is already short enough.
 *
 * A string value keeps its original result type; anything else collapses to `"text"`, because a
 * truncated JSON payload is no longer parseable and handing the model a broken object is worse than
 * handing it a clearly-marked excerpt.
 */
const truncateResult = (result: ToolResultValue): ToolResultValue | undefined => {
	const text = resultText(result)
	if (text.length <= PRUNE_TOOL_RESULT_CHARS) return undefined
	const kept = text.slice(0, PRUNE_TOOL_RESULT_CHARS) + MARKER(text.length - PRUNE_TOOL_RESULT_CHARS)
	return typeof result.value === "string"
		? { type: result.type, value: kept }
		: { type: "text", value: kept }
}

/**
 * The index of the first message belonging to the last `PROTECT_RECENT_STEPS` steps.
 *
 * Steps are delimited by assistant messages — `runStep` appends exactly one per step, followed by
 * its tool results — so counting assistant turns backwards finds the boundary without the request
 * having to carry a step marker.
 */
const protectedFrom = (messages: ReadonlyArray<Message>): number => {
	let seen = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue
		seen += 1
		// The assistant turn that *opens* the oldest protected step. Everything before it belongs
		// to an older step and is fair game; the message at this index is not.
		if (seen === PROTECT_RECENT_STEPS) return i
	}
	return 0
}

/**
 * Truncate tool output from all but the most recent steps.
 *
 * Returns the request **unchanged** when there is nothing worth reclaiming, so a short turn pays
 * nothing and callers can apply this unconditionally.
 */
export const pruneToolResults = (request: LLMRequest): LLMRequest => {
	const boundary = protectedFrom(request.messages)
	if (boundary === 0) return request

	let reclaimed = 0
	const messages = request.messages.map((message, index) => {
		if (index >= boundary || message.role !== "tool") return message
		let changed = false
		const content = message.content.map((part) => {
			if (part.type !== "tool-result") return part
			const truncated = truncateResult(part.result)
			if (truncated === undefined) return part
			changed = true
			reclaimed += resultText(part.result).length - resultText(truncated).length
			return ToolResultPart.make({ ...part, result: truncated })
		})
		return changed ? Message.make({ ...message, content }) : message
	})

	if (tokensFromChars(reclaimed) < PRUNE_MIN_RECLAIM_TOKENS) return request
	return LLM.updateRequest(request, { messages })
}
