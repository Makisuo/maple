import { McpQueryError, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { withDashboardMutation } from "../lib/dashboard-mutations"

const TOOL = "reorder_dashboard_widgets"

const LayoutEntrySchema = Schema.Struct({
	widget_id: Schema.String,
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: Schema.optional(Schema.Number),
	minH: Schema.optional(Schema.Number),
	maxW: Schema.optional(Schema.Number),
	maxH: Schema.optional(Schema.Number),
})

const LayoutsFromJson = Schema.fromJsonString(Schema.Array(LayoutEntrySchema))

export function registerReorderDashboardWidgetsTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Reposition or resize one or more widgets on a dashboard in a single call. Only the widgets you include are touched; any widget id not present in layouts_json keeps its existing layout. Useful for drag/drop-style moves without re-sending unrelated widget state.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard to reorder (use list_dashboards to find IDs)",
			),
			layouts_json: requiredStringParam(
				"JSON array of layout updates: [{ widget_id, x, y, w, h, minW?, minH?, maxW?, maxH? }, ...]. Only listed widgets are updated.",
			),
		}),
		Effect.fn("McpTool.reorderDashboardWidgets")(function* ({ dashboard_id, layouts_json }) {
			const layouts = yield* Schema.decodeUnknownEffect(LayoutsFromJson)(layouts_json).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: `Invalid layouts_json: ${String(error)}`,
							pipe: TOOL,
						}),
				),
			)

			if (layouts.length === 0) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "layouts_json must contain at least one layout entry.",
						},
					],
				}
			}

			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					const layoutById = new Map(layouts.map((entry) => [entry.widget_id, entry] as const))

					const unknownIds = layouts
						.filter((entry) => !existingWidgets.some((w) => w.id === entry.widget_id))
						.map((entry) => entry.widget_id)

					if (unknownIds.length > 0) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Unknown widget ids in layouts_json: ${unknownIds.join(", ")}. Use get_dashboard to see existing widget ids.`,
								pipe: TOOL,
							}),
						)
					}

					return existingWidgets.map((widget) => {
						const update = layoutById.get(widget.id)
						if (!update) return widget
						return {
							...widget,
							layout: {
								x: update.x,
								y: update.y,
								w: update.w,
								h: update.h,
								minW: update.minW,
								minH: update.minH,
								maxW: update.maxW,
								maxH: update.maxH,
							},
						}
					})
				}),
			)

			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: result.notFound }],
				}
			}

			const { dashboard } = result

			const lines = [
				`## Widgets Reordered`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Widgets updated: ${layouts.length}`,
				`Total widgets: ${dashboard.widgets.length}`,
				`Updated: ${dashboard.updatedAt.slice(0, 19)}`,
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: TOOL,
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
						updatedWidgetIds: layouts.map((entry) => entry.widget_id),
					},
				}),
			}
		}),
	)
}
