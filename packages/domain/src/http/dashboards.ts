import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	DashboardId,
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardVersionId,
	IsoDateTimeString,
	UserId,
} from "../primitives"
import { Authorization } from "./current-tenant"

const TimeRangeSchema = Schema.Union([
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

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const StringRecord = Schema.Record(Schema.String, Schema.String)

export const WidgetDataSourceSchema = Schema.Struct({
	endpoint: Schema.String,
	params: Schema.optionalKey(UnknownRecord),
	transform: Schema.optionalKey(
		Schema.Struct({
			fieldMap: Schema.optionalKey(StringRecord),
			hideSeries: Schema.optionalKey(
				Schema.Struct({
					baseNames: Schema.Array(Schema.String),
				}),
			),
			flattenSeries: Schema.optionalKey(
				Schema.Struct({
					valueField: Schema.String,
				}),
			),
			reduceToValue: Schema.optionalKey(
				Schema.Struct({
					field: Schema.String,
					aggregate: Schema.optionalKey(Schema.String),
				}),
			),
			computeRatio: Schema.optionalKey(
				Schema.Struct({
					numeratorName: Schema.String,
					denominatorNames: Schema.Array(Schema.String),
				}),
			),
			limit: Schema.optionalKey(Schema.Number),
			sortBy: Schema.optionalKey(
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
	unit: Schema.optionalKey(Schema.String),
	width: Schema.optionalKey(Schema.Number),
	align: Schema.optionalKey(Schema.Literals(["left", "center", "right"])),
	hidden: Schema.optionalKey(Schema.Boolean),
	thresholds: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				value: Schema.Number,
				color: Schema.String,
			}),
		),
	),
})

export const WidgetDisplayConfigSchema = Schema.Struct({
	title: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.String),
	chartId: Schema.optionalKey(Schema.String),
	chartPresentation: Schema.optionalKey(
		Schema.Struct({
			legend: Schema.optionalKey(Schema.Literals(["visible", "hidden", "right"])),
			seriesStats: Schema.optionalKey(Schema.Boolean),
			tooltip: Schema.optionalKey(Schema.Literals(["visible", "hidden"])),
			showPoints: Schema.optionalKey(Schema.Boolean),
			fillNulls: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Literal(false)])),
			compareToPreviousPeriod: Schema.optionalKey(Schema.Boolean),
		}),
	),
	xAxis: Schema.optionalKey(
		Schema.Struct({
			label: Schema.optionalKey(Schema.String),
			unit: Schema.optionalKey(Schema.String),
			visible: Schema.optionalKey(Schema.Boolean),
		}),
	),
	yAxis: Schema.optionalKey(
		Schema.Struct({
			label: Schema.optionalKey(Schema.String),
			unit: Schema.optionalKey(Schema.String),
			min: Schema.optionalKey(Schema.Number),
			max: Schema.optionalKey(Schema.Number),
			softMin: Schema.optionalKey(Schema.Number),
			softMax: Schema.optionalKey(Schema.Number),
			logScale: Schema.optionalKey(Schema.Boolean),
			visible: Schema.optionalKey(Schema.Boolean),
		}),
	),
	seriesMapping: Schema.optionalKey(StringRecord),
	colorOverrides: Schema.optionalKey(StringRecord),
	stacked: Schema.optionalKey(Schema.Boolean),
	curveType: Schema.optionalKey(Schema.Literals(["linear", "monotone"])),
	unit: Schema.optionalKey(Schema.String),
	thresholds: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				value: Schema.Number,
				color: Schema.String,
				label: Schema.optionalKey(Schema.String),
			}),
		),
	),
	prefix: Schema.optionalKey(Schema.String),
	suffix: Schema.optionalKey(Schema.String),
	sparkline: Schema.optionalKey(
		Schema.Struct({
			enabled: Schema.Boolean,
			dataSource: Schema.optionalKey(WidgetDataSourceSchema),
		}),
	),
	columns: Schema.optionalKey(Schema.Array(WidgetDisplayColumnSchema)),

	// List-specific
	listDataSource: Schema.optionalKey(Schema.String),
	listWhereClause: Schema.optionalKey(Schema.String),
	listLimit: Schema.optionalKey(Schema.Number),
	listRootOnly: Schema.optionalKey(Schema.Boolean),

	// Pie-specific
	pie: Schema.optionalKey(
		Schema.Struct({
			donut: Schema.optionalKey(Schema.Boolean),
			innerRadius: Schema.optionalKey(Schema.Number),
			showLabels: Schema.optionalKey(Schema.Boolean),
			showPercent: Schema.optionalKey(Schema.Boolean),
		}),
	),

	// Histogram-specific
	histogram: Schema.optionalKey(
		Schema.Struct({
			bucketCount: Schema.optionalKey(Schema.Number),
			bucketWidth: Schema.optionalKey(Schema.Number),
			logScaleY: Schema.optionalKey(Schema.Boolean),
		}),
	),

	// Heatmap-specific
	heatmap: Schema.optionalKey(
		Schema.Struct({
			colorScale: Schema.optionalKey(Schema.Literals(["viridis", "magma", "cividis", "blues", "reds"])),
			scaleType: Schema.optionalKey(Schema.Literals(["linear", "log"])),
		}),
	),

	// Gauge-specific
	gauge: Schema.optionalKey(
		Schema.Struct({
			min: Schema.optionalKey(Schema.Number),
			max: Schema.optionalKey(Schema.Number),
			style: Schema.optionalKey(Schema.Literals(["radial", "bar"])),
		}),
	),

	// Markdown-specific
	markdown: Schema.optionalKey(
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
	minW: Schema.optionalKey(Schema.Number),
	minH: Schema.optionalKey(Schema.Number),
	maxW: Schema.optionalKey(Schema.Number),
	maxH: Schema.optionalKey(Schema.Number),
})

export const DashboardWidgetSchema = Schema.Struct({
	id: Schema.String,
	visualization: Schema.String,
	dataSource: WidgetDataSourceSchema,
	display: WidgetDisplayConfigSchema,
	layout: WidgetLayoutSchema,
})

export class PortableDashboardDocument extends Schema.Class<PortableDashboardDocument>(
	"PortableDashboardDocument",
)({
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	widgets: Schema.Array(DashboardWidgetSchema),
}) {}

export class DashboardDocument extends Schema.Class<DashboardDocument>("DashboardDocument")({
	id: DashboardId,
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	widgets: Schema.Array(DashboardWidgetSchema),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class DashboardsListResponse extends Schema.Class<DashboardsListResponse>("DashboardsListResponse")({
	dashboards: Schema.Array(DashboardDocument),
}) {}

export class DashboardUpsertRequest extends Schema.Class<DashboardUpsertRequest>("DashboardUpsertRequest")({
	dashboard: DashboardDocument,
}) {}

export class DashboardCreateRequest extends Schema.Class<DashboardCreateRequest>("DashboardCreateRequest")({
	dashboard: PortableDashboardDocument,
}) {}

export class DashboardDeleteResponse extends Schema.Class<DashboardDeleteResponse>("DashboardDeleteResponse")(
	{
		id: DashboardId,
	},
) {}

// ---------------------------------------------------------------------------
// Versions / history
// ---------------------------------------------------------------------------

export const DashboardVersionChangeKind = Schema.Literals([
	"created",
	"renamed",
	"description_changed",
	"tags_changed",
	"time_range_changed",
	"widget_added",
	"widget_removed",
	"widget_updated",
	"layout_changed",
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
	limit: Schema.optionalKey(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
	),
	before: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt())),
})

export class DashboardVersionNotFoundError extends Schema.TaggedErrorClass<DashboardVersionNotFoundError>()(
	"@maple/http/errors/DashboardVersionNotFoundError",
	{
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardPersistenceError extends Schema.TaggedErrorClass<DashboardPersistenceError>()(
	"@maple/http/errors/DashboardPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class DashboardNotFoundError extends Schema.TaggedErrorClass<DashboardNotFoundError>()(
	"@maple/http/errors/DashboardNotFoundError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardValidationError extends Schema.TaggedErrorClass<DashboardValidationError>()(
	"@maple/http/errors/DashboardValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

export class DashboardConcurrencyError extends Schema.TaggedErrorClass<DashboardConcurrencyError>()(
	"@maple/http/errors/DashboardConcurrencyError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export class DashboardTemplateParameter extends Schema.Class<DashboardTemplateParameter>(
	"DashboardTemplateParameter",
)({
	key: DashboardTemplateParameterKey,
	label: Schema.String,
	description: Schema.String,
	required: Schema.Boolean,
	placeholder: Schema.optionalKey(Schema.String),
}) {}

export class DashboardTemplateMetadata extends Schema.Class<DashboardTemplateMetadata>(
	"DashboardTemplateMetadata",
)({
	id: DashboardTemplateId,
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	parameters: Schema.Array(DashboardTemplateParameter),
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

export class DashboardTemplateNotFoundError extends Schema.TaggedErrorClass<DashboardTemplateNotFoundError>()(
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
	.middleware(Authorization) {}
