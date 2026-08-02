//! Gateway-side sanitization for the session-analytics endpoints.
//!
//! `/v1/sessionReplays/meta` and the distilled-event endpoint are CORS-open and
//! their ingest key ships in customer JavaScript, so the SDK is not a trust
//! boundary — every cap and allowlist that bounds what reaches the warehouse
//! lives here.

/// Normalized referrer host for the acquisition breakdown.
///
/// Derived here rather than in the SDK so there is exactly one normalization
/// implementation across every SDK version in the wild, and so the LC
/// dictionary stays tight. Empty/unparseable/host-less referrers collapse to
/// `""`, which the analytics layer reads as "direct, internal, or suppressed by
/// Referrer-Policy" — notably *not* the same thing as "direct traffic".
/// Canonical host of a URL: lowercased, trailing dot and `www.` stripped.
/// Both sides of the self-referral comparison go through this, so the two hosts
/// can never disagree because one was canonicalized differently.
fn canonical_host(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return String::new();
    };
    let Some(host) = parsed.host_str() else {
        return String::new();
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

/// A bare host (no scheme) as sent by the SDK.
fn normalize_host(host: &str) -> String {
    canonical_host(&format!("http://{}", host.trim()))
}

pub fn derive_referrer_host(referrer: &str, current_host: &str) -> String {
    let trimmed = referrer.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let host = canonical_host(trimmed);
    if host.is_empty() || host == normalize_host(current_host) {
        String::new()
    } else {
        host
    }
}

/// Distilled session event types the warehouse knows about.
///
/// `Type` is `LowCardinality(String)` on a CORS-open endpoint whose ingest key
/// ships in customer JavaScript, so the value set has to be closed here — the
/// SDK is not a trust boundary. `custom` is the SDK's `track(name, props)`:
/// `Message` carries the event name, `Attributes` the properties.
const SESSION_EVENT_TYPES: [&str; 7] = [
    "navigation",
    "click",
    "input",
    "console",
    "network",
    "error",
    "custom",
];

/// Caps on a distilled session event, enforced gateway-side.
const SESSION_EVENT_MAX_MESSAGE_BYTES: usize = 1024;
const SESSION_EVENT_MAX_ATTRIBUTES: usize = 32;
const SESSION_EVENT_MAX_ATTRIBUTE_KEY_BYTES: usize = 64;
const SESSION_EVENT_MAX_ATTRIBUTE_VALUE_BYTES: usize = 1024;

/// Truncate to a byte budget without splitting a UTF-8 character.
fn truncate_str(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// Caps on a session metadata row, enforced gateway-side for the same reason
/// the event caps above exist: `/v1/sessionReplays/meta` is CORS-open and its
/// ingest key ships in customer JavaScript, so nothing the SDK trims is a trust
/// boundary.
///
/// `DIMENSION` covers the `LowCardinality(String)` columns. A length cap cannot
/// bound distinct values on its own — a bot spraying `?utm_campaign=<uuid>`
/// still writes one dictionary entry per hit — but it does bound how much each
/// entry costs, and it is the only stateless defence available here. Truly
/// unbounded campaign cardinality is a query-side problem (top-N + other).
const SESSION_META_MAX_DIMENSION_BYTES: usize = 128;
/// Free-text columns, stored as plain `String`.
const SESSION_META_MAX_TEXT_BYTES: usize = 1024;
/// Mirrors the SDK's `identify()` trait cap.
const SESSION_META_MAX_TRAITS: usize = 24;
const SESSION_META_MAX_TRAIT_KEY_BYTES: usize = 64;
const SESSION_META_MAX_TRAIT_VALUE_BYTES: usize = 1024;

/// `LowCardinality(String)` columns fed straight from the request body.
/// `country` is absent on purpose — it is server-derived and already strict.
const SESSION_META_DIMENSION_FIELDS: [&str; 6] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "host",
    "language",
    // Gateway-derived, but from a client-supplied URL, so it is clamped here too.
    "referrer_host",
];

/// Plain `String` columns fed straight from the request body.
const SESSION_META_TEXT_FIELDS: [&str; 10] = [
    "visitor_id",
    "user_email",
    "user_name",
    "group_id",
    "group_name",
    "referrer",
    "utm_term",
    "utm_content",
    "entry_path",
    "exit_path",
];

/// Truncate a string field in place; drop it when it is not a string.
///
/// Dropping rather than coercing is deliberate — an absent key falls back to
/// the column DEFAULT, whereas a JSON number against a `String` column
/// quarantines the whole row.
fn clamp_string_field(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    field: &str,
    max_bytes: usize,
) {
    let Some(value) = obj.get(field) else { return };
    match value.as_str() {
        Some(text) => {
            if text.len() > max_bytes {
                let truncated = truncate_str(text, max_bytes);
                obj.insert(field.to_string(), serde_json::Value::String(truncated));
            }
        }
        None => {
            obj.remove(field);
        }
    }
}

/// Clamp the client-supplied fields of one session metadata row in place.
///
/// Every column touched here is written from the request body. The
/// LowCardinality ones are the reason this exists: an unbounded dictionary on
/// `session_replays` degrades every query on the table for that org, and the
/// SDK-side trimming that used to be the only bound is customer-editable
/// JavaScript.
///
/// Nothing is rejected — over-long values are trimmed and off-type values fall
/// back to their column default, so a malformed field never costs a session.
pub fn sanitize_session_meta(obj: &mut serde_json::Map<String, serde_json::Value>) {
    for field in SESSION_META_DIMENSION_FIELDS {
        clamp_string_field(obj, field, SESSION_META_MAX_DIMENSION_BYTES);
    }
    for field in SESSION_META_TEXT_FIELDS {
        clamp_string_field(obj, field, SESSION_META_MAX_TEXT_BYTES);
    }

    // Trait keys are untrusted and arbitrary. The warehouse uses Map(String,
    // String), but the cap still bounds row size and prevents abusive payloads.
    match obj.get_mut("user_traits") {
        Some(serde_json::Value::Object(traits)) => clamp_string_map(
            traits,
            SESSION_META_MAX_TRAITS,
            SESSION_META_MAX_TRAIT_KEY_BYTES,
            SESSION_META_MAX_TRAIT_VALUE_BYTES,
        ),
        Some(_) => {
            obj.remove("user_traits");
        }
        None => {}
    }
}

/// Clamp an untrusted string map in place: bound the entry count, truncate keys
/// and values, and stringify non-string values.
///
/// Insertion order is preserved (serde_json keeps it), so *which* entries
/// survive the cap is deterministic rather than hash-dependent — the same
/// payload always produces the same row.
fn clamp_string_map(
    map: &mut serde_json::Map<String, serde_json::Value>,
    max_entries: usize,
    max_key_bytes: usize,
    max_value_bytes: usize,
) {
    let mut sanitized = serde_json::Map::new();
    for (key, value) in map.iter() {
        if sanitized.len() >= max_entries {
            break;
        }
        let key = truncate_str(key, max_key_bytes);
        let value = match value {
            serde_json::Value::String(s) => truncate_str(s, max_value_bytes),
            other => truncate_str(&other.to_string(), max_value_bytes),
        };
        sanitized.insert(key, serde_json::Value::String(value));
    }
    *map = sanitized;
}

/// Clamp one distilled session event in place. Returns false when the row
/// should be dropped entirely (unknown `Type`).
///
/// Dropping the single row rather than rejecting the batch is deliberate: these
/// arrive as NDJSON, and a 400 would discard a whole good session's transcript
/// because one row was malformed.
pub fn sanitize_session_event(obj: &mut serde_json::Map<String, serde_json::Value>) -> bool {
    let event_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !SESSION_EVENT_TYPES.contains(&event_type) {
        return false;
    }

    if let Some(message) = obj.get("message").and_then(|v| v.as_str()) {
        if message.len() > SESSION_EVENT_MAX_MESSAGE_BYTES {
            let truncated = truncate_str(message, SESSION_EVENT_MAX_MESSAGE_BYTES);
            obj.insert("message".to_string(), serde_json::Value::String(truncated));
        }
    }

    if let Some(serde_json::Value::Object(attributes)) = obj.get_mut("attributes") {
        // `track(name, props)` keys are customer-chosen, which is why the column
        // is Map(String, String) (migration 0012) rather than sharing an LC
        // dictionary. The caps still bound one row's damage.
        clamp_string_map(
            attributes,
            SESSION_EVENT_MAX_ATTRIBUTES,
            SESSION_EVENT_MAX_ATTRIBUTE_KEY_BYTES,
            SESSION_EVENT_MAX_ATTRIBUTE_VALUE_BYTES,
        );
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referrer_host_is_normalized_and_defaults_empty() {
        assert_eq!(
            derive_referrer_host("https://WWW.Google.com/search?q=maple", "app.example.com"),
            "google.com"
        );
        assert_eq!(
            derive_referrer_host("https://news.ycombinator.com/", "app.example.com"),
            "news.ycombinator.com"
        );
        assert_eq!(
            derive_referrer_host("https://app.example.com/pricing", "app.example.com"),
            ""
        );
        assert_eq!(
            derive_referrer_host("https://www.app.example.com/pricing", "APP.EXAMPLE.COM:443"),
            ""
        );
        // Empty, relative, and host-less referrers all collapse into the one
        // "direct / internal / suppressed" bucket.
        assert_eq!(derive_referrer_host("", "app.example.com"), "");
        assert_eq!(derive_referrer_host("   ", "app.example.com"), "");
        assert_eq!(derive_referrer_host("/dashboard", "app.example.com"), "");
        assert_eq!(derive_referrer_host("about:blank", "app.example.com"), "");
    }

    #[test]
    fn session_meta_dimensions_are_clamped() {
        let mut obj = serde_json::Map::new();
        obj.insert("utm_campaign".to_string(), serde_json::json!("c".repeat(512)));
        obj.insert("host".to_string(), serde_json::json!("app.example.com"));
        obj.insert("referrer".to_string(), serde_json::json!("r".repeat(4096)));
        obj.insert("entry_path".to_string(), serde_json::json!("/pricing"));

        sanitize_session_meta(&mut obj);

        // LowCardinality columns get the tight cap; plain String columns the
        // wide one. Short values are left exactly as they arrived.
        assert_eq!(
            obj["utm_campaign"].as_str().unwrap().len(),
            SESSION_META_MAX_DIMENSION_BYTES
        );
        assert_eq!(
            obj["referrer"].as_str().unwrap().len(),
            SESSION_META_MAX_TEXT_BYTES
        );
        assert_eq!(obj["host"].as_str().unwrap(), "app.example.com");
        assert_eq!(obj["entry_path"].as_str().unwrap(), "/pricing");
    }

    #[test]
    fn session_meta_off_type_fields_fall_back_to_the_column_default() {
        let mut obj = serde_json::Map::new();
        obj.insert("utm_source".to_string(), serde_json::json!(42));
        obj.insert("user_traits".to_string(), serde_json::json!("not-a-map"));

        sanitize_session_meta(&mut obj);

        // Absent → DEFAULT ''. Present-but-wrong-type would quarantine the row,
        // which costs the whole session.
        assert!(!obj.contains_key("utm_source"));
        assert!(!obj.contains_key("user_traits"));
    }

    #[test]
    fn session_meta_traits_are_capped_like_the_sdk_promises() {
        let mut traits = serde_json::Map::new();
        for i in 0..100 {
            traits.insert(format!("trait{i}"), serde_json::json!("v"));
        }
        traits.insert("long".to_string(), serde_json::json!("x".repeat(4096)));
        traits.insert("numeric".to_string(), serde_json::json!(7));

        let mut obj = serde_json::Map::new();
        obj.insert("user_traits".to_string(), serde_json::Value::Object(traits));
        sanitize_session_meta(&mut obj);

        let traits = obj["user_traits"].as_object().unwrap();
        // Trait keys are LowCardinality — one unique key per user would bloat the
        // dictionary exactly like an unbounded Type.
        assert_eq!(traits.len(), SESSION_META_MAX_TRAITS);
        assert!(traits.contains_key("trait0"));
        assert!(!traits.contains_key("trait99"));
        // The column is Map(_, String): values arrive coerced.
        assert_eq!(traits["trait0"].as_str().unwrap(), "v");
    }

    #[test]
    fn session_meta_trait_values_are_stringified_and_truncated() {
        let mut traits = serde_json::Map::new();
        traits.insert("big".to_string(), serde_json::json!("y".repeat(4096)));
        traits.insert("flag".to_string(), serde_json::json!(false));

        let mut obj = serde_json::Map::new();
        obj.insert("user_traits".to_string(), serde_json::Value::Object(traits));
        sanitize_session_meta(&mut obj);

        let traits = obj["user_traits"].as_object().unwrap();
        assert_eq!(
            traits["big"].as_str().unwrap().len(),
            SESSION_META_MAX_TRAIT_VALUE_BYTES
        );
        assert_eq!(traits["flag"].as_str().unwrap(), "false");
    }

    #[test]
    fn session_event_types_outside_the_allowlist_are_dropped() {
        for accepted in SESSION_EVENT_TYPES {
            let mut obj = serde_json::Map::new();
            obj.insert("type".to_string(), serde_json::json!(accepted));
            assert!(sanitize_session_event(&mut obj), "{accepted} should be kept");
        }

        let mut unknown = serde_json::Map::new();
        unknown.insert("type".to_string(), serde_json::json!("uniqueish-per-event"));
        assert!(!sanitize_session_event(&mut unknown));

        let mut missing = serde_json::Map::new();
        assert!(!sanitize_session_event(&mut missing));
    }

    #[test]
    fn session_event_payloads_are_clamped() {
        let mut attributes = serde_json::Map::new();
        for i in 0..100 {
            attributes.insert(format!("k{i}"), serde_json::json!("v"));
        }
        attributes.insert("long".to_string(), serde_json::json!("x".repeat(4096)));
        attributes.insert("numeric".to_string(), serde_json::json!(42));

        let mut obj = serde_json::Map::new();
        obj.insert("type".to_string(), serde_json::json!("custom"));
        obj.insert("message".to_string(), serde_json::json!("n".repeat(4096)));
        obj.insert("attributes".to_string(), serde_json::Value::Object(attributes));

        assert!(sanitize_session_event(&mut obj));

        let message = obj["message"].as_str().unwrap();
        assert_eq!(message.len(), SESSION_EVENT_MAX_MESSAGE_BYTES);

        let attributes = obj["attributes"].as_object().unwrap();
        assert_eq!(attributes.len(), SESSION_EVENT_MAX_ATTRIBUTES);
        // Insertion order decides which survive, so the cut is deterministic.
        assert!(attributes.contains_key("k0"));
        assert!(!attributes.contains_key("k99"));
    }

    #[test]
    fn session_event_attribute_values_are_stringified_and_truncated() {
        let mut attributes = serde_json::Map::new();
        attributes.insert("big".to_string(), serde_json::json!("y".repeat(4096)));
        attributes.insert("flag".to_string(), serde_json::json!(true));

        let mut obj = serde_json::Map::new();
        obj.insert("type".to_string(), serde_json::json!("custom"));
        obj.insert("attributes".to_string(), serde_json::Value::Object(attributes));

        assert!(sanitize_session_event(&mut obj));
        let attributes = obj["attributes"].as_object().unwrap();
        assert_eq!(
            attributes["big"].as_str().unwrap().len(),
            SESSION_EVENT_MAX_ATTRIBUTE_VALUE_BYTES
        );
        // The column is Map(_, String), so non-string values must arrive coerced.
        assert_eq!(attributes["flag"].as_str().unwrap(), "true");
    }

    #[test]
    fn truncate_str_never_splits_a_utf8_character() {
        // "é" is two bytes: a naive slice at 1 would panic.
        let value = "é".repeat(10);
        let truncated = truncate_str(&value, 5);
        assert_eq!(truncated, "éé");
    }
}
