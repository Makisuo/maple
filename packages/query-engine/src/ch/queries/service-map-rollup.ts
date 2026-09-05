// Service Map — hourly edge rollup
//
// `service_map_edges_hourly` cannot be filled by a materialized view: the
// downstream service of an edge is only known by joining a Client/Producer
// span to its child Server/Consumer span, a cross-span join no MV can express.
// Instead, `ServiceMapRollupService` runs this query once per completed hour
// and ingests the result into `service_map_edges_hourly`.
//
// The query is `serviceMapEdgeJoinQuery` (sharing its join source verbatim with
// the in-progress branch of `serviceDependenciesSQL`) bounded to a single hour.
// Its output columns match the `service_map_edges_hourly` table exactly — a
// test in `service-map.test.ts` asserts the alias set — so rows flow straight
// into `ingest` with no reshaping.

import { Schema, Effect } from "effect"
import type { CompiledQuery, CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { compile } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery } from "@maple-dev/clickhouse-builder"
import { OrgId } from "@maple/domain"
import { ServiceAddressResolutionsHourly, ServiceMapEdgesHourly, Traces } from "../tables"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { serviceMapEdgeJoinQuery } from "./service-map"
import { CHNumber } from "../schema"
import type { QueryBuilderError } from "@maple-dev/clickhouse-builder"

/** One pre-aggregated service-to-service edge bucket — mirrors the columns of
 * the `service_map_edges_hourly` ClickHouse table. */
export interface ServiceMapEdgesHourlyOutput {
	readonly OrgId: OrgId
	readonly Hour: string
	readonly SourceService: string
	readonly TargetService: string
	readonly DeploymentEnv: string
	readonly CallCount: number
	readonly ErrorCount: number
	readonly DurationSumMs: number
	readonly MaxDurationMs: number
	readonly SampledSpanCount: number
	readonly UnsampledSpanCount: number
	readonly SampleRateSum: number
}

const ServiceMapEdgesHourlyOutputSchema: CompiledQueryRowSchema<ServiceMapEdgesHourlyOutput> = Schema.Struct({
	// The tables' OrgId column is branded, so the derived output is too — a
	// declared schema may only narrow, so it has to say the brand as well.
	OrgId,
	Hour: Schema.String,
	SourceService: Schema.String,
	TargetService: Schema.String,
	DeploymentEnv: Schema.String,
	CallCount: CHNumber,
	ErrorCount: CHNumber,
	DurationSumMs: CHNumber,
	MaxDurationMs: CHNumber,
	SampledSpanCount: CHNumber,
	UnsampledSpanCount: CHNumber,
	SampleRateSum: CHNumber,
})

export interface ServiceMapEdgesRollupParams {
	readonly orgId: string
	/** Tinybird datetime string — start of the completed hour (inclusive). */
	readonly hourStart: string
	/** Tinybird datetime string — `hourStart` + 1 hour (exclusive). */
	readonly hourEnd: string
}

/** One already-rolled-up hour bucket — the Unix-second start of the hour. */
export interface ServiceMapEdgesExistingHour {
	readonly hourTs: number
}

/**
 * SQL listing the distinct hours already present in `service_map_edges_hourly`
 * for an org within `[startTime, endTime)`. The rollup uses this to skip hours
 * it has already sealed — re-rolling an hour would double-count it because the
 * target is an AggregatingMergeTree.
 */
export function serviceMapEdgesExistingHoursSQL(params: {
	orgId: string
	startTime: string
	endTime: string
}): Effect.Effect<CompiledQuery<ServiceMapEdgesExistingHour>, QueryBuilderError> {
	// `GROUP BY hourTs` collapses identical hour values across edge rows — the
	// rollup only cares about which hour starts have been sealed, not which
	// edges live in them. Same semantics as SELECT DISTINCT, with the DSL.
	const query = from(ServiceMapEdgesHourly)
		.select(($) => ({ hourTs: CH.toUnixTimestamp($.Hour) }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lt(param.dateTimeSeconds("endTime")),
		])
		.groupBy("hourTs")
		.format("JSON")
		// The seal probe must read the backend the rollup WRITES (`ingest` is
		// Tinybird-pinned). Resolved as a read for a BYO-ClickHouse org, it saw
		// that org's never-written table, judged every hour missing, and re-rolled
		// + re-ingested the same additive rows into Tinybird on every tick.
		.route("ingest")

	return compile(query, {
		orgId: params.orgId,
		startTime: params.startTime,
		endTime: params.endTime,
	})
}

/**
 * SQL listing the distinct hours already present in
 * `service_address_resolutions_hourly` for an org within `[startTime, endTime)`.
 *
 * The companion resolutions write can fail independently of the edges write, so
 * the rollup runs a repair pass over sealed hours. Without this probe that pass
 * was unconditional: it re-ran the resolutions join — a raw-`traces` self-join,
 * the most expensive query in the tick — for every sealed hour on every tick,
 * forever. Asking which hours already resolved costs one cheap sorted-prefix
 * read and skips nearly all of them.
 */
export function serviceMapResolutionsExistingHoursSQL(params: {
	orgId: string
	startTime: string
	endTime: string
}): Effect.Effect<CompiledQuery<ServiceMapEdgesExistingHour>, QueryBuilderError> {
	const query = from(ServiceAddressResolutionsHourly)
		.select(($) => ({ hourTs: CH.toUnixTimestamp($.Hour) }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTimeSeconds("startTime")),
			$.Hour.lt(param.dateTimeSeconds("endTime")),
		])
		.groupBy("hourTs")
		.format("JSON")
		// Same backend-consistency rule as the edges probe: resolutions are
		// written via `ingest`, so "which hours already resolved" must ask the
		// ingest backend, not a BYO read override.
		.route("ingest")

	return compile(query, {
		orgId: params.orgId,
		startTime: params.startTime,
		endTime: params.endTime,
	})
}

/**
 * SQL that computes the service-to-service edges for one completed hour
 * `[hourStart, hourEnd)`. Output rows are ready to `ingest` into
 * `service_map_edges_hourly` unchanged.
 */
export function serviceMapEdgesRollupSQL(
	params: ServiceMapEdgesRollupParams,
): Effect.Effect<CompiledQuery<ServiceMapEdgesHourlyOutput>, QueryBuilderError> {
	const query = serviceMapEdgeJoinQuery({
		rangeStart: CH.toDateTime(param.dateTimeString("hourStart")),
		rangeEnd: CH.toDateTime(param.dateTimeString("hourEnd")),
	}).format("JSON")

	// Scope is derived from both join sources filtering OrgId — see
	// `serviceMapEdgeJoinQuery`, which used to hand it over as an assertion.
	return compile(
		query,
		{
			orgId: params.orgId,
			hourStart: params.hourStart,
			hourEnd: params.hourEnd,
		},
		{ rowSchema: ServiceMapEdgesHourlyOutputSchema },
	)
}

// Resolutions rollup (companion of the edges rollup)
//
// Emits one row per resolved `(SourceService, parent.server.address) →
// child.ServiceName` triple per hour. Used by `serviceExternalEdgesSQL`'s
// LEFT ANTI JOIN to suppress internal-service HTTP overlap from the
// Dependencies tab's "external" view.
//
// Reads raw `traces` (not `service_map_spans`) because the projection MV
// doesn't carry SpanAttributes; we need `server.address` on the parent. Runs
// once per completed hour from `ServiceMapRollupService.processOrg`.

/** One resolved address-to-service mapping bucket — mirrors the columns of
 * `service_address_resolutions_hourly`. */
export interface ServiceAddressResolutionsHourlyOutput {
	readonly OrgId: OrgId
	readonly Hour: string
	readonly SourceService: string
	readonly ParentServerAddress: string
	readonly ResolvedTargetService: string
	readonly DeploymentEnv: string
}

export function serviceMapResolutionsRollupSQL(
	params: ServiceMapEdgesRollupParams,
): Effect.Effect<CompiledQuery<ServiceAddressResolutionsHourlyOutput>, QueryBuilderError> {
	// Parent side: Client/Producer spans, projecting just what the join + outer
	// SELECT needs. The map lookups (`server.address`, `deployment.environment`)
	// happen here so the outer query reads them as plain columns instead of
	// re-evaluating the map per output row.
	const parents = from(Traces)
		.select(($) => ({
			OrgId: $.OrgId,
			Timestamp: $.Timestamp,
			TraceId: $.TraceId,
			SpanId: $.SpanId,
			ServiceName: $.ServiceName,
			ServerAddress: $.SpanAttributes.get("server.address"),
			DeploymentEnv: deploymentEnvExpr($.ResourceAttributes),
		}))
		.where(($) => [
			CH.inList($.SpanKind, ["Client", "Producer"]),
			$.Timestamp.gte(param.dateTimeString("hourStart")),
			$.Timestamp.lt(param.dateTimeString("hourEnd")),
			$.OrgId.eq(param.string("orgId")),
			$.SpanAttributes.get("server.address").neq(""),
		])

	// Child side: Server/Consumer spans. Only the columns needed to JOIN on
	// (TraceId, ParentSpanId) and to project the resolved target ServiceName.
	const children = from(Traces)
		.select(($) => ({
			TraceId: $.TraceId,
			ParentSpanId: $.ParentSpanId,
			ServiceName: $.ServiceName,
		}))
		.where(($) => [
			CH.inList($.SpanKind, ["Server", "Consumer"]),
			$.Timestamp.gte(param.dateTimeString("hourStart")),
			$.Timestamp.lt(param.dateTimeString("hourEnd")),
			$.OrgId.eq(param.string("orgId")),
		])

	const query = fromQuery(parents, "p")
		.innerJoinQuery(children, "c", (p, c) => p.SpanId.eq(c.ParentSpanId).and(p.TraceId.eq(c.TraceId)))
		.select(($) => ({
			OrgId: $.OrgId,
			Hour: CH.toStartOfHour($.Timestamp),
			SourceService: $.ServiceName,
			ParentServerAddress: $.ServerAddress,
			ResolvedTargetService: $.c.ServiceName,
			DeploymentEnv: $.DeploymentEnv,
		}))
		.where(($) => [$.ServiceName.neq($.c.ServiceName)])
		.groupBy(
			"OrgId",
			"Hour",
			"SourceService",
			"ParentServerAddress",
			"ResolvedTargetService",
			"DeploymentEnv",
		)
		.format("JSON")

	// No top-level `OrgId` predicate here on purpose: the scope is derived from
	// the sources, both of which filter `OrgId` themselves.
	return compile(query, {
		orgId: params.orgId,
		hourStart: params.hourStart,
		hourEnd: params.hourEnd,
	})
}
