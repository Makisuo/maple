import { Clock, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import {
	DashboardDocument,
	DashboardId,
	DashboardWidgetSchema,
	IsoDateTimeString,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
} from "@maple/domain/http"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { McpQueryError } from "@/mcp/tools/types"

const decodeDashboardId = Schema.decodeUnknownSync(DashboardId)

export type DashboardWidget = typeof DashboardWidgetSchema.Type
export type WidgetLayout = typeof WidgetLayoutSchema.Type

const GRID_COLS = 12

const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

const WidgetFromJson = Schema.fromJsonString(DashboardWidgetSchema)
const DataSourceFromJson = Schema.fromJsonString(WidgetDataSourceSchema)
const DisplayFromJson = Schema.fromJsonString(WidgetDisplayConfigSchema)
const LayoutFromJson = Schema.fromJsonString(WidgetLayoutSchema)

const jsonDecodeError = (field: string, tool: string) => (error: unknown) =>
	new McpQueryError({
		message: `Invalid ${field}: ${String(error)}`,
		pipe: tool,
	})

export const decodeWidgetJson = (json: string, tool: string) =>
	Schema.decodeUnknownEffect(WidgetFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("widget_json", tool)),
	)

export const decodeDataSourceJson = (json: string, tool: string) =>
	Schema.decodeUnknownEffect(DataSourceFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("data_source_json", tool)),
	)

export const decodeDisplayJson = (json: string, tool: string) =>
	Schema.decodeUnknownEffect(DisplayFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("display_json", tool)),
	)

export const decodeLayoutJson = (json: string, tool: string) =>
	Schema.decodeUnknownEffect(LayoutFromJson)(json).pipe(
		Effect.mapError(jsonDecodeError("layout_json", tool)),
	)

export const generateWidgetId = (): string => randomUUID()

/**
 * Default grid size per visualization type. Mirrors the web store so
 * auto-placed widgets match what the "Add widget" UI would produce.
 */
export const defaultSizeForVisualization = (visualization: string): { w: number; h: number } => {
	switch (visualization) {
		case "stat":
			return { w: 3, h: 4 }
		case "gauge":
			return { w: 3, h: 5 }
		case "table":
		case "list":
			return { w: 6, h: 5 }
		default:
			return { w: 4, h: 5 }
	}
}

/**
 * Port of `findNextPosition` from
 * `apps/web/src/hooks/use-dashboard-store.ts:32-54`. Keeps auto-layout
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

export class DashboardMutationNotFound {
	readonly _tag = "DashboardMutationNotFound"
	constructor(readonly message: string) {}
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
export const withDashboardMutation = <E, R>(
	dashboardId: string,
	tool: string,
	transform: (
		existingWidgets: ReadonlyArray<DashboardWidget>,
	) => Effect.Effect<ReadonlyArray<DashboardWidget>, E, R>,
) =>
	Effect.gen(function* () {
		const tenant = yield* resolveTenant
		const persistence = yield* DashboardPersistenceService

		// `mutate` reports "not found" via a typed `DashboardNotFoundError` and
		// concurrency exhaustion via `DashboardConcurrencyError`. We collapse
		// the not-found case into the structured `notFound` return shape that
		// callers already render to the user, and map every other persistence
		// error onto `McpQueryError`.
		const dashboardIdBranded = decodeDashboardId(dashboardId)

		return yield* persistence
			.mutate(tenant.orgId, tenant.userId, dashboardIdBranded, (existing) =>
				Effect.gen(function* () {
					const nextWidgets = yield* transform(existing.widgets)
					const nowMs = yield* Clock.currentTimeMillis
					const now = decodeIsoDateTimeString(new Date(nowMs).toISOString())

					return new DashboardDocument({
						id: existing.id,
						name: existing.name,
						description: existing.description,
						tags: existing.tags,
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
				Effect.mapError((error) => {
					const message =
						error !== null &&
						typeof error === "object" &&
						"message" in error &&
						typeof (error as { message: unknown }).message === "string"
							? (error as { message: string }).message
							: String(error)
					return new McpQueryError({ message, pipe: tool })
				}),
			)
	})
