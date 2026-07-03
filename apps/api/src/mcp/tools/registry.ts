import { Effect, Schema } from "effect"
import { registerAddDashboardWidgetTool } from "./add-dashboard-widget"
import { registerDescribeWarehouseTablesTool } from "./describe-warehouse-tables"
import { registerComparePeriodsTool } from "./compare-periods"
import { registerCreateAlertRuleTool } from "./create-alert-rule"
import { registerUpdateAlertRuleTool } from "./update-alert-rule"
import { registerDeleteAlertRuleTool } from "./delete-alert-rule"
import { registerCreateDashboardTool } from "./create-dashboard"
import { registerDiagnoseServiceTool } from "./diagnose-service"
import { registerErrorDetailTool } from "./error-detail"
import { registerExploreAttributesTool } from "./explore-attributes"
import { registerFindErrorsTool } from "./find-errors"
import { registerFindSlowTracesTool } from "./find-slow-traces"
import { registerGetAlertRuleTool } from "./get-alert-rule"
import { registerGetDashboardTool } from "./get-dashboard"
import { registerGetIncidentTimelineTool } from "./get-incident-timeline"
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
import { registerHeartbeatErrorIssueTool } from "./heartbeat-error-issue"
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
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./types"
import { registerUpdateDashboardTool } from "./update-dashboard"
import { registerUpdateDashboardWidgetTool } from "./update-dashboard-widget"

// `R` is intentionally `any` here: MapleToolDefinition is the type-erased
// boundary between heterogeneous tool implementations (each with its own
// service requirements) and the McpServer.addTool API (which expects
// McpServerClient). The runtime layer wires the actual services; we accept the
// loose `any` here to let both sides typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MapleToolDefinition {
	readonly name: string
	readonly description: string
	readonly schema: Schema.Codec<unknown, unknown, never, unknown>
	readonly handler: (params: unknown) => Effect.Effect<McpToolResult, McpToolError, any>
}

export const toInputSchema = (schema: Schema.Top): Record<string, unknown> => {
	const document = Schema.toJsonSchemaDocument(schema)
	return Object.keys(document.definitions).length > 0
		? { ...document.schema, $defs: document.definitions }
		: document.schema
}

const collectMapleToolDefinitions = (): ReadonlyArray<MapleToolDefinition> => {
	const definitions: MapleToolDefinition[] = []
	const registrar: McpToolRegistrar = {
		tool(name, description, schema, handler) {
			definitions.push({
				name,
				description,
				schema,
				handler: handler as MapleToolDefinition["handler"],
			})
		},
	}

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
	registerListErrorIssuesTool(registrar)
	registerTransitionErrorIssueTool(registrar)
	registerSetIssueSeverityTool(registrar)
	registerClaimErrorIssueTool(registrar)
	registerReleaseErrorIssueTool(registrar)
	registerHeartbeatErrorIssueTool(registrar)
	registerCommentOnErrorIssueTool(registrar)
	registerProposeFixTool(registrar)
	registerListErrorIssueEventsTool(registrar)
	registerRegisterAgentTool(registrar)
	registerListErrorIncidentsTool(registrar)
	registerUpdateErrorNotificationPolicyTool(registrar)

	return definitions
}

export const mapleToolDefinitions = collectMapleToolDefinitions()
