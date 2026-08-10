import { describe, expect, it } from "vitest"
import {
	QueryEngineExecuteRequest,
	QUERY_ENGINE_BATCH_MAX,
	type QueryEngineBatchOutcome,
} from "@maple/query-engine"
import { makeExecuteBatcher, type SendExecuteBatch } from "./execute-batcher"

// The batcher never inspects the payload, so the cheapest valid query will do.
const request = () =>
	new QueryEngineExecuteRequest({
		startTime: "2026-08-01 00:00:00",
		endTime: "2026-08-01 01:00:00",
		query: { kind: "count", source: "logs" },
	})

const countOutcome = (total: number): QueryEngineBatchOutcome => ({
	outcome: "success",
	result: { kind: "count", source: "logs", data: { total } },
})

/** Records each batch's size and replies with per-index outcomes. */
const recordingSend = (
	reply: (requests: ReadonlyArray<QueryEngineExecuteRequest>) => ReadonlyArray<QueryEngineBatchOutcome>,
) => {
	const batches: Array<number> = []
	const send: SendExecuteBatch = (requests) => {
		batches.push(requests.length)
		return Promise.resolve(reply(requests))
	}
	return { send, batches }
}

describe("makeExecuteBatcher", () => {
	it("coalesces concurrent queries into a single request", async () => {
		const { send, batches } = recordingSend((requests) => requests.map((_, index) => countOutcome(index)))
		const batcher = makeExecuteBatcher(send, 1)

		const responses = await Promise.all([
			batcher.enqueue(request()),
			batcher.enqueue(request()),
			batcher.enqueue(request()),
		])

		expect(batches).toEqual([3])
		expect(responses.map((r) => (r.result.kind === "count" ? r.result.data.total : -1))).toEqual([
			0, 1, 2,
		])
	})

	it("settles each caller from its own positional outcome", async () => {
		const { send } = recordingSend((requests) =>
			requests.map((_, index) =>
				index === 1
					? ({
							outcome: "failure",
							error: {
								_tag: "@maple/http/errors/QueryEngineTimeoutError",
								message: "too slow",
							},
						} satisfies QueryEngineBatchOutcome)
					: countOutcome(index),
			),
		)
		const batcher = makeExecuteBatcher(send, 1)

		const settled = await Promise.allSettled([
			batcher.enqueue(request()),
			batcher.enqueue(request()),
			batcher.enqueue(request()),
		])

		// One failing query must not take its siblings down with it.
		expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
		const rejected = settled[1]
		if (rejected?.status !== "rejected") throw new Error("expected a rejection")
		// The server's tag survives, so normalizeWarehouseError passes it through.
		expect(rejected.reason).toEqual({
			_tag: "@maple/http/errors/QueryEngineTimeoutError",
			message: "too slow",
		})
	})

	it("fails every caller in the batch when the request itself fails", async () => {
		const cause = new Error("transport failed")
		const batcher = makeExecuteBatcher(() => Promise.reject(cause), 1)

		const settled = await Promise.allSettled([batcher.enqueue(request()), batcher.enqueue(request())])

		expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"])
		for (const result of settled) {
			if (result.status !== "rejected") throw new Error("expected a rejection")
			expect(result.reason).toBe(cause)
		}
	})

	it("splits past the batch cap instead of dropping queries", async () => {
		const { send, batches } = recordingSend((requests) => requests.map(() => countOutcome(1)))
		const batcher = makeExecuteBatcher(send, 1)
		const overflow = 3

		const responses = await Promise.all(
			Array.from({ length: QUERY_ENGINE_BATCH_MAX + overflow }, () => batcher.enqueue(request())),
		)

		expect(responses).toHaveLength(QUERY_ENGINE_BATCH_MAX + overflow)
		expect(batches).toEqual([QUERY_ENGINE_BATCH_MAX, overflow])
	})

	it("does not hold a query for a batch that already went out", async () => {
		const { send, batches } = recordingSend((requests) => requests.map(() => countOutcome(1)))
		const batcher = makeExecuteBatcher(send, 1)

		await batcher.enqueue(request())
		await batcher.enqueue(request())

		expect(batches).toEqual([1, 1])
	})
})
