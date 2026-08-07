/**
 * Keeping a turn inside the model's context window, when bounding results at creation wasn't enough.
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
 * ## Why this is now a fallback rather than the main defence
 *
 * This module used to truncate old tool results *in place*, mid-turn. That is the one shape the
 * default route cannot afford: OpenRouter `openai/gpt-5.6-luna` gets no cache breakpoints from
 * `lib/llm` (its route id is not in `RESPECTS_INLINE_HINTS`), so caching there is implicit-prefix and
 * prefix stability is the only lever. Rewriting a step-3 result diverges the prefix near the front of
 * the turn and voids everything after it — at exactly the moment the transcript is longest.
 *
 * Results are therefore bounded once, when they are created (`mcp/tools/tool-output.ts`), and the
 * transcript is append-only. What is left here is the case that survives that: enough bounded
 * results to still overflow. The answer then is to drop whole *steps* off the front rather than edit
 * any message — one clean break in the prefix instead of a rolling one, and it should almost never
 * run. An assistant turn leaves with its own tool results, so the transcript never ends up with an
 * orphaned result or a tool call whose answer vanished.
 */
import { LLM, type LLMRequest, type Message } from "@maple/llm"

/**
 * How many of the most recent steps are never dropped.
 *
 * The model is usually still reasoning about the last step or two; taking those away is what makes
 * context management feel like amnesia rather than housekeeping.
 *
 * (The char-based token estimate that used to live here went with the pruner. It existed only to
 * decide whether a rewrite reclaimed enough to be worth its fidelity cost; dropping a whole step is
 * unambiguously worth it, and the trigger below reads the provider's reported count anyway.)
 */
const PROTECT_RECENT_STEPS = 2

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
 * Drop the oldest tool-calling step: one assistant message and the tool results that answered it.
 *
 * Targets an assistant message *followed by tool results* rather than simply the first assistant
 * message, so plain conversational history from earlier turns is not what gets sacrificed — the
 * tokens are in the tool payloads, and dropping prose to save them would trade the model's memory of
 * what the user asked for nothing.
 *
 * Returns the request **unchanged** when there is no such step outside the protected window, which
 * is the caller's signal that there is nothing left to give.
 */
export const dropOldestToolStep = (request: LLMRequest): LLMRequest => {
	const boundary = protectedFrom(request.messages)
	if (boundary === 0) return request

	const messages = request.messages
	for (let i = 0; i < boundary; i++) {
		if (messages[i]?.role !== "assistant") continue
		// Its results run to the next non-tool message.
		let end = i + 1
		while (end < messages.length && messages[end]?.role === "tool") end++
		// An assistant turn with no tool results is prose, not payload. Leave it.
		if (end === i + 1) continue
		// Never cut into the protected window, even if this step straddles it.
		if (end > boundary) return request
		return LLM.updateRequest(request, { messages: [...messages.slice(0, i), ...messages.slice(end)] })
	}
	return request
}
