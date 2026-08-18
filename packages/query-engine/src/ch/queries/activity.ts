// Active-org discovery queries
//
// Per-org cron loops (error-issue detector, anomaly detector) historically
// fanned out across EVERY org that ever held an ingest key, re-scanning the
// warehouse for hundreds of idle orgs every tick. These queries let a tick
// first ask "which orgs produced telemetry recently?" and skip the rest.
//
// They are deliberately CROSS-ORG: there is no `OrgId.eq(...)` predicate, so a
// single cheap scan of the small recent window / hourly MVs enumerates active
// orgs at once. Each declares `.crossOrg()`, which is what lets them through
// `WarehouseQueryService.crossOrgQuery` — the ordinary read path rejects a
// query with no top-level tenant predicate. `.routing("ingest")` routes them to
// the managed Tinybird workspace (where all managed orgs' data lives);
// BYO-ClickHouse orgs are invisible here and are gated separately by the caller
// (always processed).
//
// The discovery window must be a SUPERSET of the per-org scan window so no
// active org is missed for the tick.

import { from, param } from "@maple-dev/clickhouse-builder"
import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { ErrorEventsByTime, LogsAggregatesHourly, TracesAggregatesHourly } from "../tables"

export const ActiveOrgsOutputSchema = Schema.Struct({ orgId: OrgId })
export type ActiveOrgsOutput = Schema.Schema.Type<typeof ActiveOrgsOutputSchema>

/** Orgs with any error events since `startTime` (gates the error-issue detector). */
export function activeOrgsByErrorEventsQuery() {
	return from(ErrorEventsByTime)
		.select(($) => ({ orgId: $.OrgId }))
		.where(($) => [$.Timestamp.gte(param.dateTime("startTime"))])
		.groupBy("orgId")
		.format("JSON")
		.routing("ingest")
		.crossOrg()
}

/** Orgs with any span aggregates since `startTime` (gates the anomaly detector). */
export function activeOrgsByTracesQuery() {
	return from(TracesAggregatesHourly)
		.select(($) => ({ orgId: $.OrgId }))
		.where(($) => [$.Hour.gte(param.dateTime("startTime"))])
		.groupBy("orgId")
		.format("JSON")
		.routing("ingest")
		.crossOrg()
}

/** Orgs with any log aggregates since `startTime` (gates the anomaly detector). */
export function activeOrgsByLogsQuery() {
	return from(LogsAggregatesHourly)
		.select(($) => ({ orgId: $.OrgId }))
		.where(($) => [$.Hour.gte(param.dateTime("startTime"))])
		.groupBy("orgId")
		.format("JSON")
		.routing("ingest")
		.crossOrg()
}
