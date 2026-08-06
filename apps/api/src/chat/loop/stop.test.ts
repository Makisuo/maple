/**
 * The repeated-batch detector.
 *
 * The properties that matter: it fires on a genuinely stuck model, it does not fire on a model that
 * is working, and the things it treats as "the same batch" are the things that carry no meaning —
 * dispatch order and JSON key order.
 */
import { assert, describe, it } from "vitest"
import { REPEATED_TOOL_CALLS } from "./budgets"
import { initialDoomLoopState, observeToolCallBatch, type DoomLoopState } from "./stop"

/** Feed a sequence of batches through the detector, returning the step each one stopped on. */
const run = (batches: ReadonlyArray<ReadonlyArray<{ name: string; input: unknown }>>) => {
	let state: DoomLoopState = initialDoomLoopState
	const stops: number[] = []
	batches.forEach((batch, index) => {
		const observed = observeToolCallBatch(state, batch)
		state = observed.state
		if (observed.stop) stops.push(index)
	})
	return stops
}

const call = (name: string, input: unknown = {}) => ({ name, input })

describe("observeToolCallBatch", () => {
	it("stops on the Nth identical batch", () => {
		const batch = [call("query_data", { sql: "select 1" })]
		assert.deepEqual(run([batch, batch, batch]), [REPEATED_TOOL_CALLS - 1])
	})

	it("does not stop before then", () => {
		const batch = [call("query_data", { sql: "select 1" })]
		assert.deepEqual(run([batch, batch]), [])
	})

	it("treats a reordered batch as the same batch", () => {
		// `TOOL_CONCURRENCY` dispatches concurrently, so the order calls come back in is a race. A
		// model that reissues the same set has not made progress regardless of how it arrives.
		const forward = [call("search_logs", { q: "a" }), call("search_traces", { q: "b" })]
		const reversed = [call("search_traces", { q: "b" }), call("search_logs", { q: "a" })]
		assert.deepEqual(run([forward, reversed, forward]), [REPEATED_TOOL_CALLS - 1])
	})

	it("treats reordered argument keys as the same arguments", () => {
		const a = [call("query_data", { limit: 10, sql: "select 1" })]
		const b = [call("query_data", { sql: "select 1", limit: 10 })]
		assert.deepEqual(run([a, b, a]), [REPEATED_TOOL_CALLS - 1])
	})

	it("treats reordered array arguments as different, because there order means something", () => {
		// A list of services in a different order is a different question to ask a warehouse.
		const a = [call("service_map", { services: ["web", "api"] })]
		const b = [call("service_map", { services: ["api", "web"] })]
		assert.deepEqual(run([a, b, a, b]), [])
	})

	it("does not fire on different arguments to the same tool", () => {
		assert.deepEqual(
			run([
				[call("search_logs", { page: 1 })],
				[call("search_logs", { page: 2 })],
				[call("search_logs", { page: 3 })],
				[call("search_logs", { page: 4 })],
			]),
			[],
		)
	})

	it("does not fire on a different set of tools", () => {
		assert.deepEqual(run([[call("search_logs")], [call("search_traces")], [call("list_services")]]), [])
	})

	it("resets the run when the model changes course", () => {
		const stuck = [call("query_data", { sql: "select 1" })]
		const different = [call("list_services")]
		assert.deepEqual(run([stuck, stuck, different, stuck, stuck]), [])
	})

	it("ignores an empty batch rather than counting it", () => {
		// No tool calls means the model answered in prose — which ends the turn, and is the opposite
		// of the failure this looks for. Counting it would also let two prose turns "repeat".
		const state = observeToolCallBatch(initialDoomLoopState, [])
		assert.isFalse(state.stop)
		assert.strictEqual(state.state, initialDoomLoopState)
	})

	it("keeps counting past the threshold without wrapping", () => {
		const batch = [call("query_data", { sql: "select 1" })]
		let state: DoomLoopState = initialDoomLoopState
		for (let i = 0; i < 5; i++) state = observeToolCallBatch(state, batch).state
		assert.isTrue(observeToolCallBatch(state, batch).stop)
	})

	it("distinguishes arguments that differ only in nesting", () => {
		const a = [call("query_data", { filter: { service: "web" } })]
		const b = [call("query_data", { filter: { service: "api" } })]
		assert.deepEqual(run([a, b, a, b]), [])
	})
})
