import { optionalNumberParam, optionalStringParam, optionalTimeParam, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange, rangeExceededResult, MCP_DISCOVERY_MAX_HOURS } from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatTable, formatNumber, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import { Effect, Schema } from "effect"
import type { ListProductEventsData } from "@maple/domain"
import { productEventNames } from "@maple/query-engine/observability"

const TOOL = "list_product_events"
const DEFAULT_RANGE_HOURS = 7 * 24

export function registerListProductEventsTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"List the product event names an org has recorded — browser `track()` events, server-side events and page views — with how often each fired and how many sessions and persons it reached. Use it to discover the step names for `query_funnel` (an event step needs an exact `eventName`). `kind` tells them apart: `custom` is a `track()`/server event, `navigation` is a page view (`$pageview`), `screen` a mobile screen. Filters (`host`, `page_path`, `referrer_host`, `country`, `utm_*`) narrow to events from matching sessions.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss). Default: last 7 days."),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss)."),
			kind: optionalStringParam(
				"Only events of this kind: `custom`, `navigation` or `screen`. Default: all.",
			),
			search: optionalStringParam("Case-insensitive substring match on the event name."),
			host: optionalStringParam("Only events from sessions on this site host."),
			page_path: optionalStringParam("Only events from sessions that viewed this page path."),
			referrer_host: optionalStringParam("Only events from sessions referred by this host."),
			country: optionalStringParam("Only events from sessions in this country (ISO code)."),
			utm_source: optionalStringParam("Only events from sessions carrying this utm_source."),
			utm_medium: optionalStringParam("Only events from sessions carrying this utm_medium."),
			utm_campaign: optionalStringParam("Only events from sessions carrying this utm_campaign."),
			limit: optionalNumberParam("Max event names to return (default 50, max 200)."),
		}),
		Effect.fn("McpTool.listProductEvents")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: DEFAULT_RANGE_HOURS,
				maxHours: MCP_DISCOVERY_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, TOOL)
			const limit = clampLimit(params.limit, { defaultValue: 50, max: 200 })

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, kind: params.kind ?? "any", limit })

			// The query ranks every name; kind and name filters apply here so the
			// limit still means "names shown". Fetch the full cap when narrowing.
			const narrowing = params.kind !== undefined || params.search !== undefined
			const rows = yield* withTenantExecutor(
				productEventNames({
					startTime: st,
					endTime: et,
					limit: narrowing ? 200 : limit,
					filters: {
						host: params.host ?? undefined,
						pagePath: params.page_path ?? undefined,
						referrerHost: params.referrer_host ?? undefined,
						country: params.country ?? undefined,
						utmSource: params.utm_source ?? undefined,
						utmMedium: params.utm_medium ?? undefined,
						utmCampaign: params.utm_campaign ?? undefined,
					},
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

			const search = params.search?.toLowerCase()
			const events = rows
				.filter((row) => params.kind === undefined || row.kind === params.kind)
				.filter((row) => search === undefined || row.eventName.toLowerCase().includes(search))
				.slice(0, limit)
				.map((row) => ({
					eventName: row.eventName,
					kind: row.kind,
					count: Number(row.count) || 0,
					sessions: Number(row.sessions) || 0,
					persons: Number(row.persons) || 0,
				}))

			yield* Effect.annotateCurrentSpan("result.rowCount", events.length)

			if (events.length === 0) {
				const custom = params.kind === undefined || params.kind === "custom"
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`No product events matched (${st} — ${et}).`,
								custom
									? 'To record product events call `maple.track("signup_completed", { plan: "pro" })` from the browser SDK, or `MapleEvents.track()` server-side; each name then shows up here and can be a funnel step.'
									: "",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
				}
			}

			const lines: string[] = [
				`## Product events (${events.length}${narrowing ? " matching" : ""})`,
				`Time range: ${st} — ${et}`,
				"",
				formatTable(
					["Event", "Kind", "Count", "Sessions", "Persons"],
					events.map((event) => [
						truncate(event.eventName, 60),
						event.kind,
						formatNumber(event.count),
						formatNumber(event.sessions),
						formatNumber(event.persons),
					]),
				),
			]

			const customEvents = events.filter((event) => event.kind === "custom")
			if (customEvents.length === 0) {
				lines.push(
					"",
					"Only page views so far — no `track()` events. Page steps still work in `query_funnel`; custom events come from `maple.track(name, props)` in the browser SDK or `MapleEvents.track()` server-side.",
				)
			}

			const suggested = customEvents.slice(0, 2).map((event) => event.eventName)
			lines.push(
				formatNextSteps([
					suggested.length > 0
						? `\`query_funnel steps_json='${JSON.stringify(suggested.map((eventName) => ({ kind: "event", eventName })))}'\` — measure conversion between them`
						: '`query_funnel steps_json=\'[{"kind":"page","pagePath":"/"},{"kind":"page","pagePath":"/pricing"}]\'\` — a page-to-page funnel',
				]),
			)

			const data: ListProductEventsData = { timeRange: { start: st, end: et }, events }
			return { content: createDualContent(lines.join("\n"), { tool: TOOL, data }) }
		}),
	)
}
