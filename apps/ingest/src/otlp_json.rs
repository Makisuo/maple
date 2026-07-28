//! OTLP/JSON leniency shim.
//!
//! `opentelemetry-proto`'s serde derives are stricter than the OTLP/JSON spec
//! requires a *receiver* to be, and the gap is not academic: the OTel JS SDK
//! (and anything else hand-rolling OTLP/JSON) trips it on ordinary payloads.
//! Two failure modes, both silent from the sender's point of view:
//!
//! * **Logs / traces reject the whole request.** `time_unix_nano` and friends
//!   deserialize with `deserialize_string_to_u64`, so a JSON *number* is a hard
//!   error even though the spec says "either numbers or strings are accepted
//!   when decoding". An empty `AnyValue` (`{}`) — which the proto explicitly
//!   documents as a valid "empty" value, and which is what JS emits for a log
//!   with no body or an attribute whose value is `undefined` — errors with
//!   "no known keys found".
//! * **Metrics silently drop the data.** `Metric.data` is a `#[serde(flatten)]`
//!   oneof, so the same errors resolve to `None` instead of failing: the request
//!   is accepted, billed, and forwarded with zero data points.
//!
//! So we normalize the parsed JSON tree before handing it to the generated
//! types. Every rewrite here maps a spec-legal (or proto-default-equivalent)
//! encoding onto the one encoding the derives accept — none of them invent data.
//!
//! Ref: <https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding> and
//! `docs/otel-spec/otlp.md` ("JSON encoding — deviations from standard protobuf
//! JSON").

use serde_json::{Map, Value};

/// 64-bit integer fields. The spec encodes these as decimal strings but
/// requires decoders to accept numbers too; the derives accept strings only.
const U64_STRING_FIELDS: &[&str] = &[
    "timeUnixNano",
    "observedTimeUnixNano",
    "startTimeUnixNano",
    "endTimeUnixNano",
    "asInt",
    "count",
    "zeroCount",
    "bucketCounts",
];

/// 32-bit integer fields, where the reverse also shows up in the wild: a
/// decimal *string* where the derives want a number.
const U32_NUMBER_FIELDS: &[&str] = &[
    "droppedAttributesCount",
    "droppedEventsCount",
    "droppedLinksCount",
    "flags",
];

/// Enum fields sent as their protobuf enum *name*. The OTLP/JSON profile tells
/// senders to use numbers, but standard protobuf JSON permits names and some
/// clients emit them, so decode both.
fn enum_value(field: &str, name: &str) -> Option<i64> {
    let n = match (field, name) {
        ("severityNumber", n) => return severity_number(n),
        ("aggregationTemporality", "AGGREGATION_TEMPORALITY_UNSPECIFIED") => 0,
        ("aggregationTemporality", "AGGREGATION_TEMPORALITY_DELTA") => 1,
        ("aggregationTemporality", "AGGREGATION_TEMPORALITY_CUMULATIVE") => 2,
        ("kind", "SPAN_KIND_UNSPECIFIED") => 0,
        ("kind", "SPAN_KIND_INTERNAL") => 1,
        ("kind", "SPAN_KIND_SERVER") => 2,
        ("kind", "SPAN_KIND_CLIENT") => 3,
        ("kind", "SPAN_KIND_PRODUCER") => 4,
        ("kind", "SPAN_KIND_CONSUMER") => 5,
        ("code", "STATUS_CODE_UNSET") => 0,
        ("code", "STATUS_CODE_OK") => 1,
        ("code", "STATUS_CODE_ERROR") => 2,
        _ => return None,
    };
    Some(n)
}

/// `SEVERITY_NUMBER_TRACE`..`FATAL4` map to 1..=24 in declaration order.
fn severity_number(name: &str) -> Option<i64> {
    let rest = name.strip_prefix("SEVERITY_NUMBER_")?;
    if rest == "UNSPECIFIED" {
        return Some(0);
    }
    let (base, offset) = rest.split_at(rest.len() - rest.chars().rev().take_while(|c| c.is_ascii_digit()).count());
    let step = match base {
        "TRACE" => 1,
        "DEBUG" => 5,
        "INFO" => 9,
        "WARN" => 13,
        "ERROR" => 17,
        "FATAL" => 21,
        _ => return None,
    };
    let offset = if offset.is_empty() {
        0
    } else {
        offset.parse::<i64>().ok()? - 1
    };
    if !(0..=3).contains(&offset) {
        return None;
    }
    Some(step + offset)
}

/// Rewrites `value` in place so the `opentelemetry-proto` derives accept it.
/// `root_field` is the request's single top-level field (`resourceSpans` /
/// `resourceLogs` / `resourceMetrics`), which the derives require to be present.
pub fn normalize(value: &mut Value, root_field: &str) {
    normalize_value(value);
    if let Value::Object(map) = value {
        // An export request with nothing in it is a no-op, not a 400.
        if !matches!(map.get(root_field), Some(Value::Array(_))) {
            map.insert(root_field.to_string(), Value::Array(Vec::new()));
        }
    }
}

fn normalize_value(value: &mut Value) {
    match value {
        Value::Object(map) => normalize_object(map),
        Value::Array(items) => {
            for item in items.iter_mut() {
                normalize_value(item);
            }
            // `ArrayValue.values` may hold empty AnyValues; the derives reject
            // those, and an empty element carries nothing, so drop them.
            items.retain(|item| !is_empty_object(item));
        }
        _ => {}
    }
}

fn normalize_object(map: &mut Map<String, Value>) {
    // `{"arrayValue": {}}` / `{"kvlistValue": {}}` are empty-but-present
    // containers. Give them their (defaulted) `values` list so the branch
    // survives the pass below instead of collapsing to an empty AnyValue.
    for key in ["arrayValue", "kvlistValue"] {
        if let Some(Value::Object(inner)) = map.get_mut(key) {
            inner.entry("values").or_insert_with(|| Value::Array(Vec::new()));
        }
    }

    for (key, child) in map.iter_mut() {
        let key = key.as_str();

        if U64_STRING_FIELDS.contains(&key) {
            stringify_u64(child);
        } else if U32_NUMBER_FIELDS.contains(&key) {
            numberify_u32(child);
        } else if let Some(name) = child.as_str() {
            if let Some(n) = enum_value(key, name) {
                *child = Value::from(n);
            }
        }

        normalize_value(child);
    }

    // proto3 JSON reads `null` as "field absent / default value", but the
    // derives run their custom deserializers on it and fail (`"traceId": null`,
    // `"severityNumber": null`). Dropping the key gives the default.
    //
    // An empty object is either an empty `AnyValue` — invalid to the derives,
    // valid per the proto — or a message with every field defaulted, which is
    // what the receiver reconstructs anyway. Dropping is equivalent in both
    // cases, and the enrichment step re-inserts `resource` when it is missing.
    map.retain(|_, child| !child.is_null() && !is_empty_object(child));
}

fn is_empty_object(value: &Value) -> bool {
    matches!(value, Value::Object(map) if map.is_empty())
}

fn stringify_u64(value: &mut Value) {
    match value {
        Value::Number(n) => *value = Value::String(n.to_string()),
        Value::Array(items) => {
            for item in items.iter_mut() {
                stringify_u64(item);
            }
        }
        _ => {}
    }
}

fn numberify_u32(value: &mut Value) {
    if let Some(parsed) = value.as_str().and_then(|s| s.parse::<u64>().ok()) {
        *value = Value::from(parsed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(json: &str) -> Value {
        let mut value: Value = serde_json::from_str(json).expect("valid json");
        normalize(&mut value, "resourceLogs");
        value
    }

    #[test]
    fn numeric_nanos_become_strings() {
        let v = norm(r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":1753660000000000000}]}]}]}"#);
        assert_eq!(
            v["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["timeUnixNano"],
            Value::from("1753660000000000000")
        );
    }

    #[test]
    fn string_nanos_are_left_alone() {
        let v = norm(r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":"17"}]}]}]}"#);
        assert_eq!(
            v["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["timeUnixNano"],
            Value::from("17")
        );
    }

    #[test]
    fn bucket_counts_are_stringified_elementwise() {
        let mut v: Value = serde_json::from_str(r#"{"bucketCounts":[1,"2",3]}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v["bucketCounts"], serde_json::json!(["1", "2", "3"]));
    }

    #[test]
    fn empty_any_value_is_dropped() {
        let v = norm(r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{},"attributes":[{"key":"a","value":{}}]}]}]}]}"#);
        let record = &v["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];
        assert!(record.get("body").is_none());
        assert_eq!(record["attributes"][0]["key"], Value::from("a"));
        assert!(record["attributes"][0].get("value").is_none());
    }

    #[test]
    fn empty_containers_keep_their_values_list() {
        let mut v: Value = serde_json::from_str(r#"{"body":{"arrayValue":{}}}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v["body"]["arrayValue"]["values"], serde_json::json!([]));
    }

    #[test]
    fn nulls_are_dropped() {
        let mut v: Value =
            serde_json::from_str(r#"{"traceId":null,"severityNumber":null,"body":null}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v, serde_json::json!({}));
    }

    #[test]
    fn enum_names_become_numbers() {
        let mut v: Value = serde_json::from_str(
            r#"{"severityNumber":"SEVERITY_NUMBER_INFO","kind":"SPAN_KIND_SERVER","code":"STATUS_CODE_ERROR","aggregationTemporality":"AGGREGATION_TEMPORALITY_DELTA"}"#,
        )
        .unwrap();
        normalize_value(&mut v);
        assert_eq!(v["severityNumber"], Value::from(9));
        assert_eq!(v["kind"], Value::from(2));
        assert_eq!(v["code"], Value::from(2));
        assert_eq!(v["aggregationTemporality"], Value::from(1));
    }

    #[test]
    fn severity_name_covers_the_whole_range() {
        assert_eq!(severity_number("SEVERITY_NUMBER_TRACE"), Some(1));
        assert_eq!(severity_number("SEVERITY_NUMBER_TRACE2"), Some(2));
        assert_eq!(severity_number("SEVERITY_NUMBER_INFO"), Some(9));
        assert_eq!(severity_number("SEVERITY_NUMBER_INFO4"), Some(12));
        assert_eq!(severity_number("SEVERITY_NUMBER_FATAL4"), Some(24));
        assert_eq!(severity_number("SEVERITY_NUMBER_UNSPECIFIED"), Some(0));
        assert_eq!(severity_number("SEVERITY_NUMBER_INFO9"), None);
        assert_eq!(severity_number("NONSENSE"), None);
    }

    #[test]
    fn severity_text_is_not_mistaken_for_an_enum_name() {
        let mut v: Value =
            serde_json::from_str(r#"{"severityText":"SEVERITY_NUMBER_INFO"}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v["severityText"], Value::from("SEVERITY_NUMBER_INFO"));
    }

    #[test]
    fn unknown_enum_names_are_left_for_the_deserializer_to_reject() {
        let mut v: Value = serde_json::from_str(r#"{"severityNumber":"LOUD"}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v["severityNumber"], Value::from("LOUD"));
    }

    #[test]
    fn counts_sent_as_strings_become_numbers() {
        let mut v: Value =
            serde_json::from_str(r#"{"droppedAttributesCount":"3","flags":"1"}"#).unwrap();
        normalize_value(&mut v);
        assert_eq!(v["droppedAttributesCount"], Value::from(3));
        assert_eq!(v["flags"], Value::from(1));
    }

    #[test]
    fn empty_request_gets_its_root_list() {
        assert_eq!(norm(r#"{}"#), serde_json::json!({"resourceLogs": []}));
        assert_eq!(
            norm(r#"{"resourceLogs":null}"#),
            serde_json::json!({"resourceLogs": []})
        );
    }

    #[test]
    fn well_formed_payloads_are_untouched() {
        let original = r#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"svc"}}]},"scopeLogs":[{"scope":{"name":"s","version":"1"},"logRecords":[{"timeUnixNano":"1","observedTimeUnixNano":"1","severityNumber":9,"severityText":"INFO","body":{"stringValue":"hello"},"attributes":[{"key":"n","value":{"intValue":"5"}}],"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","flags":1}]}]}]}"#;
        let parsed: Value = serde_json::from_str(original).unwrap();
        assert_eq!(norm(original), parsed);
    }
}
