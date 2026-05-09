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
	align: Schema.optional(Schema.String),
})

export const WidgetDisplayConfigSchema = Schema.Struct({
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	chartId: Schema.optional(Schema.String),
	chartPresentation: Schema.optional(
		Schema.Struct({
			legend: Schema.optional(Schema.String),
			tooltip: Schema.optional(Schema.String),
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
			visible: Schema.optional(Schema.Boolean),
		}),
	),
	seriesMapping: Schema.optional(StringRecord),
	colorOverrides: Schema.optional(StringRecord),
	stacked: Schema.optional(Schema.Boolean),
	curveType: Schema.optional(Schema.String),
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

	// List-specific
	listDataSource: Schema.optional(Schema.String),
	listWhereClause: Schema.optional(Schema.String),
	listLimit: Schema.optional(Schema.Number),
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
	description: Schema.optional(Schema.String),
	tags: Schema.optional(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	widgets: Schema.Array(DashboardWidgetSchema),
}) {}

export class DashboardDocument extends Schema.Class<DashboardDocument>("DashboardDocument")({
	id: DashboardId,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	tags: Schema.optional(Schema.Array(Schema.String)),
	timeRange: TimeRangeSchema,
	variables: Schema.optional(Schema.Array(Schema.Unknown)),
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
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
	),
	before: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
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
	placeholder: Schema.optional(Schema.String),
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
	parameters: Schema.optional(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
	name: Schema.optional(Schema.String),
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
