import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	DashboardId,
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardVersionId,
	IsoDateTimeString,
	PostgresTransactionId,
	UserId,
} from "../primitives"
import { Authorization } from "./current-tenant"
import { HEATMAP_COLOR_SCALES, HEATMAP_SCALE_TYPES } from "./widget-types"

export const TimeRangeSchema = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("relative"),
		value: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("absolute"),
		startTime: IsoDateTimeString,
		endTime: IsoDateTimeString,
	}),
])
export type TimeRange = typeof TimeRangeSchema.Type

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const StringRecord = Schema.Record(Schema.String, Schema.String)

export const WidgetDataSourceSchema = Schema.Struct({
	endpoint: Schema.String,
	params: Schema.optional(UnknownRecord),
	transform: Schema.optional(
		Schema.Struct({
			fieldMap: Schema.optional(StringRecord),
			hideSeries: Schema.optional(
				Schema.Struct({
					baseNames: Schema.Array(Schema.String),
				}),
			),
			flattenSeries: Schema.optional(
				Schema.Struct({
					valueField: Schema.String,
				}),
			),
			reduceToValue: Schema.optional(
				Schema.Struct({
					field: Schema.String,
					aggregate: Schema.optional(Schema.String),
				}),
			),
			computeRatio: Schema.optional(
				Schema.Struct({
					numeratorName: Schema.String,
					denominatorNames: Schema.Array(Schema.String),
				}),
			),
			limit: Schema.optional(Schema.Number),
			sortBy: Schema.optional(
				Schema.Struct({
					field: Schema.String,
					direction: Schema.String,
				}),
			),
		}),
	),
})

const WidgetDisplayColumnSchema = Schema.Struct({
	field: Schema.String,
	header: Schema.String,
	unit: Schema.optional(Schema.String),
	width: Schema.optional(Schema.Number),
	align: Schema.optional(Schema.Literals(["left", "center", "right"])),
	hidden: Schema.optional(Schema.Boolean),
	thresholds: Schema.optional(
		Schema.Array(
			Schema.Struct({
				value: Schema.Number,
				color: Schema.String,
			}),
		),
	),
})

export const WidgetDisplayConfigSchema = Schema.Struct({
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	chartId: Schema.optional(Schema.String),
	chartPresentation: Schema.optional(
		Schema.Struct({
			legend: Schema.optional(Schema.Literals(["visible", "hidden", "right"])),
			seriesStats: Schema.optional(Schema.Boolean),
			tooltip: Schema.optional(Schema.Literals(["visible", "hidden"])),
			showPoints: Schema.optional(Schema.Boolean),
			fillNulls: Schema.optional(Schema.Union([Schema.Number, Schema.Literal(false)])),
			compareToPreviousPeriod: Schema.optional(Schema.Boolean),
		}),
	),
	xAxis: Schema.optional(
		Schema.Struct({
			label: Schema.optional(Schema.String),
			unit: Schema.optional(Schema.String),
			visible: Schema.optional(Schema.Boolean),
		}),
	),
	yAxis: Schema.optional(
		Schema.Struct({
			label: Schema.optional(Schema.String),
			unit: Schema.optional(Schema.String),
			min: Schema.optional(Schema.Number),
			max: Schema.optional(Schema.Number),
			softMin: Schema.optional(Schema.Number),
			softMax: Schema.optional(Schema.Number),
			logScale: Schema.optional(Schema.Boolean),
			// When true, the y-axis lower bound follows the minimum of the
			// displayed data (with padding) instead of being pinned at zero,
			// making small fluctuations between series easier to see. Ignored
			// when `softMin`/`min` or `logScale` are set.
			fitYAxisToData: Schema.optional(Schema.Boolean),
			visible: Schema.optional(Schema.Boolean),
		}),
	),
	seriesMapping: Schema.optional(StringRecord),
	colorOverrides: Schema.optional(StringRecord),
	stacked: Schema.optional(Schema.Boolean),
	curveType: Schema.optional(Schema.Literals(["linear", "monotone"])),
	unit: Schema.optional(Schema.String),
	thresholds: Schema.optional(
		Schema.Array(
			Schema.Struct({
				value: Schema.Number,
				color: Schema.String,
				label: Schema.optional(Schema.String),
			}),
		),
	),
	prefix: Schema.optional(Schema.String),
	suffix: Schema.optional(Schema.String),
	sparkline: Schema.optional(
		Schema.Struct({
			enabled: Schema.Boolean,
			dataSource: Schema.optional(WidgetDataSourceSchema),
		}),
	),
	columns: Schema.optional(Schema.Array(WidgetDisplayColumnSchema)),

	listDataSource: Schema.optional(Schema.String),
	listWhereClause: Schema.optional(Schema.String),
	listLimit: Schema.optional(Schema.Number),
	listRootOnly: Schema.optional(Schema.Boolean),

	// Pie-specific
	pie: Schema.optional(
		Schema.Struct({
			donut: Schema.optional(Schema.Boolean),
			innerRadius: Schema.optional(Schema.Number),
			showLabels: Schema.optional(Schema.Boolean),
			showPercent: Schema.optional(Schema.Boolean),
		}),
	),

	// Funnel-specific
	funnel: Schema.optional(
		Schema.Struct({
			showStepPercent: Schema.optional(Schema.Boolean),
		}),
	),

	// Histogram-specific
	histogram: Schema.optional(
		Schema.Struct({
			bucketCount: Schema.optional(Schema.Number),
			bucketWidth: Schema.optional(Schema.Number),
			logScaleY: Schema.optional(Schema.Boolean),
		}),
	),

	heatmap: Schema.optional(
		Schema.Struct({
			colorScale: Schema.optional(Schema.Literals(HEATMAP_COLOR_SCALES)),
			scaleType: Schema.optional(Schema.Literals(HEATMAP_SCALE_TYPES)),
		}),
	),

	gauge: Schema.optional(
		Schema.Struct({
			min: Schema.optional(Schema.Number),
			max: Schema.optional(Schema.Number),
			style: Schema.optional(Schema.Literals(["radial", "bar"])),
		}),
	),

	// Markdown-specific
	markdown: Schema.optional(
		Schema.Struct({
			content: Schema.String,
		}),
	),
})

export const WidgetLayoutSchema = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: Schema.optional(Schema.Number),
	minH: Schema.optional(Schema.Number),
	maxW: Schema.optional(Schema.Number),
	maxH: Schema.optional(Schema.Number),
})

// Sections (collapsible widget groups, optionally tabbed)

export const DASHBOARD_MAX_SECTIONS = 50
export const DASHBOARD_MAX_TABS_PER_SECTION = 20

export const DashboardSectionTabSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
})
export type DashboardSectionTab = typeof DashboardSectionTabSchema.Type

/**
 * A collapsible group of widgets, optionally split into tabs.
 *
 * Invariants — enforced by `sanitizeDashboardSections` on write, deliberately
 * NOT by schema `check`s: `tabs` is non-empty, and every widget carrying this
 * section's id also carries one of its tab ids. A document that violates them
 * must still decode (a widget pointing at a deleted section becomes ungrouped)
 * rather than failing the whole dashboard read.
 *
 * One tab renders as a plain group header; two or more render a tab bar.
 */
export const DashboardSectionSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	// The *stored default* collapse state. Per-viewer overrides ride the URL
	// (`?collapsed=`/`?expanded=`), so one person collapsing a group on their
	// screen never changes what the next person sees.
	collapsed: Schema.optionalKey(Schema.Boolean),
	// Absent or `true`: the group has a chevron and any viewer may fold it away.
	// `false` pins it open — no chevron, and a `?collapsed=` override naming it is
	// ignored rather than hiding a group the viewer has no control to reopen.
	// Use it for the band a dashboard is *about*, which should never be hidden.
	collapsible: Schema.optionalKey(Schema.Boolean),
	tabs: Schema.Array(DashboardSectionTabSchema).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(DASHBOARD_MAX_TABS_PER_SECTION),
	),
})
export type DashboardSection = typeof DashboardSectionSchema.Type

const DashboardSectionsSchema = Schema.Array(DashboardSectionSchema).check(
	Schema.isMaxLength(DASHBOARD_MAX_SECTIONS),
)

export const DashboardWidgetSchema = Schema.Struct({
	id: Schema.String,
	visualization: Schema.String,
	dataSource: WidgetDataSourceSchema,
	display: WidgetDisplayConfigSchema,
	layout: WidgetLayoutSchema,
	// Per-widget time range. Absent (the common case) means "follow the
	// dashboard's range" — the tile re-queries whenever the board's picker moves.
	// When set, the tile is pinned to its own window regardless of the board's,
	// which is how a "last 30 minutes" health stat lives on a 7-day board. The
	// override only replaces the time window: dashboard variables still
	// interpolate normally, and the board's auto-refresh still rebases a relative
	// override against "now".
	timeRange: Schema.optionalKey(TimeRangeSchema),
	// Group membership. Absent means the widget lives on the root canvas, which
	// renders above every section. `layout.x/y` are relative to the widget's
	// *container* — the root canvas, or the (section, tab) named here — never to
	// one global canvas, so every container's coordinate space starts at (0, 0).
	sectionId: Schema.optionalKey(Schema.String),
	tabId: Schema.optionalKey(Schema.String),
})

// Dashboard variables

// Must not start with an underscore so `$name` references can never collide
// with the `$__` built-in macros ($__startTime, $__timeFilter, ...).
export const DashboardVariableName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/),
).annotate({ identifier: "@maple/DashboardVariableName", title: "Dashboard Variable Name" })
export type DashboardVariableName = Schema.Schema.Type<typeof DashboardVariableName>

/**
 * Auto-refresh cadence in seconds; `0` or absent means off. A closed literal set
 * rather than a free number so a hand-edited document (or `?refresh=`) can't ask
 * the browser to re-query every 100ms.
 */
export const DashboardRefreshIntervalSeconds = Schema.Literals([0, 5, 10, 30, 60, 300, 900]).annotate({
	identifier: "@maple/DashboardRefreshIntervalSeconds",
	title: "Dashboard Refresh Interval Seconds",
})
export type DashboardRefreshIntervalSeconds = typeof DashboardRefreshIntervalSeconds.Type

export const DashboardQueryVariableFacet = Schema.Literals([
	"service",
	"environment",
	"span_name",
	"http_method",
	"http_status_code",
	"log_severity",
])
export type DashboardQueryVariableFacet = typeof DashboardQueryVariableFacet.Type

export const DashboardQueryVariableSourceSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("facet"),
		facet: DashboardQueryVariableFacet,
	}),
	Schema.Struct({
		kind: Schema.Literal("attribute"),
		scope: Schema.Literals(["span", "resource"]),
		attributeKey: Schema.String,
	}),
])
export type DashboardQueryVariableSource = typeof DashboardQueryVariableSourceSchema.Type

const dashboardVariableBaseFields = {
	name: DashboardVariableName,
	label: Schema.optionalKey(Schema.String),
	includeAll: Schema.optionalKey(Schema.Boolean),
	defaultValue: Schema.optionalKey(Schema.String),
}

export const DashboardVariableSchema = Schema.Union([
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("query"),
		source: DashboardQueryVariableSourceSchema,
	}),
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("custom"),
		options: Schema.Array(
			Schema.Struct({
				value: Schema.String,
				label: Schema.optionalKey(Schema.String),
			}),
		),
	}),
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("textbox"),
	}),
])
export type DashboardVariable = typeof DashboardVariableSchema.Type

export class PortableDashboardDocument extends Schema.Class<PortableDashboardDocument>(
	"PortableDashboardDocument",
)({
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	widgets: Schema.Array(DashboardWidgetSchema),
	sections: Schema.optionalKey(DashboardSectionsSchema),
	variables: Schema.optionalKey(Schema.Array(DashboardVariableSchema)),
	refreshIntervalSeconds: Schema.optionalKey(DashboardRefreshIntervalSeconds),
}) {}

export class DashboardDocument extends Schema.Class<DashboardDocument>("DashboardDocument")({
	id: DashboardId,
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	widgets: Schema.Array(DashboardWidgetSchema),
	sections: Schema.optionalKey(DashboardSectionsSchema),
	variables: Schema.optionalKey(Schema.Array(DashboardVariableSchema)),
	refreshIntervalSeconds: Schema.optionalKey(DashboardRefreshIntervalSeconds),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	// Postgres transaction id of the write that produced this response, present
	// only on mutation responses (create/upsert/restore/import). The web's
	// ElectricSQL collection write handlers pass it to `awaitTxId` to resolve
	// optimistic state on the exact synced transaction. Never persisted into
	// `payload_json` (stripped at the storage boundary) and never present on
	// list/read responses.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class DashboardsListResponse extends Schema.Class<DashboardsListResponse>("DashboardsListResponse")({
	dashboards: Schema.Array(DashboardDocument),
}) {}

export class DashboardUpsertRequest extends Schema.Class<DashboardUpsertRequest>("DashboardUpsertRequest")(
	{ dashboard: DashboardDocument },
	{ parseOptions: { reportInput: true } },
) {}

export class DashboardCreateRequest extends Schema.Class<DashboardCreateRequest>("DashboardCreateRequest")(
	{ dashboard: PortableDashboardDocument },
	{ parseOptions: { reportInput: true } },
) {}

export class DashboardPersesImportRequest extends Schema.Class<DashboardPersesImportRequest>(
	"DashboardPersesImportRequest",
)({
	dashboard: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class DashboardPersesImportResponse extends Schema.Class<DashboardPersesImportResponse>(
	"DashboardPersesImportResponse",
)({
	dashboard: DashboardDocument,
	warnings: Schema.Array(Schema.String),
	// Txid of the import write, for the Electric collection's onInsert handler.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class DashboardDeleteResponse extends Schema.Class<DashboardDeleteResponse>("DashboardDeleteResponse")(
	{
		id: DashboardId,
		// Txid of the delete, for the Electric collection's onDelete handler.
		txid: Schema.optionalKey(PostgresTransactionId),
	},
) {}

// Versions / history

export const DashboardVersionChangeKind = Schema.Literals([
	"created",
	"renamed",
	"description_changed",
	"tags_changed",
	"time_range_changed",
	"variables_changed",
	"refresh_interval_changed",
	"widget_added",
	"widget_removed",
	"widget_updated",
	"layout_changed",
	// Section edits collapse into three kinds. Renames, tab add/rename/delete,
	// reordering and the stored collapse default all read as `section_updated`:
	// the history panel shows a summary line, not a structural diff, so finer
	// granularity would add enum members nothing renders differently. Moving a
	// widget between sections is `layout_changed` — it genuinely is a layout act.
	"section_added",
	"section_removed",
	"section_updated",
	"restored",
	"multiple",
]).annotate({
	identifier: "@maple/DashboardVersionChangeKind",
	title: "Dashboard Version Change Kind",
})
export type DashboardVersionChangeKind = Schema.Schema.Type<typeof DashboardVersionChangeKind>

export class DashboardVersionSummary extends Schema.Class<DashboardVersionSummary>("DashboardVersionSummary")(
	{
		id: DashboardVersionId,
		dashboardId: DashboardId,
		versionNumber: Schema.Number,
		changeKind: DashboardVersionChangeKind,
		changeSummary: Schema.NullOr(Schema.String),
		sourceVersionId: Schema.NullOr(DashboardVersionId),
		createdAt: IsoDateTimeString,
		createdBy: UserId,
	},
) {}

export class DashboardVersionDetail extends Schema.Class<DashboardVersionDetail>("DashboardVersionDetail")({
	id: DashboardVersionId,
	dashboardId: DashboardId,
	versionNumber: Schema.Number,
	changeKind: DashboardVersionChangeKind,
	changeSummary: Schema.NullOr(Schema.String),
	sourceVersionId: Schema.NullOr(DashboardVersionId),
	createdAt: IsoDateTimeString,
	createdBy: UserId,
	snapshot: DashboardDocument,
}) {}

export class DashboardVersionsListResponse extends Schema.Class<DashboardVersionsListResponse>(
	"DashboardVersionsListResponse",
)({
	versions: Schema.Array(DashboardVersionSummary),
	hasMore: Schema.Boolean,
}) {}

const DashboardVersionsListQuery = Schema.Struct({
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
	),
	before: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
})

export class DashboardVersionNotFoundError extends Schema.TaggedError<DashboardVersionNotFoundError>()(
	"@maple/http/errors/DashboardVersionNotFoundError",
	{
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardPersistenceError extends Schema.TaggedError<DashboardPersistenceError>()(
	"@maple/http/errors/DashboardPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class DashboardNotFoundError extends Schema.TaggedError<DashboardNotFoundError>()(
	"@maple/http/errors/DashboardNotFoundError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardValidationError extends Schema.TaggedError<DashboardValidationError>()(
	"@maple/http/errors/DashboardValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

/**
 * Rewrites request-decode failures on the dashboards group into a
 * `DashboardValidationError` carrying the JSON path, the enclosing widget id
 * and the expected-vs-received message for every offending field.
 *
 * Without it the runtime answers a schema failure with a bare empty 400, so the
 * only way to find one bad key in a 14-widget document is to bisect it. The
 * error class is already in every endpoint's error list, so attaching this
 * widens no client contract.
 */
export class DashboardSchemaErrors extends HttpApiMiddleware.Service<DashboardSchemaErrors>()(
	"DashboardSchemaErrors",
	{ error: DashboardValidationError },
) {}

export class DashboardConcurrencyError extends Schema.TaggedError<DashboardConcurrencyError>()(
	"@maple/http/errors/DashboardConcurrencyError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

// Templates

export class DashboardTemplateParameter extends Schema.Class<DashboardTemplateParameter>(
	"DashboardTemplateParameter",
)({
	key: DashboardTemplateParameterKey,
	label: Schema.String,
	description: Schema.String,
	required: Schema.Boolean,
	placeholder: Schema.optionalKey(Schema.String),
}) {}

/**
 * Panel type of a widget in a template thumbnail. Mirrors `PanelType` in
 * `./widget-types` — spelled out here because the API surface is a wire schema,
 * not a derived one, so widening it stays a deliberate, reviewable edit.
 */
export const DashboardTemplatePreviewKind = Schema.Literals([
	"line",
	"area",
	"bar",
	"stat",
	"gauge",
	"table",
	"list",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
	"hbar",
	"markdown",
])
export type DashboardTemplatePreviewKind = typeof DashboardTemplatePreviewKind.Type

export class DashboardTemplatePreviewWidget extends Schema.Class<DashboardTemplatePreviewWidget>(
	"DashboardTemplatePreviewWidget",
)({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	kind: DashboardTemplatePreviewKind,
	title: Schema.String,
}) {}

export const DashboardTemplateRequirementKind = Schema.Literals(["metrics", "integration", "telemetry"])
export type DashboardTemplateRequirementKind = typeof DashboardTemplateRequirementKind.Type

/**
 * What an org needs before a template's widgets have anything to draw. The
 * picker states it twice at different lengths — `missing` next to the template
 * name, `collector` in the detail panel — so neither has to be recovered from
 * prose by the client.
 */
export const DashboardTemplateRequirement = Schema.Struct({
	kind: DashboardTemplateRequirementKind,
	/** Full prose; the same string the `requirements` array carries. */
	label: Schema.String,
	/**
	 * Row-sized statement of what's missing ("not connected"). Absent for
	 * `metrics`, where clients derive `no <prefix>*` from
	 * `requiredMetricPrefixes`.
	 */
	missing: Schema.optionalKey(Schema.String),
	/** Noun phrase read as "Collected by {collector}." */
	collector: Schema.String,
	/** Noun phrase read as "Set up {setupLabel}". Absent for `telemetry`. */
	setupLabel: Schema.optionalKey(Schema.String),
	/** One extra sentence shown when the template is gated. */
	hint: Schema.optionalKey(Schema.String),
})
export type DashboardTemplateRequirement = typeof DashboardTemplateRequirement.Type

export class DashboardTemplateMetadata extends Schema.Class<DashboardTemplateMetadata>(
	"DashboardTemplateMetadata",
)({
	id: DashboardTemplateId,
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	/** Derived from `requirement.label`. Empty for the blank template. */
	requirements: Schema.Array(Schema.String),
	/** Null only for the blank template, which needs nothing. */
	requirement: Schema.NullOr(DashboardTemplateRequirement),
	/**
	 * Metric-name prefixes the template's widgets query; the picker greys out
	 * templates whose prefixes match none of the org's metrics. Empty array =
	 * never gated. An empty-string prefix means "any metric".
	 */
	requiredMetricPrefixes: Schema.Array(Schema.String),
	parameters: Schema.Array(DashboardTemplateParameter),
	preview: Schema.Array(DashboardTemplatePreviewWidget),
}) {}

export class DashboardTemplatesListResponse extends Schema.Class<DashboardTemplatesListResponse>(
	"DashboardTemplatesListResponse",
)({
	templates: Schema.Array(DashboardTemplateMetadata),
}) {}

export class DashboardTemplateInstantiateRequest extends Schema.Class<DashboardTemplateInstantiateRequest>(
	"DashboardTemplateInstantiateRequest",
)({
	parameters: Schema.optionalKey(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
	name: Schema.optionalKey(Schema.String),
}) {}

export class DashboardTemplateNotFoundError extends Schema.TaggedError<DashboardTemplateNotFoundError>()(
	"@maple/http/errors/DashboardTemplateNotFoundError",
	{
		templateId: DashboardTemplateId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardsApiGroup extends HttpApiGroup.make("dashboards")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: DashboardsListResponse,
			error: DashboardPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: DashboardCreateRequest,
			success: DashboardDocument,
			error: [DashboardValidationError, DashboardPersistenceError, DashboardConcurrencyError],
		}),
	)
	.add(
		HttpApiEndpoint.post("importPerses", "/import/perses", {
			payload: DashboardPersesImportRequest,
			success: DashboardPersesImportResponse,
			error: [DashboardValidationError, DashboardPersistenceError, DashboardConcurrencyError],
		}),
	)
	.add(
		HttpApiEndpoint.put("upsert", "/:dashboardId", {
			params: {
				dashboardId: DashboardId,
			},
			payload: DashboardUpsertRequest,
			success: DashboardDocument,
			error: [
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
				DashboardNotFoundError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:dashboardId", {
			params: {
				dashboardId: DashboardId,
			},
			success: DashboardDeleteResponse,
			error: [DashboardNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listVersions", "/:dashboardId/versions", {
			params: { dashboardId: DashboardId },
			query: DashboardVersionsListQuery,
			success: DashboardVersionsListResponse,
			error: [DashboardNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getVersion", "/:dashboardId/versions/:versionId", {
			params: { dashboardId: DashboardId, versionId: DashboardVersionId },
			success: DashboardVersionDetail,
			error: [DashboardNotFoundError, DashboardVersionNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("restoreVersion", "/:dashboardId/versions/:versionId/restore", {
			params: { dashboardId: DashboardId, versionId: DashboardVersionId },
			success: DashboardDocument,
			error: [
				DashboardNotFoundError,
				DashboardVersionNotFoundError,
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listTemplates", "/templates", {
			success: DashboardTemplatesListResponse,
		}),
	)
	.add(
		HttpApiEndpoint.post("instantiateTemplate", "/templates/:templateId/instantiate", {
			params: { templateId: DashboardTemplateId },
			payload: DashboardTemplateInstantiateRequest,
			success: DashboardDocument,
			error: [
				DashboardTemplateNotFoundError,
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
			],
		}),
	)
	.prefix("/api/dashboards")
	.middleware(Authorization)
	.middleware(DashboardSchemaErrors) {}
