/**
 * The series behind an alert notification's sparkline and chart.
 *
 * The source is `alert_checks` — the audit row the scheduler already writes on
 * every evaluation — rather than a fresh warehouse aggregation. Three reasons,
 * in order of how much they matter:
 *
 *   1. **It is what the alert saw.** A re-derived series can disagree with the
 *      number printed one line above it in the same message, and a chart that
 *      contradicts its own alert is worse than no chart.
 *   2. It is a `list` scan over rows keyed by the rule, not a re-aggregation
 *      of raw telemetry.
 *   3. It carries `Status` per row, so "was this point breaching" needs no
 *      re-run of the comparator.
 *
 * `alert_checks` is written through `warehouse.ingest` (pinned to managed
 * Tinybird for every org) and `listRuleChecksQuery` declares `.routing("ingest")`,
 * so both halves resolve the same pipeline — this works for BYO-ClickHouse
 * orgs too, and needs no second code path. See
 * `packages/query-engine/src/ch/queries/alert-checks.ts`.
 *
 * Nothing here is allowed to fail a notification. Every entry point returns
 * `null` instead of an error: a chart is an enrichment, and a page that is late
 * because a warehouse read was slow is a worse outcome than a page with no
 * picture on it.
 */
import * as CH from "@maple/query-engine/ch"
import { CHNumber } from "@maple/query-engine/ch"
import type { AlertComparator, AlertRuleId, OrgId } from "@maple/domain/http"
import { alertChartId } from "@maple/db"
import {
	downsample,
	sparkline,
	type BreachSide,
	type ChartPoint,
	type ChartUnit,
} from "@maple/widgets/chart/static-chart"
import { Array as Arr, Cause, Duration, Effect, Option, Order, Result, Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"

/**
 * Points to draw. More than this and a 720px-wide card is drawing sub-pixel
 * segments; fewer and a slow drift stops being visible.
 */
export const MAX_CHART_POINTS = 60

/**
 * Rows to read before downsampling. One row per rule per minute, so this is
 * ~12 hours of an incident — past that the shape matters more than the detail,
 * and {@link downsample} keeps the excursion either way.
 */
const MAX_CHECK_ROWS = 720

/**
 * How long the read gets before the notification goes out without it.
 *
 * Deliberately far below the queue tick: this runs while an alert is waiting
 * to be delivered.
 */
const SERIES_TIMEOUT = Duration.seconds(3)

/** Context before the incident, so a trigger chart shows what "normal" was. */
const LEAD_WINDOWS = 2
/** Floor on the range, so a 1-minute rule does not chart a 2-minute window. */
const MIN_WINDOWS = 6

export interface AlertChartSeries {
	readonly points: ReadonlyArray<ChartPoint>
	readonly sparkline: string
	readonly threshold: number | null
	readonly breachSide: BreachSide
}

/**
 * Which side of the threshold is the bad side.
 *
 * `between`/`not_between`/`eq`/`neq` have no single bad half-plane, so they
 * shade nothing — the rule still draws, and inventing a side would point the
 * reader's eye at the wrong half of the chart.
 */
export const breachSideFor = (comparator: AlertComparator): BreachSide => {
	switch (comparator) {
		case "gt":
		case "gte":
			return "above"
		case "lt":
		case "lte":
			return "below"
		default:
			return "none"
	}
}

/**
 * The window an incident's chart covers: enough lead-in to show the baseline,
 * and growing with the incident so each renotify says more than the last.
 */
export const chartWindow = (options: {
	readonly incidentStartedAtMs: number
	readonly nowMs: number
	readonly windowMinutes: number
}): { readonly fromMs: number; readonly toMs: number } => {
	const windowMs = Math.max(1, options.windowMinutes) * 60_000
	const lead = options.incidentStartedAtMs - windowMs * LEAD_WINDOWS
	const floor = options.nowMs - windowMs * MIN_WINDOWS
	return { fromMs: Math.min(lead, floor), toMs: options.nowMs }
}

/**
 * The two columns a chart reads, decoded rather than coerced.
 *
 * `listRuleChecksQuery` declares no `rowSchema`, so `compiledQuery` hands back
 * undecoded rows. `Number(row.observedValue)` would have compiled and produced
 * `NaN` on any wire-format drift — the exact failure `CHNumber` exists to
 * absorb, since a gateway or read-only cluster that refuses
 * `output_format_json_quote_64bit_integers=0` sends quoted numbers.
 */
const CheckRow = Schema.Struct({
	timestamp: Schema.String,
	observedValue: Schema.NullOr(CHNumber),
})
const decodeCheckRow = Schema.decodeUnknownResult(CheckRow)

/**
 * One audit row as a chart point, or a reason it was dropped.
 *
 * `Array.filterMap` in Effect v4 keeps the successes of a `Result`-returning
 * transform, so the failure side names why a row is not drawn instead of
 * silently vanishing into a boolean filter.
 */
const toChartPoint = (row: unknown): Result.Result<ChartPoint, string> => {
	const decoded = decodeCheckRow(row)
	if (Result.isFailure(decoded)) return Result.fail("undecodable check row")

	const { timestamp, observedValue } = decoded.success
	// A failed evaluation writes an audit row with no observed value. Reading
	// that as 0 would draw a recovery that never happened.
	if (observedValue === null) return Result.fail("no observed value")

	const at = Date.parse(timestamp)
	return Number.isNaN(at) ? Result.fail("unparseable timestamp") : Result.succeed([at, observedValue])
}

/** The query pages newest-first for the checks table; a chart reads left to right. */
const byTimestamp = Order.mapInput(Order.Number, (point: ChartPoint) => point[0])

/** `alert_checks` is DateTime64(3) on the wire: "YYYY-MM-DD HH:MM:SS.mmm" UTC. */
const toWarehouseDateTime = (epochMs: number): string =>
	new Date(epochMs).toISOString().replace("T", " ").replace("Z", "")

/**
 * The one warehouse method this module calls.
 *
 * A narrow port rather than the whole service: it is what lets the tests hand
 * in a stub the compiler actually checks. A `Partial<WarehouseQueryServiceApi>`
 * cast would compile against a signature that had since changed underneath it,
 * which is exactly how a stubbed service stops testing anything.
 */
export interface ChartSeriesWarehouse {
	readonly compiledQuery: WarehouseQueryServiceApi["compiledQuery"]
}

export interface LoadChartSeriesOptions {
	readonly orgId: OrgId
	readonly ruleId: AlertRuleId
	/** `null` for an ungrouped rule — the query then spans every group. */
	readonly groupKey: string | null
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly fromMs: number
	readonly toMs: number
}

/**
 * The rule's observed values over a window, or `null` when there is nothing
 * worth drawing.
 *
 * `null` — never a failure — for a warehouse error, a timeout, or a series so
 * short that a chart of it would be a single dot. Callers treat it as "no
 * chart" and carry on.
 */
export const loadChartSeries = (
	warehouse: ChartSeriesWarehouse,
	tenant: TenantContext,
	options: LoadChartSeriesOptions,
): Effect.Effect<AlertChartSeries | null> =>
	Effect.gen(function* () {
		const compiled = CH.compile(
			CH.listRuleChecksQuery({
				limit: MAX_CHECK_ROWS,
				...(options.groupKey != null && options.groupKey !== ""
					? { groupKey: options.groupKey }
					: undefined),
				since: toWarehouseDateTime(options.fromMs),
				until: toWarehouseDateTime(options.toMs),
			}),
			{
				orgId: options.orgId,
				ruleId: options.ruleId,
				...(options.groupKey != null && options.groupKey !== ""
					? { groupKey: options.groupKey }
					: undefined),
				since: toWarehouseDateTime(options.fromMs),
				until: toWarehouseDateTime(options.toMs),
			},
		)

		const rows = yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "alertChartSeries",
		})

		const breachSide = breachSideFor(options.comparator)
		// The query orders newest-first for the checks table's own pagination;
		// a chart reads left to right.
		const points = Arr.sort(Arr.filterMap(rows, toChartPoint), byTimestamp)

		// Two points is a line segment, not a trend, and it makes the message
		// look instrumented without informing anyone.
		if (points.length < 3) return null

		const drawn = downsample(points, MAX_CHART_POINTS, breachSide)
		return {
			points: drawn,
			sparkline: sparkline(drawn.map((p) => p[1])),
			threshold: options.threshold,
			breachSide,
		}
	}).pipe(
		Effect.timeoutOption(SERIES_TIMEOUT),
		Effect.map(Option.getOrNull),
		// An enrichment must never take a page down with it: a bad rowSchema, a
		// warehouse outage and a decode failure all land here as "no chart".
		Effect.catchCause((cause) =>
			Effect.logWarning("Alert chart series unavailable; notifying without one").pipe(
				Effect.annotateLogs({
					orgId: options.orgId,
					"maple.alert.rule_id": options.ruleId,
					cause: Cause.pretty(cause),
				}),
				Effect.as(null),
			),
		),
	)

/**
 * The public URL of a notification's chart image.
 *
 * Built at queue time alongside the series, not at delivery: everything it
 * pins — the window, the title, the threshold — is what the alert observed at
 * this moment, and recomputing it per destination or per retry would let two
 * deliveries of the same notification disagree about their own picture.
 *
 * `null` when the deployment has no share HMAC key configured. Sharing is
 * optional infrastructure and an unsigned chart URL is not a thing this repo
 * will mint, so the notification simply goes out with its sparkline only.
 */
export const chartImageUrl = (options: {
	readonly appBaseUrl: string
	readonly hmacKey: string | null
	readonly orgId: OrgId
	readonly ruleId: AlertRuleId
	readonly groupKey: string | null
	readonly fromMs: number
	readonly toMs: number
	readonly title: string
	readonly unit: ChartUnit
	readonly threshold: number | null
	readonly breachSide: BreachSide
}): string | null => {
	if (options.hmacKey === null) return null
	const id = alertChartId(
		{
			orgId: options.orgId,
			ruleId: options.ruleId,
			groupKey: options.groupKey,
			fromMs: options.fromMs,
			toMs: options.toMs,
			// Bounded before signing: the id travels in a URL, and a rule with a
			// paragraph for a name must not be able to grow it without limit.
			title: options.title.slice(0, 120),
			unit: options.unit,
			threshold: options.threshold,
			breachSide: options.breachSide,
		},
		options.hmacKey,
	)
	return new URL(`/alerts/chart/${encodeURIComponent(id)}.png`, options.appBaseUrl).toString()
}
