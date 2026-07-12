# OTLP (Protocol, Encodings & Exporter Config)

OTLP (OpenTelemetry Protocol) is the wire format OpenTelemetry SDKs and collectors use to send traces, metrics, and logs. It defines the transports (gRPC, HTTP/protobuf, HTTP/JSON), the protobuf message schemas (`Resource` → `Scope*` → `Span`/`Metric`/`LogRecord`), the request/response contract (including partial-success semantics), and retry/backpressure rules a compliant server must implement.

> **Relevance to Maple:** Maple's Rust ingest gateway (`apps/ingest`) is an **OTLP server** — it receives OTLP/HTTP (binary protobuf and JSON) from customer SDKs/collectors and must implement the server-side MUSTs below: correct status codes, partial-success vs full-failure semantics, `Retry-After`/throttling signals, and JSON encoding rules (hex trace/span IDs, camelCase, numeric enums, stringified int64). Getting these wrong causes silent data loss or client retry storms. Maple is also an OTLP **client** for self-observability (`apps/ingest` and the API self-instrument via `@effect/opentelemetry`/OTLP exporters) — the exporter env-var section governs that config. Our dummy-data script (`scripts/ingest-dummy.ts`, `bun run ingest:dummy`) hand-constructs OTLP/JSON and depends on the JSON encoding rules (camelCase + hex IDs); see also the root `CLAUDE.md` self-observability section for the loop-prevention rules layered on top of this transport.

---

## Stability

Per the OTLP spec (v1.10.0): OTLP is **Stable** for the **trace, metric, and log** signals. The **profiles** signal is **Development** status (entered public Alpha in March 2026 per the OpenTelemetry blog); its default HTTP path is versioned accordingly (`/v1development/profiles`, not `/v1/profiles`), and its proto messages/fields are explicitly excluded from stability guarantees until promoted.

Source: https://opentelemetry.io/docs/specs/otlp/ · https://opentelemetry.io/blog/2026/profiles-alpha/

---

## Transports: gRPC vs HTTP

| Transport | Default port | Encoding | Notes |
|---|---|---|---|
| OTLP/gRPC | **4317** | Protobuf (unary calls) | HTTP/2-based; server MAY multiplex gRPC and HTTP on the same port |
| OTLP/HTTP | **4318** | Protobuf (binary) or JSON | Implementations MAY use HTTP/1.1 or HTTP/2 |

### Default URL paths (OTLP/HTTP)

| Signal | Path | Stability |
|---|---|---|
| Traces | `/v1/traces` | Stable |
| Metrics | `/v1/metrics` | Stable |
| Logs | `/v1/logs` | Stable |
| Profiles | `/v1development/profiles` | Development |

### Content types

| Encoding | `Content-Type` |
|---|---|
| Binary protobuf | `application/x-protobuf` |
| JSON | `application/json` |

### Compression

- **MUST support:** "All server components MUST support the following transport compression options: No compression, denoted by `none`. Gzip compression, denoted by `gzip`."
- Client: "The client MAY gzip the content and in that case MUST include `Content-Encoding: gzip` request header."

### Concurrency

- gRPC: "The implementations that need to achieve high throughput SHOULD support concurrent Unary calls to achieve higher throughput," and "the number of concurrent requests SHOULD be configurable."
- HTTP: "the client MAY send requests using several parallel HTTP connections. In that case, the maximum number of parallel connections SHOULD be configurable."

### Connection management

- "The client SHOULD keep the connection alive between requests."
- "If the client cannot connect to the server, the client SHOULD retry the connection using an exponential backoff strategy between retries. The interval between retries must have a random jitter."
- "If the server disconnects without returning a response, the client SHOULD retry and send the same request."

Source: https://opentelemetry.io/docs/specs/otlp/

---

## Request/response shapes

Each signal has its own collector service with one RPC method:

```protobuf
service TraceService {
  rpc Export(ExportTraceServiceRequest) returns (ExportTraceServiceResponse) {}
}
```

(Analogous `MetricsService`/`LogsService`/`ProfilesService`, each with one `Export` unary RPC.)

```protobuf
message ExportTraceServiceRequest {
  repeated opentelemetry.proto.trace.v1.ResourceSpans resource_spans = 1;
}

message ExportTraceServiceResponse {
  ExportTracePartialSuccess partial_success = 1;
}

message ExportTracePartialSuccess {
  int64 rejected_spans = 1;   // 0 == fully accepted
  string error_message = 2;   // human-readable, English
}
```

Metrics/logs mirror this exactly: `ExportMetricsServiceRequest{resource_metrics}` / `ExportMetricsServiceResponse{partial_success: ExportMetricsPartialSuccess{rejected_data_points, error_message}}`, and `ExportLogsServiceRequest{resource_logs}` / `ExportLogsServiceResponse{partial_success: ExportLogsPartialSuccess{rejected_log_records, error_message}}`. Profiles: `rejected_profiles`.

Source: https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto

### Full success

- **gRPC:** server responds with the appropriate `Export<Signal>ServiceResponse` and **"MUST leave the `partial_success` field unset in case of a successful response."**
- **HTTP:** **"On success, the server MUST respond with `HTTP 200 OK`."** The response body **"MUST be a Protobuf-encoded `Export<signal>ServiceResponse` message"** (even for a JSON request — response encoding for HTTP is always the ordinary protobuf-JSON/binary mapping, matching the request's encoding).

### Partial success (server MUST rules)

Applicability: **"If the request is only partially accepted (i.e. when the server accepts only parts of the data and rejects the rest)…"** the server:

- **MUST** initialize the `partial_success` field.
- **MUST** set the respective `rejected_spans` / `rejected_data_points` / `rejected_log_records` / `rejected_profiles` field to the count of rejected items.
- **SHOULD** populate `error_message` with a human-readable (English) explanation.

Warnings-only case: **"Servers MAY also use the `partial_success` field to convey warnings/suggestions to clients even when the server fully accepts the request. In such cases, the `rejected_<signal>` field MUST have a value of `0`."**

Client behavior: **"The client MUST NOT retry the request when it receives a partial success response where the `partial_success` is populated"** — partial success is a terminal outcome, not a retry signal, regardless of which items were rejected.

Degenerate case: a `partial_success` with `rejected_* == 0` and empty `error_message` is defined as equivalent to the field being unset (full success).

Source: https://opentelemetry.io/docs/specs/otlp/ · https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto

### When to use partial success vs full failure (server MUST)

- If **any** part of the request is decodable and acceptable, respond `200 OK` + partial success describing what was rejected and why — do not fail the whole request just because some items were bad.
- If the request **cannot be decoded at all**, or is invalid such that nothing in it can be processed, and the failure is permanent: **"the server MUST respond with `HTTP 400 Bad Request`"** (full failure, no partial success). The client **"MUST NOT retry"** on a 400.

---

## Failure handling

### gRPC status codes — retryable matrix

| gRPC code | Retryable? |
|---|---|
| CANCELLED | Yes |
| UNKNOWN | No |
| INVALID_ARGUMENT | No |
| DEADLINE_EXCEEDED | Yes |
| NOT_FOUND | No |
| ALREADY_EXISTS | No |
| PERMISSION_DENIED | No |
| UNAUTHENTICATED | No |
| RESOURCE_EXHAUSTED | Only if server signals recoverability (via `RetryInfo`) |
| FAILED_PRECONDITION | No |
| ABORTED | Yes |
| OUT_OF_RANGE | Yes |
| UNIMPLEMENTED | No |
| INTERNAL | No |
| UNAVAILABLE | Yes |
| DATA_LOSS | Yes |

- Retryable: **"indicate that telemetry data processing failed, and the client SHOULD record the error and may retry exporting the same data."**
- Non-retryable: **"indicate that telemetry data processing failed, and the client MUST NOT retry sending the same telemetry data."**
- `RESOURCE_EXHAUSTED` special case: **"The client SHOULD interpret `RESOURCE_EXHAUSTED` code as retryable only if the server signals that the recovery from resource exhaustion is possible. This is signaled by the server by returning a status containing `RetryInfo`."**
- Backoff: **"When retrying, the client SHOULD implement an exponential backoff strategy."**
- gRPC backpressure signal: **"To signal backpressure when using gRPC transport, the server SHOULD return an error with code `Unavailable` and MAY supply additional details via status using `RetryInfo`."**

### HTTP status codes — retryable matrix

| HTTP status | Retryable? | Notes |
|---|---|---|
| 200 | n/a | Success (full or partial) |
| 400 Bad Request | **No** | Undecodable/permanently invalid request; client MUST NOT retry |
| 429 Too Many Requests | **Yes** | Throttling; MAY carry `Retry-After` |
| 502 Bad Gateway | **Yes** | |
| 503 Service Unavailable | **Yes** | Overload; MAY carry `Retry-After` |
| 504 Gateway Timeout | **Yes** | |
| other 4xx/5xx | **No** | **"All other `4xx` or `5xx` response status codes MUST NOT be retried."** |

- Error body: **"The response body for all `HTTP 4xx` and `HTTP 5xx` responses MUST be a Protobuf-encoded `Status` message that describes the problem."** — this applies regardless of whether the request was binary or JSON encoded.
- Bad data: **"If the processing of the request fails because the request contains data that cannot be decoded or is otherwise invalid and such failure is permanent, then the server MUST respond with `HTTP 400 Bad Request`."**

### Throttling / backpressure (server SHOULD)

- **"If the server is unable to keep up with the pace of data it receives from the client then it SHOULD signal that fact to the client."**
- HTTP: **"the server SHOULD respond with `HTTP 429 Too Many Requests` or `HTTP 503 Service Unavailable` and MAY include a `Retry-After` header with a recommended time interval in seconds."**
- Client honoring: **"The client SHOULD honour the waiting interval specified in the `Retry-After` header if it is present. If the client receives a retryable error code and the `Retry-After` header is not present in the response, then the client SHOULD implement an exponential backoff strategy."**

### Duplicate data (known limitation, informational)

**"In edge cases (e.g. on reconnections, network interruptions, etc) the client has no way of knowing if recently sent data was delivered if no acknowledgement was received yet. The client will typically choose to re-send such data to guarantee delivery, which may result in duplicate data on the server side."** — downstream consumers (Tinybird MVs, dashboards) should tolerate duplicate spans/log records/data points; OTLP does not guarantee exactly-once delivery.

### Empty envelopes

**"Senders SHOULD NOT create empty envelopes (OTLP payloads that contain zero spans, zero metric points or zero log records), receivers MAY ignore empty envelopes, and implementations that receive and send (forward) OTLP payloads MAY drop empty envelopes."**

Source: https://opentelemetry.io/docs/specs/otlp/

---

## JSON encoding (OTLP/HTTP JSON) — deviations from standard protobuf JSON

OTLP/HTTP JSON starts from the proto3 standard JSON mapping but overrides it in ways that matter for anyone hand-constructing or parsing OTLP JSON (e.g. Maple's ingest-dummy script):

| Aspect | Standard protobuf JSON | **OTLP/JSON rule** |
|---|---|---|
| `trace_id`/`span_id` (`bytes`) | base64 | **Case-insensitive hex-encoded string.** Example: `{"traceId": "5B8EFFF798038103D269B633813FC60C"}` |
| Field names | configurable | **lowerCamelCase only** — original (snake_case) field names are **not valid**. Example: `droppedAttributesCount`, not `dropped_attributes_count` |
| Enums | name string OR number, receiver's choice | **Numbers only — enum name strings MUST NOT be used.** Example: `{"kind": 2}`, not `{"kind": "SPAN_KIND_SERVER"}` |
| `int64`/`uint64` | string | Same as standard: **encoded as decimal strings**; **"either numbers or strings are accepted when decoding"** |
| Unknown fields | mapping-defined | **"OTLP/JSON receivers MUST ignore message fields with unknown names and MUST unmarshal the message as if the unknown field was not present"** (forward compatibility) |

These are normative MUSTs for any OTLP/JSON server, including Maple's ingest gateway when it accepts `Content-Type: application/json`.

Source: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding

---

## Proto schema essentials

All three stable signals share the same `Resource → Scope<Signal> → <Item>` hierarchy, each level carrying its own `schema_url`:

```
Export<Signal>ServiceRequest
└── repeated Resource<Signal>          (resource = 1, scope_<signal> = 2, schema_url = 3)
    └── repeated Scope<Signal>         (scope = 1, <items> = 2, schema_url = 3)
        └── repeated <Span|Metric|LogRecord>
```

- `ResourceSpans{resource, scope_spans[], schema_url}`, `ScopeSpans{scope, spans[], schema_url}`
- `ResourceMetrics{resource, scope_metrics[], schema_url}`, `ScopeMetrics{scope, metrics[], schema_url}`
- `ResourceLogs{resource, scope_logs[], schema_url}`, `ScopeLogs{scope, log_records[], schema_url}`

`schema_url` at the **resource** level versions the resource's attribute schema; at the **scope** level it versions the schema of the scope and everything nested under it (spans/metrics/log records in that `Scope*` block).

### `Resource`

```protobuf
message Resource {
  repeated KeyValue attributes = 1;       // keys MUST be unique
  uint32 dropped_attributes_count = 2;    // 0 == none dropped
  repeated EntityRef entity_refs = 3;     // Development status; keys must exist in attributes
}
```

### `InstrumentationScope` (common.proto)

```protobuf
message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
```

### `AnyValue` / `KeyValue` recursion (attribute value model)

```protobuf
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
    int32 string_value_strindex = 8;   // Alpha, profiling-exclusive
  }
}
message ArrayValue    { repeated AnyValue values = 1; }
message KeyValueList  { repeated KeyValue values = 1; }   // keys must be unique
message KeyValue {
  string key = 1;
  AnyValue value = 2;
  int32 key_strindex = 3;  // Alpha, profiling-exclusive; mutually exclusive with key
}
```

`ArrayValue`/`KeyValueList` let `AnyValue` recurse arbitrarily (arrays of any value, maps of any value), which is how OTel represents nested/structured attributes over a flat protobuf wire format.

### `Span` (trace.proto)

```protobuf
message Span {
  bytes  trace_id = 1;                 // 16 bytes
  bytes  span_id = 2;                  // 8 bytes
  string trace_state = 3;
  bytes  parent_span_id = 4;           // 8 bytes
  fixed32 flags = 16;                  // low 8 bits = W3C trace-context flags; bits 8-9 = remote span/link markers
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
}
enum SpanKind {
  SPAN_KIND_UNSPECIFIED = 0;
  SPAN_KIND_INTERNAL = 1;
  SPAN_KIND_SERVER = 2;
  SPAN_KIND_CLIENT = 3;
  SPAN_KIND_PRODUCER = 4;
  SPAN_KIND_CONSUMER = 5;
}
message Status {
  reserved 1;
  string message = 2;
  StatusCode code = 3;
  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
}
```

> Note for Maple: `Status.code` on the wire is the numeric enum (`0`/`1`/`2` — `Unset`/`Ok`/`Error`); the project's own data convention (per root `CLAUDE.md`) renders these as title-case strings (`"Ok"`, `"Error"`, `"Unset"`) once ingested — that's a Maple display/storage convention, not an OTLP wire rule.

### `LogRecord` (logs.proto)

```protobuf
message LogRecord {
  fixed64 time_unix_nano = 1;
  fixed64 observed_time_unix_nano = 11;
  SeverityNumber severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;                 // low 8 bits = W3C trace flags
  bytes trace_id = 9;                // 16 bytes, correlates log to a trace
  bytes span_id = 10;                // 8 bytes, correlates log to a span
  string event_name = 12;            // identifies the record as a named event
}
```

`SeverityNumber` is a 1–24 numeric scale (`UNSPECIFIED=0`, then `TRACE`(1-4)/`DEBUG`(5-8)/`INFO`(9-12)/`WARN`(13-16)/`ERROR`(17-20)/`FATAL`(21-24) tiers, each tier having 4 numbered sub-levels e.g. `TRACE2`).

### Dropped-count fields (uniform pattern across all signals)

Every repeated collection that the SDK may have truncated carries a paired `dropped_*_count: uint32` sibling — `dropped_attributes_count` (Resource, InstrumentationScope, Span, LogRecord, metric data points), `dropped_events_count`/`dropped_links_count` (Span only). `0` always means "nothing was dropped," never "field not applicable."

### `flags` fields

Both `Span.flags` (field 16) and `LogRecord.flags` (field 8) are `fixed32`, with the low 8 bits reserved for the W3C Trace Context trace-flags byte (e.g. sampled bit); `Span.flags` additionally uses bits 8-9 to mark whether the span's parent or a link is remote.

Source: https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto · https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto · https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto · https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto · https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/resource/v1/resource.proto

---

## Exporter configuration (`OTEL_EXPORTER_OTLP_*`)

All options are defined generically and per-signal (`TRACES`/`METRICS`/`LOGS`); **"Each configuration option MUST be overridable by a signal specific option"** — signal-specific always wins over the generic one.

| Env var (generic → per-signal suffix pattern) | Default | Values / format |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` → `_TRACES_ENDPOINT` / `_METRICS_ENDPOINT` / `_LOGS_ENDPOINT` | `http://localhost:4318` (HTTP), `http://localhost:4317` (gRPC) | URL (scheme+host+port[+path]) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` → `_TRACES_PROTOCOL` / etc. | `http/protobuf` | `grpc`, `http/protobuf`, `http/json` |
| `OTEL_EXPORTER_OTLP_HEADERS` → `_TRACES_HEADERS` / etc. | none | W3C Baggage-style `key1=value1,key2=value2` (no `;`); values always strings |
| `OTEL_EXPORTER_OTLP_TIMEOUT` → `_TRACES_TIMEOUT` / etc. | `10s` | duration |
| `OTEL_EXPORTER_OTLP_COMPRESSION` → `_TRACES_COMPRESSION` / etc. | none specified (SIG picks a sensible default) | `none`, `gzip` |
| `OTEL_EXPORTER_OTLP_INSECURE` → `_TRACES_INSECURE` / etc. | `false` | bool; gRPC-only (HTTP uses the endpoint's scheme). Legacy `OTEL_EXPORTER_OTLP_SPAN_INSECURE`/`_METRIC_INSECURE` SHOULD still be supported |
| `OTEL_EXPORTER_OTLP_CERTIFICATE` → `_TRACES_CERTIFICATE` / etc. | none | PEM file path (trusted server cert) |
| `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE` → `_TRACES_CLIENT_CERTIFICATE` / etc. | none | PEM file path (mTLS client cert/chain) |
| `OTEL_EXPORTER_OTLP_CLIENT_KEY` → `_TRACES_CLIENT_KEY` / etc. | none | PEM file path (mTLS client private key) |

### Endpoint path-appending rule — generic vs per-signal

- **Generic `OTEL_EXPORTER_OTLP_ENDPOINT` (HTTP):** the base URL, with the signal path appended: `v1/traces`, `v1/metrics`, `v1/logs`.
- **Per-signal endpoint (e.g. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`):** **"the URL MUST be used as-is without any modification. The only exception is that if a URL contains no path part, the root path `/` MUST be used."** — i.e. per-signal endpoints are NOT auto-suffixed with `/v1/traces`; you must include the full path yourself, or the request goes to `/`.
- **Precedence:** **"The per-signal endpoint configuration options take precedence and can be used to override this behavior (the URL is used as-is for them, without any modifications)."**

### Protocol defaults / SDK requirements

**"SDKs SHOULD support both `grpc` and `http/protobuf` transports and MUST support at least one. If they support only one, it SHOULD be `http/protobuf`."** Default protocol value is `http/protobuf` unless a language SIG documents otherwise.

### Retry requirement on the client/exporter

**"Transient errors MUST be handled with a retry strategy. This retry strategy MUST implement an exponential back-off with jitter to avoid overwhelming the destination until the network is restored or the destination has recovered."** ("Transient" = the retryable gRPC/HTTP codes above.)

Source: https://opentelemetry.io/docs/specs/otel/protocol/exporter/

---

## Key references

- OTLP specification (main spec — transports, request/response, retries, throttling): https://opentelemetry.io/docs/specs/otlp/
- OTLP/JSON encoding deviations: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
- Exporter configuration (env vars): https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- opentelemetry-proto repo (all `.proto` sources): https://github.com/open-telemetry/opentelemetry-proto
  - Trace: `opentelemetry/proto/trace/v1/trace.proto`
  - Logs: `opentelemetry/proto/logs/v1/logs.proto`
  - Metrics: `opentelemetry/proto/metrics/v1/metrics.proto`
  - Common (`AnyValue`/`KeyValue`/`InstrumentationScope`): `opentelemetry/proto/common/v1/common.proto`
  - Resource: `opentelemetry/proto/resource/v1/resource.proto`
  - Collector services (`Export` RPCs, partial-success messages): `opentelemetry/proto/collector/{trace,metrics,logs}/v1/*_service.proto`
- Profiles (Development/Alpha, separate proto fork for active WG work): https://github.com/open-telemetry/opentelemetry-proto-profile · https://opentelemetry.io/blog/2026/profiles-alpha/
- opentelemetry-proto stability policy (Development/Alpha/Beta/RC grades): https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md
