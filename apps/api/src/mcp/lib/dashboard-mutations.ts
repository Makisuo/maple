import { Clock, Effect, Result, Schema } from "effect"
import { randomUUID } from "node:crypto"
import {
	DashboardId,
	DashboardWidgetSchema,
	IsoDateTimeString,
	TimeRangeSchema,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
	defaultWidgetLayout,
	findNextPosition,
	WIDGET_TYPES,
	type PanelType,
	widgetTypeByVisualization,
	withWidgets,
} from "@maple/domain/http"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { McpQueryError } from "@/mcp/tools/types"

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

export type DashboardWidget = typeof DashboardWidgetSchema.Type

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

/**
 * v2 data sources were `{ endpoint, params }`; v3 is a `kind`-discriminated
 * union. The MCP tool descriptions taught v2 long after the decoders moved to
 * v3, so this shape is what an agent trained on the old text — or on a stale
 * transcript — still sends. The raw decode error for a four-arm union is a wall
 * of per-arm failures that buries the one thing worth saying.
 *
 * Detection is deliberately narrow (a string `endpoint`, no `kind`) and the
 * result is an ERROR, not a coercion. `fromLegacyDataSource` would happily
 * convert this, but it is total by design — an endpoint name the agent invented
 * falls through to a `route` source and persists as a permanently blank widget.
 * Failing loudly with the v3 equivalent is the correction; guessing is not.
 */
const LegacyDataSourceFromJson = Schema.fromJsonString(
	Schema.Struct({
		endpoint: Schema.String,
		// A v3 source always carries `kind`; its absence is what identifies the
		// legacy shape. `Schema.Undefined` makes "must not be present" explicit
		// rather than a manual `=== undefined` guard.
		kind: Schema.optionalKey(Schema.Undefined),
	}),
)

const decodeLegacyDataSource = Schema.decodeUnknownResult(LegacyDataSourceFromJson)

const legacyDataSourceHint = (json: string): string | null => {
	const decoded = decodeLegacyDataSource(json)
	if (Result.isFailure(decoded)) return null

	const { endpoint } = decoded.success
	const equivalent =
		endpoint === "markdown_static"
			? '{"kind":"static"}'
			: endpoint === "raw_sql_chart"
				? '{"kind":"raw_sql","sql":"SELECT …"}'
				: endpoint.startsWith("custom_query_builder_")
					? `{"kind":"query","resultShape":"${endpoint.slice("custom_query_builder_".length)}","queries":[…]}`
					: `{"kind":"route","endpoint":"${endpoint}","params":{…}}`

	return (
		`This is the legacy v2 data-source shape (\`{"endpoint":"${endpoint}", …}\`). ` +
		`Widgets now use a \`kind\`-discriminated union — the v3 equivalent is \`${equivalent}\`. ` +
		"Note that a `query` source spreads `queries`/`formulas` at the TOP LEVEL (not under `params`) " +
		'and requires `resultShape`. Call `describe_dashboard_schema` with `section: "data_sources"` for the full shapes.'
	)
}

/**
 * The same hint, reached through a whole widget's `dataSource` field. Kept
 * separate so the widget decoder can look one level in without the caller
 * hand-rolling a parse.
 */
const WidgetDataSourceFieldFromJson = Schema.fromJsonString(Schema.Struct({ dataSource: Schema.Unknown }))

const decodeWidgetDataSourceField = Schema.decodeUnknownResult(WidgetDataSourceFieldFromJson)

const legacyWidgetDataSourceHint = (json: string): string | null => {
	const decoded = decodeWidgetDataSourceField(json)
	if (Result.isFailure(decoded)) return null
	return legacyDataSourceHint(JSON.stringify(decoded.success.dataSource))
}

export const decodeWidgetJson = (json: string, tool: string) =>
	Schema.decodeEffect(WidgetFromJson)(json).pipe(
		Effect.mapError((error) => {
			const hint = legacyWidgetDataSourceHint(json)
			return new McpQueryError({
				message: hint ? `Invalid widget_json: ${hint}` : `Invalid widget_json: ${String(error)}`,
				pipeName: tool,
				cause: error,
			})
		}),
	)

export const decodeDataSourceJson = (json: string, tool: string) =>
	Schema.decodeEffect(DataSourceFromJson)(json).pipe(
		Effect.mapError((error) => {
			const hint = legacyDataSourceHint(json)
			return hint
				? new McpQueryError({
						message: `Invalid data_source_json: ${hint}`,
						pipeName: tool,
						cause: error,
					})
				: jsonDecodeError("data_source_json", tool)(error)
		}),
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
 * Grid size by panel type.
 *
 * The `visualization` variant above cannot tell a bar from a line (both persist
 * as `"chart"`), and more importantly `widgetTypeByVisualization("chart")`
 * resolves to `line`, so any per-type `mcpWidth` on a chart-family panel would
 * be lost. Callers that have resolved a panel type should use this.
 */
export const defaultSizeForPanelType = (panelType: PanelType): { w: number; h: number } => {
	const meta = WIDGET_TYPES[panelType]
	return { w: meta.mcpWidth ?? meta.defaultLayout.w, h: meta.defaultLayout.h }
}

/**
 * Auto-layout is the shared `findNextPosition` from `@maple/widgets`, so a
 * widget an agent adds lands exactly where the "Add widget" button would put it.
 * This used to be a hand-maintained port of the web copy.
 */
export { findNextPosition as findNextWidgetPosition }

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

				// Everything but the widgets and `updatedAt` is carried forward
				// wholesale. Naming the fields here is exactly what used to drop
				// `sections`, `variables` and `refreshIntervalSeconds` from every
				// dashboard an agent touched.
				return withWidgets(existing, nextWidgets, now)
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
				"@maple/http/errors/DashboardStoredConfigInvalidError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
				"@maple/http/errors/DashboardConcurrencyError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
				"@maple/http/errors/DashboardValidationError": (error) =>
					Effect.fail(new McpQueryError({ message: error.message, pipeName: tool, cause: error })),
			}),
		)
})
