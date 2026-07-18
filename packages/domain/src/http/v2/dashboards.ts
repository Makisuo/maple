import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema, SchemaGetter } from "effect"
import {
	DashboardId,
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardVersionId,
	PostgresTransactionId,
	UserId,
} from "../../primitives"
import { DashboardQueryVariableFacet, DashboardVariableName, DashboardVersionChangeKind } from "../dashboards"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ConflictError, V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

export const DashboardPublicId = PublicId(PublicIdPrefixes.dashboard, DashboardId)
export const DashboardVersionPublicId = PublicId(PublicIdPrefixes.dashboardVersion, DashboardVersionId)
export const DashboardTemplatePublicId = PublicId(PublicIdPrefixes.dashboardTemplate, DashboardTemplateId)

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

export const V2TimeRange = Schema.Union([
	Schema.Struct({ type: Schema.Literal("relative"), value: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("absolute"),
		startTime: Timestamp,
		endTime: Timestamp,
	}).pipe(Schema.encodeKeys({ startTime: "start_time", endTime: "end_time" })),
]).annotate({ identifier: "DashboardTimeRange", title: "Dashboard time range" })

const StringRecord = Schema.Record(Schema.String, Schema.String)
const UnknownRecordWire = Schema.Record(Schema.String, Schema.Unknown)

const mapJsonKeys = (value: unknown, mapKey: (key: string) => string): unknown => {
	if (Array.isArray(value)) return value.map((item) => mapJsonKeys(item, mapKey))
	if (typeof value !== "object" || value === null) return value
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [mapKey(key), mapJsonKeys(item, mapKey)]),
	)
}

const toSnakeKey = (key: string): string =>
	key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
const toCamelKey = (key: string): string =>
	key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase())

/** Opaque widget params still obey the v2 recursive snake_case wire convention. */
const UnknownRecord = UnknownRecordWire.pipe(
	Schema.decodeTo(UnknownRecordWire, {
		decode: SchemaGetter.transform((value) => mapJsonKeys(value, toCamelKey) as Record<string, unknown>),
		encode: SchemaGetter.transform((value) => mapJsonKeys(value, toSnakeKey) as Record<string, unknown>),
	}),
)

const V2WidgetTransform = Schema.Struct({
	fieldMap: optional(StringRecord),
	hideSeries: optional(
		Schema.Struct({ baseNames: Schema.Array(Schema.String) }).pipe(
			Schema.encodeKeys({ baseNames: "base_names" }),
		),
	),
	flattenSeries: optional(
		Schema.Struct({ valueField: Schema.String }).pipe(Schema.encodeKeys({ valueField: "value_field" })),
	),
	reduceToValue: optional(
		Schema.Struct({ field: Schema.String, aggregate: optional(Schema.String) }).pipe(
			Schema.encodeKeys({}),
		),
	),
	computeRatio: optional(
		Schema.Struct({
			numeratorName: Schema.String,
			denominatorNames: Schema.Array(Schema.String),
		}).pipe(
			Schema.encodeKeys({ numeratorName: "numerator_name", denominatorNames: "denominator_names" }),
		),
	),
	limit: optional(Schema.Number),
	sortBy: optional(
		Schema.Struct({ field: Schema.String, direction: Schema.String }).pipe(Schema.encodeKeys({})),
	),
}).pipe(
	Schema.encodeKeys({
		fieldMap: "field_map",
		hideSeries: "hide_series",
		flattenSeries: "flatten_series",
		reduceToValue: "reduce_to_value",
		computeRatio: "compute_ratio",
		sortBy: "sort_by",
	}),
)

export const V2WidgetDataSource = Schema.Struct({
	endpoint: Schema.String,
	params: optional(UnknownRecord),
	transform: optional(V2WidgetTransform),
}).annotate({ identifier: "DashboardWidgetDataSource", title: "Dashboard widget data source" })

const V2WidgetDisplayColumn = Schema.Struct({
	field: Schema.String,
	header: Schema.String,
	unit: optional(Schema.String),
	width: optional(Schema.Number),
	align: optional(Schema.Literals(["left", "center", "right"])),
	hidden: optional(Schema.Boolean),
	thresholds: optional(Schema.Array(Schema.Struct({ value: Schema.Number, color: Schema.String }))),
})

const V2ChartPresentation = Schema.Struct({
	legend: optional(Schema.Literals(["visible", "hidden", "right"])),
	seriesStats: optional(Schema.Boolean),
	tooltip: optional(Schema.Literals(["visible", "hidden"])),
	showPoints: optional(Schema.Boolean),
	fillNulls: optional(Schema.Union([Schema.Number, Schema.Literal(false)])),
	compareToPreviousPeriod: optional(Schema.Boolean),
}).pipe(
	Schema.encodeKeys({
		seriesStats: "series_stats",
		showPoints: "show_points",
		fillNulls: "fill_nulls",
		compareToPreviousPeriod: "compare_to_previous_period",
	}),
)

const V2Axis = Schema.Struct({
	label: optional(Schema.String),
	unit: optional(Schema.String),
	visible: optional(Schema.Boolean),
})

const V2YAxis = Schema.Struct({
	...V2Axis.fields,
	min: optional(Schema.Number),
	max: optional(Schema.Number),
	softMin: optional(Schema.Number),
	softMax: optional(Schema.Number),
	logScale: optional(Schema.Boolean),
	fitYAxisToData: optional(Schema.Boolean),
}).pipe(
	Schema.encodeKeys({
		softMin: "soft_min",
		softMax: "soft_max",
		logScale: "log_scale",
		fitYAxisToData: "fit_y_axis_to_data",
	}),
)

export const V2WidgetDisplay = Schema.Struct({
	title: optional(Schema.String),
	description: optional(Schema.String),
	chartId: optional(Schema.String),
	chartPresentation: optional(V2ChartPresentation),
	xAxis: optional(V2Axis),
	yAxis: optional(V2YAxis),
	seriesMapping: optional(StringRecord),
	colorOverrides: optional(StringRecord),
	stacked: optional(Schema.Boolean),
	curveType: optional(Schema.Literals(["linear", "monotone"])),
	unit: optional(Schema.String),
	thresholds: optional(
		Schema.Array(
			Schema.Struct({ value: Schema.Number, color: Schema.String, label: optional(Schema.String) }),
		),
	),
	prefix: optional(Schema.String),
	suffix: optional(Schema.String),
	sparkline: optional(
		Schema.Struct({ enabled: Schema.Boolean, dataSource: optional(V2WidgetDataSource) }).pipe(
			Schema.encodeKeys({ dataSource: "data_source" }),
		),
	),
	columns: optional(Schema.Array(V2WidgetDisplayColumn)),
	listDataSource: optional(Schema.String),
	listWhereClause: optional(Schema.String),
	listLimit: optional(Schema.Number),
	listRootOnly: optional(Schema.Boolean),
	pie: optional(
		Schema.Struct({
			donut: optional(Schema.Boolean),
			innerRadius: optional(Schema.Number),
			showLabels: optional(Schema.Boolean),
			showPercent: optional(Schema.Boolean),
		}).pipe(
			Schema.encodeKeys({
				innerRadius: "inner_radius",
				showLabels: "show_labels",
				showPercent: "show_percent",
			}),
		),
	),
	funnel: optional(
		Schema.Struct({ showStepPercent: optional(Schema.Boolean) }).pipe(
			Schema.encodeKeys({ showStepPercent: "show_step_percent" }),
		),
	),
	histogram: optional(
		Schema.Struct({
			bucketCount: optional(Schema.Number),
			bucketWidth: optional(Schema.Number),
			logScaleY: optional(Schema.Boolean),
		}).pipe(
			Schema.encodeKeys({
				bucketCount: "bucket_count",
				bucketWidth: "bucket_width",
				logScaleY: "log_scale_y",
			}),
		),
	),
	heatmap: optional(
		Schema.Struct({
			colorScale: optional(Schema.Literals(["viridis", "magma", "cividis", "blues", "reds"])),
			scaleType: optional(Schema.Literals(["linear", "log"])),
		}).pipe(Schema.encodeKeys({ colorScale: "color_scale", scaleType: "scale_type" })),
	),
	gauge: optional(
		Schema.Struct({
			min: optional(Schema.Number),
			max: optional(Schema.Number),
			style: optional(Schema.Literals(["radial", "bar"])),
		}),
	),
	markdown: optional(Schema.Struct({ content: Schema.String })),
})
	.pipe(
		Schema.encodeKeys({
			chartId: "chart_id",
			chartPresentation: "chart_presentation",
			xAxis: "x_axis",
			yAxis: "y_axis",
			seriesMapping: "series_mapping",
			colorOverrides: "color_overrides",
			curveType: "curve_type",
			listDataSource: "list_data_source",
			listWhereClause: "list_where_clause",
			listLimit: "list_limit",
			listRootOnly: "list_root_only",
		}),
	)
	.annotate({ identifier: "DashboardWidgetDisplay", title: "Dashboard widget display" })

export const V2WidgetLayout = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: optional(Schema.Number),
	minH: optional(Schema.Number),
	maxW: optional(Schema.Number),
	maxH: optional(Schema.Number),
}).pipe(Schema.encodeKeys({ minW: "min_w", minH: "min_h", maxW: "max_w", maxH: "max_h" }))

export const V2DashboardWidget = Schema.Struct({
	id: Schema.String,
	visualization: Schema.String,
	dataSource: V2WidgetDataSource,
	display: V2WidgetDisplay,
	layout: V2WidgetLayout,
}).pipe(Schema.encodeKeys({ dataSource: "data_source" }))

const V2DashboardVariableSource = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("facet"), facet: DashboardQueryVariableFacet }),
	Schema.Struct({
		kind: Schema.Literal("attribute"),
		scope: Schema.Literals(["span", "resource"]),
		attributeKey: Schema.String,
	}).pipe(Schema.encodeKeys({ attributeKey: "attribute_key" })),
])

const variableBase = {
	name: DashboardVariableName,
	label: optional(Schema.String),
	includeAll: optional(Schema.Boolean),
	defaultValue: optional(Schema.String),
}

export const V2DashboardVariable = Schema.Union([
	Schema.Struct({ ...variableBase, type: Schema.Literal("query"), source: V2DashboardVariableSource }).pipe(
		Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" }),
	),
	Schema.Struct({
		...variableBase,
		type: Schema.Literal("custom"),
		options: Schema.Array(Schema.Struct({ value: Schema.String, label: optional(Schema.String) })),
	}).pipe(Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" })),
	Schema.Struct({ ...variableBase, type: Schema.Literal("textbox") }).pipe(
		Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" }),
	),
])

const dashboardFields = {
	id: DashboardPublicId,
	object: Schema.Literal("dashboard"),
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	tags: Schema.Array(Schema.String),
	timeRange: V2TimeRange,
	widgets: Schema.Array(V2DashboardWidget),
	variables: Schema.Array(V2DashboardVariable),
	createdAt: Timestamp,
	updatedAt: Timestamp,
}

export const V2Dashboard = Schema.Struct(dashboardFields)
	.pipe(Schema.encodeKeys({ timeRange: "time_range", createdAt: "created_at", updatedAt: "updated_at" }))
	.annotate({
		identifier: "Dashboard",
		title: "Dashboard",
		description: "A complete Maple dashboard definition, including its widgets and variables.",
	})
export type V2Dashboard = Schema.Schema.Type<typeof V2Dashboard>

export const V2DashboardMutation = Schema.Struct({
	...dashboardFields,
	txid: optional(PostgresTransactionId),
})
	.pipe(Schema.encodeKeys({ timeRange: "time_range", createdAt: "created_at", updatedAt: "updated_at" }))
	.annotate({
		identifier: "DashboardMutationResponse",
		title: "Dashboard mutation response",
		description:
			"The committed dashboard. `txid` is optional reconciliation metadata for ElectricSQL-integrated clients; other public API consumers do not need it.",
	})
export type V2DashboardMutation = Schema.Schema.Type<typeof V2DashboardMutation>

export const V2DashboardCreateParams = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1)),
	description: optional(Schema.NullOr(Schema.String)),
	tags: optional(Schema.Array(Schema.String)),
	timeRange: optional(V2TimeRange),
	widgets: optional(Schema.Array(V2DashboardWidget)),
	variables: optional(Schema.Array(V2DashboardVariable)),
})
	.pipe(Schema.encodeKeys({ timeRange: "time_range" }))
	.annotate({
		identifier: "DashboardCreateParams",
		title: "Dashboard create parameters",
	})
export type V2DashboardCreateParams = Schema.Schema.Type<typeof V2DashboardCreateParams>

export const V2DashboardUpdateParams = Schema.Struct({
	name: optional(Schema.String.check(Schema.isMinLength(1))),
	description: optional(Schema.NullOr(Schema.String)),
	tags: optional(Schema.Array(Schema.String)),
	timeRange: optional(V2TimeRange),
	widgets: optional(Schema.Array(V2DashboardWidget)),
	variables: optional(Schema.Array(V2DashboardVariable)),
})
	.pipe(Schema.encodeKeys({ timeRange: "time_range" }))
	.annotate({
		identifier: "DashboardUpdateParams",
		title: "Dashboard update parameters",
		description: "Fields to update. Omitted fields retain their current values.",
	})
export type V2DashboardUpdateParams = Schema.Schema.Type<typeof V2DashboardUpdateParams>

export const V2DashboardDeleteResponse = Schema.Struct({
	id: DashboardPublicId,
	object: Schema.Literal("dashboard"),
	deleted: Schema.Literal(true),
	txid: optional(PostgresTransactionId),
}).annotate({
	identifier: "DashboardDeleted",
	title: "Deleted dashboard",
	description:
		"A dashboard deletion tombstone. `txid` is optional reconciliation metadata for ElectricSQL-integrated clients.",
})
export type V2DashboardDeleteResponse = Schema.Schema.Type<typeof V2DashboardDeleteResponse>

const versionFields = {
	id: DashboardVersionPublicId,
	object: Schema.Literal("dashboard_version"),
	dashboardId: DashboardPublicId,
	versionNumber: Schema.Number,
	changeKind: DashboardVersionChangeKind,
	changeSummary: Schema.NullOr(Schema.String),
	sourceVersionId: Schema.NullOr(DashboardVersionPublicId),
	createdAt: Timestamp,
	createdBy: UserId,
}

export const V2DashboardVersion = Schema.Struct(versionFields)
	.pipe(
		Schema.encodeKeys({
			dashboardId: "dashboard_id",
			versionNumber: "version_number",
			changeKind: "change_kind",
			changeSummary: "change_summary",
			sourceVersionId: "source_version_id",
			createdAt: "created_at",
			createdBy: "created_by",
		}),
	)
	.annotate({ identifier: "DashboardVersion", title: "Dashboard version" })
export type V2DashboardVersion = Schema.Schema.Type<typeof V2DashboardVersion>

export const V2DashboardVersionDetail = Schema.Struct({
	...versionFields,
	snapshot: V2Dashboard,
})
	.pipe(
		Schema.encodeKeys({
			dashboardId: "dashboard_id",
			versionNumber: "version_number",
			changeKind: "change_kind",
			changeSummary: "change_summary",
			sourceVersionId: "source_version_id",
			createdAt: "created_at",
			createdBy: "created_by",
		}),
	)
	.annotate({ identifier: "DashboardVersionDetail", title: "Dashboard version detail" })
export type V2DashboardVersionDetail = Schema.Schema.Type<typeof V2DashboardVersionDetail>

const V2DashboardTemplateParameter = Schema.Struct({
	key: DashboardTemplateParameterKey,
	label: Schema.String,
	description: Schema.String,
	required: Schema.Boolean,
	placeholder: optional(Schema.String),
})

const V2DashboardTemplatePreviewWidget = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	kind: Schema.Literals(["line", "area", "bar", "stat", "table", "list"]),
	title: Schema.String,
})

export const V2DashboardTemplate = Schema.Struct({
	id: DashboardTemplatePublicId,
	object: Schema.Literal("dashboard_template"),
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	requiredMetricPrefixes: Schema.Array(Schema.String),
	parameters: Schema.Array(V2DashboardTemplateParameter),
	preview: Schema.Array(V2DashboardTemplatePreviewWidget),
})
	.pipe(Schema.encodeKeys({ requiredMetricPrefixes: "required_metric_prefixes" }))
	.annotate({
		identifier: "DashboardTemplate",
		title: "Dashboard template",
	})
export type V2DashboardTemplate = Schema.Schema.Type<typeof V2DashboardTemplate>

export const V2DashboardTemplateInstantiateParams = Schema.Struct({
	parameters: optional(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
	name: optional(Schema.String),
}).annotate({
	identifier: "DashboardTemplateInstantiateParams",
	title: "Dashboard template instantiate parameters",
})

export const V2DashboardPersesImportParams = Schema.Struct({
	dashboard: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "DashboardPersesImportParams", title: "Perses import parameters" })

export const V2DashboardPersesImportResponse = Schema.Struct({
	object: Schema.Literal("dashboard_import"),
	dashboard: V2DashboardMutation,
	warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "DashboardPersesImport", title: "Perses dashboard import" })

const DashboardList = ListOf(V2Dashboard).annotate({ identifier: "DashboardList" })
const DashboardVersionList = ListOf(V2DashboardVersion).annotate({ identifier: "DashboardVersionList" })
const DashboardTemplateList = ListOf(V2DashboardTemplate).annotate({ identifier: "DashboardTemplateList" })

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const
const mutationErrors = [...commonErrors, V2ConflictError] as const

export class V2DashboardsApiGroup extends HttpApiGroup.make("dashboards")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: DashboardList,
			error: commonErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboards",
				summary: "List dashboards",
				description: "Returns a cursor-paginated list of dashboards, most recently updated first.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2DashboardCreateParams,
			success: V2DashboardMutation,
			error: mutationErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createDashboard",
				summary: "Create a dashboard",
				description:
					"Creates a dashboard and returns the committed object, with optional ElectricSQL reconciliation metadata when available.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("importPerses", "/import/perses", {
			payload: V2DashboardPersesImportParams,
			success: V2DashboardPersesImportResponse,
			error: mutationErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "importPersesDashboard",
				summary: "Import a Perses dashboard",
				description:
					"Converts a Perses dashboard into Maple's dashboard model and returns any conversion warnings.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listTemplates", "/templates", {
			query: ListQuery,
			success: DashboardTemplateList,
			error: [V2InvalidRequestError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboardTemplates",
				summary: "List dashboard templates",
				description:
					"Returns the built-in dashboard templates in the standard cursor-paginated list envelope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("instantiateTemplate", "/templates/:template_id/instantiate", {
			params: { template_id: DashboardTemplatePublicId },
			payload: V2DashboardTemplateInstantiateParams,
			success: V2DashboardMutation,
			error: [...mutationErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "instantiateDashboardTemplate",
				summary: "Instantiate a dashboard template",
				description:
					"Builds and persists a new dashboard from a template and its required parameters.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: DashboardPublicId },
			success: V2Dashboard,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboard",
				summary: "Retrieve a dashboard",
				description: "Returns a complete dashboard definition by its opaque `dash_` public ID.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: DashboardPublicId },
			payload: V2DashboardUpdateParams,
			success: V2DashboardMutation,
			error: [...mutationErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateDashboard",
				summary: "Update a dashboard",
				description: "Applies a partial JSON update; omitted fields retain their current values.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: DashboardPublicId },
			success: V2DashboardDeleteResponse,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteDashboard",
				summary: "Delete a dashboard",
				description:
					"Permanently deletes a dashboard and returns a tombstone, with optional ElectricSQL reconciliation metadata when available.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listVersions", "/:id/versions", {
			params: { id: DashboardPublicId },
			query: ListQuery,
			success: DashboardVersionList,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listDashboardVersions",
				summary: "List dashboard versions",
				description: "Returns a newest-first, cursor-paginated audit history for a dashboard.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveVersion", "/:id/versions/:version_id", {
			params: { id: DashboardPublicId, version_id: DashboardVersionPublicId },
			success: V2DashboardVersionDetail,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDashboardVersion",
				summary: "Retrieve a dashboard version",
				description: "Returns one dashboard version together with its complete immutable snapshot.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("restoreVersion", "/:id/versions/:version_id/restore", {
			params: { id: DashboardPublicId, version_id: DashboardVersionPublicId },
			success: V2DashboardMutation,
			error: [...mutationErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "restoreDashboardVersion",
				summary: "Restore a dashboard version",
				description: "Restores a historical snapshot as the dashboard's new current version.",
			}),
		),
	)
	.prefix("/v2/dashboards")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Dashboards",
			description:
				"Create and manage dashboards, browse version history, restore snapshots, and instantiate built-in templates.",
		}),
	) {}
