import { AIChatAgent } from "@cloudflare/ai-chat"
import {
	tool,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type LanguageModelUsage,
	type StreamTextOnFinishCallback,
	type ToolSet,
} from "ai"
import { Effect } from "effect"
import { routeAgentRequest } from "agents"
import { makeAgentHarnessRuntime, type AgentHarnessRuntime } from "@maple/agent-harness"
import { z } from "zod"
import type { Env } from "./lib/types"
import { resolveOrgOpenrouterKey } from "@maple/api/agent"
import { trackTokenUsage } from "./lib/autumn-tracker"
import { createMapleAiTools } from "./lib/direct-tools"
import { applyApprovalGates } from "./lib/gated-tools"
import { createModelGateway } from "./lib/model-gateway"
import { createDurableObjectSessionStore, type DurableSqlClient } from "./lib/session-store"
import { SYSTEM_PROMPT, DASHBOARD_BUILDER_SYSTEM_PROMPT } from "./lib/system-prompt"
import { orgIdFromDoName, parseDoNameFromUrl, verifyRequest } from "./lib/auth"

interface DashboardContext {
	dashboardName: string
	existingWidgets: Array<{ title: string; visualization: string }>
}

type AutoContext =
	| { kind: "service"; id: string; serviceName: string }
	| { kind: "trace"; id: string; traceId: string }
	| { kind: "dashboard"; id: string; dashboardId: string; widgetId?: string }
	| { kind: "error_type"; id: string; errorType: string }
	| { kind: "error_issue"; id: string; issueId: string }
	| { kind: "alert_rule"; id: string; ruleId: string }
	| { kind: "host"; id: string; hostName: string }
	| { kind: "logs_explorer"; id: string }
	| { kind: "metrics_explorer"; id: string }
	| { kind: "traces_explorer"; id: string }
	| { kind: "service_map"; id: string }

interface PageContextPayload {
	pathname: string
	contexts: AutoContext[]
}

const formatAutoContextLine = (ctx: AutoContext): string => {
	switch (ctx.kind) {
		case "service":
			return `- service: ${ctx.serviceName}`
		case "trace":
			return `- trace: ${ctx.traceId}`
		case "dashboard":
			return ctx.widgetId
				? `- dashboard: ${ctx.dashboardId} (widget: ${ctx.widgetId})`
				: `- dashboard: ${ctx.dashboardId}`
		case "error_type":
			return `- error_type: ${ctx.errorType}`
		case "error_issue":
			return `- error_issue: ${ctx.issueId}`
		case "alert_rule":
			return `- alert_rule: ${ctx.ruleId}`
		case "host":
			return `- host: ${ctx.hostName}`
		case "logs_explorer":
			return "- view: logs explorer"
		case "metrics_explorer":
			return "- view: metrics explorer"
		case "traces_explorer":
			return "- view: traces explorer"
		case "service_map":
			return "- view: service map"
	}
}

const formatPageContextBlock = (payload: PageContextPayload): string => {
	if (payload.contexts.length === 0) return ""
	const lines = [
		"",
		"## Current Page Context",
		"The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says \"this\", \"here\", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what's listed below.",
		"",
		`page: ${payload.pathname}`,
		...payload.contexts.map(formatAutoContextLine),
	]
	return lines.join("\n")
}

interface AlertContext {
	ruleId: string
	ruleName: string
	incidentId: string | null
	eventType: string
	signalType: string
	severity: string
	comparator: string
	threshold: number
	value: number | null
	windowMinutes: number
	groupKey: string | null
	sampleCount: number | null
}

const formatAlertComparator = (c: string) => {
	switch (c) {
		case "gt":
			return ">"
		case "gte":
			return ">="
		case "lt":
			return "<"
		case "lte":
			return "<="
		default:
			return c
	}
}

const SIGNAL_TOOL_HINTS: Record<string, string> = {
	error_rate:
		"- Prefer `find_errors` and `list_error_issues` for the affected service.\n- Use `search_logs` to surface exception messages in the alert window.",
	p95_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	p99_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	apdex: "- Investigate both latency and errors: `find_slow_traces`, `find_errors`, and `get_service_top_operations`.",
	throughput:
		"- Use `compare_periods` to contrast the alert window against the prior equivalent window.\n- `service_map` can reveal upstream dependencies that dropped or surged.",
	metric: "- Use `query_data` or `inspect_chart_data` to pull the raw metric values across the window.",
}

const formatAlertContextBlock = (alert: AlertContext): string => {
	const observedRaw = alert.value === null ? "n/a" : String(alert.value)
	const thresholdExpr = `${formatAlertComparator(alert.comparator)} ${alert.threshold}`
	const toolHints =
		SIGNAL_TOOL_HINTS[alert.signalType] ??
		"- Use `diagnose_service` and `explore_attributes` on the affected service."

	const lines = [
		"",
		"## Attached Alert",
		"The on-call engineer is investigating an alert that has been attached to this conversation as structured context. It is visible to them as a pinned card above the message thread, and it remains attached to every message in this thread.",
		"",
		"```yaml",
		`rule_id: ${alert.ruleId}`,
		`rule_name: ${JSON.stringify(alert.ruleName)}`,
		`incident_id: ${alert.incidentId ?? "null"}`,
		`event_type: ${alert.eventType}`,
		`severity: ${alert.severity}`,
		`signal: ${alert.signalType}`,
		`threshold: ${thresholdExpr}`,
		`observed: ${observedRaw}`,
		`sample_count: ${alert.sampleCount ?? "null"}`,
		`window_minutes: ${alert.windowMinutes}`,
		`group_key: ${alert.groupKey === null ? "null" : JSON.stringify(alert.groupKey)}`,
		"```",
		"",
		"### Investigation guidance",
		`- Scope every query to service/group \`${alert.groupKey ?? "all"}\` unless the engineer explicitly broadens it.`,
		`- Default time range: the alert window (${alert.windowMinutes}m ending at the event time) with ~15m of surrounding context. Widen if needed.`,
		`- Treat the attachment as authoritative — do not ask the engineer to repeat values it already contains. Reference the rule by name, not by ID.`,
		toolHints,
		"- When you recommend dashboards or links, prefer existing Maple routes (services, traces, errors, alerts). Use `get_alert_rule`/`list_alert_incidents` if you need deeper rule history.",
		"- If the event is `resolve`, focus on root-cause and prevention rather than immediate mitigation.",
	]
	return lines.join("\n")
}

const METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
const METRIC_TYPES_SET = new Set<string>(METRIC_TYPES)
const QUERY_SOURCES = ["traces", "logs", "metrics"] as const
const QUERY_SOURCES_SET = new Set<string>(QUERY_SOURCES)
const QUERY_BUILDER_CHART_IDS = ["query-builder-bar", "query-builder-area", "query-builder-line"] as const

const widgetDisplaySchema = z.object({
	title: z.string().trim().min(1).describe("Widget title shown in the dashboard header"),
	unit: z
		.enum([
			"none",
			"number",
			"percent",
			"duration_ms",
			"duration_us",
			"duration_s",
			"duration_ns",
			"bytes",
			"requests_per_sec",
			"short",
		])
		.optional(),
	chartId: z.enum(QUERY_BUILDER_CHART_IDS).optional(),
	columns: z
		.array(
			z.object({
				field: z.string(),
				header: z.string(),
				unit: z.string().optional(),
				align: z.enum(["left", "center", "right"]).optional(),
			}),
		)
		.optional(),
	listDataSource: z.enum(["traces", "logs"]).optional().describe("Data source for list visualization"),
	listLimit: z.number().min(1).max(50).optional().describe("Max items in list visualization"),
	listWhereClause: z.string().optional().describe("Filter for list visualization"),
	listRootOnly: z.boolean().optional().describe("Only root spans for trace lists"),
})

const dashboardWidgetDataSourceSchema = z
	.object({
		endpoint: z.string().describe("One of the available DataSourceEndpoint values"),
		params: z.record(z.string(), z.unknown()).optional(),
		transform: z
			.object({
				reduceToValue: z
					.object({
						field: z.string(),
						aggregate: z.enum(["sum", "first", "count", "avg", "max", "min"]),
					})
					.optional(),
				fieldMap: z.record(z.string(), z.string()).optional(),
				flattenSeries: z.object({ valueField: z.string() }).optional(),
				limit: z.number().optional(),
				sortBy: z
					.object({
						field: z.string(),
						direction: z.enum(["asc", "desc"]),
					})
					.optional(),
			})
			.optional(),
	})
	.superRefine((dataSource, ctx) => {
		if (dataSource.endpoint !== "custom_query_builder_timeseries") {
			return
		}

		const params = dataSource.params
		if (!params || typeof params !== "object" || Array.isArray(params)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "custom_query_builder_timeseries requires params.queries[]",
				path: ["params"],
			})
			return
		}

		const rawQueries = (params as Record<string, unknown>).queries
		if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "custom_query_builder_timeseries requires params.queries[]",
				path: ["params", "queries"],
			})
			return
		}

		for (const [index, rawQuery] of rawQueries.entries()) {
			if (typeof rawQuery !== "object" || rawQuery === null || Array.isArray(rawQuery)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Each query must be an object",
					path: ["params", "queries", index],
				})
				continue
			}

			const query = rawQuery as Record<string, unknown>
			const querySource = query.dataSource ?? query.source
			if (typeof querySource !== "string" || !QUERY_SOURCES_SET.has(querySource)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Each query must provide dataSource or source in traces|logs|metrics",
					path: ["params", "queries", index, "dataSource"],
				})
				continue
			}

			if (querySource !== "metrics") continue

			if (typeof query.metricName !== "string" || query.metricName.trim().length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Metrics queries require metricName",
					path: ["params", "queries", index, "metricName"],
				})
			}

			if (typeof query.metricType !== "string" || !METRIC_TYPES_SET.has(query.metricType)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Metrics queries require a valid metricType",
					path: ["params", "queries", index, "metricType"],
				})
			}
		}
	})

// ---------------------------------------------------------------------------
// Endpoint → MCP tool mapping for test_widget_query
// ---------------------------------------------------------------------------

const GROUP_BY_TOKEN_MAP: Record<string, string> = {
	"service.name": "service",
	"span.name": "span_name",
	"status.code": "status_code",
	"http.method": "http_method",
}

interface EndpointMapping {
	mcpTool: string
	mapParams: (params: Record<string, unknown>) => Record<string, unknown>
}

const ENDPOINT_MCP_MAP: Record<string, EndpointMapping> = {
	service_usage: {
		mcpTool: "service_overview",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
		}),
	},
	service_overview: {
		mcpTool: "service_overview",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
		}),
	},
	errors_summary: {
		mcpTool: "find_errors",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: (Array.isArray(p.services) ? p.services[0] : undefined) ?? p.service,
		}),
	},
	errors_by_type: {
		mcpTool: "find_errors",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: (Array.isArray(p.services) ? p.services[0] : undefined) ?? p.service,
			limit: p.limit,
		}),
	},
	list_traces: {
		mcpTool: "search_traces",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: p.service,
			limit: p.limit ?? 5,
		}),
	},
	list_logs: {
		mcpTool: "search_logs",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: p.service,
			severity: p.severity ?? p.minSeverity,
			limit: p.limit ?? 5,
		}),
	},
	list_metrics: {
		mcpTool: "list_metrics",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: p.service,
		}),
	},
	metrics_summary: {
		mcpTool: "list_metrics",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
			service: p.service,
		}),
	},
	error_rate_by_service: {
		mcpTool: "find_errors",
		mapParams: (p) => ({
			start_time: p.startTime ?? p.start_time,
			end_time: p.endTime ?? p.end_time,
		}),
	},
}

function mapQueryDraftToQueryDataParams(query: Record<string, unknown>): Record<string, unknown> {
	const source = (query.dataSource ?? query.source) as string
	const rawGroupBy = Array.isArray(query.groupBy)
		? (query.groupBy.find(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			) ?? "none")
		: typeof query.groupBy === "string" && query.groupBy.trim().length > 0
			? query.groupBy
			: "none"
	const groupBy = GROUP_BY_TOKEN_MAP[rawGroupBy] ?? rawGroupBy

	const params: Record<string, unknown> = {
		source,
		kind: "timeseries",
		group_by: groupBy === "none" ? "none" : groupBy,
	}

	if (source === "traces") {
		params.metric = query.aggregation ?? "count"
	} else if (source === "logs") {
		params.metric = "count"
	} else if (source === "metrics") {
		params.metric = query.aggregation ?? "avg"
		params.metric_name = query.metricName
		params.metric_type = query.metricType
	}

	// Parse simple whereClause filters
	const whereClause = query.whereClause as string | undefined
	if (whereClause) {
		for (const match of whereClause.matchAll(/(\w[\w.]*)\s*=\s*['"]([^'"]+)['"]/g)) {
			const key = match[1]!.toLowerCase()
			const value = match[2]!
			if (key === "service" || key === "service.name") params.service_name = value
			else if (key === "span" || key === "span.name") params.span_name = value
			else if (key === "severity") params.severity = value
		}
	}

	return params
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpToolSet = Record<string, { execute: (...args: any[]) => Promise<unknown> }>

function callMcpTool(
	mcpTools: McpToolSet,
	toolName: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	const mcpTool = mcpTools[toolName]
	if (!mcpTool) return Promise.resolve({ error: `MCP tool "${toolName}" not available` })
	// Strip undefined values from params
	const cleanParams: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) cleanParams[k] = v
	}
	return mcpTool.execute(cleanParams)
}

// ---------------------------------------------------------------------------
// Dashboard builder tools factory
// ---------------------------------------------------------------------------

function createDashboardBuilderTools(mcpTools: McpToolSet) {
	return {
		test_widget_query: tool({
			description:
				"Test a dashboard widget query before adding it. Runs the query the widget would use via MCP tools and returns the results so you can verify data exists and makes sense. ALWAYS call this before add_dashboard_widget.",
			inputSchema: z.object({
				endpoint: z
					.string()
					.describe(
						"Widget data source endpoint (e.g., 'service_usage', 'errors_summary', 'custom_query_builder_timeseries')",
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Parameters for the query (startTime, endTime, limit, queries[], etc.)"),
				transform: z
					.object({
						reduceToValue: z
							.object({
								field: z.string(),
								aggregate: z.enum(["sum", "first", "count", "avg", "max", "min"]),
							})
							.optional(),
						limit: z.number().optional(),
					})
					.optional()
					.describe("Transform config to preview what the widget would display"),
			}),
			execute: async ({ endpoint, params: rawParams, transform }) => {
				const p = rawParams ?? {}

				// --- custom_query_builder_timeseries: test each query via query_data ---
				if (endpoint === "custom_query_builder_timeseries") {
					const queries = p.queries as Record<string, unknown>[] | undefined
					if (!Array.isArray(queries) || queries.length === 0) {
						return { error: "custom_query_builder_timeseries requires params.queries[]" }
					}

					const enabledQueries = queries.filter((q) => q.enabled !== false)
					const results: string[] = [
						`Testing ${enabledQueries.length} query builder queries...`,
						"",
					]

					let anyData = false
					for (const query of enabledQueries) {
						const label = (query.name ?? "?") as string
						const queryDataParams = {
							...mapQueryDraftToQueryDataParams(query),
							start_time: p.startTime ?? p.start_time,
							end_time: p.endTime ?? p.end_time,
						}

						try {
							const result = await callMcpTool(mcpTools, "query_data", queryDataParams)
							const resultStr = typeof result === "string" ? result : JSON.stringify(result)

							if (resultStr.includes("No data") || resultStr.includes("no data")) {
								results.push(`Query "${label}": EMPTY — no data returned`)
							} else {
								anyData = true
								results.push(`Query "${label}": OK — data found`)
								// Include a truncated preview of the result
								const preview =
									resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr
								results.push(preview)
							}
						} catch (error) {
							results.push(
								`Query "${label}": ERROR — ${error instanceof Error ? error.message : String(error)}`,
							)
						}
						results.push("")
					}

					results.push(
						anyData
							? "Widget query validated — data exists."
							: "WARNING: No data for any query. The widget would show empty.",
					)

					return { status: "tested", summary: results.join("\n") }
				}

				// --- Pipe-backed endpoints: map to MCP tool ---
				const mapping = ENDPOINT_MCP_MAP[endpoint]
				if (!mapping) {
					return {
						error: `Unknown endpoint "${endpoint}". Known endpoints: ${Object.keys(ENDPOINT_MCP_MAP).join(", ")}, custom_query_builder_timeseries`,
					}
				}

				try {
					const mappedParams = mapping.mapParams(p)
					const result = await callMcpTool(mcpTools, mapping.mcpTool, mappedParams)
					const resultStr = typeof result === "string" ? result : JSON.stringify(result)
					const isEmpty =
						resultStr.includes("No ") &&
						(resultStr.includes("found") || resultStr.includes("data"))

					const lines: string[] = [
						`Testing endpoint="${endpoint}" via MCP tool "${mapping.mcpTool}"...`,
						"",
					]

					// Include truncated result
					const preview = resultStr.length > 800 ? resultStr.slice(0, 800) + "..." : resultStr
					lines.push(preview)

					// Apply transform preview
					if (transform?.reduceToValue) {
						lines.push(
							"",
							`Transform: reduceToValue(field="${transform.reduceToValue.field}", aggregate="${transform.reduceToValue.aggregate}")`,
						)
						lines.push(
							"Note: The actual value will be computed from the widget's data. Check that the field name appears in the results above.",
						)
					}

					lines.push(
						"",
						isEmpty
							? "WARNING: Query returned no data. The widget would show empty."
							: "Widget query validated — data exists.",
					)

					return { status: "tested", summary: lines.join("\n") }
				} catch (error) {
					return {
						status: "error",
						summary: `Failed to test endpoint="${endpoint}": ${error instanceof Error ? error.message : String(error)}`,
					}
				}
			},
		}),
		add_dashboard_widget: tool({
			description:
				"Add a widget to the user's dashboard. IMPORTANT: You must first call test_widget_query with the same endpoint/params/transform to verify the data exists BEFORE calling this tool. Titles must be specific and non-empty. For charts, use chartId from query-builder-area|query-builder-line|query-builder-bar.",
			inputSchema: z.object({
				visualization: z.enum(["stat", "chart", "table", "list"]),
				dataSource: dashboardWidgetDataSourceSchema,
				display: widgetDisplaySchema,
			}),
			execute: async () => ({
				status: "proposed",
			}),
		}),
		remove_dashboard_widget: tool({
			description: "Remove a widget from the dashboard by its title.",
			inputSchema: z.object({
				widgetTitle: z.string().describe("The title of the widget to remove"),
			}),
			execute: async () => ({
				status: "proposed",
			}),
		}),
	}
}

function createErrorResponse(errorMessage: string): Response {
	const stream = createUIMessageStream({
		execute: ({ writer }) => {
			writer.write({ type: "error", errorText: errorMessage })
		},
	})
	return createUIMessageStreamResponse({ stream })
}

function extractLatestUserText(
	messages: ReadonlyArray<{
		role: string
		parts: ReadonlyArray<{ type: string; text?: string }>
	}>,
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (!message || message.role !== "user") continue
		const text = message.parts
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim()
		if (text.length > 0) return text
	}
	return undefined
}

export { ChatAgent }

class ChatAgent extends AIChatAgent<Env> {
	private buildHarness(
		apiKey: string,
		options: { onCompactionUsage?: (usage: LanguageModelUsage) => void } = {},
	): AgentHarnessRuntime {
		return makeAgentHarnessRuntime(
			"default",
			createDurableObjectSessionStore(this.sql.bind(this) as DurableSqlClient),
			createModelGateway(apiKey, { onCompactionUsage: options.onCompactionUsage }),
			{ definitions: [] },
		)
	}

	async onChatMessage(
		onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
		options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
	) {
		const latestUserText = extractLatestUserText(this.messages)
		if (!latestUserText) {
			return createErrorResponse("A user text message is required")
		}
		return this.runChatTurn({
			body: options?.body as Record<string, unknown> | undefined,
			userText: latestUserText,
			requestId: options?.requestId,
			abortSignal: options?.abortSignal,
			onFinish: onFinish as StreamTextOnFinishCallback<ToolSet>,
		})
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const last = url.pathname.split("/").pop()

		if (request.method === "POST" && last === "mobile-chat") {
			try {
				const body = (await request.json()) as {
					orgId?: string
					userText?: string
					mode?: string
					alertContext?: AlertContext
					dashboardContext?: DashboardContext
				}
				const userText = (body.userText ?? "").trim()
				if (!userText) return createErrorResponse("userText is required")
				return this.runChatTurn({
					body: body as Record<string, unknown>,
					userText,
					abortSignal: request.signal,
					onFinish: async () => {},
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				console.error("[chat-agent] Error in /mobile-chat:", errorMessage)
				return createErrorResponse(errorMessage)
			}
		}

		return new Response("Not Found", { status: 404 })
	}

	private resolveOrgId(): string | undefined {
		return orgIdFromDoName(this.name)
	}

	private async runChatTurn(input: {
		body: Record<string, unknown> | undefined
		userText: string
		requestId?: string
		abortSignal?: AbortSignal
		onFinish: StreamTextOnFinishCallback<ToolSet>
	}): Promise<Response> {
		const { body, userText, abortSignal, onFinish } = input

		const orgId = this.resolveOrgId()
		if (!orgId) {
			return createErrorResponse("Agent instance is not bound to an organization")
		}
		const bodyOrgId = body?.orgId
		if (typeof bodyOrgId === "string" && bodyOrgId !== orgId) {
			return createErrorResponse("orgId mismatch between agent instance and request body")
		}

		const envRecord = this.env as unknown as Record<string, unknown>
		const orgApiKey = await resolveOrgOpenrouterKey(envRecord, orgId)
		const apiKey = orgApiKey ?? this.env.OPENROUTER_API_KEY
		if (!apiKey) {
			return createErrorResponse(
				"No OpenRouter API key configured. An admin must add one in Settings → AI.",
			)
		}
		const isByok = orgApiKey !== undefined
		const turnId = input.requestId ?? crypto.randomUUID()
		const env = this.env
		const ctx = this.ctx
		const trackUsage = (
			usage: LanguageModelUsage,
			source: "chat" | "compaction",
			idempotencyKey: string,
		) => {
			if (isByok || !env.AUTUMN_SECRET_KEY) return
			const promise = trackTokenUsage(env, {
				orgId,
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				idempotencyKey,
				source,
			})
			ctx.waitUntil(promise)
		}

		const mode = (body?.mode as string) ?? "default"
		const dashboardContext = body?.dashboardContext as DashboardContext | undefined
		const alertContext = body?.alertContext as AlertContext | undefined
		const pageContext = body?.pageContext as PageContextPayload | undefined

		try {
			const directTools = applyApprovalGates(await createMapleAiTools(envRecord, orgId))
			const isDashboardMode = mode === "dashboard_builder"
			const isAlertMode = mode === "alert"

			let systemPrompt = isDashboardMode ? DASHBOARD_BUILDER_SYSTEM_PROMPT : SYSTEM_PROMPT
			if (isDashboardMode && dashboardContext) {
				const widgetList =
					dashboardContext.existingWidgets.length > 0
						? dashboardContext.existingWidgets
								.map((w) => `- "${w.title}" (${w.visualization})`)
								.join("\n")
						: "(none)"
				systemPrompt += `\n\n## Current Dashboard Context\nDashboard: "${dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
			}
			if (isAlertMode && alertContext) {
				systemPrompt += `\n${formatAlertContextBlock(alertContext)}`
			}
			if (pageContext && pageContext.contexts.length > 0) {
				systemPrompt += `\n${formatPageContextBlock(pageContext)}`
			}

			const allTools = isDashboardMode
				? { ...directTools, ...createDashboardBuilderTools(directTools as unknown as McpToolSet) }
				: directTools

			const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (event) => {
				await onFinish(event)
				trackUsage(event.totalUsage, "chat", turnId)
			}

			const { result } = await Effect.runPromise(
				this.buildHarness(apiKey, {
					onCompactionUsage: (usage) => {
						trackUsage(
							usage,
							"compaction",
							`${turnId}:compact:${crypto.randomUUID().slice(0, 8)}`,
						)
					},
				}).prompt({
					text: userText,
					turnId,
					system: systemPrompt,
					abortSignal,
					tools: allTools as ToolSet,
					onFinish: wrappedOnFinish,
				}),
			)

			return result.toUIMessageStreamResponse()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("[chat-agent] Error in runChatTurn:", errorMessage)

			return createErrorResponse(errorMessage)
		}
	}
}

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const withCors = (response: Response): Response => {
	const next = new Response(response.body, response)
	for (const [key, value] of Object.entries(corsHeaders)) {
		next.headers.set(key, value)
	}
	return next
}

const denied = (status: number, message: string): Response =>
	withCors(
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	)

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders })
		}

		const url = new URL(request.url)
		if (!url.pathname.startsWith("/agents/")) {
			return new Response("Not Found", { status: 404 })
		}

		const doName = parseDoNameFromUrl(url)
		if (!doName) return denied(404, "Unknown agent route")

		const verified = await verifyRequest(request, env)
		if (!verified) return denied(401, "Authentication required")

		const namedOrgId = orgIdFromDoName(doName)
		if (!namedOrgId || namedOrgId !== verified.orgId) {
			return denied(403, "Agent name does not match authenticated organization")
		}

		const response = await routeAgentRequest(request, env)
		if (response) return withCors(response)

		return new Response("Not Found", { status: 404 })
	},
} satisfies ExportedHandler<Env>
