import protobuf from "protobufjs"

/**
 * Self-contained OTLP protobuf source, inlined from the official
 * opentelemetry-proto repository. Field numbers MUST match upstream exactly so
 * that protobuf payloads emitted by real OTLP exporters decode correctly.
 *
 * Sources (opentelemetry-proto v1.x):
 *   - common/v1/common.proto
 *   - resource/v1/resource.proto
 *   - trace/v1/trace.proto
 *   - logs/v1/logs.proto
 *   - metrics/v1/metrics.proto
 *   - collector/{trace,logs,metrics}/v1/*_service.proto (request wrappers only)
 *
 * Kept as a single proto3 source string (no package separation needed) so the
 * binary stays `bun build --compile`-friendly — nothing is read from disk.
 */
const PROTO_SRC = `
syntax = "proto3";

// ---------------------------------------------------------------------------
// common/v1
// ---------------------------------------------------------------------------
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

// ---------------------------------------------------------------------------
// resource/v1
// ---------------------------------------------------------------------------
message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

// ---------------------------------------------------------------------------
// trace/v1
// ---------------------------------------------------------------------------
message TracesData {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;

  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }

  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;

  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }

  repeated Event events = 11;
  uint32 dropped_events_count = 12;

  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }

  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;
}

message Status {
  reserved 1;
  string message = 2;

  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }

  StatusCode code = 3;
}

// ---------------------------------------------------------------------------
// logs/v1
// ---------------------------------------------------------------------------
message LogsData {
  repeated ResourceLogs resource_logs = 1;
}

message ResourceLogs {
  Resource resource = 1;
  repeated ScopeLogs scope_logs = 2;
  string schema_url = 3;
}

message ScopeLogs {
  InstrumentationScope scope = 1;
  repeated LogRecord log_records = 2;
  string schema_url = 3;
}

enum SeverityNumber {
  SEVERITY_NUMBER_UNSPECIFIED = 0;
  SEVERITY_NUMBER_TRACE = 1;
  SEVERITY_NUMBER_TRACE2 = 2;
  SEVERITY_NUMBER_TRACE3 = 3;
  SEVERITY_NUMBER_TRACE4 = 4;
  SEVERITY_NUMBER_DEBUG = 5;
  SEVERITY_NUMBER_DEBUG2 = 6;
  SEVERITY_NUMBER_DEBUG3 = 7;
  SEVERITY_NUMBER_DEBUG4 = 8;
  SEVERITY_NUMBER_INFO = 9;
  SEVERITY_NUMBER_INFO2 = 10;
  SEVERITY_NUMBER_INFO3 = 11;
  SEVERITY_NUMBER_INFO4 = 12;
  SEVERITY_NUMBER_WARN = 13;
  SEVERITY_NUMBER_WARN2 = 14;
  SEVERITY_NUMBER_WARN3 = 15;
  SEVERITY_NUMBER_WARN4 = 16;
  SEVERITY_NUMBER_ERROR = 17;
  SEVERITY_NUMBER_ERROR2 = 18;
  SEVERITY_NUMBER_ERROR3 = 19;
  SEVERITY_NUMBER_ERROR4 = 20;
  SEVERITY_NUMBER_FATAL = 21;
  SEVERITY_NUMBER_FATAL2 = 22;
  SEVERITY_NUMBER_FATAL3 = 23;
  SEVERITY_NUMBER_FATAL4 = 24;
}

message LogRecord {
  reserved 4;

  fixed64 time_unix_nano = 1;
  fixed64 observed_time_unix_nano = 11;
  SeverityNumber severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  string event_name = 12;
}

// ---------------------------------------------------------------------------
// metrics/v1
// ---------------------------------------------------------------------------
message MetricsData {
  repeated ResourceMetrics resource_metrics = 1;
}

message ResourceMetrics {
  Resource resource = 1;
  repeated ScopeMetrics scope_metrics = 2;
  string schema_url = 3;
}

message ScopeMetrics {
  InstrumentationScope scope = 1;
  repeated Metric metrics = 2;
  string schema_url = 3;
}

message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;

  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }

  repeated KeyValue metadata = 12;
}

enum AggregationTemporality {
  AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
  AGGREGATION_TEMPORALITY_DELTA = 1;
  AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
}

message Gauge {
  repeated NumberDataPoint data_points = 1;
}

message Sum {
  repeated NumberDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
  bool is_monotonic = 3;
}

message Histogram {
  repeated HistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message ExponentialHistogram {
  repeated ExponentialHistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message Summary {
  repeated SummaryDataPoint data_points = 1;
}

message NumberDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;

  oneof value {
    double as_double = 4;
    sfixed64 as_int = 6;
  }

  repeated Exemplar exemplars = 5;
  uint32 flags = 8;
}

message HistogramDataPoint {
  repeated KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  optional double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
  repeated Exemplar exemplars = 8;
  uint32 flags = 10;
  optional double min = 11;
  optional double max = 12;
}

message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  optional double sum = 5;
  sint32 scale = 6;
  fixed64 zero_count = 7;

  message Buckets {
    sint32 offset = 1;
    repeated uint64 bucket_counts = 2;
  }

  Buckets positive = 8;
  Buckets negative = 9;
  uint32 flags = 10;
  repeated Exemplar exemplars = 11;
  optional double min = 12;
  optional double max = 13;
  double zero_threshold = 14;
}

message SummaryDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;

  message ValueAtQuantile {
    double quantile = 1;
    double value = 2;
  }

  repeated ValueAtQuantile quantile_values = 6;
  uint32 flags = 8;
}

message Exemplar {
  repeated KeyValue filtered_attributes = 7;
  fixed64 time_unix_nano = 2;

  oneof value {
    double as_double = 3;
    sfixed64 as_int = 6;
  }

  bytes span_id = 4;
  bytes trace_id = 5;
}

// ---------------------------------------------------------------------------
// collector request wrappers
// ---------------------------------------------------------------------------
message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ExportLogsServiceRequest {
  repeated ResourceLogs resource_logs = 1;
}

message ExportMetricsServiceRequest {
  repeated ResourceMetrics resource_metrics = 1;
}
`

/**
 * Shared protobufjs Root parsed from the inline OTLP source. `keepCase: false`
 * converts snake_case proto field names to lowerCamelCase, matching the
 * OTLP/JSON wire shape so a single encoder can consume either input.
 */
const otlpRoot = protobuf.parse(PROTO_SRC, { keepCase: false }).root

const ExportTraceServiceRequest = otlpRoot.lookupType("ExportTraceServiceRequest")
const ExportLogsServiceRequest = otlpRoot.lookupType("ExportLogsServiceRequest")
const ExportMetricsServiceRequest = otlpRoot.lookupType("ExportMetricsServiceRequest")

/**
 * Normalize a decoded protobuf message into the same plain-object shape the
 * OTLP/JSON wire format produces:
 *   - 64-bit ints (e.g. `*UnixNano`) become DECIMAL STRINGS
 *   - byte fields (`traceId`, `spanId`, ...) become BASE64 STRINGS
 *   - enums (`kind`, `code`, `severityNumber`, ...) stay NUMBERS
 *   - attributes are arrays of `{ key, value: AnyValue }`
 */
const toObjectOptions: protobuf.IConversionOptions = {
	longs: String,
	enums: Number,
	bytes: String,
	defaults: true,
	arrays: true,
	objects: true,
	oneofs: true,
}

export function decodeTraceRequest(bytes: Uint8Array): unknown {
	const message = ExportTraceServiceRequest.decode(bytes)
	return ExportTraceServiceRequest.toObject(message, toObjectOptions)
}

export function decodeLogsRequest(bytes: Uint8Array): unknown {
	const message = ExportLogsServiceRequest.decode(bytes)
	return ExportLogsServiceRequest.toObject(message, toObjectOptions)
}

export function decodeMetricsRequest(bytes: Uint8Array): unknown {
	const message = ExportMetricsServiceRequest.decode(bytes)
	return ExportMetricsServiceRequest.toObject(message, toObjectOptions)
}

/** Test helper: encode a trace request object to protobuf bytes. */
export function encodeTraceRequest(obj: unknown): Uint8Array {
	const message = ExportTraceServiceRequest.fromObject(obj as Record<string, unknown>)
	return ExportTraceServiceRequest.encode(message).finish()
}

/** Test helper: encode a metrics request object to protobuf bytes. */
export function encodeMetricsRequest(obj: unknown): Uint8Array {
	const message = ExportMetricsServiceRequest.fromObject(obj as Record<string, unknown>)
	return ExportMetricsServiceRequest.encode(message).finish()
}
