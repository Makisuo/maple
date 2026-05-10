//! Encoders that mirror the Go exporter's `internal/encoding.go` so the Rust
//! pipeline produces JSONEachRow rows byte-equivalent (after key-sorted
//! normalization) to the existing exporter. Any drift here breaks the
//! `traces_full_span` golden parity test.

use chrono::{DateTime, TimeZone, Utc};
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeMap;

/// Lower-case hex of `b`, with the Go exporter's special case: empty input AND
/// all-zero input both return `""`. Maple's `trace_list_mv` filters root spans
/// via `WHERE ParentSpanId = ''`, so all-zero parent IDs MUST stringify to
/// empty.
pub fn bytes_hex(b: &[u8]) -> String {
    if b.is_empty() || b.iter().all(|&v| v == 0) {
        return String::new();
    }
    let mut out = String::with_capacity(b.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &v in b {
        out.push(HEX[(v >> 4) as usize] as char);
        out.push(HEX[(v & 0x0f) as usize] as char);
    }
    out
}

/// `unix_nano` → `"YYYY-MM-DD HH:MM:SS.nnnnnnnnn"` UTC string ClickHouse
/// parses for `DateTime64(9)` columns under `date_time_input_format=best_effort`.
/// Zero converts to the Unix epoch literal so the column is always populated.
pub fn format_timestamp_nano(unix_nano: u64) -> String {
    if unix_nano == 0 {
        return "1970-01-01 00:00:00.000000000".to_string();
    }
    let secs = (unix_nano / 1_000_000_000) as i64;
    let nanos = (unix_nano % 1_000_000_000) as u32;
    let dt: DateTime<Utc> = Utc
        .timestamp_opt(secs, nanos)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    // Go uses "2006-01-02 15:04:05.000000000" which is fixed-width 9-digit nanos.
    dt.format("%Y-%m-%d %H:%M:%S%.9f").to_string()
}

/// Second-precision form for `Timestamp DateTime` / `Hour DateTime` columns.
#[allow(dead_code)] // used by logs/metrics writers in upcoming phases
pub fn format_datetime(unix_nano: u64) -> String {
    if unix_nano == 0 {
        return "1970-01-01 00:00:00".to_string();
    }
    let secs = (unix_nano / 1_000_000_000) as i64;
    let dt: DateTime<Utc> = Utc
        .timestamp_opt(secs, 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Maple's canonical `SpanKind` labels. Mirrors the Go exporter's
/// `SpanKindString` so the resulting `LowCardinality(String)` values stay
/// byte-stable.
pub fn span_kind_string(kind: i32) -> &'static str {
    match kind {
        1 => "Internal",
        2 => "Server",
        3 => "Client",
        4 => "Producer",
        5 => "Consumer",
        _ => "Unspecified",
    }
}

/// Maple's `"Ok"` / `"Error"` / `"Unset"` status labels. pdata uses
/// 0 = Unset, 1 = Ok, 2 = Error.
pub fn status_code_string(code: i32) -> &'static str {
    match code {
        1 => "Ok",
        2 => "Error",
        _ => "Unset",
    }
}

/// Severity-number → text mapping matching the Go exporter (`SeverityNumberToText`).
#[allow(dead_code)] // used by the logs writer in phase 2
pub fn severity_number_to_text(n: i32) -> String {
    match n {
        1..=4 => "TRACE".into(),
        5..=8 => "DEBUG".into(),
        9..=12 => "INFO".into(),
        13..=16 => "WARN".into(),
        17..=20 => "ERROR".into(),
        21..=24 => "FATAL".into(),
        other => other.to_string(),
    }
}

/// Stringify an OTLP `AnyValue` the way Go's `pcommon.Value.AsString()` does:
/// strings as-is, bools as `"true"`/`"false"`, ints as decimal, doubles as the
/// shortest round-trippable form, slices/maps as JSON, bytes as base64.
///
/// Used by [`attr_map`] to flatten attribute lists into the
/// `Map(LowCardinality(String), String)` shape Maple's tables expect.
pub fn any_value_as_string(value: &AnyValue) -> String {
    let Some(inner) = &value.value else {
        return String::new();
    };
    match inner {
        any_value::Value::StringValue(s) => s.clone(),
        any_value::Value::BoolValue(b) => if *b { "true" } else { "false" }.to_string(),
        any_value::Value::IntValue(i) => i.to_string(),
        any_value::Value::DoubleValue(f) => format_double_like_go(*f),
        any_value::Value::ArrayValue(arr) => {
            let items: Vec<JsonValue> = arr.values.iter().map(any_value_to_json).collect();
            JsonValue::Array(items).to_string()
        }
        any_value::Value::KvlistValue(kv) => {
            let mut obj = JsonMap::new();
            for entry in &kv.values {
                if let Some(v) = &entry.value {
                    obj.insert(entry.key.clone(), any_value_to_json(v));
                } else {
                    obj.insert(entry.key.clone(), JsonValue::Null);
                }
            }
            JsonValue::Object(obj).to_string()
        }
        any_value::Value::BytesValue(b) => {
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            B64.encode(b)
        }
    }
}

/// Recursive `AnyValue → serde_json::Value` for the nested array/kvlist cases.
/// Single source of truth for how OTLP nested values render into JSON inside
/// stringified maps.
fn any_value_to_json(value: &AnyValue) -> JsonValue {
    let Some(inner) = &value.value else {
        return JsonValue::Null;
    };
    match inner {
        any_value::Value::StringValue(s) => JsonValue::String(s.clone()),
        any_value::Value::BoolValue(b) => JsonValue::Bool(*b),
        any_value::Value::IntValue(i) => JsonValue::Number((*i).into()),
        any_value::Value::DoubleValue(f) => serde_json::Number::from_f64(*f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        any_value::Value::ArrayValue(arr) => {
            JsonValue::Array(arr.values.iter().map(any_value_to_json).collect())
        }
        any_value::Value::KvlistValue(kv) => {
            let mut obj = JsonMap::new();
            for entry in &kv.values {
                obj.insert(
                    entry.key.clone(),
                    entry.value.as_ref().map(any_value_to_json).unwrap_or(JsonValue::Null),
                );
            }
            JsonValue::Object(obj)
        }
        any_value::Value::BytesValue(b) => {
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            JsonValue::String(B64.encode(b))
        }
    }
}

/// Format a float the way Go's `strconv.FormatFloat(_, 'g', -1, 64)` does for
/// typical OTel numeric attributes — shortest representation that
/// round-trips. Matches Go's `pcommon.Value.AsString()` for double values.
fn format_double_like_go(f: f64) -> String {
    if f.is_nan() {
        return "NaN".to_string();
    }
    if f.is_infinite() {
        return if f > 0.0 { "+Inf".to_string() } else { "-Inf".to_string() };
    }
    // Go's 'g' verb with prec=-1 uses the shortest decimal that uniquely
    // identifies the float. Rust's default `{}` formatter for f64 already does
    // this via Grisu, so it matches for the common cases (1.0 → "1", 1.5 →
    // "1.5", 1e10 → "10000000000"). Edge cases at extreme exponents may
    // differ; if a test exposes that, add an explicit rule here.
    let s = format!("{}", f);
    s
}

/// Flatten OTLP key/value attribute lists into a `BTreeMap<String,String>` so
/// downstream JSON encoding (Map(LowCardinality(String), String) on the CH
/// side) is order-stable. Empty values still emit the key — same as Go's
/// `AttrMap`.
pub fn attr_map(attrs: &[KeyValue]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for kv in attrs {
        let v = kv
            .value
            .as_ref()
            .map(any_value_as_string)
            .unwrap_or_default();
        out.insert(kv.key.clone(), v);
    }
    out
}

/// Resolve the `service.name` attribute. Empty string when missing — Maple's
/// `LowCardinality(String)` column accepts empty.
pub fn service_name(attrs: &[KeyValue]) -> String {
    for kv in attrs {
        if kv.key == "service.name" {
            if let Some(v) = &kv.value {
                return any_value_as_string(v);
            }
        }
    }
    String::new()
}

/// Emit a row map as a single-line JSON document with no trailing newline.
/// Equivalent to Go exporter's `internal.MarshalRow`.
pub fn marshal_row(row: &JsonValue) -> Vec<u8> {
    serde_json::to_vec(row).expect("row JSON serialization is infallible")
}


#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::any_value::Value as Av;

    fn av(v: Av) -> AnyValue {
        AnyValue { value: Some(v) }
    }

    #[test]
    fn bytes_hex_all_zero_returns_empty() {
        assert_eq!(bytes_hex(&[0u8; 8]), "");
        assert_eq!(bytes_hex(&[0u8; 16]), "");
        assert_eq!(bytes_hex(&[]), "");
    }

    #[test]
    fn bytes_hex_lowercase_padded() {
        assert_eq!(bytes_hex(&[0x01, 0x23, 0xab]), "0123ab");
        // Match the trace-id used by makeFullSpan.
        let tid = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
        ];
        assert_eq!(bytes_hex(&tid), "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn timestamp_nano_format_matches_go() {
        // Same fixed instant as the Go fixture: 2024-01-15 10:30:00.123456789 UTC.
        assert_eq!(
            format_timestamp_nano(1_705_314_600_123_456_789),
            "2024-01-15 10:30:00.123456789"
        );
        assert_eq!(format_timestamp_nano(0), "1970-01-01 00:00:00.000000000");
    }

    #[test]
    fn span_kind_and_status_labels() {
        assert_eq!(span_kind_string(2), "Server");
        assert_eq!(span_kind_string(99), "Unspecified");
        assert_eq!(status_code_string(1), "Ok");
        assert_eq!(status_code_string(2), "Error");
        assert_eq!(status_code_string(0), "Unset");
    }

    #[test]
    fn any_value_stringification() {
        assert_eq!(any_value_as_string(&av(Av::StringValue("x".into()))), "x");
        assert_eq!(any_value_as_string(&av(Av::BoolValue(true))), "true");
        assert_eq!(any_value_as_string(&av(Av::IntValue(200))), "200");
        assert_eq!(any_value_as_string(&av(Av::DoubleValue(1.5))), "1.5");
    }
}
