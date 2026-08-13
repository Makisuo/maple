import { Schema } from "effect"

/**
 * A query-builder draft: the editable description of one warehouse query.
 *
 * Persisted by BOTH dashboard widgets (`WidgetDataSourceV3`, `kind: "query"`)
 * and alert rules (`alert_rules.query_builder_draft_json`). That shared
 * ownership is why this lives in a leaf package rather than in `@maple/domain`
 * or `@maple/widgets` — `@maple/widgets` sits below `@maple/domain` (domain's
 * `MapleApi` embeds the widget schemas), so a widget schema cannot reach up into
 * domain for it.
 */

export const QUERY_BUILDER_DATA_SOURCES = ["traces", "logs", "metrics"] as const
export type QueryBuilderDataSource = (typeof QUERY_BUILDER_DATA_SOURCES)[number]

export const QUERY_BUILDER_METRIC_TYPES = ["sum", "gauge", "histogram", "exponential_histogram"] as const
export type QueryBuilderMetricType = (typeof QUERY_BUILDER_METRIC_TYPES)[number]

export const QUERY_BUILDER_SIGNAL_SOURCES = ["default", "meter"] as const
export type QueryBuilderSignalSource = (typeof QUERY_BUILDER_SIGNAL_SOURCES)[number]

export const QueryBuilderAddOnsSchema = Schema.Struct({
	groupBy: Schema.Boolean,
	having: Schema.Boolean,
	orderBy: Schema.Boolean,
	limit: Schema.Boolean,
	legend: Schema.Boolean,
})

// Fields shared by every query-draft source. Metric-specific fields live only
// on the metrics variant below — traces/logs queries never carry them.
const queryDraftBaseFields = {
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.optional(Schema.Boolean),
	hidden: Schema.optional(Schema.Boolean),
	whereClause: Schema.optional(Schema.String),
	aggregation: Schema.String,
	stepInterval: Schema.optional(Schema.String),
	orderByDirection: Schema.optional(Schema.Literals(["desc", "asc"])),
	addOns: Schema.optional(QueryBuilderAddOnsSchema),
	groupBy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	having: Schema.optional(Schema.String),
	orderBy: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	// Opt-in top-N series cap for group-by timeseries charts (entered as a string
	// in the builder; parsed to a positive integer when lowering to a QuerySpec).
	seriesLimit: Schema.optional(Schema.String),
	legend: Schema.optional(Schema.String),
}

export const TracesQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("traces"),
	// A non-empty `valueField` (e.g. "attr.result.rowCount") switches the traces
	// query into numeric-attribute aggregation mode: `aggregation` becomes a
	// numeric function over that span attribute instead of a duration-based metric.
	valueField: Schema.optional(Schema.String),
})

export const LogsQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("logs"),
})

export const MetricsQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("metrics"),
	signalSource: Schema.optional(Schema.Literals(QUERY_BUILDER_SIGNAL_SOURCES)),
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	isMonotonic: Schema.optional(Schema.Boolean),
})

export const QueryBuilderQueryDraftSchema = Schema.Union([
	TracesQueryDraftSchema,
	LogsQueryDraftSchema,
	MetricsQueryDraftSchema,
])
export type QueryBuilderQueryDraftPayload = Schema.Schema.Type<typeof QueryBuilderQueryDraftSchema>
