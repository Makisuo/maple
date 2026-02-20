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
  },
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
