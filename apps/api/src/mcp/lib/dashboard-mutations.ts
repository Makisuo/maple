import { Clock, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import {
	DashboardDocument,
	DashboardId,
	DashboardWidgetSchema,
	IsoDateTimeString,
	TimeRangeSchema,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
	defaultWidgetLayout,
	widgetTypeByVisualization,
} from "@maple/domain/http"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { McpQueryError } from "@/mcp/tools/types"

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

export type DashboardWidget = typeof DashboardWidgetSchema.Type

const GRID_COLS = 12

const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

const WidgetFromJson = Schema.fromJsonString(DashboardWidgetSchema)
const DataSourceFromJson = Schema.fromJsonString(WidgetDataSourceSchema)
const DisplayFromJson = Schema.fromJsonString(WidgetDisplayConfigSchema)
const LayoutFromJson = Schema.fromJsonString(WidgetLayoutSchema)
const TimeRangeFromJson = Schema.fromJsonString(TimeRangeSchema)

const jsonDecodeError = (field: string, tool: string) => (error: unknown) =>
	new McpQueryError({
		message: `Invalid ${field}: ${String(error)}`,
		pipeName: tool,
		cause: error,
	})

export const decodeWidgetJson = (json: string, tool: string) =>
	Schema.decodeEffect(WidgetFromJson)(json).pipe(Effect.mapError(jsonDecodeError("widget_json", tool)))

export const decodeDataSourceJson = (json: string, tool: string) =>
	Schema.decodeEffect(DataSourceFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("data_source_json", tool)),
	)

export const decodeDisplayJson = (json: string, tool: string) =>
	Schema.decodeEffect(DisplayFromJson)(json).pipe(Effect.mapError(jsonDecodeError("display_json", tool)))

export const decodeLayoutJson = (json: string, tool: string) =>
	Schema.decodeEffect(LayoutFromJson)(json).pipe(Effect.mapError(jsonDecodeError("layout_json", tool)))

export const decodeTimeRangeJson = (json: string, tool: string) =>
	Schema.decodeEffect(TimeRangeFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("time_range_json", tool)),
	)

export const generateWidgetId = (): string => randomUUID()

/**
 * Default grid size per visualization type — the same table the web store reads,
 * so an MCP-added widget matches what the "Add widget" UI would produce. A gauge
 * is the one deliberate difference: agents get the narrow tile.
 */
export const defaultSizeForVisualization = (visualization: string): { w: number; h: number } => {
	const { w, h } = defaultWidgetLayout(visualization)
	return { w: widgetTypeByVisualization(visualization)?.mcpWidth ?? w, h }
}

/**
 * Port of `findNextPosition` from
 * `findNextPosition` in `apps/web/src/hooks/use-dashboard-store.ts`. Keeps auto-layout
 * behavior identical between UI-added and MCP-added widgets.
 */
export const findNextWidgetPosition = (
	widgets: ReadonlyArray<DashboardWidget>,
	newWidth: number,
): { x: number; y: number } => {
	if (widgets.length === 0) {
		return { x: 0, y: 0 }
	}

	const maxY = Math.max(...widgets.map((w) => w.layout.y))
	const bottomRowWidgets = widgets.filter((w) => w.layout.y === maxY)
	const rightEdge = Math.max(...bottomRowWidgets.map((w) => w.layout.x + w.layout.w))

	if (rightEdge + newWidth <= GRID_COLS) {
		return { x: rightEdge, y: maxY }
	}

	const maxBottom = Math.max(...widgets.map((w) => w.layout.y + w.layout.h))
	return { x: 0, y: maxBottom }
}

/**
 * Shared workflow: resolve tenant, load dashboard by id, run a pure transform
 * over its widgets, and persist the result. The transform receives the
 * existing widgets and should return the new widget array; any other change
 * (rename, description, etc.) should stay on the dedicated `update_dashboard`
 * tool.
 *
 * Concurrency: delegates to `persistence.mutate`, which uses a compare-and-swap
 * on `dashboards.version`. If a concurrent writer (another MCP call or web
 * edit) lands between our read and write the transform is re-applied on top
 * of the new state and retried. After exhausting the retry budget the caller
 * receives a `DashboardConcurrencyError` (mapped here to `McpQueryError`),
 * which is preferable to a silent lost update.
 */
export const withDashboardMutation = Effect.fn("withDashboardMutation")(function* <R>(
	dashboardId: string,
	tool: string,
	transform: (
		existingWidgets: ReadonlyArray<DashboardWidget>,
	) => Effect.Effect<ReadonlyArray<DashboardWidget>, McpQueryError, R>,
) {
	const tenant = yield* CurrentMcpTenant
	const persistence = yield* DashboardPersistenceService

	// `mutate` reports "not found" via a typed `DashboardNotFoundError` and
	// concurrency exhaustion via `DashboardConcurrencyError`. We collapse
	// the not-found case into the structured `notFound` return shape that
	// callers already render to the user, and map the remaining persistence
	// error tags onto `McpQueryError`.
	const dashboardIdBranded = yield* decodeDashboardId(dashboardId).pipe(
		Effect.mapError(
			(cause) =>
				new McpQueryError({
					message: `Invalid dashboard_id: ${dashboardId}. Use list_dashboards to find available dashboard IDs.`,
					pipeName: tool,
					cause,
				}),
		),
	)

	return yield* persistence
		.mutate(tenant.orgId, tenant.userId, dashboardIdBranded, (existing) =>
			Effect.gen(function* () {
				const nextWidgets = yield* transform(existing.widgets)
				const nowMillis = yield* Clock.currentTimeMillis
				const now = decodeIsoDateTimeString(new Date(nowMillis).toISOString())

				return new DashboardDocument({
					id: existing.id,
					name: existing.name,
					// `description`/`tags` are `Schema.optionalKey` — the Schema.Class
					// constructor permits the key to be *absent* but rejects a present
					// `undefined` ("Expected array, got undefined"). A dashboard stored
					// without either field surfaces as `undefined` here, so omit the key
					// rather than forwarding `undefined` and crashing the mutation.
					...(existing.description !== undefined && { description: existing.description }),
					...(existing.tags !== undefined && { tags: existing.tags }),
					timeRange: existing.timeRange,
					widgets: nextWidgets,
					createdAt: existing.createdAt,
					updatedAt: now,
				})
			}),
		)
		.pipe(
			Effect.map((dashboard) => ({ ok: true as const, dashboard })),
			Effect.catchTag("@maple/http/errors/DashboardNotFoundError", () =>
				Effect.succeed({
					ok: false as const,
					notFound: `Dashboard not found: ${dashboardId}. Use list_dashboards to find available dashboard IDs.`,
				}),
			),
			Effect.catchTags({
				"@maple/http/errors/DashboardPersistenceError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
				"@maple/http/errors/DashboardConcurrencyError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
				"@maple/http/errors/DashboardValidationError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
			}),
		)
})
