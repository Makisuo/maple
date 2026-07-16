import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { makeQueryEngineExecute, type QueryEngineWarehouse } from "./query-engine"

const asOrgId = Schema.decodeUnknownSync(OrgId)

describe("query-engine ClickHouse row boundary", () => {
	it.effect("coerces every trace aggregate returned as a ClickHouse JSON string", () =>
		Effect.gen(function* () {
			let decodedRows: ReadonlyArray<Record<string, unknown>> = []
			const rawRows = [
				{
					bucket: "2026-07-16 12:00:00",
					groupName: "all",
					count: "10",
					avgDuration: "20",
					p50Duration: "15",
					p95Duration: "40",
					p99Duration: "50",
					errorRate: "0.1",
					apdexScore: "0.8",
					estimatedSpanCount: "12",
					satisfiedCount: "7",
					toleratingCount: "2",
				},
			]
			const warehouse: QueryEngineWarehouse = {
				sqlQuery: () => Effect.succeed([]),
				compiledQuery: (_tenant, compiled) =>
					compiled.decodeRows(rawRows).pipe(
						Effect.tap((rows) =>
							Effect.sync(() => (decodedRows = rows as Record<string, unknown>[])),
						),
						Effect.orDie,
					),
			}
			const execute = makeQueryEngineExecute(warehouse)

			const response = yield* execute(
				{ orgId: asOrgId("org_query_engine_decode") },
				{
					startTime: "2026-07-16 12:00:00",
					endTime: "2026-07-16 12:01:00",
					query: {
						kind: "timeseries",
						source: "traces",
						metric: "apdex",
						allMetrics: true,
						apdexThresholdMs: 500,
						groupBy: ["none"],
						bucketSeconds: 60,
					},
				},
			)

			assert.deepStrictEqual(
				{
					count: decodedRows[0]?.count,
					estimatedSpanCount: decodedRows[0]?.estimatedSpanCount,
					satisfiedCount: decodedRows[0]?.satisfiedCount,
					toleratingCount: decodedRows[0]?.toleratingCount,
				},
				{
					count: 10,
					estimatedSpanCount: 12,
					satisfiedCount: 7,
					toleratingCount: 2,
				},
			)
			assert.strictEqual(response.result.kind, "timeseries")
			assert.strictEqual(response.result.source, "traces")
		}),
	)
})
