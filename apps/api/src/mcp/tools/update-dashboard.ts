import { McpQueryError, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { Clock, Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { DashboardDocument, DashboardId, PortableDashboardDocument } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain"
import { validateDashboardTimeRange } from "@/mcp/lib/resolve-dashboard-time-range"
import { MAX_QUERY_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"

const PortableDashboardFromJson = Schema.fromJsonString(PortableDashboardDocument)
const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeDashboardId = Schema.decodeUnknownSync(DashboardId)

export function registerUpdateDashboardTool(server: McpToolRegistrar) {
	server.tool(
		"update_dashboard",
		"Update an existing dashboard's top-level metadata (name, description, time_range). For widget-level changes prefer the incremental tools: add_dashboard_widget, update_dashboard_widget, remove_dashboard_widget, reorder_dashboard_widgets — they do not require re-sending the whole dashboard. `dashboard_json` is still accepted as an escape hatch for full replacement but is expensive on large dashboards and easy to corrupt.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard to update (use list_dashboards to find IDs)",
			),
			name: optionalStringParam("New dashboard name"),
			description: optionalStringParam("New dashboard description"),
			time_range: optionalStringParam(
				`New time range as relative shorthand — e.g. 15m, 6h, 24h, 7d, 2w, 3mo, or "today". Up to ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)}.`,
			),
			dashboard_json: optionalStringParam(
				"Full dashboard JSON to replace the current configuration. Use get_dashboard to see the current schema.",
			),
		}),
		Effect.fn("McpTool.updateDashboard")(function* ({
			dashboard_id,
			name,
			description,
			time_range,
			dashboard_json,
		}) {
			if (time_range) {
				const timeRangeError = validateDashboardTimeRange(time_range)
				if (timeRangeError) {
					return {
						isError: true as const,
						content: [{ type: "text" as const, text: timeRangeError }],
					}
				}
			}

			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const portable = dashboard_json
				? yield* Schema.decodeEffect(PortableDashboardFromJson)(dashboard_json).pipe(
						Effect.mapError(
							(cause) =>
								new McpQueryError({
									message: "Invalid dashboard JSON",
									pipeName: "update_dashboard",
									cause,
								}),
						),
					)
				: null

			const dashboardIdBranded = decodeDashboardId(dashboard_id)

			const nowMillis = yield* Clock.currentTimeMillis
			const now = decodeIsoDateTimeString(new Date(nowMillis).toISOString())

			const result = yield* persistence
				.mutate(tenant.orgId, tenant.userId, dashboardIdBranded, (existing) =>
					Effect.sync(() => {
						// `description`/`tags` are `Schema.optionalKey` on `DashboardDocument`;
						// the Schema.Class constructor permits an absent key but rejects a
						// present `undefined`. A tag-less / description-less dashboard surfaces
						// those fields as `undefined`, so omit the key instead of forwarding it.
						if (portable) {
							return new DashboardDocument({
								id: existing.id,
								name: portable.name,
								...(portable.description !== undefined && {
									description: portable.description,
								}),
								...(portable.tags !== undefined && { tags: portable.tags }),
								timeRange: portable.timeRange,
								widgets: portable.widgets,
								createdAt: existing.createdAt,
								updatedAt: now,
							})
						}

						const timeRange = time_range
							? {
									type: "relative" as const,
									value: time_range,
								}
							: existing.timeRange

						const nextDescription = description ?? existing.description

						return new DashboardDocument({
							id: existing.id,
							name: name ?? existing.name,
							...(nextDescription !== undefined && { description: nextDescription }),
							...(existing.tags !== undefined && { tags: existing.tags }),
							timeRange,
							widgets: existing.widgets,
							createdAt: existing.createdAt,
							updatedAt: now,
						})
					}),
				)
				.pipe(
					Effect.map((dashboard) => ({ ok: true as const, dashboard })),
					Effect.catchTag("@maple/http/errors/DashboardNotFoundError", () =>
						Effect.succeed({ ok: false as const }),
					),
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "update_dashboard",
								cause: error,
							}),
					),
				)

			if (!result.ok) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Dashboard not found: ${dashboard_id}. Use list_dashboards to find available dashboard IDs.`,
						},
					],
				}
			}

			const { dashboard } = result

			const lines: string[] = [
				`## Dashboard Updated`,
				`ID: ${dashboard.id}`,
				`Name: ${dashboard.name}`,
				`Widgets: ${dashboard.widgets.length}`,
				`Updated: ${dashboard.updatedAt.slice(0, 19)}`,
			]

			if (dashboard.description) {
				lines.splice(3, 0, `Description: ${dashboard.description}`)
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "update_dashboard",
					data: {
						dashboard: {
							id: dashboard.id,
							name: dashboard.name,
							description: dashboard.description,
							tags: dashboard.tags ? [...dashboard.tags] : undefined,
							widgetCount: dashboard.widgets.length,
							createdAt: dashboard.createdAt,
							updatedAt: dashboard.updatedAt,
						},
					},
				}),
			}
		}),
	)
}
