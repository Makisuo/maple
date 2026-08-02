import { Effect } from "effect"
import { type WarehouseError, WarehouseSchemaDriftError } from "@maple/domain"
import { McpQueryError } from "../tools/types"

const SCHEMA_DRIFT_HINT =
	" — your ClickHouse cluster's schema is out of sync with what Maple expects. " +
	"Run schema apply from the org's ClickHouse settings page (or POST " +
	"/api/org-clickhouse-settings/apply-schema) to add the missing columns."

const enrich = (error: WarehouseError): string =>
	error instanceof WarehouseSchemaDriftError ? `${error.message}${SCHEMA_DRIFT_HINT}` : error.message

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
		new McpQueryError({ message: enrich(error), pipeName: pipe, cause: error })

/**
 * Pipe combinator that converts every warehouse error tag into an
 * `McpQueryError` (with the schema-drift hint), leaving any non-warehouse
 * errors (e.g. the MCP auth errors from `resolveTenant`) untouched in the
 * channel. Use as `effect.pipe(catchWarehouseToMcp("pipe_label"))`.
 */
/**
 * `Effect.catchTags` handler map that converts every warehouse error tag into an
 * `McpQueryError` (with the schema-drift hint), leaving any non-warehouse errors
 * (e.g. the MCP auth errors from `resolveTenant`) untouched. Apply inline so the
 * residual error channel infers from the caught tags:
 * `effect.pipe(Effect.catchTags(warehouseToMcpHandlers("pipe_label")))`.
 */
export const warehouseToMcpHandlers = (pipe: string) => {
	const fail = (error: WarehouseError) => Effect.fail(toMcpQueryError(pipe)(error))
	return {
		"@maple/http/errors/WarehouseQueryError": fail,
		"@maple/http/errors/WarehouseUpstreamError": fail,
		"@maple/http/errors/WarehouseAuthError": fail,
		"@maple/http/errors/WarehouseConfigError": fail,
		"@maple/http/errors/WarehouseClientError": fail,
		"@maple/http/errors/WarehouseSchemaDriftError": fail,
		"@maple/http/errors/WarehouseMalformedQueryError": fail,
		"@maple/http/errors/WarehouseQuotaExceededError": fail,
		"@maple/http/errors/WarehouseValidationError": fail,
	}
}
