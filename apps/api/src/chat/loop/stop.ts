/**
 * Stopping a turn that has stopped making progress.
 *
 * `MAX_STEPS` bounds how long a turn can run; it does not notice *why*. A model that answers every
 * tool result by issuing the identical call again is going to spend all ten steps, and every one of
 * `TASK_BUDGET_PER_TURN`'s sub-agent turns underneath it — `budgets.ts` spells that product out as
 * 240 model calls — to arrive exactly where it was after the first. The user watches a spinner for
 * the whole of it.
 *
 * So the loop watches the *shape* of what the model asks for, not just how often. A batch of tool
 * calls that repeats verbatim `REPEATED_TOOL_CALLS` times means the model is not reacting to the
 * results, and no number of further attempts will change that.
 *
 * ## Batches, not calls
 *
 * The unit is the whole batch a step issued, not an individual call. A model legitimately calls
 * `search_logs` several times in one turn with different arguments, and a fan-out that queries four
 * services and then queries them again with a wider window is progress. What is not progress is
 * issuing the same *set* twice.
 *
 * The fingerprint sorts by name and canonicalizes argument key order, because neither carries
 * meaning: `TOOL_CONCURRENCY` dispatches concurrently, so the order calls come back in is a race,
 * and a model re-emitting the same JSON object with its keys in a different order has still asked
 * the same question.
 *
 * ## Pure, like its neighbours
 *
 * The policy is here and the loop applies it, the same split `retry.ts` and `context.ts` use. The
 * turn owns what a stop *does* — see `DOOM_LOOP_NOTICE` in `turn.ts`, which spends the closing step
 * getting an answer out of the model rather than dead-ending the user.
 */

import { REPEATED_TOOL_CALLS } from "./budgets"

/** One call as the detector sees it: what was asked for, and with what. */
export interface ObservedToolCall {
	readonly name: string
	readonly input: unknown
}

/** Per-branch detector state. A sub-agent turn starts with a fresh one; it is not the parent's loop. */
export interface DoomLoopState {
	readonly fingerprint: string | null
	readonly count: number
}

export const initialDoomLoopState: DoomLoopState = { fingerprint: null, count: 0 }

export interface DoomLoopObservation {
	readonly state: DoomLoopState
	/** True when this batch is the `REPEATED_TOOL_CALLS`th identical one in a row. */
	readonly stop: boolean
}

/**
 * Stable JSON: object keys sorted at every depth, arrays left alone.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical argument objects can
 * serialize differently. Arrays keep their order because there it *is* meaningful — a list of
 * service names in a different order is a different question to ask a warehouse.
 */
const canonical = (value: unknown): string => {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
	return `{${entries.join(",")}}`
}

const fingerprintOf = (calls: ReadonlyArray<ObservedToolCall>): string =>
	calls
		.map((call) => `${call.name}(${canonical(call.input)})`)
		.sort()
		.join("|")

/**
 * Fold one step's tool-call batch into the detector.
 *
 * An empty batch is not observed at all: it means the model answered in prose, which both ends the
 * turn and is the opposite of the failure this looks for.
 */
export const observeToolCallBatch = (
	state: DoomLoopState,
	calls: ReadonlyArray<ObservedToolCall>,
): DoomLoopObservation => {
	if (calls.length === 0) return { state, stop: false }

	const fingerprint = fingerprintOf(calls)
	if (fingerprint !== state.fingerprint) {
		return { state: { fingerprint, count: 1 }, stop: false }
	}

	const count = state.count + 1
	return { state: { fingerprint, count }, stop: count >= REPEATED_TOOL_CALLS }
}
