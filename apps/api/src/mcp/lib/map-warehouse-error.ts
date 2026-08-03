import { Effect } from "effect"
import { type WarehouseError, WarehouseSchemaDriftError } from "@maple/domain"
import { warehouseHandlers } from "@/services/warehouse/warehouse-error-handlers"
import { McpQueryError } from "@/mcp/tools/types"

export { warehouseHandlers }

const SCHEMA_DRIFT_HINT =
	" — your ClickHouse cluster's schema is out of sync with what Maple expects. " +
	"Run schema apply from the org's ClickHouse settings page (or POST " +
	"/api/org-clickhouse-settings/apply-schema) to add the missing columns."

/**
 * Human-facing message for a warehouse error, with the schema-drift remediation
 * hint appended when apt. Without this hint the customer sees only the raw CH
 * error and has to chase infra symptoms (as happened with the SampleRate
 * column). Every MCP surface that renders a warehouse error should go through
 * this, not `error.message`.
 *
 * `kind: "decode"` drift means the cluster answered fine but the rows failed
 * Maple's own row schema — schema apply cannot fix that, so no hint.
 */
export const warehouseErrorText = (error: WarehouseError): string =>
	error instanceof WarehouseSchemaDriftError && error.kind !== "decode"
		? `${error.message}${SCHEMA_DRIFT_HINT}`
		: error.message

/**
 * Curry the pipe label so call sites read as
 * `Effect.mapError(toMcpQueryError("service_overview"))`.
 */
export const toMcpQueryError =
	(pipe: string) =>
	(error: WarehouseError): McpQueryError =>
		new McpQueryError({ message: warehouseErrorText(error), pipeName: pipe, cause: error })

/**
 * `Effect.catchTags` handler map that converts every warehouse error tag into an
 * `McpQueryError` (with the schema-drift hint), leaving any non-warehouse errors
 * (e.g. the MCP auth errors from `resolveTenant`) untouched. Apply inline so the
 * residual error channel infers from the caught tags:
 * `effect.pipe(Effect.catchTags(warehouseToMcpHandlers("pipe_label")))`.
 */
export const warehouseToMcpHandlers = (pipe: string) =>
	warehouseHandlers((error) => Effect.fail(toMcpQueryError(pipe)(error)))
