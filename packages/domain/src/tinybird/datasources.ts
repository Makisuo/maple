import {
  defineDatasource,
  t,
  engine,
  column,
  type InferRow,
} from "@tinybirdco/sdk";

/**
 * OpenTelemetry logs datasource
 * Matches the official OpenTelemetry Collector Tinybird exporter format
 */
export const logs = defineDatasource("logs", {
  description:
    "This is a table that contains the logs from the OpenTelemetry Collector.",
  schema: {
    OrgId: column(t.string().lowCardinality(), {
      jsonPath: "$.resource_attributes.maple_org_id",
    }),
    Timestamp: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
    TimestampTime: column(t.dateTime(), { jsonPath: "$.timestamp" }),
    TraceId: column(t.string(), { jsonPath: "$.trace_id" }),
    SpanId: column(t.string(), { jsonPath: "$.span_id" }),
    TraceFlags: column(t.uint8(), { jsonPath: "$.flags" }),
    SeverityText: column(t.string().lowCardinality(), {
      jsonPath: "$.severity_text",
    }),
    SeverityNumber: column(t.uint8(), { jsonPath: "$.severity_number" }),
    ServiceName: column(t.string().lowCardinality(), {
      jsonPath: "$.service_name",
    }),
    Body: column(t.string(), { jsonPath: "$.body" }),
    ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
    ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.resource_attributes",
    }),
    ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
    ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
    ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
    ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.scope_attributes",
    }),
    LogAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.log_attributes",
    }),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(TimestampTime)",
    sortingKey: ["OrgId", "ServiceName", "TimestampTime", "Timestamp"],
    ttl: "toDate(TimestampTime) + INTERVAL 90 DAY",
  }),
});

export type LogsRow = InferRow<typeof logs>;

/**
 * Sampling weight expression. Resolution priority:
 *   1. Explicit `SpanAttributes['SampleRate']` (collector-set, takes precedence)
 *   2. W3C TraceState `th:<hex>` threshold sampling
 *   3. Default 1.0 (unsampled)
 *
 * Used in two places:
 *   - As the `SampleRate` column DEFAULT expression on the `traces` datasource
 *     (computes for future inserts that don't supply the field)
 *   - In the `traces` FORWARD_QUERY (backfills existing rows when the column
 *     is added)
 *
 * Both must produce identical values per row, so the expression is hoisted
 * here. If you change one, change the other.
 *
 * The W3C `th:` parsing math mirrors `parseSamplingWeight()` in
 * apps/api/src/services/QueryEngineService.ts — see
 * QueryEngineService.sampling.test.ts for parity tests.
 */
const SAMPLE_RATE_EXPR =
  "multiIf(" +
    "SpanAttributes['SampleRate'] != '' AND toFloat64OrZero(SpanAttributes['SampleRate']) >= 1.0, " +
      "toFloat64OrZero(SpanAttributes['SampleRate']), " +
    "match(TraceState, 'th:[0-9a-f]+'), " +
      "1.0 / greatest(" +
        "1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), " +
        "0.0001" +
      "), " +
    "1.0" +
  ")";

const IS_ENTRY_POINT_EXPR =
  "if(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '', 1, 0)";

/**
 * OpenTelemetry traces datasource
 * Matches the official OpenTelemetry Collector Tinybird exporter format
 */
export const traces = defineDatasource("traces", {
  description:
    "A table that contains trace data from OpenTelemetry in Tinybird format.",
  schema: {
    OrgId: column(t.string().lowCardinality(), {
      jsonPath: "$.resource_attributes.maple_org_id",
    }),
    Timestamp: column(t.dateTime64(9), { jsonPath: "$.start_time" }),
    TraceId: column(t.string(), { jsonPath: "$.trace_id" }),
    SpanId: column(t.string(), { jsonPath: "$.span_id" }),
    ParentSpanId: column(t.string(), { jsonPath: "$.parent_span_id" }),
    TraceState: column(t.string(), { jsonPath: "$.trace_state" }),
    SpanName: column(t.string().lowCardinality(), { jsonPath: "$.span_name" }),
    SpanKind: column(t.string().lowCardinality(), { jsonPath: "$.span_kind" }),
    ServiceName: column(t.string().lowCardinality(), {
      jsonPath: "$.service_name",
    }),
    ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
    ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.resource_attributes",
    }),
    ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
    ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
    ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
    ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.scope_attributes",
    }),
    Duration: column(t.uint64().default(0), { jsonPath: "$.duration" }),
    StatusCode: column(t.string().lowCardinality(), {
      jsonPath: "$.status_code",
    }),
    StatusMessage: column(t.string(), { jsonPath: "$.status_message" }),
    SpanAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.span_attributes",
    }),
    EventsTimestamp: column(t.array(t.dateTime64(9)), {
      jsonPath: "$.events_timestamp[:]",
    }),
    EventsName: column(t.array(t.string().lowCardinality()), {
      jsonPath: "$.events_name[:]",
    }),
    EventsAttributes: column(
      t.array(t.map(t.string().lowCardinality(), t.string())),
      { jsonPath: "$.events_attributes[:]" }
    ),
    LinksTraceId: column(t.array(t.string()), {
      jsonPath: "$.links_trace_id[:]",
    }),
    LinksSpanId: column(t.array(t.string()), {
      jsonPath: "$.links_span_id[:]",
    }),
    LinksTraceState: column(t.array(t.string()), {
      jsonPath: "$.links_trace_state[:]",
    }),
    LinksAttributes: column(
      t.array(t.map(t.string().lowCardinality(), t.string())),
      { jsonPath: "$.links_attributes[:]" }
    ),
    /**
     * Sampling weight per span. >= 1.0 means "this stored row represents
     * SampleRate population spans". Used by `quantilesTDigestWeighted`,
     * `sumIf(SampleRate, ...)` etc. for sample-aware aggregations.
     *
     * Expression hoisted to SAMPLE_RATE_EXPR — same value populated on
     * existing rows via FORWARD_QUERY.
     */
    SampleRate: t.float64().defaultExpr(SAMPLE_RATE_EXPR),
    /**
     * Entry-point predicate as a queryable dimension. True for spans that
     * begin a request from the perspective of the receiving service:
     * Server/Consumer kinds, or any root span (ParentSpanId = '').
     */
    IsEntryPoint: t.uint8().defaultExpr(IS_ENTRY_POINT_EXPR),
  },
  /**
   * Backfills SampleRate + IsEntryPoint on existing rows when these columns
   * are added. Tinybird treats new columns with DEFAULT expressions as
   * "incompatible" changes and requires this query.
   *
   * Must produce identical values to the column DEFAULT expressions
   * (SAMPLE_RATE_EXPR / IS_ENTRY_POINT_EXPR) so backfilled values match
   * what new inserts would compute.
   */
  forwardQuery:
    "SELECT " +
    "OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, " +
    "SpanKind, ServiceName, ResourceSchemaUrl, ResourceAttributes, " +
    "ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, Duration, " +
    "StatusCode, StatusMessage, SpanAttributes, EventsTimestamp, EventsName, " +
    "EventsAttributes, LinksTraceId, LinksSpanId, LinksTraceState, LinksAttributes, " +
    SAMPLE_RATE_EXPR + " AS SampleRate, " +
    IS_ENTRY_POINT_EXPR + " AS IsEntryPoint",
  indexes: [
    {
      name: "idx_trace_id",
      expr: "TraceId",
      type: "bloom_filter(0.01)",
      granularity: 1,
    },
    {
      name: "idx_span_attr_keys",
      expr: "mapKeys(SpanAttributes)",
      type: "bloom_filter(0.01)",
      granularity: 1,
    },
    {
      name: "idx_span_attr_vals",
      expr: "mapValues(SpanAttributes)",
      type: "bloom_filter(0.01)",
      granularity: 1,
    },
    {
      name: "idx_resource_attr_keys",
      expr: "mapKeys(ResourceAttributes)",
      type: "bloom_filter(0.01)",
      granularity: 1,
    },
    {
      name: "idx_resource_attr_vals",
      expr: "mapValues(ResourceAttributes)",
      type: "bloom_filter(0.01)",
      granularity: 1,
    },
  ],
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "ServiceName", "SpanName", "toDateTime(Timestamp)"],
    ttl: "toDate(Timestamp) + INTERVAL 90 DAY",
  }),
});

export type TracesRow = InferRow<typeof traces>;

/**
 * Service usage aggregation datasource
 * Populated via materialized views, no JSON ingestion
 */
export const serviceUsage = defineDatasource("service_usage", {
  description:
    "Aggregated usage statistics per service per hour. Uses SummingMergeTree for efficient incremental updates from multiple materialized views.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    ServiceName: t.string().lowCardinality(),
    Hour: t.dateTime(),
    LogCount: t.uint64(),
    LogSizeBytes: t.uint64(),
    TraceCount: t.uint64(),
    TraceSizeBytes: t.uint64(),
    SumMetricCount: t.uint64(),
    SumMetricSizeBytes: t.uint64(),
    GaugeMetricCount: t.uint64(),
    GaugeMetricSizeBytes: t.uint64(),
    HistogramMetricCount: t.uint64(),
    HistogramMetricSizeBytes: t.uint64(),
    ExpHistogramMetricCount: t.uint64(),
    ExpHistogramMetricSizeBytes: t.uint64(),
  },
  forwardQuery: `SELECT *`,
  engine: engine.summingMergeTree({
    sortingKey: ["OrgId", "ServiceName", "Hour"],
    ttl: "Hour + INTERVAL 365 DAY",
  }),
});

export type ServiceUsageRow = InferRow<typeof serviceUsage>;

/**
 * Lightweight projection of traces for service map JOIN queries.
 * Pre-extracts peer.service and deployment.environment from Map columns.
 * Sorted by (OrgId, TraceId, SpanId) to align with the JOIN key.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapSpans = defineDatasource("service_map_spans", {
  description:
    "Lightweight projection of traces for service map JOIN queries. Pre-extracts peer.service and deployment.environment from Map columns. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime(),
    TraceId: t.string(),
    SpanId: t.string(),
    ParentSpanId: t.string(),
    ServiceName: t.string().lowCardinality(),
    SpanKind: t.string().lowCardinality(),
    Duration: t.uint64(),
    StatusCode: t.string().lowCardinality(),
    TraceState: t.string(),
    PeerService: t.string(),
    DeploymentEnv: t.string().lowCardinality(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "TraceId", "SpanId", "Timestamp"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type ServiceMapSpansRow = InferRow<typeof serviceMapSpans>;

/**
 * Server/Consumer spans with ParentSpanId for efficient service map child-side JOIN lookups.
 * Pre-filters to only Server/Consumer spans with a parent at write time,
 * sorted by (OrgId, TraceId, ParentSpanId) to align with the JOIN key.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapChildren = defineDatasource("service_map_children", {
  description:
    "Server/Consumer spans with ParentSpanId for efficient service map child-side JOIN lookups. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime(),
    TraceId: t.string(),
    ParentSpanId: t.string(),
    ServiceName: t.string().lowCardinality(),
    SpanKind: t.string().lowCardinality(),
    Duration: t.uint64(),
    StatusCode: t.string().lowCardinality(),
    TraceState: t.string(),
    DeploymentEnv: t.string().lowCardinality(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "TraceId", "ParentSpanId", "Timestamp"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type ServiceMapChildrenRow = InferRow<typeof serviceMapChildren>;

/**
 * Pre-aggregated hourly service-to-service edges for the service map.
 * Aggregates Client spans with peer.service at write time so the service map
 * query reads ~hundreds of hourly rows instead of millions of individual spans.
 * Uses AggregatingMergeTree with SimpleAggregateFunction columns for correct
 * incremental merging of sum/max aggregates.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapEdgesHourly = defineDatasource(
  "service_map_edges_hourly",
  {
    description:
      "Pre-aggregated hourly service-to-service edges for the service map. Uses AggregatingMergeTree for incremental aggregation. Populated by materialized view.",
    jsonPaths: false,
    schema: {
      OrgId: t.string().lowCardinality(),
      Hour: t.dateTime(),
      SourceService: t.string().lowCardinality(),
      TargetService: t.string(),
      DeploymentEnv: t.string().lowCardinality(),
      CallCount: t.simpleAggregateFunction("sum", t.uint64()),
      ErrorCount: t.simpleAggregateFunction("sum", t.uint64()),
      DurationSumMs: t.simpleAggregateFunction("sum", t.float64()),
      MaxDurationMs: t.simpleAggregateFunction("max", t.float64()),
      SampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
      UnsampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
    },
    engine: engine.aggregatingMergeTree({
      partitionKey: "toDate(Hour)",
      sortingKey: [
        "OrgId",
        "Hour",
        "DeploymentEnv",
        "SourceService",
        "TargetService",
      ],
      ttl: "toDate(Hour) + INTERVAL 90 DAY",
    }),
  }
);

export type ServiceMapEdgesHourlyRow = InferRow<typeof serviceMapEdgesHourly>;

/**
 * Lightweight projection of service entry point spans for service overview queries.
 * Pre-extracts deployment.environment and deployment.commit_sha from ResourceAttributes.
 * Stores Server/Consumer spans (service entry points) plus root spans as fallback.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceOverviewSpans = defineDatasource("service_overview_spans", {
  description:
    "Lightweight projection of service entry point spans (Server/Consumer + root) for service overview queries. Pre-extracts deployment attributes from ResourceAttributes. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime(),
    ServiceName: t.string().lowCardinality(),
    Duration: t.uint64(),
    StatusCode: t.string().lowCardinality(),
    TraceState: t.string(),
    DeploymentEnv: t.string().lowCardinality(),
    CommitSha: t.string().lowCardinality(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "ServiceName", "Timestamp"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type ServiceOverviewSpansRow = InferRow<typeof serviceOverviewSpans>;

/**
 * Pre-materialized error spans for the errors page.
 * Pre-filters to StatusCode='Error' and pre-extracts deployment.environment
 * so error queries avoid scanning the full traces table and Map columns.
 * Sorted by (OrgId, ServiceName, Timestamp) for efficient filtering and aggregation.
 * Populated by materialized view, not direct ingestion.
 */
export const errorSpans = defineDatasource("error_spans", {
  description:
    "Pre-materialized error spans for the errors page. Pre-filters to StatusCode='Error' and pre-extracts deployment.environment. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime(),
    TraceId: t.string(),
    SpanId: t.string(),
    ParentSpanId: t.string().default("__unset__"),
    ServiceName: t.string().lowCardinality(),
    StatusMessage: t.string(),
    Duration: t.uint64(),
    DeploymentEnv: t.string().lowCardinality(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "ServiceName", "Timestamp"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type ErrorSpansRow = InferRow<typeof errorSpans>;

/**
 * Pre-materialized error events for the errors-as-issues triage system.
 * Populated from traces where StatusCode='Error'. Unwraps the first OTel
 * `exception` event (if any) to surface exception.type / message / stacktrace,
 * normalizes the top stack frame, and hashes (OrgId, ServiceName, ExceptionType,
 * TopFrame) with cityHash64 to produce a stable per-issue FingerprintHash.
 * Sorted by (OrgId, FingerprintHash, Timestamp) so queries grouping by issue
 * and scanning recent activity stay on the sort-key prefix.
 */
export const errorEvents = defineDatasource("error_events", {
  description:
    "Per-error-occurrence rows for the triageable-errors system. Unwraps OTel exception events and computes a stable FingerprintHash for grouping into issues. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime(),
    TraceId: t.string(),
    SpanId: t.string(),
    ParentSpanId: t.string().default("__unset__"),
    ServiceName: t.string().lowCardinality(),
    DeploymentEnv: t.string().lowCardinality(),
    ExceptionType: t.string().lowCardinality(),
    ExceptionMessage: t.string(),
    ExceptionStacktrace: t.string(),
    TopFrame: t.string(),
    FingerprintHash: t.uint64(),
    StatusMessage: t.string(),
    Duration: t.uint64(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "FingerprintHash", "Timestamp"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type ErrorEventsRow = InferRow<typeof errorEvents>;

/**
 * Pre-materialized root spans for the trace list view.
 * Extracts HTTP attributes and normalizes span names at write time
 * so the trace list query avoids scanning heavy Map columns and GROUP BY.
 * Sorted by (OrgId, Timestamp, TraceId) for fast time-range pagination.
 * Populated by materialized view, not direct ingestion.
 */
export const traceListMv = defineDatasource("trace_list_mv", {
  description:
    "Pre-materialized root spans for the trace list view. Extracts HTTP attributes and normalizes span names at write time. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    TraceId: t.string(),
    Timestamp: t.dateTime(),
    ServiceName: t.string().lowCardinality(),
    SpanName: t.string(),
    SpanKind: t.string().lowCardinality(),
    Duration: t.uint64(),
    StatusCode: t.string().lowCardinality(),
    HttpMethod: t.string().lowCardinality(),
    HttpRoute: t.string(),
    HttpStatusCode: t.string().lowCardinality(),
    DeploymentEnv: t.string().lowCardinality(),
    HasError: t.uint8(),
    TraceState: t.string(),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "Timestamp", "TraceId"],
    ttl: "Timestamp + INTERVAL 90 DAY",
  }),
});

export type TraceListMvRow = InferRow<typeof traceListMv>;

/**
 * All spans for a given trace, re-sorted by TraceId for fast detail lookups.
 * Populated by materialized view, not direct ingestion.
 * Sorting key (OrgId, TraceId, SpanId) enables O(log N) primary-key lookup
 * instead of bloom-filter scanning across all partitions.
 */
export const traceDetailSpans = defineDatasource("trace_detail_spans", {
  description:
    "All spans for a trace, sorted by TraceId for fast detail lookups. Populated by materialized view.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Timestamp: t.dateTime64(9),
    TraceId: t.string(),
    SpanId: t.string(),
    ParentSpanId: t.string(),
    SpanName: t.string().lowCardinality(),
    SpanKind: t.string().lowCardinality(),
    ServiceName: t.string().lowCardinality(),
    Duration: t.uint64().default(0),
    StatusCode: t.string().lowCardinality(),
    StatusMessage: t.string(),
    SpanAttributes: t.map(t.string().lowCardinality(), t.string()),
    ResourceAttributes: t.map(t.string().lowCardinality(), t.string()),
    EventsTimestamp: t.array(t.dateTime64(9)),
    EventsName: t.array(t.string().lowCardinality()),
    EventsAttributes: t.array(t.map(t.string().lowCardinality(), t.string())),
  },
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "TraceId", "SpanId"],
    ttl: "toDate(Timestamp) + INTERVAL 90 DAY",
  }),
});

export type TraceDetailSpansRow = InferRow<typeof traceDetailSpans>;

/**
 * OpenTelemetry sum/counter metrics datasource
 */
export const metricsSum = defineDatasource("metrics_sum", {
  description:
    "This is a table that contains the metrics from the OpenTelemetry Collector.",
  schema: {
    OrgId: column(t.string().lowCardinality(), {
      jsonPath: "$.resource_attributes.maple_org_id",
    }),
    ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.resource_attributes",
    }),
    ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
    ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
    ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
    ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.scope_attributes",
    }),
    ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
    ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
    MetricName: column(t.string().lowCardinality(), {
      jsonPath: "$.metric_name",
    }),
    MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
    MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
    Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.metric_attributes",
    }),
    StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
    TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
    Value: column(t.float64(), { jsonPath: "$.value" }),
    Flags: column(t.uint32(), { jsonPath: "$.flags" }),
    ExemplarsTraceId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_trace_id[:]",
    }),
    ExemplarsSpanId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_span_id[:]",
    }),
    ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
      jsonPath: "$.exemplars_timestamp[:]",
    }),
    ExemplarsValue: column(t.array(t.float64()), {
      jsonPath: "$.exemplars_value[:]",
    }),
    ExemplarsFilteredAttributes: column(
      t.array(t.map(t.string().lowCardinality(), t.string())),
      { jsonPath: "$.exemplars_filtered_attributes[:]" }
    ),
    AggregationTemporality: column(t.int32(), {
      jsonPath: "$.aggregation_temporality",
    }),
    IsMonotonic: column(t.bool(), { jsonPath: "$.is_monotonic" }),
  },
  forwardQuery: `
    SELECT
      OrgId,
      ResourceAttributes,
      ResourceSchemaUrl,
      ScopeName,
      ScopeVersion,
      ScopeAttributes,
      ScopeSchemaUrl,
      ServiceName,
      MetricName,
      MetricDescription,
      MetricUnit,
      Attributes,
      StartTimeUnix,
      TimeUnix,
      Value,
      CAST(Flags, 'UInt32') AS Flags,
      ExemplarsTraceId,
      ExemplarsSpanId,
      ExemplarsTimestamp,
      ExemplarsValue,
      ExemplarsFilteredAttributes,
      AggregationTemporality,
      IsMonotonic
  `,
  engine: engine.mergeTree({
    partitionKey: "toDate(TimeUnix)",
    sortingKey: [
      "OrgId",
      "ServiceName",
      "MetricName",
      "Attributes",
      "toUnixTimestamp64Nano(TimeUnix)",
    ],
    ttl: "toDate(TimeUnix) + INTERVAL 365 DAY",
  }),
});

export type MetricsSumRow = InferRow<typeof metricsSum>;

/**
 * OpenTelemetry gauge metrics datasource
 */
export const metricsGauge = defineDatasource("metrics_gauge", {
  description:
    "This is a table that contains the metrics from the OpenTelemetry Collector.",
  schema: {
    OrgId: column(t.string().lowCardinality(), {
      jsonPath: "$.resource_attributes.maple_org_id",
    }),
    ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.resource_attributes",
    }),
    ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
    ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
    ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
    ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.scope_attributes",
    }),
    ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
    ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
    MetricName: column(t.string().lowCardinality(), {
      jsonPath: "$.metric_name",
    }),
    MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
    MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
    Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.metric_attributes",
    }),
    StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
    TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
    Value: column(t.float64(), { jsonPath: "$.value" }),
    Flags: column(t.uint32(), { jsonPath: "$.flags" }),
    ExemplarsTraceId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_trace_id[:]",
    }),
    ExemplarsSpanId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_span_id[:]",
    }),
    ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
      jsonPath: "$.exemplars_timestamp[:]",
    }),
    ExemplarsValue: column(t.array(t.float64()), {
      jsonPath: "$.exemplars_value[:]",
    }),
    ExemplarsFilteredAttributes: column(
      t.array(t.map(t.string().lowCardinality(), t.string())),
      { jsonPath: "$.exemplars_filtered_attributes[:]" }
    ),
  },
  forwardQuery: `
    SELECT
      OrgId,
      ResourceAttributes,
      ResourceSchemaUrl,
      ScopeName,
      ScopeVersion,
      ScopeAttributes,
      ScopeSchemaUrl,
      ServiceName,
      MetricName,
      MetricDescription,
      MetricUnit,
      Attributes,
      StartTimeUnix,
      TimeUnix,
      Value,
      CAST(Flags, 'UInt32') AS Flags,
      ExemplarsTraceId,
      ExemplarsSpanId,
      ExemplarsTimestamp,
      ExemplarsValue,
      ExemplarsFilteredAttributes
  `,
  engine: engine.mergeTree({
    partitionKey: "toDate(TimeUnix)",
    sortingKey: [
      "OrgId",
      "ServiceName",
      "MetricName",
      "Attributes",
      "toUnixTimestamp64Nano(TimeUnix)",
    ],
    ttl: "toDate(TimeUnix) + INTERVAL 365 DAY",
  }),
});

export type MetricsGaugeRow = InferRow<typeof metricsGauge>;

/**
 * OpenTelemetry histogram metrics datasource
 */
export const metricsHistogram = defineDatasource("metrics_histogram", {
  description:
    "This is a table that contains the metrics from the OpenTelemetry Collector.",
  schema: {
    OrgId: column(t.string().lowCardinality(), {
      jsonPath: "$.resource_attributes.maple_org_id",
    }),
    ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.resource_attributes",
    }),
    ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
    ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
    ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
    ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.scope_attributes",
    }),
    ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
    ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
    MetricName: column(t.string().lowCardinality(), {
      jsonPath: "$.metric_name",
    }),
    MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
    MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
    Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
      jsonPath: "$.metric_attributes",
    }),
    StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
    TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
    Count: column(t.uint64(), { jsonPath: "$.count" }),
    Sum: column(t.float64(), { jsonPath: "$.sum" }),
    BucketCounts: column(t.array(t.uint64()), {
      jsonPath: "$.bucket_counts[:]",
    }),
    ExplicitBounds: column(t.array(t.float64()), {
      jsonPath: "$.explicit_bounds[:]",
    }),
    ExemplarsTraceId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_trace_id[:]",
    }),
    ExemplarsSpanId: column(t.array(t.string()), {
      jsonPath: "$.exemplars_span_id[:]",
    }),
    ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
      jsonPath: "$.exemplars_timestamp[:]",
    }),
    ExemplarsValue: column(t.array(t.float64()), {
      jsonPath: "$.exemplars_value[:]",
    }),
    ExemplarsFilteredAttributes: column(
      t.array(t.map(t.string().lowCardinality(), t.string())),
      { jsonPath: "$.exemplars_filtered_attributes[:]" }
    ),
    Flags: column(t.uint32(), { jsonPath: "$.flags" }),
    Min: column(t.float64().nullable(), { jsonPath: "$.min" }),
    Max: column(t.float64().nullable(), { jsonPath: "$.max" }),
    AggregationTemporality: column(t.int32(), {
      jsonPath: "$.aggregation_temporality",
    }),
  },
  forwardQuery: `
    SELECT
      OrgId,
      ResourceAttributes,
      ResourceSchemaUrl,
      ScopeName,
      ScopeVersion,
      ScopeAttributes,
      ScopeSchemaUrl,
      ServiceName,
      MetricName,
      MetricDescription,
      MetricUnit,
      Attributes,
      StartTimeUnix,
      TimeUnix,
      Count,
      Sum,
      BucketCounts,
      ExplicitBounds,
      ExemplarsTraceId,
      ExemplarsSpanId,
      ExemplarsTimestamp,
      ExemplarsValue,
      ExemplarsFilteredAttributes,
      CAST(Flags, 'UInt32') AS Flags,
      CAST(Min, 'Nullable(Float64)') AS Min,
      CAST(Max, 'Nullable(Float64)') AS Max,
      AggregationTemporality
  `,
  engine: engine.mergeTree({
    partitionKey: "toDate(TimeUnix)",
    sortingKey: [
      "OrgId",
      "ServiceName",
      "MetricName",
      "Attributes",
      "toUnixTimestamp64Nano(TimeUnix)",
    ],
    ttl: "toDate(TimeUnix) + INTERVAL 365 DAY",
  }),
});

export type MetricsHistogramRow = InferRow<typeof metricsHistogram>;

/**
 * OpenTelemetry exponential histogram metrics datasource
 */
export const metricsExponentialHistogram = defineDatasource(
  "metrics_exponential_histogram",
  {
    description:
      "This is a table that contains the metrics from the OpenTelemetry Collector.",
    schema: {
      OrgId: column(t.string().lowCardinality(), {
        jsonPath: "$.resource_attributes.maple_org_id",
      }),
      ResourceAttributes: column(
        t.map(t.string().lowCardinality(), t.string()),
        { jsonPath: "$.resource_attributes" }
      ),
      ResourceSchemaUrl: column(t.string(), {
        jsonPath: "$.resource_schema_url",
      }),
      ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
      ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
      ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
        jsonPath: "$.scope_attributes",
      }),
      ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
      ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
      MetricName: column(t.string().lowCardinality(), {
        jsonPath: "$.metric_name",
      }),
      MetricDescription: column(t.string().lowCardinality(), {
        jsonPath: "$.metric_description",
      }),
      MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
      Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
        jsonPath: "$.metric_attributes",
      }),
      StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
      TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
      Count: column(t.uint64(), { jsonPath: "$.count" }),
      Sum: column(t.float64(), { jsonPath: "$.sum" }),
      Scale: column(t.int32(), { jsonPath: "$.scale" }),
      ZeroCount: column(t.uint64(), { jsonPath: "$.zero_count" }),
      PositiveOffset: column(t.int32(), { jsonPath: "$.positive_offset" }),
      PositiveBucketCounts: column(t.array(t.uint64()), {
        jsonPath: "$.positive_bucket_counts[:]",
      }),
      NegativeOffset: column(t.int32(), { jsonPath: "$.negative_offset" }),
      NegativeBucketCounts: column(t.array(t.uint64()), {
        jsonPath: "$.negative_bucket_counts[:]",
      }),
      ExemplarsTraceId: column(t.array(t.string()), {
        jsonPath: "$.exemplars_trace_id[:]",
      }),
      ExemplarsSpanId: column(t.array(t.string()), {
        jsonPath: "$.exemplars_span_id[:]",
      }),
      ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
        jsonPath: "$.exemplars_timestamp[:]",
      }),
      ExemplarsValue: column(t.array(t.float64()), {
        jsonPath: "$.exemplars_value[:]",
      }),
      ExemplarsFilteredAttributes: column(
        t.array(t.map(t.string().lowCardinality(), t.string())),
        { jsonPath: "$.exemplars_filtered_attributes[:]" }
      ),
      Flags: column(t.uint32(), { jsonPath: "$.flags" }),
      Min: column(t.float64().nullable(), { jsonPath: "$.min" }),
      Max: column(t.float64().nullable(), { jsonPath: "$.max" }),
      AggregationTemporality: column(t.int32(), {
        jsonPath: "$.aggregation_temporality",
      }),
    },
    forwardQuery: `
      SELECT
        OrgId,
        ResourceAttributes,
        ResourceSchemaUrl,
        ScopeName,
        ScopeVersion,
        ScopeAttributes,
        ScopeSchemaUrl,
        ServiceName,
        MetricName,
        MetricDescription,
        MetricUnit,
        Attributes,
        StartTimeUnix,
        TimeUnix,
        Count,
        Sum,
        Scale,
        ZeroCount,
        PositiveOffset,
        PositiveBucketCounts,
        NegativeOffset,
        NegativeBucketCounts,
        ExemplarsTraceId,
        ExemplarsSpanId,
        ExemplarsTimestamp,
        ExemplarsValue,
        ExemplarsFilteredAttributes,
        CAST(Flags, 'UInt32') AS Flags,
        CAST(Min, 'Nullable(Float64)') AS Min,
        CAST(Max, 'Nullable(Float64)') AS Max,
        AggregationTemporality
    `,
    engine: engine.mergeTree({
      partitionKey: "toDate(TimeUnix)",
      sortingKey: [
        "OrgId",
        "ServiceName",
        "MetricName",
        "Attributes",
        "toUnixTimestamp64Nano(TimeUnix)",
      ],
      ttl: "toDate(TimeUnix) + INTERVAL 365 DAY",
    }),
  }
);

export type MetricsExponentialHistogramRow = InferRow<
  typeof metricsExponentialHistogram
>;

/**
 * Pre-aggregated attribute keys with hourly usage counts.
 * Fed by MVs from traces (span + resource), logs, and metrics tables.
 */
export const attributeKeysHourly = defineDatasource("attribute_keys_hourly", {
  description:
    "Pre-aggregated attribute keys with hourly usage counts from traces, logs, and metrics.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Hour: t.dateTime(),
    AttributeKey: t.string().lowCardinality(),
    AttributeScope: t.string().lowCardinality(),
    UsageCount: t.simpleAggregateFunction("sum", t.uint64()),
  },
  engine: engine.aggregatingMergeTree({
    partitionKey: "toDate(Hour)",
    sortingKey: ["OrgId", "AttributeScope", "Hour", "AttributeKey"],
    ttl: "Hour + INTERVAL 90 DAY",
  }),
});

export type AttributeKeysHourlyRow = InferRow<typeof attributeKeysHourly>;

/**
 * Pre-aggregated attribute values with hourly usage counts.
 * Fed by MVs from traces for span and resource attribute values.
 */
export const attributeValuesHourly = defineDatasource("attribute_values_hourly", {
  description:
    "Pre-aggregated attribute values with hourly usage counts from trace span and resource attributes.",
  jsonPaths: false,
  schema: {
    OrgId: t.string().lowCardinality(),
    Hour: t.dateTime(),
    AttributeKey: t.string().lowCardinality(),
    AttributeValue: t.string(),
    AttributeScope: t.string().lowCardinality(),
    UsageCount: t.simpleAggregateFunction("sum", t.uint64()),
  },
  engine: engine.aggregatingMergeTree({
    partitionKey: "toDate(Hour)",
    sortingKey: ["OrgId", "AttributeScope", "AttributeKey", "Hour", "AttributeValue"],
    ttl: "Hour + INTERVAL 90 DAY",
  }),
});

export type AttributeValuesHourlyRow = InferRow<typeof attributeValuesHourly>;

/**
 * Alert check history datasource.
 * One row per alert rule evaluation (approximately one per rule per group per minute).
 * Durable audit trail of every check — the underlying signal that incidents are derived from.
 *
 * Enum8 values for Status/IncidentTransition/Comparator/SignalType must stay in sync with
 * the runtime literals in `packages/domain/src/http/alerts.ts` and `NormalizedRule`.
 */
export const alertChecks = defineDatasource("alert_checks", {
  description:
    "One row per alert rule evaluation. Durable audit trail of checks: status, observed value, threshold, sample count, incident linkage.",
  // jsonPaths enabled: alert_checks is ingested directly via POST /v0/events from
  // AlertsService.processEvaluation, not via a materialized view. Each column gets
  // an auto-generated `$.ColumnName` path matching the NDJSON keys in AlertChecksRow.
  // Status/SignalType/Comparator/IncidentTransition use LowCardinality(String) — not
  // Enum8 — because Tinybird's /v0/events JSONPath ingestion doesn't support Enum8.
  // The runtime literals live in http/alerts.ts and NormalizedRule; TS narrows them
  // at the assignment site in AlertsService.processEvaluation.
  schema: {
    OrgId: t.string().lowCardinality(),
    RuleId: t.string(),
    GroupKey: t.string(),
    Timestamp: t.dateTime64(3),
    Status: t.string().lowCardinality(),
    SignalType: t.string().lowCardinality(),
    Comparator: t.string().lowCardinality(),
    Threshold: t.float64(),
    ObservedValue: t.float64().nullable(),
    SampleCount: t.uint32(),
    WindowMinutes: t.uint16(),
    WindowStart: t.dateTime64(3),
    WindowEnd: t.dateTime64(3),
    ConsecutiveBreaches: t.uint16(),
    ConsecutiveHealthy: t.uint16(),
    IncidentId: t.string().nullable(),
    IncidentTransition: t.string().lowCardinality(),
    EvaluationDurationMs: t.uint32(),
  },
  // Bridge the legacy Enum8 → LowCardinality(String) migration. Tinybird requires
  // this for incompatible type changes even on an empty table. Remove in a follow-up
  // deploy once the new schema is live and no old rows exist.
  forwardQuery: `
    SELECT
      OrgId,
      RuleId,
      GroupKey,
      Timestamp,
      CAST(Status, 'LowCardinality(String)') AS Status,
      CAST(SignalType, 'LowCardinality(String)') AS SignalType,
      CAST(Comparator, 'LowCardinality(String)') AS Comparator,
      Threshold,
      ObservedValue,
      SampleCount,
      WindowMinutes,
      WindowStart,
      WindowEnd,
      ConsecutiveBreaches,
      ConsecutiveHealthy,
      IncidentId,
      CAST(IncidentTransition, 'LowCardinality(String)') AS IncidentTransition,
      EvaluationDurationMs
  `,
  engine: engine.mergeTree({
    partitionKey: "toDate(Timestamp)",
    sortingKey: ["OrgId", "RuleId", "GroupKey", "Timestamp"],
    ttl: "toDate(Timestamp) + INTERVAL 90 DAY",
  }),
});

export type AlertChecksRow = InferRow<typeof alertChecks>;

/**
 * Generalized hourly aggregating MV target for traces. Stores partial state
 * (`-State` aggregates) keyed on the dimensions that show up in 90%+ of
 * traces queries. Query layer finalizes via `-Merge` combinators at read
 * time, so a single MV serves timeseries, breakdown, and service-overview
 * shapes for any combination of these dimensions.
 *
 * Sample-aware from day one — counts and quantiles are weighted by
 * `SampleRate`, so upstream sampling does not bias dashboards.
 *
 * Populated by materialized view, not direct ingestion.
 *
 * SOURCE TTL: 90d (matches `traces.ttl`). Update in lockstep if raw TTL
 * changes — see docs/persistence.md.
 */
export const tracesAggregatesHourly = defineDatasource(
  "traces_aggregates_hourly",
  {
    description:
      "Hourly pre-aggregated trace metrics with sampling-weighted state columns. Generalized MV target for timeseries/breakdown/service-overview queries. AggregatingMergeTree.",
    jsonPaths: false,
    schema: {
      OrgId: t.string().lowCardinality(),
      Hour: t.dateTime(),
      ServiceName: t.string().lowCardinality(),
      SpanName: t.string().lowCardinality(),
      SpanKind: t.string().lowCardinality(),
      StatusCode: t.string().lowCardinality(),
      IsEntryPoint: t.uint8(),
      DeploymentEnv: t.string().lowCardinality(),
      // Sample-corrected count: sum of SampleRate (1.0 for unsampled, >1 for sampled)
      WeightedCount: t.simpleAggregateFunction("sum", t.float64()),
      // Sample-corrected duration sum: sum(Duration * SampleRate). Pair with WeightedCount for weighted avg.
      WeightedDurationSum: t.simpleAggregateFunction("sum", t.float64()),
      // Sample-corrected error count: sum of SampleRate for error spans
      WeightedErrorCount: t.simpleAggregateFunction("sum", t.float64()),
      // Quantile state (t-digest, weighted) — finalize with
      // quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles),
      // which returns Array(Float64) of [p50, p95, p99].
      //
      // CH type sig: AggregateFunction(quantilesTDigestWeighted(...), value_type, weight_type)
      // Tinybird SDK's aggregateFunction(func, type) only emits one type slot,
      // so we smuggle the value type (UInt64 for Duration) into the function
      // name and pass the weight type (UInt32 for toUInt32(SampleRate)) as
      // the explicit type argument. Generated SQL:
      //   AggregateFunction(quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64, UInt32)
      DurationQuantiles: t.aggregateFunction(
        "quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64",
        t.uint32()
      ),
      // Min/max are not weighted — true population extremes
      DurationMin: t.simpleAggregateFunction("min", t.uint64()),
      DurationMax: t.simpleAggregateFunction("max", t.uint64()),
    },
    engine: engine.aggregatingMergeTree({
      partitionKey: "toDate(Hour)",
      sortingKey: [
        "OrgId",
        "Hour",
        "ServiceName",
        "SpanName",
        "SpanKind",
        "StatusCode",
        "IsEntryPoint",
        "DeploymentEnv",
      ],
      ttl: "toDate(Hour) + INTERVAL 90 DAY",
    }),
  }
);

export type TracesAggregatesHourlyRow = InferRow<typeof tracesAggregatesHourly>;

/**
 * Generalized hourly aggregating MV target for logs. Severity-aware so
 * "errors per service per hour" / "log volume by severity" queries no
 * longer scan raw logs.
 *
 * SOURCE TTL: 90d (matches `logs.ttl`).
 */
export const logsAggregatesHourly = defineDatasource(
  "logs_aggregates_hourly",
  {
    description:
      "Hourly pre-aggregated log counts and sizes by service × severity × deployment env. AggregatingMergeTree.",
    jsonPaths: false,
    schema: {
      OrgId: t.string().lowCardinality(),
      Hour: t.dateTime(),
      ServiceName: t.string().lowCardinality(),
      SeverityText: t.string().lowCardinality(),
      DeploymentEnv: t.string().lowCardinality(),
      Count: t.simpleAggregateFunction("sum", t.uint64()),
      SizeBytes: t.simpleAggregateFunction("sum", t.uint64()),
    },
    engine: engine.aggregatingMergeTree({
      partitionKey: "toDate(Hour)",
      sortingKey: [
        "OrgId",
        "Hour",
        "ServiceName",
        "SeverityText",
        "DeploymentEnv",
      ],
      ttl: "toDate(Hour) + INTERVAL 90 DAY",
    }),
  }
);

export type LogsAggregatesHourlyRow = InferRow<typeof logsAggregatesHourly>;
