import { McpQueryError, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { DashboardDocument, PortableDashboardDocument } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain"

const PortableDashboardFromJson = Schema.fromJsonString(PortableDashboardDocument)
const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

const TIME_RANGE_MAP: Record<string, string> = {
	"1h": "1h",
	"6h": "6h",
	"24h": "24h",
	"7d": "7d",
}

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
			time_range: optionalStringParam("New time range: 1h, 6h, 24h, or 7d"),
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
			const tenant = yield* resolveTenant
			const persistence = yield* DashboardPersistenceService

			const result = yield* persistence.list(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "update_dashboard",
						}),
				),
			)

			const existing = result.dashboards.find((d) => d.id === dashboard_id)

			if (!existing) {
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

			const now = decodeIsoDateTimeString(new Date().toISOString())

			let updated: DashboardDocument

			if (dashboard_json) {
				const portable = yield* Schema.decodeUnknownEffect(PortableDashboardFromJson)(
					dashboard_json,
				).pipe(
					Effect.mapError(
						() =>
							new McpQueryError({
								message: "Invalid dashboard JSON",
								pipe: "update_dashboard",
							}),
					),
				)

				updated = new DashboardDocument({
					id: existing.id,
					name: portable.name,
					description: portable.description,
					tags: portable.tags,
					timeRange: portable.timeRange,
					widgets: portable.widgets,
					createdAt: existing.createdAt,
					updatedAt: now,
				})
			} else {
				const timeRange = time_range
					? {
							type: "relative" as const,
							value: TIME_RANGE_MAP[time_range] ?? time_range,
						}
					: existing.timeRange

				updated = new DashboardDocument({
					id: existing.id,
					name: name ?? existing.name,
					description: description ?? existing.description,
					tags: existing.tags,
					timeRange,
					widgets: existing.widgets,
					createdAt: existing.createdAt,
					updatedAt: now,
				})
			}

			const dashboard = yield* persistence.upsert(tenant.orgId, tenant.userId, updated).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "update_dashboard",
						}),
				),
			)

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
