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
import {
	DashboardQueryVariableFacet,
	DashboardConcurrencyError,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	DashboardRefreshIntervalSeconds,
	DashboardTemplateNotFoundError,
	DashboardTemplatePreviewKind,
	DashboardValidationError,
	DashboardVariableName,
	DashboardVersionNotFoundError,
	DashboardVersionChangeKind,
} from "../dashboards"
import { SORT_DIRECTIONS, STAT_AGGREGATES } from "@maple/widgets/dashboard"
import {
	QUERY_RESULT_SHAPES,
	QueryBuilderFormulaSchema,
	QueryBuilderQueryDraftSchema,
	QueryComparisonSchema,
} from "@maple/query-model"
import { HEATMAP_COLOR_SCALES, HEATMAP_SCALE_TYPES, WIDGET_VISUALIZATIONS } from "../widget-types"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid, V2ParameterMissing } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { publicErrors } from "./public-error"

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

/**
 * The same recursive snake_case convention, but decoding into a TYPED schema
 * instead of an opaque record.
 *
 * Needed by the v3 data source. A query draft used to travel inside the untyped
 * `params` bag, so its fields were snake_cased by `UnknownRecord` above and never
 * validated. v3 hoists `queries` to a real field, which leaves two bad options
 * and one good one: keep it opaque (the wire is preserved but the route cannot
 * assign it into the stored type without a second decode), type it directly (the
 * route works but every draft field silently renames on the published wire), or
 * this — snake_case on the wire, typed after decode.
 *
 * The wire bytes are therefore identical to v2 while the decoded value is the
 * real draft, which is what lets `toInternalWidgets` stay a plain field carry.
 */
const snakeCasedWire = <S extends Schema.Top>(schema: S) =>
	UnknownRecordWire.pipe(
		Schema.decodeTo(schema, {
			decode: SchemaGetter.transform((value) => mapJsonKeys(value, toCamelKey)),
			encode: SchemaGetter.transform(
				(value) => mapJsonKeys(value, toSnakeKey) as Record<string, unknown>,
			),
		}),
	)

// The widget schemas below (transform, data source, display, layout, widget) are
// a deliberate re-declaration of the stored schema in
// `packages/widgets/src/dashboard/shared/`, differing only by `encodeKeys` for
// snake_case. Keeping them explicit rather than deriving them mechanically
// preserves the OpenAPI `identifier`/`title` annotations that shape the published
// v2 spec.
//
// The cost of a clone is drift, so it is guarded rather than trusted:
// `dashboard-widget-parity.test.ts` asserts the two are assignable and that every
// stored field reaches the wire under its mechanical snake_case name. Add a field
// to the stored display and that test fails until it is mirrored here.
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
		Schema.Struct({
			field: Schema.String,
			aggregate: optional(Schema.Literals(STAT_AGGREGATES)),
		}).pipe(Schema.encodeKeys({})),
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
		Schema.Struct({
			field: Schema.String,
			direction: Schema.Literals(SORT_DIRECTIONS),
		}).pipe(Schema.encodeKeys({})),
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

/**
 * The data source, as a discriminated union on `kind`.
 *
 * Schema v3 replaced the stored `{ endpoint, params }` bag with this union, and
 * `/v2/dashboards` republishes the new shape rather than encoding back to the old
 * one — a deliberate breaking change, taken so there is exactly one data-source
 * shape in the system instead of a wire format kept alive by a translation layer.
 *
 * Re-declared here rather than aliased to `WidgetDataSourceSchema`, for the same
 * reason as every other schema in this file: the v2 wire is snake_case
 * throughout, and the stored schema is not. Aliasing compiles and silently ships
 * `fieldMap` where the published spec says `field_map`.
 *
 * `queries`, `formulas` and `comparison` go through `snakeCasedWire`, so their
 * wire representation is byte-identical to v2 — where they lived inside the
 * untyped `params` bag and got the same recursive snake_case treatment — while
 * decoding to the real stored types. Only the envelope around them moved.
 */
const V2QueryDataSource = Schema.Struct({
	kind: Schema.Literal("query"),
	resultShape: Schema.Literals(QUERY_RESULT_SHAPES),
	queries: Schema.Array(snakeCasedWire(QueryBuilderQueryDraftSchema)),
	formulas: optional(Schema.Array(snakeCasedWire(QueryBuilderFormulaSchema))),
	comparison: optional(snakeCasedWire(QueryComparisonSchema)),
	defaultLimit: optional(Schema.Number),
	limit: optional(Schema.Number),
	columns: optional(Schema.Array(Schema.String)),
	transform: optional(V2WidgetTransform),
}).pipe(Schema.encodeKeys({ resultShape: "result_shape", defaultLimit: "default_limit" }))

const V2RawSqlDataSource = Schema.Struct({
	kind: Schema.Literal("raw_sql"),
	sql: Schema.String,
	displayType: optional(Schema.String),
	granularitySeconds: optional(Schema.Number),
	transform: optional(V2WidgetTransform),
}).pipe(Schema.encodeKeys({ displayType: "display_type", granularitySeconds: "granularity_seconds" }))

const V2RouteDataSource = Schema.Struct({
	kind: Schema.Literal("route"),
	endpoint: Schema.String,
	params: optional(UnknownRecord),
	transform: optional(V2WidgetTransform),
})

const V2StaticDataSource = Schema.Struct({
	kind: Schema.Literal("static"),
	transform: optional(V2WidgetTransform),
})

export const V2WidgetDataSource = Schema.Union([
	V2QueryDataSource,
	V2RawSqlDataSource,
	V2RouteDataSource,
	V2StaticDataSource,
]).annotate({ identifier: "DashboardWidgetDataSource", title: "Dashboard widget data source" })

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
			colorScale: optional(Schema.Literals(HEATMAP_COLOR_SCALES)),
			scaleType: optional(Schema.Literals(HEATMAP_SCALE_TYPES)),
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
	// Closed against the widget-type table, matching the stored schema. An
	// unrecognised kind is a 400 here rather than a widget that silently renders
	// as a line chart via the renderer registry's fallback.
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	dataSource: V2WidgetDataSource,
	display: V2WidgetDisplay,
	layout: V2WidgetLayout,
	// Optional per-widget window. Omit it — the overwhelmingly common case — and
	// the widget follows the dashboard's `time_range`.
	timeRange: optional(V2TimeRange),
	// Section membership. Omit both — the common case — and the widget sits on
	// the root canvas. `layout` is relative to whichever container these name, so
	// two widgets in different sections may both be at `x: 0, y: 0`.
	sectionId: optional(Schema.String),
	tabId: optional(Schema.String),
}).pipe(
	Schema.encodeKeys({
		dataSource: "data_source",
		timeRange: "time_range",
		sectionId: "section_id",
		tabId: "tab_id",
	}),
)

const V2DashboardSectionTab = Schema.Struct({ id: Schema.String, title: Schema.String })

export const V2DashboardSection = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	// The stored default. Individual viewers override it in their own URL without
	// changing what anyone else sees.
	collapsed: optional(Schema.Boolean),
	// `false` pins the section open: no collapse control, and a viewer's collapse
	// override naming it is ignored. Omit for the default (collapsible).
	collapsible: optional(Schema.Boolean),
	tabs: Schema.Array(V2DashboardSectionTab),
}).annotate({
	identifier: "DashboardSection",
	title: "Dashboard section",
	description:
		"A collapsible group of widgets. A section with one tab renders as a plain header; two or more render a tab bar. Widgets join a section by setting `section_id` and `tab_id`.",
})

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
	// Always present, `[]` when the dashboard is one flat canvas — matching how
	// `tags` and `variables` read on this resource.
	sections: Schema.Array(V2DashboardSection),
	variables: Schema.Array(V2DashboardVariable),
	// `null` is off, matching `description`'s absence convention on this resource.
	refreshIntervalSeconds: Schema.NullOr(DashboardRefreshIntervalSeconds),
	createdAt: Timestamp,
	updatedAt: Timestamp,
}

export const V2Dashboard = Schema.Struct(dashboardFields)
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
			createdAt: "created_at",
			updatedAt: "updated_at",
		}),
	)
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
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
			createdAt: "created_at",
			updatedAt: "updated_at",
		}),
	)
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
	sections: optional(Schema.Array(V2DashboardSection)),
	variables: optional(Schema.Array(V2DashboardVariable)),
	refreshIntervalSeconds: optional(Schema.NullOr(DashboardRefreshIntervalSeconds)),
})
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
		}),
	)
	.annotate({
		identifier: "DashboardCreateParams",
		title: "Dashboard create parameters",
		parseOptions: { reportInput: true },
	})
export type V2DashboardCreateParams = Schema.Schema.Type<typeof V2DashboardCreateParams>

export const V2DashboardUpdateParams = Schema.Struct({
	name: optional(Schema.String.check(Schema.isMinLength(1))),
	description: optional(Schema.NullOr(Schema.String)),
	tags: optional(Schema.Array(Schema.String)),
	timeRange: optional(V2TimeRange),
	widgets: optional(Schema.Array(V2DashboardWidget)),
	sections: optional(Schema.Array(V2DashboardSection)),
	variables: optional(Schema.Array(V2DashboardVariable)),
	refreshIntervalSeconds: optional(Schema.NullOr(DashboardRefreshIntervalSeconds)),
})
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
		}),
	)
	.annotate({
		identifier: "DashboardUpdateParams",
		title: "Dashboard update parameters",
		description: "Fields to update. Omitted fields retain their current values.",
		parseOptions: { reportInput: true },
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
	kind: DashboardTemplatePreviewKind,
	title: Schema.String,
})

export const V2DashboardTemplateRequirement = Schema.Struct({
	kind: Schema.Literals(["metrics", "integration", "telemetry"]).annotate({
		description:
			"`metrics` is gated on `required_metric_prefixes`, `integration` on a connected integration, `telemetry` is never gated.",
	}),
	label: Schema.String.annotate({
		description: "Full prose — the same string the `requirements` array carries.",
	}),
	missing: optional(
		Schema.String.annotate({
			description:
				'Short statement of what is missing, e.g. "not connected". Absent for `metrics`, where clients derive `no <prefix>*` from `required_metric_prefixes`.',
		}),
	),
	collector: Schema.String.annotate({
		description: 'Noun phrase naming what emits the data, read as "Collected by {collector}."',
	}),
	setupLabel: optional(
		Schema.String.annotate({
			description: 'Noun phrase read as "Set up {setup_label}". Absent for `telemetry`.',
		}),
	),
	hint: optional(
		Schema.String.annotate({
			description: "One extra sentence shown when the template is gated.",
		}),
	),
})
	.pipe(Schema.encodeKeys({ setupLabel: "setup_label" }))
	.annotate({
		identifier: "DashboardTemplateRequirement",
		title: "Dashboard template requirement",
		description: "What an org needs before this template's widgets have anything to draw.",
	})
export type V2DashboardTemplateRequirement = Schema.Schema.Type<typeof V2DashboardTemplateRequirement>

export const V2DashboardTemplate = Schema.Struct({
	id: DashboardTemplatePublicId,
	object: Schema.Literal("dashboard_template"),
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	requirement: Schema.NullOr(V2DashboardTemplateRequirement),
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

export const V2DashboardTemplatePreviewParams = Schema.Struct({
	parameters: optional(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
}).annotate({
	identifier: "DashboardTemplatePreviewParams",
	title: "Dashboard template preview parameters",
})
export type V2DashboardTemplatePreviewParams = Schema.Schema.Type<typeof V2DashboardTemplatePreviewParams>

export const V2DashboardTemplatePreview = Schema.Struct({
	object: Schema.Literal("dashboard_template_preview"),
	name: Schema.String,
	timeRange: V2TimeRange,
	widgets: Schema.Array(V2DashboardWidget),
	variables: Schema.Array(V2DashboardVariable),
})
	.pipe(Schema.encodeKeys({ timeRange: "time_range" }))
	.annotate({
		identifier: "DashboardTemplatePreview",
		title: "Dashboard template preview",
		description:
			"The dashboard a template would build, without creating it. Nothing is persisted; the widgets are identical to what `instantiate` would save for the same parameters.",
	})
export type V2DashboardTemplatePreview = Schema.Schema.Type<typeof V2DashboardTemplatePreview>

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

const [
	dashboardVersionNotFound,
	dashboardPersistence,
	dashboardNotFound,
	dashboardValidation,
	dashboardConcurrency,
	dashboardTemplateNotFound,
	dashboardStoredConfigInvalid,
] = publicErrors(
	DashboardVersionNotFoundError,
	DashboardPersistenceError,
	DashboardNotFoundError,
	DashboardValidationError,
	DashboardConcurrencyError,
	DashboardTemplateNotFoundError,
	DashboardStoredConfigInvalidError,
)

const dashboardCreateErrors = [dashboardValidation, dashboardPersistence] as const
const dashboardUpdateErrors = [
	dashboardValidation,
	dashboardPersistence,
	dashboardConcurrency,
	dashboardStoredConfigInvalid,
] as const

export class V2DashboardsApiGroup extends HttpApiGroup.make("dashboards")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: DashboardList,
			error: [V2ParameterInvalid.schema, dashboardPersistence, dashboardStoredConfigInvalid],
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
			error: dashboardCreateErrors,
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
			error: dashboardCreateErrors,
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
			error: V2ParameterInvalid.schema,
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
		HttpApiEndpoint.post("previewTemplate", "/templates/:template_id/preview", {
			params: { template_id: DashboardTemplatePublicId },
			payload: V2DashboardTemplatePreviewParams,
			success: V2DashboardTemplatePreview,
			error: [V2ParameterInvalid.schema, dashboardTemplateNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "previewDashboardTemplate",
				summary: "Preview a dashboard template",
				description:
					"Builds the template for the given parameters and returns the resulting dashboard without saving it. Read-only — use `instantiate` to create the dashboard.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("instantiateTemplate", "/templates/:template_id/instantiate", {
			params: { template_id: DashboardTemplatePublicId },
			payload: V2DashboardTemplateInstantiateParams,
			success: V2DashboardMutation,
			error: [
				V2ParameterInvalid.schema,
				V2ParameterMissing.schema,
				dashboardTemplateNotFound,
				...dashboardCreateErrors,
			],
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
			error: [dashboardPersistence, dashboardNotFound, dashboardStoredConfigInvalid],
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
			error: [dashboardNotFound, ...dashboardUpdateErrors],
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
			error: [dashboardPersistence, dashboardNotFound],
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
			error: [
				V2ParameterInvalid.schema,
				dashboardPersistence,
				dashboardNotFound,
				dashboardStoredConfigInvalid,
			],
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
			error: [
				dashboardPersistence,
				dashboardNotFound,
				dashboardVersionNotFound,
				dashboardStoredConfigInvalid,
			],
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
			error: [dashboardNotFound, dashboardVersionNotFound, ...dashboardUpdateErrors],
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
	.annotateMerge(
		OpenApi.annotations({
			title: "Dashboards",
			description:
				"Create and manage dashboards, browse version history, restore snapshots, and instantiate built-in templates.",
		}),
	) {}
