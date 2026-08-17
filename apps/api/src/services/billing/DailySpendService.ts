import { DailySpendResponse, DailyVolume, WarehouseQueryError } from "@maple/domain/http"
import { CH, parseWarehouseDateTime, formatWarehouseDateTime } from "@maple/query-engine"
import { Context, Effect, Layer } from "effect"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@/services/auth/AuthService"
import * as Integrations from "@maple/query-engine-integrations"

/**
 * The daily volume series behind the billing page's cumulative spend chart.
 *
 * Autumn reports cycle totals only, so the daily shape comes from the warehouse:
 * `service_usage` for log/trace/metric bytes and `session_replays` for browser
 * sessions. Volume only — this service never prices anything. Dollars are the
 * client's job, computed from the same catalog rates the cost breakdown uses, so
 * the chart and the invoice can't tell two stories.
 *
 * The series is gap-filled across the whole cycle: a day with no ingest is a
 * real zero and the chart's cumulative line must stay flat through it rather
 * than skipping the day and steepening.
 */

const DAY_MS = 86_400_000
const BYTES_PER_BILLED_GB = 1_000_000_000

/** ClickHouse datetime literal (`YYYY-MM-DD HH:MM:SS`), which is what the DSL params want. */

/** `YYYY-MM-DD` in UTC — the key the client renders and the series is indexed by. */
export const toUtcDateKey = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10)

const startOfUtcDay = (epochMs: number) => Math.floor(epochMs / DAY_MS) * DAY_MS

export interface DailySpendServiceApi {
	readonly get: (
		tenant: TenantContext,
		/**
		 * The FULL billing cycle, including days that haven't happened. The series
		 * spans all of it so the chart can show where the cycle is headed; only the
		 * warehouse read is clamped to `nowMs`.
		 */
		cycle: { readonly startMs: number; readonly endMs: number; readonly nowMs: number },
	) => Effect.Effect<DailySpendResponse, WarehouseQueryError>
}

// Every warehouse failure mode collapses to one 502 here: the chart is a
// secondary read on a page whose primary numbers come from Autumn, so the client
// only needs "the series is unavailable", not which layer refused.
const toQueryError = (error: { readonly message: string }) =>
	new WarehouseQueryError({ pipeName: "billingDailySpend", message: error.message })

export class DailySpendService extends Context.Service<DailySpendService, DailySpendServiceApi>()(
	"@maple/api/services/DailySpendService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			const get = Effect.fn("DailySpendService.get")(function* (
				tenant: TenantContext,
				cycle: { readonly startMs: number; readonly endMs: number },
			) {
				const orgId = tenant.orgId
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const params = {
					orgId,
					startTime: formatWarehouseDateTime(cycle.startMs),
					endTime: formatWarehouseDateTime(cycle.endMs),
				}

				// Two queries rather than a UNION: the tables disagree on the bucket
				// column's type and unifying branches has produced 502s before. Both are
				// pre-aggregated reads, so the second round-trip is cheap.
				const signalRows = yield* warehouse
					.compiledQuery(
						tenant,
						CH.compile(Integrations.dailySignalVolumeQuery(), params, {
							rowSchema: Integrations.dailySignalVolumeRowSchema,
						}),
						{ profile: "list", context: "billingDailySignalVolume" },
					)
					.pipe(Effect.mapError(toQueryError))

				const sessionRows = yield* warehouse
					.compiledQuery(
						tenant,
						CH.compile(Integrations.dailySessionCountQuery(), params, {
							rowSchema: Integrations.dailySessionCountRowSchema,
						}),
						{ profile: "list", context: "billingDailySessionCount" },
					)
					.pipe(Effect.mapError(toQueryError))

				const byDay = new Map<string, { logsGB: number; tracesGB: number; metricsGB: number }>()
				for (const row of signalRows) {
					byDay.set(toUtcDateKey(parseWarehouseDateTime(row.day)), {
						logsGB: row.logBytes / BYTES_PER_BILLED_GB,
						tracesGB: row.traceBytes / BYTES_PER_BILLED_GB,
						metricsGB: row.metricBytes / BYTES_PER_BILLED_GB,
					})
				}

				const eventRows = yield* warehouse
					.compiledQuery(
						tenant,
						CH.compile(Integrations.dailyProductEventCountQuery(), params, {
							rowSchema: Integrations.dailyProductEventCountRowSchema,
						}),
						{ profile: "list", context: "billingDailyProductEventCount" },
					)
					.pipe(Effect.mapError(toQueryError))

				const sessionsByDay = new Map<string, number>()
				for (const row of sessionRows) {
					sessionsByDay.set(toUtcDateKey(parseWarehouseDateTime(row.day)), row.sessions)
				}

				const eventsByDay = new Map<string, number>()
				for (const row of eventRows) {
					eventsByDay.set(toUtcDateKey(parseWarehouseDateTime(row.day)), row.events)
				}

				const days: DailyVolume[] = []
				const firstDay = startOfUtcDay(cycle.startMs)
				const lastDay = startOfUtcDay(cycle.endMs)
				for (let dayMs = firstDay; dayMs <= lastDay; dayMs += DAY_MS) {
					const key = toUtcDateKey(dayMs)
					const signals = byDay.get(key)
					days.push(
						new DailyVolume({
							date: key,
							logsGB: signals?.logsGB ?? 0,
							tracesGB: signals?.tracesGB ?? 0,
							metricsGB: signals?.metricsGB ?? 0,
							browserSessions: sessionsByDay.get(key) ?? 0,
							productEvents: eventsByDay.get(key) ?? 0,
						}),
					)
				}

				yield* Effect.annotateCurrentSpan({
					orgId,
					"billing.days": days.length,
				})

				return new DailySpendResponse({
					days,
					cycleStart: cycle.startMs,
					cycleEnd: cycle.endMs,
				})
			})

			return { get } satisfies DailySpendServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
