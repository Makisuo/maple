import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import type { V2WidgetSummaryService } from "@maple/domain/http/v2"
import {
	MapleApiV2,
	timestamp,
	WIDGET_SUMMARY_ISSUE_LIMIT,
	WIDGET_SUMMARY_ISSUES_WINDOW_SECONDS,
	WIDGET_SUMMARY_SCHEMA_VERSION,
	WIDGET_SUMMARY_SERIES_LIMIT,
	WIDGET_SUMMARY_SERVICE_LIMIT,
	WIDGET_SUMMARY_THROUGHPUT_WINDOW_SECONDS,
} from "@maple/domain/http/v2"
import {
	CH,
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
	QueryEngineExecuteRequest,
} from "@maple/query-engine"
import { computeBucketSeconds } from "@maple/query-engine/runtime"
import { Effect, Schema } from "effect"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { serviceCatalogRowSchema, toService, type ServiceBaselines } from "./telemetry.http"

/**
 * The one read behind the iOS Home Screen widgets.
 *
 * Composed here rather than by the client, because the client is a WidgetKit
 * timeline provider with seconds of wall clock: what used to be four requests
 * (`/v2/error_issues`, `/v2/services`, and two `/v2/traces/timeseries`) is one.
 * See the contract in `packages/domain/src/http/v2/widget-summary.ts` for why
 * this is its own resource family and not a shaped view over those.
 *
 * The windows are built here from constants, never from the caller — which is
 * also why this route validates none of them. `parseWindow` and
 * `validateTimeseriesBucket` exist to turn a *caller's* bounds into a 400, and
 * wiring them in would put three unreachable telemetry errors into a public
 * contract whose only consumer is a widget that cannot act on any of them.
 *
 * The two halves are not independent the way the app's old publisher made them:
 * one response means an issues failure also costs the caller its throughput.
 * That is the accepted trade, because the caller renders its last good snapshot
 * on any failure — a widget never shows an error, it shows an honest age.
 * The *series* are the exception and degrade in place: a sparkline is a nicety
 * next to the scalars it sits under, so a timeseries read that fails leaves
 * `bucket_seconds` null and the points empty rather than costing the summary.
 */

/**
 * Latency baselines are a service-health signal the widgets do not render, and
 * loading them is a second warehouse round-trip per request. `toService` omits
 * the baseline fields entirely for a service it has no baseline for, which is
 * exactly the shape wanted here.
 */
const NO_BASELINES: ServiceBaselines = new Map()

const decodeExecuteRequest = Schema.decodeUnknownEffect(QueryEngineExecuteRequest)

/**
 * One group's buckets, oldest first, holes filled with zero.
 *
 * Counts, not rates: the client divides by `bucket_seconds` so that the
 * sparkline and the headline provably carry the same unit, and so a bucket
 * length it cannot make sense of drops the series instead of drawing counts as
 * if they were rates.
 */
const bucketCounts = (
	data: ReadonlyArray<{ readonly bucket: string; readonly series: Readonly<Record<string, number>> }>,
	group: string | undefined,
): ReadonlyArray<number> =>
	data.map((point) => {
		// An ungrouped series carries exactly one key, whose name the engine
		// picks; naming it here would couple this file to that choice.
		const value = group === undefined ? Object.values(point.series)[0] : point.series[group]
		return Number(value ?? 0)
	})

export const HttpV2WidgetSummaryLive = HttpApiBuilder.group(MapleApiV2, "widgetSummary", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* ErrorIssueReadModelsService
		const warehouse = yield* WarehouseQueryService
		const queryEngine = yield* QueryEngineService

		return handlers.handle("retrieve", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				// One clock for the whole response. Two `Date.now()` calls would let
				// the issues window and the throughput window describe times that do
				// not line up, which is the sort of skew a widget renders as a
				// contradiction between its two halves.
				const nowMs = Date.now()
				const issuesStartMs = nowMs - WIDGET_SUMMARY_ISSUES_WINDOW_SECONDS * 1000
				const throughputStartMs = nowMs - WIDGET_SUMMARY_THROUGHPUT_WINDOW_SECONDS * 1000

				const issuesPage = yield* readModels.listIssues(tenant.orgId, {
					actionable: true,
					sort: "severity",
					startTime: new Date(issuesStartMs).toISOString(),
					endTime: new Date(nowMs).toISOString(),
					limit: WIDGET_SUMMARY_ISSUE_LIMIT,
				})

				// Whole seconds: the catalog reads the hourly rollups, whose
				// Timestamp is a plain `DateTime` and rejects a fractional literal.
				const compiled = CH.compile(
					CH.serviceCatalogQuery({ limit: WIDGET_SUMMARY_SERVICE_LIMIT }),
					{
						orgId: tenant.orgId,
						startTime: formatWarehouseDateTime(throughputStartMs),
						endTime: formatWarehouseDateTime(nowMs),
					},
					{ rowSchema: serviceCatalogRowSchema },
				)
				const serviceRows = yield* warehouse.compiledQuery(tenant, compiled, {
					profile: "aggregation",
					context: "v2WidgetSummaryServices",
				})

				const bucketSeconds = computeBucketSeconds(throughputStartMs, nowMs)
				const timeseries = (groupByService: boolean) =>
					decodeExecuteRequest({
						// Millisecond precision: the series read the raw trace table,
						// not the rollups the catalog above reads.
						startTime: formatWarehouseDateTimeMs(throughputStartMs),
						endTime: formatWarehouseDateTimeMs(nowMs),
						query: {
							kind: "timeseries",
							source: "traces",
							metric: "count",
							bucketSeconds,
							...(groupByService
								? { groupBy: ["service"], seriesLimit: WIDGET_SUMMARY_SERIES_LIMIT }
								: undefined),
						},
					}).pipe(
						Effect.flatMap((request) => queryEngine.execute(tenant, request)),
						Effect.map((response) =>
							response.result.kind === "timeseries" ? response.result.data : [],
						),
						Effect.catchCause((cause) =>
							Effect.as(Effect.logWarning("widget summary timeseries read failed", cause), []),
						),
					)

				const [grouped, total] = yield* Effect.all([timeseries(true), timeseries(false)], {
					concurrency: 2,
				})
				// Null rather than the computed length when nothing came back: the
				// client divides its points by this, and a bucket length attached to
				// no points invites it to draw a unit it was never given.
				const seriesBucketSeconds = grouped.length > 0 || total.length > 0 ? bucketSeconds : null

				const rangeSeconds = WIDGET_SUMMARY_THROUGHPUT_WINDOW_SECONDS
				const services: ReadonlyArray<V2WidgetSummaryService> = serviceRows.map((row) => {
					const service = toService(row, rangeSeconds, NO_BASELINES)
					return {
						name: service.name,
						throughput_per_second: service.throughput,
						error_rate: service.error_rate,
						p95_latency_ms: service.p95_latency_ms,
						points: bucketCounts(grouped, row.serviceName),
					}
				})

				return {
					object: "widget_summary" as const,
					schema_version: WIDGET_SUMMARY_SCHEMA_VERSION,
					generated_at: timestamp(new Date(nowMs).toISOString()),
					organization_id: tenant.orgId,
					issues: {
						window_seconds: WIDGET_SUMMARY_ISSUES_WINDOW_SECONDS,
						has_more: issuesPage.nextCursor !== undefined,
						data: issuesPage.issues.map((issue) => ({
							id: issue.id,
							exception_type: issue.exceptionType,
							error_label: issue.errorLabel,
							exception_message: issue.exceptionMessage,
							service_name: issue.serviceName,
							severity: issue.severity,
							occurrence_count: issue.occurrenceCount,
							last_seen_at: issue.lastSeenAt,
							is_regressed: issue.regressionCount > 0,
							has_open_incident: issue.hasOpenIncident,
						})),
					},
					throughput: {
						window_seconds: WIDGET_SUMMARY_THROUGHPUT_WINDOW_SECONDS,
						bucket_seconds: seriesBucketSeconds,
						services,
						total_points: bucketCounts(total, undefined),
					},
				}
			}),
		)
	}),
)
