// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { InternalRpcToolNotFoundError } from "@maple/domain/internal-rpc"
import { Effect, Schema } from "effect"
import { registerAddDashboardWidgetTool } from "./add-dashboard-widget"
import { registerDescribeWarehouseTablesTool } from "./describe-warehouse-tables"
import { registerComparePeriodsTool } from "./compare-periods"
import { registerCreateAlertRuleTool } from "./create-alert-rule"
import { registerUpdateAlertRuleTool } from "./update-alert-rule"
import { registerDeleteAlertRuleTool } from "./delete-alert-rule"
import { registerCreateDashboardTool } from "./create-dashboard"
import { registerDescribeDashboardSchemaTool } from "./describe-dashboard-schema"
import { registerDiagnoseServiceTool } from "./diagnose-service"
import { registerErrorDetailTool } from "./error-detail"
import { registerExploreAttributesTool } from "./explore-attributes"
import { registerFindErrorsTool } from "./find-errors"
import { registerFindSlowTracesTool } from "./find-slow-traces"
import { registerGetAlertRuleTool } from "./get-alert-rule"
import { registerGetDashboardTool } from "./get-dashboard"
import { registerGetIncidentTimelineTool } from "./get-incident-timeline"
import { registerAuditSetupTool } from "./audit-setup"
import { registerGetInstrumentationRecommendationsTool } from "./get-instrumentation-recommendations"
import { registerGetServiceTopOperationsTool } from "./get-service-top-operations"
import { registerInspectChartDataTool } from "./inspect-chart-data"
import { registerInspectTraceTool } from "./inspect-trace"
import { registerInspectSpanTool } from "./inspect-span"
import { registerListAlertChecksTool } from "./list-alert-checks"
import { registerListAlertIncidentsTool } from "./list-alert-incidents"
import { registerListAlertRulesTool } from "./list-alert-rules"
import { registerClaimErrorIssueTool } from "./claim-error-issue"
import { registerCommentOnErrorIssueTool } from "./comment-on-error-issue"
import { registerListErrorIncidentsTool } from "./list-error-incidents"
import { registerListErrorIssueEventsTool } from "./list-error-issue-events"
import { registerListErrorIssuesTool } from "./list-error-issues"
import { registerProposeFixTool } from "./propose-fix"
import { registerRegisterAgentTool } from "./register-agent"
import { registerReleaseErrorIssueTool } from "./release-error-issue"
import { registerSetIssueSeverityTool } from "./set-issue-severity"
import { registerTransitionErrorIssueTool } from "./transition-error-issue"
import { registerUpdateErrorNotificationPolicyTool } from "./update-error-notification-policy"
import { registerListDashboardsTool } from "./list-dashboards"
import { registerListMetricsTool } from "./list-metrics"
import { registerListServicesTool } from "./list-services"
import { registerQueryDataTool } from "./query-data"
import { registerRunSqlTool } from "./run-sql"
import { registerRemoveDashboardWidgetTool } from "./remove-dashboard-widget"
import { registerReplaceDashboardWidgetsTool } from "./replace-dashboard-widgets"
import { registerReorderDashboardWidgetsTool } from "./reorder-dashboard-widgets"
import { registerMineLogPatternsTool } from "./mine-log-patterns"
import { registerSearchLogsTool } from "./search-logs"
import { registerSearchTracesTool } from "./search-traces"
import { registerSearchSessionsTool } from "./search-sessions"
import { registerGetSessionTranscriptTool } from "./get-session-transcript"
import { registerGetSessionTracesTool } from "./get-session-traces"
import { registerServiceMapTool } from "./service-map"
import { registerSourceCodeTools } from "./source-code"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./types"
import type { McpToolRequirements } from "./runtime-requirements"
import { registerUpdateDashboardTool } from "./update-dashboard"
import { registerUpdateDashboardWidgetTool } from "./update-dashboard-widget"

interface MapleToolDefinition {
	readonly name: string
	readonly description: string
	readonly schema: Schema.Codec<unknown, unknown, never, unknown>
	readonly handler: (params: unknown) => Effect.Effect<McpToolResult, McpToolError, McpToolRequirements>
}

export interface MapleToolCatalogEntry {
	readonly name: string
	readonly description: string
	readonly schema: Schema.Codec<unknown, unknown, never, unknown>
}

class McpDecodeError extends Schema.TaggedError<McpDecodeError>()("@maple/mcp/decode-error", {
	errorMessage: Schema.String,
}) {
	override get message(): string {
		return this.errorMessage
	}
}

/**
 * Effect emits exactly `{ anyOf: [{ type: "object" }, { type: "array" }] }` — no
 * `type`, no `properties` — for an empty `Struct({})`. Matched structurally so
 * the normalization below cannot swallow any other rootless schema.
 */
const isEmptyStructSchema = (base: Record<string, unknown>): boolean => {
	if ("type" in base || "properties" in base) return false
	const anyOf = base.anyOf
	if (!Array.isArray(anyOf) || anyOf.length === 0) return false
	return anyOf.every((member) => {
		if (typeof member !== "object" || member === null) return false
		const type = (member as { type?: unknown }).type
		return Object.keys(member).length === 1 && (type === "object" || type === "array")
	})
}

/**
 * Rewrite `anyOf: [T, {type: "null"}]` to plain `T`, keeping the sibling keys
 * (`description`, and anything else attached to the property).
 *
 * `Schema.optional(X)` — which CLAUDE.md mandates for MCP tool params — has type
 * `X | undefined`, but `toJsonSchemaDocument` renders that absence as a JSON
 * `null` branch. The published schema therefore told every MCP client that
 * `{"service": null}` was valid on every optional parameter of all 57 tools,
 * while the decoder rejects it with `Expected string | undefined`. An agent that
 * read the schema literally got "Invalid parameters" for doing what it was told.
 *
 * So this is a correctness fix first; it also happens to remove ~2.3k tokens
 * (17% of the published schema bytes) of union wrapper.
 *
 * Safe only while no MCP parameter is GENUINELY nullable — `Schema.NullOr` would
 * render identically and be wrongly narrowed here. `registry.test.ts` pins that
 * invariant by decoding `null` into every parameter of every tool.
 */
const collapseNullableUnions = (node: unknown): unknown => {
	if (Array.isArray(node)) return node.map(collapseNullableUnions)
	if (node === null || typeof node !== "object") return node
	const obj = node as Record<string, unknown>
	const anyOf = obj.anyOf
	if (Array.isArray(anyOf) && anyOf.length === 2) {
		const nullIndex = anyOf.findIndex(
			(member) => (member as Record<string, unknown> | null)?.type === "null",
		)
		if (nullIndex !== -1) {
			const { anyOf: _replaced, ...siblings } = obj
			const kept = anyOf[1 - nullIndex] as Record<string, unknown>
			// Siblings last: a `description` on the property outranks one on the branch.
			return collapseNullableUnions({ ...kept, ...siblings })
		}
	}
	return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, collapseNullableUnions(value)]))
}

export const toInputSchema = (schema: Schema.Top): Record<string, unknown> => {
	const document = Schema.toJsonSchemaDocument(schema)
	const rawBase =
		Object.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	const base = collapseNullableUnions(rawBase) as typeof rawBase
	// MCP requires the top-level inputSchema to be an object schema (`type: "object"`).
	// An empty `Struct({})` (a no-parameter tool) comes out untyped, which strict MCP
	// clients reject — the Vercel AI SDK's `tools/list` Zod validator fails on
	// `inputSchema.type` and drops EVERY tool from the connection. Normalize just that
	// case. `$ref` roots (hoisted schemas) already carry a valid object type.
	const record = base as Record<string, unknown>
	if (isEmptyStructSchema(record)) {
		return {
			type: "object",
			properties: {},
			additionalProperties: false,
			...("$defs" in record ? { $defs: record.$defs } : undefined),
		}
	}
	// A genuinely non-object root (a top-level `Schema.Union`/`Schema.Literals`/array)
	// has parameters that an empty object schema would erase, publishing the tool to
	// every MCP client as if it took none. Fail at registration instead — this runs at
	// module init, so it surfaces in tests and at worker boot rather than in the wire.
	if (record.type !== "object" && !("$ref" in record)) {
		throw new Error(
			`MCP tool input schemas must have an object root; got ${JSON.stringify(record).slice(0, 200)}. Wrap the tool input in a Schema.Struct.`,
		)
	}
	return base
}

const collectMapleToolDefinitions = (): ReadonlyArray<MapleToolDefinition> => {
	const definitions: MapleToolDefinition[] = []
	const collect: McpToolRegistrar["tool"] = (name, description, schema, handler) => {
		definitions.push({
			name,
			description,
			schema,
			handler: (params) => handler(params as typeof schema.Type),
		})
	}
	const registrar: McpToolRegistrar = { tool: collect }

	registerFindErrorsTool(registrar)
	registerInspectTraceTool(registrar)
	registerInspectSpanTool(registrar)
	registerSearchLogsTool(registrar)
	registerMineLogPatternsTool(registrar)
	registerSearchTracesTool(registrar)
	registerSearchSessionsTool(registrar)
	registerGetSessionTranscriptTool(registrar)
	registerGetSessionTracesTool(registrar)
	registerDiagnoseServiceTool(registrar)
	registerFindSlowTracesTool(registrar)
	registerErrorDetailTool(registrar)
	registerListMetricsTool(registrar)
	registerQueryDataTool(registrar)
	registerRunSqlTool(registrar)
	registerServiceMapTool(registrar)
	registerListAlertRulesTool(registrar)
	registerGetAlertRuleTool(registrar)
	registerListAlertIncidentsTool(registrar)
	registerListAlertChecksTool(registrar)
	registerGetIncidentTimelineTool(registrar)
	registerCreateAlertRuleTool(registrar)
	registerUpdateAlertRuleTool(registrar)
	registerDeleteAlertRuleTool(registrar)
	registerDescribeDashboardSchemaTool(registrar)
	registerListDashboardsTool(registrar)
	registerGetDashboardTool(registrar)
	registerCreateDashboardTool(registrar)
	registerUpdateDashboardTool(registrar)
	registerAddDashboardWidgetTool(registrar)
	registerDescribeWarehouseTablesTool(registrar)
	registerUpdateDashboardWidgetTool(registrar)
	registerRemoveDashboardWidgetTool(registrar)
	registerReplaceDashboardWidgetsTool(registrar)
	registerReorderDashboardWidgetsTool(registrar)
	registerInspectChartDataTool(registrar)
	registerComparePeriodsTool(registrar)
	registerExploreAttributesTool(registrar)
	registerListServicesTool(registrar)
	registerGetServiceTopOperationsTool(registrar)
	registerGetInstrumentationRecommendationsTool(registrar)
	registerAuditSetupTool(registrar)
	registerSourceCodeTools(registrar)
	registerListErrorIssuesTool(registrar)
	registerTransitionErrorIssueTool(registrar)
	registerSetIssueSeverityTool(registrar)
	registerClaimErrorIssueTool(registrar)
	registerReleaseErrorIssueTool(registrar)
	registerCommentOnErrorIssueTool(registrar)
	registerProposeFixTool(registrar)
	registerListErrorIssueEventsTool(registrar)
	registerRegisterAgentTool(registrar)
	registerListErrorIncidentsTool(registrar)
	registerUpdateErrorNotificationPolicyTool(registrar)

	return definitions
}

const mapleToolDefinitions = collectMapleToolDefinitions()

/** Handler-free registry view for schemas, permissions, MCP discovery, and tests. */
export const mapleToolCatalog: ReadonlyArray<MapleToolCatalogEntry> = mapleToolDefinitions.map(
	({ name, description, schema }) => ({ name, description, schema }),
)

const toDecodeErrorMessage = (definition: MapleToolDefinition, error: unknown): string => {
	if (Schema.isSchemaError(error)) {
		return `${String(error)}. Check the "${definition.name}" tool schema for valid parameter names and types.`
	}
	return String(error)
}

/**
 * The one raw registry entry point. Its full Effect environment is intentionally
 * preserved; only `McpToolExecutor` may close it with tenant and app services.
 */
export const executeRegisteredMcpToolUnscoped = Effect.fn("McpToolRegistry.execute")(function* (
	name: string,
	input: unknown,
) {
	const definition = mapleToolDefinitions.find((candidate) => candidate.name === name)
	if (!definition) {
		return yield* new InternalRpcToolNotFoundError({
			name,
			message: `Unknown MCP tool: ${name}`,
		})
	}

	yield* Effect.annotateCurrentSpan({ tool: definition.name })
	const decoded = yield* Schema.decodeUnknownEffect(definition.schema)(input).pipe(
		Effect.mapError(
			(error) =>
				new McpDecodeError({
					errorMessage: toDecodeErrorMessage(definition, error),
				}),
		),
	)

	return yield* definition.handler(decoded).pipe(Effect.tap(() => Effect.logInfo("Tool completed")))
})
