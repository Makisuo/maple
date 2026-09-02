import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
	serviceMapEdgesExistingHoursSQL,
	serviceMapEdgesRollupSQL,
	serviceMapResolutionsExistingHoursSQL,
	serviceMapResolutionsRollupSQL,
} from "./service-map-rollup"

const hourParams = {
	orgId: "org_1",
	hourStart: "2024-01-01 00:00:00",
	hourEnd: "2024-01-01 01:00:00",
}

describe("service-map rollup compiled row schemas", () => {
	it.effect("decodes existing-hour rows with numeric strings", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceMapEdgesExistingHoursSQL({
				orgId: "org_1",
				startTime: "2024-01-01 00:00:00",
				endTime: "2024-01-02 00:00:00",
			})

			const rows = yield* compiled.decodeRows([{ hourTs: "1704067200" }])

			expect(rows).toEqual([{ hourTs: 1704067200 }])
		}),
	)

	it.effect("decodes edge rollup rows into the service_map_edges_hourly ingest shape", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceMapEdgesRollupSQL(hourParams)

			const rows = yield* compiled.decodeRows([
				{
					OrgId: "org_1",
					Hour: "2024-01-01 00:00:00",
					SourceService: "checkout-api",
					TargetService: "payments-api",
					DeploymentEnv: "production",
					CallCount: "12",
					ErrorCount: "1",
					DurationSumMs: "150.5",
					MaxDurationMs: "80",
					SampledSpanCount: "9",
					UnsampledSpanCount: "3",
					SampleRateSum: "18",
				},
			])

			expect(rows).toEqual([
				{
					OrgId: "org_1",
					Hour: "2024-01-01 00:00:00",
					SourceService: "checkout-api",
					TargetService: "payments-api",
					DeploymentEnv: "production",
					CallCount: 12,
					ErrorCount: 1,
					DurationSumMs: 150.5,
					MaxDurationMs: 80,
					SampledSpanCount: 9,
					UnsampledSpanCount: 3,
					SampleRateSum: 18,
				},
			])
		}),
	)

	it.effect(
		"decodes address resolution rows into the service_address_resolutions_hourly ingest shape",
		() =>
			Effect.gen(function* () {
				const compiled = yield* serviceMapResolutionsRollupSQL(hourParams)

				const rows = yield* compiled.decodeRows([
					{
						OrgId: "org_1",
						Hour: "2024-01-01 00:00:00",
						SourceService: "checkout-api",
						ParentServerAddress: "payments.internal",
						ResolvedTargetService: "payments-api",
						DeploymentEnv: "production",
					},
				])

				expect(rows).toEqual([
					{
						OrgId: "org_1",
						Hour: "2024-01-01 00:00:00",
						SourceService: "checkout-api",
						ParentServerAddress: "payments.internal",
						ResolvedTargetService: "payments-api",
						DeploymentEnv: "production",
					},
				])
			}),
	)
})

describe("service-map rollup routing", () => {
	const windowParams = {
		orgId: "org_1",
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
	}

	it.effect("pins both seal probes to the ingest backend the rollup writes", () =>
		Effect.gen(function* () {
			// The rollup ingests into Tinybird unconditionally. A probe resolved as
			// an ordinary read hits a BYO org's own (never-written) ClickHouse table,
			// judges every hour missing, and re-ingests the same additive edge rows
			// into Tinybird every tick — permanent double counting.
			const edges = yield* serviceMapEdgesExistingHoursSQL(windowParams)
			const resolutions = yield* serviceMapResolutionsExistingHoursSQL(windowParams)
			expect(edges.route).toBe("ingest")
			expect(resolutions.route).toBe("ingest")
		}),
	)

	it.effect("leaves the compute rollups on the org backend where raw spans live", () =>
		Effect.gen(function* () {
			const edges = yield* serviceMapEdgesRollupSQL(hourParams)
			const resolutions = yield* serviceMapResolutionsRollupSQL(hourParams)
			expect(edges.route).toBeUndefined()
			expect(resolutions.route).toBeUndefined()
		}),
	)
})
