import { DemoSeedError, DemoSeedResponse } from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import type { TenantContext } from "./AuthService"
import { generateDemoRows } from "./demo/fixtures"

const DEMO_HOURS_DEFAULT = 6
const DEMO_RATE_PER_HOUR = 250
// Rows per warehouse append. Keeps each NDJSON POST body modest (~1.5k rows
// total for the 6h default) without fanning out into many tiny requests.
const INGEST_CHUNK = 500

const chunk = <T>(rows: ReadonlyArray<T>, size: number): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
	return out
}

export interface DemoServiceShape {
	readonly seed: (tenant: TenantContext, hours?: number) => Effect.Effect<DemoSeedResponse, DemoSeedError>
}

export class DemoService extends Context.Service<DemoService, DemoServiceShape>()("@maple/api/services/DemoService", {
	make: Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		const seed = Effect.fn("DemoService.seed")(function* (
			tenant: TenantContext,
			hours: number = DEMO_HOURS_DEFAULT,
		) {
			const safeHours = Math.max(1, Math.min(24, Math.floor(hours)))
			const { traceRows, logRows, metricGaugeRows, metricSumRows } = generateDemoRows({
				orgId: tenant.orgId,
				hours: safeHours,
				ratePerHour: DEMO_RATE_PER_HOUR,
			})

			const ingestAll = (
				datasource: "traces" | "logs" | "metrics_gauge" | "metrics_sum",
				rows: ReadonlyArray<unknown>,
			) =>
				Effect.forEach(
					chunk(rows, INGEST_CHUNK),
					(batch) =>
						warehouse
							.ingest(tenant, datasource, batch)
							.pipe(Effect.mapError((error) => new DemoSeedError({ message: error.message }))),
					{ concurrency: 1, discard: true },
				)

			// Write straight to the warehouse datasources, bypassing the
			// billing-enforced ingest gateway (which 402s brand-new orgs that have
			// no active subscription — the whole point of demo data is to work
			// before the user has picked a plan). Also deliberately NOT metered to
			// Autumn: these are Maple-injected samples, not billable customer
			// telemetry.
			yield* ingestAll("traces", traceRows)
			yield* ingestAll("logs", logRows)
			// Runtime metrics so metric-based dashboard templates (Node.js
			// Runtime, Metric Overview) have data to show.
			yield* ingestAll("metrics_gauge", metricGaugeRows)
			yield* ingestAll("metrics_sum", metricSumRows)

			return new DemoSeedResponse({
				seeded: true,
				skippedReason: null,
				spansSent: traceRows.length,
				logsSent: logRows.length,
				metricsSent: metricGaugeRows.length + metricSumRows.length,
			})
		})

		return { seed } satisfies DemoServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
