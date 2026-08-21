// Coalescing expressions for OpenTelemetry attribute renames.
//
// Semconv renames keys; instrumentation in the wild does not update in lockstep.
// Anything that reads a renamed key has to accept BOTH spellings, or it silently
// loses the attribute for whichever half of the fleet uses the other one — an
// empty environment column, a service-map node collapsed onto the wrong label.
// Each expression here is used in two places that MUST agree byte-for-byte:
// the materialized view that pre-extracts the value at write time, and the
// query-engine builder that reads it off the raw table.
//
// Renames whose keys are only ever surfaced (never keyed on) live in the
// recommendation dictionary in `../recommendations.ts` instead.

import type { Expr } from "@maple-dev/clickhouse-builder/expr"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"

/**
 * The shape every caller shares: a query builder's `$.ResourceAttributes` /
 * `$.SpanAttributes` column accessor, and the bare-column stand-in below that
 * the generated SQL text is compiled from.
 */
interface MapColumnLike {
	get(key: string): Expr<string>
}

const mapColumn = (name: string): MapColumnLike => {
	const column = CH.dynamicColumn<Record<string, string>>(name)
	return { get: (key) => CH.mapGet(column, key) }
}

/**
 * Canonical deployment-environment expression, shared by the materialized views
 * that pre-extract `DeploymentEnv` at write time and by the runtime queries that
 * read the environment straight off `ResourceAttributes`.
 *
 * OpenTelemetry renamed the resource attribute: `deployment.environment.name` is
 * the stable key, and the registry marks plain `deployment.environment` as
 * deprecated ("Replaced by `deployment.environment.name`"). Both spellings are in
 * the wild — Maple's own SDKs and the ingest gateway dual-emit, an OTel SDK new
 * enough to have adopted the rename sends only `.name`, and everything older
 * sends only the legacy key. Reading either one alone drops an environment for
 * half the fleet, which is what this expression exists to prevent.
 *
 * Map lookups return `''` for a missing key, so the `nullIf` is what turns
 * "absent" into a `coalesce` fallback. The last argument is non-nullable, so the
 * whole expression stays `String` — it can feed a non-Nullable MV column.
 */
export function deploymentEnvExpr(resourceAttributes: MapColumnLike): Expr<string> {
	return CH.coalesce(
		CH.nullIf(resourceAttributes.get("deployment.environment.name"), ""),
		resourceAttributes.get("deployment.environment"),
	)
}

/**
 * SQL text required by Tinybird materialization and ClickHouse migration DDL.
 * Compiles byte-identically to {@link deploymentEnvExpr} applied to the raw
 * `ResourceAttributes` column, so an MV's pre-extracted `DeploymentEnv` and the
 * read side's raw-table fallback agree on every row.
 */
export const DEPLOYMENT_ENV_SQL = compile(deploymentEnvExpr(mapColumn("ResourceAttributes")).toFragment())

/**
 * Canonical messaging-destination expression.
 *
 * The messaging semconv namespaced the destination as `messaging.destination.name`
 * and deprecated the bare `messaging.destination`. The service-map external-edge
 * rollup keys its `TargetName` off this: reading only the deprecated spelling
 * made every topic and queue from current instrumentation fall back to the
 * *system* value, collapsing per-destination edges into a single `kafka` / `sqs`
 * node. Maple's own producer spans (`VcsSyncQueue`) emit the `.name` key, so the
 * gap was visible on our own service map.
 */
export function messagingDestinationExpr(spanAttributes: MapColumnLike): Expr<string> {
	return CH.coalesce(
		CH.nullIf(spanAttributes.get("messaging.destination.name"), ""),
		spanAttributes.get("messaging.destination"),
	)
}

/** SQL text for {@link messagingDestinationExpr} over the raw `SpanAttributes` column. */
export const MESSAGING_DESTINATION_SQL = compile(
	messagingDestinationExpr(mapColumn("SpanAttributes")).toFragment(),
)
