//! Traces writer — Rust port of `packages/otel-collector-maple-exporter/exporter_traces.go`.
//!
//! Walks an `ExportTraceServiceRequest`, emits one `traces` row per span, and
//! returns the rows so the caller (pipeline orchestrator) can hand them to a
//! `ClickhouseClient`. Materialized views inside ClickHouse fan these out to
//! the per-feature tables (`error_events`, `service_overview_spans`,
//! `service_map_*`, `trace_list_mv`, `traces_aggregates_hourly`, etc.) — we
//! only insert into `traces`.
//!
//! Correctness anchor: the `golden_traces_parity` integration test reads the
//! Go exporter's `testdata/golden/traces_full_span.jsonl` directly. Any drift
//! in row shape between Rust and Go fails the test.

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::trace::v1::span::{Event, Link};
use serde_json::{json, Value as JsonValue};

use super::encoding::{
    any_value_as_string, attr_map, bytes_hex, format_timestamp_nano, marshal_row, service_name,
    span_kind_string, status_code_string,
};

/// Encode every span in `request` as a JSON row destined for the `traces`
/// table, stamping each with `org_id` (always wins over any resource-attribute
/// `maple_org_id` — same as the Go exporter's default mode where
/// `OrgIDFromResourceAttribute` is unset). Returns the encoded rows ready for
/// `ClickhouseClient::insert_json_each_row`.
pub fn encode_trace_rows(org_id: &str, request: &ExportTraceServiceRequest) -> Vec<Vec<u8>> {
    let mut rows = Vec::with_capacity(estimate_span_count(request));

    for resource_spans in &request.resource_spans {
        let resource_attrs = resource_spans
            .resource
            .as_ref()
            .map(|r| attr_map(&r.attributes))
            .unwrap_or_default();
        let resource_schema_url = resource_spans.schema_url.clone();
        let svc = resource_spans
            .resource
            .as_ref()
            .map(|r| service_name(&r.attributes))
            .unwrap_or_default();

        for scope_spans in &resource_spans.scope_spans {
            let (scope_name, scope_version, scope_attrs) = match &scope_spans.scope {
                Some(s) => (s.name.clone(), s.version.clone(), attr_map(&s.attributes)),
                None => (String::new(), String::new(), Default::default()),
            };
            let scope_schema_url = scope_spans.schema_url.clone();

            for span in &scope_spans.spans {
                let row = encode_trace_row(
                    org_id,
                    &svc,
                    &resource_attrs,
                    &resource_schema_url,
                    &scope_attrs,
                    &scope_name,
                    &scope_version,
                    &scope_schema_url,
                    span,
                );
                rows.push(marshal_row(&row));
            }
        }
    }

    rows
}

fn estimate_span_count(request: &ExportTraceServiceRequest) -> usize {
    request
        .resource_spans
        .iter()
        .flat_map(|rs| &rs.scope_spans)
        .map(|ss| ss.spans.len())
        .sum()
}

#[allow(clippy::too_many_arguments)]
fn encode_trace_row(
    org_id: &str,
    service_name: &str,
    resource_attrs: &std::collections::BTreeMap<String, String>,
    resource_schema_url: &str,
    scope_attrs: &std::collections::BTreeMap<String, String>,
    scope_name: &str,
    scope_version: &str,
    scope_schema_url: &str,
    span: &opentelemetry_proto::tonic::trace::v1::Span,
) -> JsonValue {
    let duration_ns = saturating_duration_ns(span.start_time_unix_nano, span.end_time_unix_nano);

    let (events_ts, events_name, events_attrs) = encode_events(&span.events);
    let (links_tid, links_sid, links_state, links_attrs) = encode_links(&span.links);

    let status_code = span.status.as_ref().map(|s| s.code).unwrap_or(0);
    let status_message = span.status.as_ref().map(|s| s.message.clone()).unwrap_or_default();

    let span_attrs = attr_map(&span.attributes);

    json!({
        "OrgId":              org_id,
        "Timestamp":          format_timestamp_nano(span.start_time_unix_nano),
        "TraceId":            bytes_hex(&span.trace_id),
        "SpanId":             bytes_hex(&span.span_id),
        "ParentSpanId":       bytes_hex(&span.parent_span_id),
        "TraceState":         span.trace_state,
        "SpanName":           span.name,
        "SpanKind":           span_kind_string(span.kind),
        "ServiceName":        service_name,
        "ResourceSchemaUrl":  resource_schema_url,
        "ResourceAttributes": resource_attrs,
        "ScopeSchemaUrl":     scope_schema_url,
        "ScopeName":          scope_name,
        "ScopeVersion":       scope_version,
        "ScopeAttributes":    scope_attrs,
        "Duration":           duration_ns,
        "StatusCode":         status_code_string(status_code),
        "StatusMessage":      status_message,
        "SpanAttributes":     span_attrs,
        "EventsTimestamp":    events_ts,
        "EventsName":         events_name,
        "EventsAttributes":   events_attrs,
        "LinksTraceId":       links_tid,
        "LinksSpanId":        links_sid,
        "LinksTraceState":    links_state,
        "LinksAttributes":    links_attrs,
    })
}

/// `end - start` in nanos; clamps to 0 when end is zero, missing, or earlier
/// than start. Mirrors the Go exporter's defensive logic so partial spans
/// don't underflow into giant durations.
fn saturating_duration_ns(start: u64, end: u64) -> u64 {
    if start == 0 || end == 0 || end <= start {
        0
    } else {
        end - start
    }
}

fn encode_events(
    events: &[Event],
) -> (
    Vec<String>,
    Vec<String>,
    Vec<std::collections::BTreeMap<String, String>>,
) {
    let mut ts = Vec::with_capacity(events.len());
    let mut names = Vec::with_capacity(events.len());
    let mut attrs = Vec::with_capacity(events.len());
    for ev in events {
        ts.push(format_timestamp_nano(ev.time_unix_nano));
        names.push(ev.name.clone());
        attrs.push(attr_map(&ev.attributes));
    }
    (ts, names, attrs)
}

fn encode_links(
    links: &[Link],
) -> (
    Vec<String>,
    Vec<String>,
    Vec<String>,
    Vec<std::collections::BTreeMap<String, String>>,
) {
    let mut tid = Vec::with_capacity(links.len());
    let mut sid = Vec::with_capacity(links.len());
    let mut state = Vec::with_capacity(links.len());
    let mut attrs = Vec::with_capacity(links.len());
    for l in links {
        tid.push(bytes_hex(&l.trace_id));
        sid.push(bytes_hex(&l.span_id));
        state.push(l.trace_state.clone());
        attrs.push(attr_map(&l.attributes));
    }
    (tid, sid, state, attrs)
}

// Suppress "unused import warning during incremental build", same idea as the
// Go exporter does at the bottom of exporter_traces.go.
#[allow(dead_code)]
fn _unused_imports_anchor() {
    let _ = any_value_as_string;
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::{any_value::Value as Av, AnyValue, KeyValue};
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{
        span::{Event, Link},
        ResourceSpans, ScopeSpans, Span, Status,
    };
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use serde_json::Value as JsonValue;

    /// 2024-01-15 10:30:00.123456789 UTC — the Go fixtures' fixed instant. Must
    /// match `fixedTimeNanos` in `exporter_traces_test.go` exactly.
    const FIXED_TIME_NANOS: u64 = 1_705_314_600_123_456_789;
    const FIXED_DURATION_NANOS: u64 = 250_000_000;

    #[test]
    fn duration_clamps_when_end_before_start() {
        assert_eq!(saturating_duration_ns(100, 50), 0);
        assert_eq!(saturating_duration_ns(100, 0), 0);
        assert_eq!(saturating_duration_ns(0, 100), 0);
        assert_eq!(saturating_duration_ns(100, 100), 0);
        assert_eq!(saturating_duration_ns(100, 350), 250);
    }

    #[test]
    fn empty_request_emits_zero_rows() {
        let req = ExportTraceServiceRequest::default();
        assert!(encode_trace_rows("o", &req).is_empty());
    }

    /// Build the exact same span as the Go fixture's `makeFullSpan()`. Any
    /// drift here desyncs the golden parity test — keep field-by-field
    /// alignment with `packages/otel-collector-maple-exporter/exporter_traces_test.go`.
    fn make_full_span_request() -> ExportTraceServiceRequest {
        fn s(k: &str, v: &str) -> KeyValue {
            KeyValue {
                key: k.to_string(),
                value: Some(AnyValue {
                    value: Some(Av::StringValue(v.to_string())),
                }),
            }
        }
        fn i(k: &str, v: i64) -> KeyValue {
            KeyValue {
                key: k.to_string(),
                value: Some(AnyValue {
                    value: Some(Av::IntValue(v)),
                }),
            }
        }

        let span = Span {
            trace_id: vec![
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
                0xcd, 0xef,
            ],
            span_id: vec![0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef],
            trace_state: "th:8".to_string(),
            parent_span_id: vec![0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10],
            flags: 0,
            name: "POST /v1/checkout".to_string(),
            kind: 2, // Server
            start_time_unix_nano: FIXED_TIME_NANOS,
            end_time_unix_nano: FIXED_TIME_NANOS + FIXED_DURATION_NANOS,
            attributes: vec![
                s("http.method", "POST"),
                s("http.route", "/v1/checkout"),
                i("http.status_code", 200),
                s("user.id", "user_42"),
            ],
            dropped_attributes_count: 0,
            events: vec![Event {
                time_unix_nano: FIXED_TIME_NANOS + 50_000_000,
                name: "cache.miss".to_string(),
                attributes: vec![s("cache.key", "cart:user_42")],
                dropped_attributes_count: 0,
            }],
            dropped_events_count: 0,
            links: vec![Link {
                trace_id: vec![
                    0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33,
                    0x22, 0x11, 0x00,
                ],
                span_id: vec![0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88],
                trace_state: String::new(),
                attributes: vec![s("link.kind", "follows-from")],
                dropped_attributes_count: 0,
                flags: 0,
            }],
            dropped_links_count: 0,
            status: Some(Status {
                message: String::new(),
                code: 1, // Ok
            }),
        };

        let scope_spans = ScopeSpans {
            scope: Some(InstrumentationScope {
                name: "checkout-api/tracer".to_string(),
                version: "1.4.2".to_string(),
                attributes: vec![s("library", "stdlib")],
                dropped_attributes_count: 0,
            }),
            spans: vec![span],
            schema_url: "https://opentelemetry.io/schemas/1.20.0".to_string(),
        };

        let resource_spans = ResourceSpans {
            resource: Some(Resource {
                attributes: vec![
                    s("service.name", "checkout-api"),
                    s("deployment.environment", "production"),
                    s("maple_org_id", "org_3AuiNCIuD1XCbbzcjkzE3s5HoQj"),
                    s("k8s.cluster.name", "prd-sw-default"),
                ],
                dropped_attributes_count: 0,
                entity_refs: vec![],
            }),
            scope_spans: vec![scope_spans],
            schema_url: "https://opentelemetry.io/schemas/1.20.0".to_string(),
        };

        ExportTraceServiceRequest {
            resource_spans: vec![resource_spans],
        }
    }

    /// Read the Go exporter's golden file relative to this crate's manifest
    /// dir. Single source of truth; if the schema changes deliberately, run
    /// `go test -update` in the Go package and copy nothing — the file is
    /// shared.
    fn read_go_golden(name: &str) -> Vec<u8> {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let path = std::path::Path::new(manifest)
            .join("..")
            .join("..")
            .join("packages")
            .join("otel-collector-maple-exporter")
            .join("testdata")
            .join("golden")
            .join(format!("{name}.jsonl"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("read golden {}: {}", path.display(), e))
    }

    /// Normalize a JSONL byte slice by parsing each line, re-serializing with
    /// sorted keys, and joining with '\n'. Mirrors the Go test's
    /// `normalizeRows`.
    fn normalize_jsonl(jsonl: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(jsonl.len());
        for line in jsonl.split(|&b| b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let v: JsonValue =
                serde_json::from_slice(line).expect("normalize_jsonl: invalid JSON line");
            let sorted = sort_recursively(v);
            let bytes = serde_json::to_vec(&sorted).unwrap();
            out.extend_from_slice(&bytes);
            out.push(b'\n');
        }
        out
    }

    fn sort_recursively(v: JsonValue) -> JsonValue {
        match v {
            JsonValue::Object(map) => {
                let sorted: std::collections::BTreeMap<String, JsonValue> = map
                    .into_iter()
                    .map(|(k, v)| (k, sort_recursively(v)))
                    .collect();
                let mut out = serde_json::Map::new();
                for (k, v) in sorted {
                    out.insert(k, v);
                }
                JsonValue::Object(out)
            }
            JsonValue::Array(items) => {
                JsonValue::Array(items.into_iter().map(sort_recursively).collect())
            }
            other => other,
        }
    }

    #[test]
    fn full_span_matches_go_exporter_golden() {
        let request = make_full_span_request();
        let rows = encode_trace_rows("org_default", &request);
        assert_eq!(rows.len(), 1, "expected exactly one row for one span");

        // Concatenate our row(s) with newline separators to form a JSONL
        // document, normalize it, and compare against the equivalent
        // normalization of the Go golden.
        let mut produced_jsonl = Vec::new();
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                produced_jsonl.push(b'\n');
            }
            produced_jsonl.extend_from_slice(row);
        }
        produced_jsonl.push(b'\n');

        let got = normalize_jsonl(&produced_jsonl);
        let want = normalize_jsonl(&read_go_golden("traces_full_span"));
        if got != want {
            panic!(
                "rust pipeline traces row diverged from Go golden\n--- got ---\n{}\n--- want ---\n{}",
                String::from_utf8_lossy(&got),
                String::from_utf8_lossy(&want),
            );
        }
    }
}
