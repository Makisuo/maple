import type { TinybirdQueryError, TinybirdQuotaExceededError } from "@maple/domain"
import type { ObservabilityError } from "@maple/query-engine/observability"
import { McpQueryError } from "../tools/types"

const SCHEMA_DRIFT_HINT =
	" — your ClickHouse cluster's schema is out of sync with what Maple expects. " +
	"Run schema apply from the org's ClickHouse settings page (or POST " +
	"/api/org-clickhouse-settings/apply-schema) to add the missing columns."

/**
 * Errors that can flow into the MCP layer from a warehouse query: either the
 * raw HTTP-domain errors (legacy `WarehouseQueryService.query` path), or the
 * `ObservabilityError` wrapper used by the DSL/observability functions in
 * `@maple/query-engine`. Both carry an optional `category` field with the same
 * literals — see TinybirdExecutorLive for the forwarding.
 */
export type WarehouseError = TinybirdQueryError | TinybirdQuotaExceededError | ObservabilityError

const enrich = (error: WarehouseError): string => {
	const category = "category" in error ? error.category : undefined
	if (category === "schema_drift") {
		return `${error.message}${SCHEMA_DRIFT_HINT}`
	}
	return error.message
}

/**
 * Curry the pipe label so call sites read as
 * `Effect.mapError(toMcpQueryError("service_overview"))`.
 *
 * Surfaces a remediation hint when the underlying CH error indicates schema
 * drift — i.e. the customer's BYO cluster is missing a column Maple's queries
 * reference. Without this hint the customer sees only the raw CH error and has
 * to chase infra symptoms (as happened with the SampleRate column).
 */
export const toMcpQueryError =
	(pipe: string) =>
	(error: WarehouseError): McpQueryError =>
		new McpQueryError({ message: enrich(error), pipe, cause: error })
