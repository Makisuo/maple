// Warehouse reads behind the setup audit (`GET /v2/instrumentation/audit`).
//
// Two rules hold throughout this file:
//
//  1. **Rates are computed app-side.** Every query returns raw counts — a numerator and its
//     denominator — never a division. The builder's arithmetic follows SQL precedence rather than
//     call order, and mixing Float64 quotients into otherwise-integer result sets is how UNION type
//     unification breaks; returning counts sidesteps both, and `nan`/`ifNotFinite` handling with it.
//  2. **Pre-aggregated MVs over raw scans.** Only `auditLogCorrelationQuery` touches a raw table, and
//     it reads three narrow columns over a hard-clamped window. Attribute *values* are never scanned
//     org-wide: a `Map` re-read at that scale is what previously exhausted query memory.
//
// Every builder filters `OrgId` (enforced at execution) and every count/sum/uniq column needs
// `CHNumber` in the caller's `rowSchema` — ClickHouse serializes 64-bit integers as JSON strings, so
// a BYO-ClickHouse org otherwise fails to decode.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import {
	from,
	param,
	unsafeCompiledQuery,
	type CompiledQuery,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { escapeClickHouseString } from "@maple-dev/clickhouse-builder/sql"
import { Schema } from "effect"
import {
	AttributeKeysHourly,
	AttributeValuesHourly,
	Logs,
	LogsAggregatesHourly,
	ServiceMapDbEdgesHourly,
	ServiceOverviewHourly,
	TracesAggregatesHourly,
} from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { hourFloor } from "@maple/query-engine/ch/query-helpers"

/** Snaps a window bound to its hour floor so any overlapping hour of an hourly MV contributes. */

/** Span kinds and status codes Maple stores; anything else is an SDK emitting the wrong casing. */
const VALID_SPAN_KINDS = ["Server", "Client", "Producer", "Consumer", "Internal", ""]
const VALID_STATUS_CODES = ["Ok", "Error", "Unset", ""]

const quoteList = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ")

// ---------------------------------------------------------------------------
// A2 — attribute key inventory (all scopes, one scan)
// ---------------------------------------------------------------------------

export interface AuditAttributeKeyRow {
	readonly scope: string
	readonly attributeKey: string
	readonly usageCount: number
}

export const auditAttributeKeyInventoryRowSchema = Schema.Struct({
	scope: Schema.String,
	attributeKey: Schema.String,
	usageCount: CHNumber,
})

/**
 * Every attribute key the org emitted, across all four scopes, in one read. `attribute_keys_hourly`
 * is sorted `(OrgId, AttributeScope, Hour, AttributeKey)`, so restricting the scope set is a prefix
 * read rather than a scan — this replaces what would otherwise be four separate queries.
 *
 * Powers the semconv-rename, naming, reserved-namespace, PII-key-name and resource-coverage checks,
 * all of which are pure functions over this one result.
 */
export function auditAttributeKeyInventoryQuery(opts: { limit?: number } = {}) {
	return from(AttributeKeysHourly)
		.select(($) => ({
			scope: $.AttributeScope,
			attributeKey: $.AttributeKey,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			CH.inList($.AttributeScope, ["span", "resource", "log", "metric"]),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
		])
		.groupBy("scope", "attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 2000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A3 — per-service span shape
// ---------------------------------------------------------------------------

export interface AuditSpanShapeRow {
	readonly serviceName: string
	readonly weightedSpanCount: number
	readonly weightedErrorCount: number
	readonly serverCount: number
	readonly consumerCount: number
	readonly clientCount: number
	readonly producerCount: number
	readonly noEnvCount: number
	readonly spanNameCount: number
	readonly badStatusCodes: ReadonlyArray<string>
	readonly badSpanKinds: ReadonlyArray<string>
}

export const auditSpanShapeRowSchema = Schema.Struct({
	serviceName: Schema.String,
	weightedSpanCount: CHNumber,
	weightedErrorCount: CHNumber,
	serverCount: CHNumber,
	consumerCount: CHNumber,
	clientCount: CHNumber,
	producerCount: CHNumber,
	noEnvCount: CHNumber,
	spanNameCount: CHNumber,
	badStatusCodes: Schema.Array(Schema.String),
	badSpanKinds: Schema.Array(Schema.String),
})

/**
 * Per-service span shape from `traces_aggregates_hourly`, which already carries every dimension the
 * audit needs — kind, status, environment and span name — so no raw span read is required.
 *
 * Run this under the `list` profile, not `discovery`: an org whose span names carry IDs (exactly what
 * the span-name cardinality check detects) inflates this MV enough to exceed a 5s budget.
 */
export function auditSpanShapeByServiceQuery(opts: { limit?: number } = {}) {
	return from(TracesAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			weightedSpanCount: CH.sum($.WeightedCount),
			weightedErrorCount: CH.sum($.WeightedErrorCount),
			serverCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Server")),
			consumerCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Consumer")),
			clientCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Client")),
			producerCount: CH.sumIf($.WeightedCount, $.SpanKind.eq("Producer")),
			noEnvCount: CH.sumIf($.WeightedCount, $.DeploymentEnv.eq("")),
			spanNameCount: CH.uniq($.SpanName),
			// Bounded samples of the offending literals so the finding can name them.
			badStatusCodes: CH.rawExpr<ReadonlyArray<string>>(
				`groupUniqArrayIf(5)(StatusCode, StatusCode NOT IN (${quoteList(VALID_STATUS_CODES)}))`,
			),
			badSpanKinds: CH.rawExpr<ReadonlyArray<string>>(
				`groupUniqArrayIf(5)(SpanKind, SpanKind NOT IN (${quoteList(VALID_SPAN_KINDS)}))`,
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["weightedSpanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A4 — per-service sampling weight and commit tagging
// ---------------------------------------------------------------------------

export interface AuditSamplingRow {
	readonly serviceName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly commitTaggedSpanCount: number
}

export const auditSamplingRowSchema = Schema.Struct({
	serviceName: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	commitTaggedSpanCount: CHNumber,
})

/**
 * `service_overview_hourly` is the only rollup carrying both the raw `SpanCount` and the
 * sampling-extrapolated `EstimatedSpanCount`, so it is the only cheap source for a service's
 * effective sample weight — the input to "these services disagree about how much they sample".
 *
 * `CommitSha` is pre-extracted from `deployment.commit_sha`, NOT `vcs.ref.head.revision`. It is a
 * per-service proxy for release tagging; the authoritative resource-key coverage comes from A2.
 */
export function auditSamplingByServiceQuery(opts: { limit?: number } = {}) {
	return from(ServiceOverviewHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			spanCount: CH.sum($.SpanCount),
			estimatedSpanCount: CH.sum($.EstimatedSpanCount),
			commitTaggedSpanCount: CH.sumIf($.SpanCount, $.CommitSha.neq("")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["spanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A5 — per-service log severity distribution
// ---------------------------------------------------------------------------

export interface AuditLogSeverityRow {
	readonly serviceName: string
	readonly severityText: string
	readonly logCount: number
}

export const auditLogSeverityRowSchema = Schema.Struct({
	serviceName: Schema.String,
	severityText: Schema.String,
	logCount: CHNumber,
})

/**
 * Severity literals per service. Feeds the non-standard-severity check directly, and supplies the
 * "this service logs errors" half of the heuristic that catches exceptions swallowed as `Unset`.
 */
export function auditLogSeverityByServiceQuery(opts: { limit?: number } = {}) {
	return from(LogsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			severityText: $.SeverityText,
			logCount: CH.sum($.Count),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
		])
		.groupBy("serviceName", "severityText")
		.orderBy(["logCount", "desc"])
		.limit(opts.limit ?? 2000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A6 — metric label cardinality
// ---------------------------------------------------------------------------

export interface AuditMetricLabelRow {
	readonly attributeKey: string
	readonly valueCardinality: number
	readonly usageCount: number
}

export const auditMetricLabelRowSchema = Schema.Struct({
	attributeKey: Schema.String,
	valueCardinality: CHNumber,
	usageCount: CHNumber,
})

/**
 * Distinct value counts per metric label. `uniq` (HyperLogLog) rather than `uniqExact` — the check
 * only cares whether cardinality is in the thousands, and an approximate count is bounded-memory by
 * construction, which matters precisely on the exploded-label orgs this detects.
 *
 * Caveat the check text must carry: the metric attribute rollups materialize from `metrics_sum`
 * only, so this covers counters, not gauges or histograms.
 */
export function auditMetricLabelCardinalityQuery(opts: { limit?: number } = {}) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			valueCardinality: CH.uniq($.AttributeValue),
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.AttributeScope.eq("metric"),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
		])
		.groupBy("attributeKey")
		.orderBy(["valueCardinality", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A7 — peer / dependency identifier values
// ---------------------------------------------------------------------------

/** Keys whose *values* name a dependency, where inconsistent spelling fragments a service-map node. */
export const AUDIT_PEER_KEYS = [
	"peer.service",
	"db.system",
	"db.system.name",
	"messaging.system",
	"rpc.system",
] as const

export interface AuditPeerValueRow {
	readonly attributeKey: string
	readonly attributeValue: string
	readonly usageCount: number
}

export const auditPeerValueRowSchema = Schema.Struct({
	attributeKey: Schema.String,
	attributeValue: Schema.String,
	usageCount: CHNumber,
})

/**
 * The distinct values behind each dependency-naming key. Case-collision detection (`tinybird` vs
 * `Tinybird`) happens app-side; the query just enumerates. Restricted to five keys, so this is a
 * bounded read of `attribute_values_hourly` rather than an attribute-value scan.
 */
export function auditPeerValueInventoryQuery(opts: { limit?: number } = {}) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.AttributeScope.eq("span"),
			CH.inList($.AttributeKey, [...AUDIT_PEER_KEYS]),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeValue.neq(""),
		])
		.groupBy("attributeKey", "attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// A8 — database edge identity
// ---------------------------------------------------------------------------

export interface AuditDbEdgeRow {
	readonly serviceName: string
	readonly dbSystem: string
	readonly callCount: number
	readonly unknownNamespaceCallCount: number
}

export const auditDbEdgeRowSchema = Schema.Struct({
	serviceName: Schema.String,
	dbSystem: Schema.String,
	callCount: CHNumber,
	unknownNamespaceCallCount: CHNumber,
})

/**
 * Database map edges whose namespace is empty — the node exists but has no identity, so every
 * database a service talks to collapses into one anonymous box.
 */
export function auditDbEdgeIdentityQuery(opts: { limit?: number } = {}) {
	return from(ServiceMapDbEdgesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			dbSystem: $.DbSystem,
			callCount: CH.sum($.CallCount),
			unknownNamespaceCallCount: CH.sumIf($.CallCount, $.DbNamespace.eq("")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			$.DbSystem.neq(""),
		])
		.groupBy("serviceName", "dbSystem")
		.orderBy(["callCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// B1 — log ↔ trace correlation (bounded raw read)
// ---------------------------------------------------------------------------

/** Upper bound on the raw `logs` window, applied in the builder — callers cannot widen it. */
export const AUDIT_LOG_CORRELATION_MAX_HOURS = 6

export interface AuditLogCorrelationRow {
	readonly serviceName: string
	readonly logCount: number
	readonly uncorrelatedCount: number
	readonly errorLogCount: number
	readonly uncorrelatedErrorCount: number
}

export const auditLogCorrelationRowSchema = Schema.Struct({
	serviceName: Schema.String,
	logCount: CHNumber,
	uncorrelatedCount: CHNumber,
	errorLogCount: CHNumber,
	uncorrelatedErrorCount: CHNumber,
})

/**
 * How many of each service's logs carry no `TraceId` — the signal for a log bridge that sits off the
 * path the application actually logs through, which silently costs every trace↔log jump.
 *
 * The only raw-table read in the audit, and deliberately narrow: three columns, never `Body` and
 * never a `Map`, filtered on both `TimestampTime` (day-partition pruning) and `Timestamp`. Error-level
 * logs are counted separately because uncorrelated startup and cron logs are normal, whereas an
 * uncorrelated error log is a debugging dead end.
 */
export function auditLogCorrelationQuery() {
	const isErrorSeverity = CH.rawCond("upper(SeverityText) IN ('ERROR', 'FATAL')")
	return from(Logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			logCount: CH.count(),
			uncorrelatedCount: CH.countIf($.TraceId.eq("")),
			errorLogCount: CH.countIf(isErrorSeverity),
			uncorrelatedErrorCount: CH.countIf($.TraceId.eq("").and(isErrorSeverity)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["logCount", "desc"])
		.limit(500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// B2 / B3 — trace completeness
//
// Both are raw-SQL builders because the DSL has no join surface; they mirror
// `serviceMapEdgeJoinSQL` in service-map.ts, which is the same join over the same two tables and the
// same window size that `ServiceMapRollupService` already runs once per org per hour in production.
// That is the cost precedent these rely on — do not widen the window, and never put them on a
// dashboard-polled path.
//
// What they can and cannot say: the warehouse only ever sees what arrived, so neither query can
// detect ingest loss. They are *internal consistency* checks — spans that reference a parent nobody
// sent, and traces observed with no root. Word every finding that way.
// ---------------------------------------------------------------------------

/**
 * Deterministic 1-in-N trace sampling, applied to **both** sides of a join so every span of a kept
 * trace survives on both — per-trace join correctness is exact, only the rate's variance widens.
 *
 * Without it a high-volume org builds a multi-gigabyte hash table on the parent side. Pick N from the
 * org's own span volume rather than a fixed value: {@link auditTraceSampleModulus}.
 */
const modulusFilter = (modulus: number) => (modulus > 1 ? `AND cityHash64(TraceId) % ${modulus} = 0` : "")

/** Clamps a caller-supplied modulus into a sane power-of-two-ish range. */
const normalizeModulus = (modulus: number | undefined) =>
	Math.max(1, Math.min(1024, Math.round(modulus ?? 1)))

/**
 * Trace-sampling divisor for the completeness joins, chosen from the org's observed span volume over
 * the audit's lookback window. Keeps the join's hash side in the low hundreds of megabytes at any
 * scale; small orgs pay nothing.
 */
export function auditTraceSampleModulus(spanCountOverLookback: number): number {
	if (spanCountOverLookback < 1_000_000) return 1
	if (spanCountOverLookback < 20_000_000) return 4
	return 16
}

/** `th:<hex>` in the W3C TraceState marks a consistent-probability sampling decision. */
const SAMPLED_TRACE_STATE = "match(c.TraceState, 'th:[0-9a-f]+')"

export interface AuditOrphanSpanRow {
	readonly serviceName: string
	readonly childCount: number
	readonly orphanCount: number
	readonly sampledOrphanCount: number
	readonly sampleTraceIds: ReadonlyArray<string>
}

export const auditOrphanSpanRowSchema: CompiledQueryRowSchema<AuditOrphanSpanRow> = Schema.Struct({
	serviceName: Schema.String,
	childCount: CHNumber,
	orphanCount: CHNumber,
	sampledOrphanCount: CHNumber,
	sampleTraceIds: Schema.Array(Schema.String),
})

export interface AuditTraceWindowParams {
	readonly orgId: string
	/** Children considered, half-open: `[childStart, childEnd)`. */
	readonly childStart: string
	readonly childEnd: string
	/** Parents scanned from here — earlier than `childStart`, to cover long-running parents. */
	readonly parentStart: string
	readonly traceSampleModulus?: number
}

/**
 * Entry-point spans (Server/Consumer) whose parent span never arrived.
 *
 * `service_map_children` holds Server/Consumer spans that declare a parent; `service_map_spans` holds
 * Client/Producer/Server/Consumer spans. A LEFT JOIN — not ANTI — so one pass yields both the
 * denominator and the numerator; with `join_use_nulls = 0` a miss surfaces as an empty `p.SpanId`.
 *
 * Two causes produce an orphan, and both are worth fixing: the caller's span genuinely never arrived
 * (dropped export or broken context propagation), or the caller modeled its outbound call as an
 * `Internal` span, which `service_map_spans` excludes — and which is separately why that call draws
 * no edge on the service map.
 *
 * `sampledOrphanCount` splits out orphans inside sampling-marked traces, where a dropped parent is
 * expected rather than a defect; the caller reports those as a sampling observation instead.
 */
export function auditOrphanSpansSQL(params: AuditTraceWindowParams): CompiledQuery<AuditOrphanSpanRow> {
	const esc = escapeClickHouseString
	const org = esc(params.orgId)
	const sampled = modulusFilter(normalizeModulus(params.traceSampleModulus))
	const childStart = `toDateTime('${esc(params.childStart)}')`
	const childEnd = `toDateTime('${esc(params.childEnd)}')`
	const parentStart = `toDateTime('${esc(params.parentStart)}')`

	const sql = `SELECT
      c.ServiceName AS serviceName,
      count() AS childCount,
      countIf(p.SpanId = '') AS orphanCount,
      countIf(p.SpanId = '' AND ${SAMPLED_TRACE_STATE}) AS sampledOrphanCount,
      groupUniqArrayIf(3)(c.TraceId, p.SpanId = '') AS sampleTraceIds
    FROM (
      SELECT TraceId, ParentSpanId, ServiceName, TraceState
      FROM service_map_children
      WHERE OrgId = '${org}'
        AND Timestamp >= ${childStart}
        AND Timestamp < ${childEnd}
        AND ParentSpanId != ''
        ${sampled}
    ) AS c
    LEFT JOIN (
      SELECT TraceId, SpanId
      FROM service_map_spans
      WHERE OrgId = '${org}'
        AND Timestamp >= ${parentStart}
        AND Timestamp < ${childEnd}
        ${sampled}
    ) AS p
    ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId
    GROUP BY serviceName
    ORDER BY orphanCount DESC
    LIMIT 200
    FORMAT JSON`

	return unsafeCompiledQuery({ sql, tenantScope: "org", rowSchema: auditOrphanSpanRowSchema })
}

export interface AuditRootlessTraceRow {
	readonly entryService: string
	readonly traceCount: number
	readonly rootlessCount: number
	readonly sampledRootlessCount: number
}

export const auditRootlessTraceRowSchema: CompiledQueryRowSchema<AuditRootlessTraceRow> = Schema.Struct({
	entryService: Schema.String,
	traceCount: CHNumber,
	rootlessCount: CHNumber,
	sampledRootlessCount: CHNumber,
})

/**
 * Traces observed with no root span anywhere. `trace_list_mv` is populated strictly from
 * `ParentSpanId = ''` spans of every kind, so it *is* the root-span index — the join is a lookup, not
 * a scan.
 *
 * Attribution uses `argMin(ServiceName, Timestamp)`: the earliest service Maple actually observed.
 * When the true root belongs to an uninstrumented upstream, that names the first instrumented hop,
 * which is exactly where the fix goes. The systemic case — an edge proxy or gateway injecting
 * `traceparent` without exporting spans — shows up as a near-total, uniform rootless rate, and the
 * caller collapses it into one finding rather than one per service.
 */
export function auditRootlessTracesSQL(params: AuditTraceWindowParams): CompiledQuery<AuditRootlessTraceRow> {
	const esc = escapeClickHouseString
	const org = esc(params.orgId)
	const sampled = modulusFilter(normalizeModulus(params.traceSampleModulus))
	const childStart = `toDateTime('${esc(params.childStart)}')`
	const childEnd = `toDateTime('${esc(params.childEnd)}')`
	const parentStart = `toDateTime('${esc(params.parentStart)}')`

	const sql = `SELECT
      t.entryService AS entryService,
      count() AS traceCount,
      countIf(r.TraceId = '') AS rootlessCount,
      countIf(r.TraceId = '' AND t.isSampled = 1) AS sampledRootlessCount
    FROM (
      SELECT
        TraceId,
        argMin(ServiceName, Timestamp) AS entryService,
        max(match(TraceState, 'th:[0-9a-f]+')) AS isSampled
      FROM service_map_children
      WHERE OrgId = '${org}'
        AND Timestamp >= ${childStart}
        AND Timestamp < ${childEnd}
        ${sampled}
      GROUP BY TraceId
    ) AS t
    LEFT JOIN (
      SELECT TraceId
      FROM trace_list_mv
      WHERE OrgId = '${org}'
        AND Timestamp >= ${parentStart}
        AND Timestamp < ${childEnd}
        ${sampled}
      GROUP BY TraceId
    ) AS r
    ON t.TraceId = r.TraceId
    GROUP BY entryService
    ORDER BY rootlessCount DESC
    LIMIT 200
    FORMAT JSON`

	return unsafeCompiledQuery({ sql, tenantScope: "org", rowSchema: auditRootlessTraceRowSchema })
}
