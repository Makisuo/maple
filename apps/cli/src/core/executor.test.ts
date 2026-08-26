// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { rawCompiledQuery } from "@maple/query-engine/ch"
import { makeLocalWarehouseExecutorApi } from "./executor"

// The local executor is the REAL makeWarehouseExecutor wired to the `chdb`
// backend — these tests pin the wiring: SQL normalization for the local
// server, row flow, and the OrgId scoping guard.

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

const stubFetch = (handler: (url: string, init?: RequestInit) => Response) => {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init)) as typeof fetch
}

const stubLocalServer = (rows: ReadonlyArray<Record<string, unknown>>) => {
	const requests: Array<{ url: string; sql: string }> = []
	stubFetch((url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { sql?: string }
		requests.push({ url, sql: body.sql ?? "" })
		return new Response(JSON.stringify(rows), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	})
	return requests
}

describe("makeLocalWarehouseExecutorApi", () => {
	it.effect("posts compiled SQL to /local/query with the trailing FORMAT stripped (chdb dialect)", () =>
		Effect.gen(function* () {
			const requests = stubLocalServer([{ c: 1 }])
			const executor = makeLocalWarehouseExecutorApi("http://127.0.0.1:4318")
			const compiled = rawCompiledQuery<{ readonly c: number }>({
				reason: "test-fixture",
				justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
				tenantScope: "single-tenant",
				sql: "SELECT count() AS c FROM traces WHERE OrgId = 'local'\nFORMAT JSON",
			})

			const rows = yield* executor.compiledQuery(compiled)

			expect(rows).toEqual([{ c: 1 }])
			expect(requests).toHaveLength(1)
			expect(requests[0]!.url).toBe("http://127.0.0.1:4318/local/query")
			// The chdb backend speaks the ClickHouse protocol shape: the executor
			// strips the trailing FORMAT and the local server owns the output format.
			expect(requests[0]!.sql).not.toContain("FORMAT JSON")
			expect(requests[0]!.sql).toContain("OrgId = 'local'")
		}),
	)

	it.effect("keeps the executor's OrgId scoping guard for trusted SQL", () =>
		Effect.gen(function* () {
			stubLocalServer([])
			const executor = makeLocalWarehouseExecutorApi("http://127.0.0.1:4318")

			// Scope now rides on the compiled query rather than being sniffed out
			// of the SQL string, so an unscoped one is rejected before execution.
			const exit = yield* executor
				.compiledQuery(
					rawCompiledQuery({
						reason: "test-fixture",
						justification:
							"Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: "SELECT 1",
						tenantScope: "cross-tenant",
					}),
				)
				.pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it.effect("classifies a local 400 query failure without retrying it", () =>
		Effect.gen(function* () {
			let attempts = 0
			stubFetch(() => {
				attempts += 1
				return new Response("query failed: Unknown expression identifier", { status: 400 })
			})
			const executor = makeLocalWarehouseExecutorApi("http://127.0.0.1:4318")

			const exit = yield* executor
				.compiledQuery(
					rawCompiledQuery({
						reason: "test-fixture",
						justification:
							"Synthetic SQL asserting executor/compile behaviour, not a product query.",
						sql: "SELECT nope FROM traces WHERE OrgId = 'local'",
						tenantScope: "single-tenant",
					}),
				)
				.pipe(Effect.exit)

			expect(Exit.isFailure(exit)).toBe(true)
			// 400 is a non-transient client-side failure — exactly one attempt.
			expect(attempts).toBe(1)
		}),
	)
})
