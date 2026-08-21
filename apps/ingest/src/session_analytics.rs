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
    host.strip_prefix("www.").unwrap_or(&host).to_owned()
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
        return value.to_owned();
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
                obj.insert(field.to_owned(), serde_json::Value::String(truncated));
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
            obj.insert("message".to_owned(), serde_json::Value::String(truncated));
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

/// Sources a direct-ingested product event may claim. Browser rows never come
/// through `/v1/events` — they are materialized from `session_events` with
/// `Source = 'browser'` — so a body claiming `browser` is dropped rather than
/// coerced, otherwise a backend could forge rows the funnel treats as
/// page views.
const PRODUCT_EVENT_SOURCES: [&str; 2] = ["server", "mobile"];

/// The only reserved (`$`-prefixed) event name direct ingest accepts: mobile
/// screen views. `$pageview` and every other reserved name are owned by the
/// browser SDK and arrive via the `session_events` materialized view.
const PRODUCT_EVENT_SCREEN_NAME: &str = "$screen";

/// Caps on a direct-ingested product event, enforced gateway-side.
const PRODUCT_EVENT_MAX_NAME_BYTES: usize = 128;
const PRODUCT_EVENT_MAX_ID_BYTES: usize = 256;
const PRODUCT_EVENT_MAX_SERVICE_NAME_BYTES: usize = 128;
const PRODUCT_EVENT_MAX_HOST_BYTES: usize = 256;
const PRODUCT_EVENT_MAX_PAGE_PATH_BYTES: usize = 1024;
const PRODUCT_EVENT_MAX_URL_BYTES: usize = 2048;

/// Fields copied from the request body into the row after clamping, with the
/// byte cap each one is trimmed to. Everything else the client sends is
/// discarded — the row is rebuilt from scratch, so an unknown key can never
/// reach the warehouse.
const PRODUCT_EVENT_ID_FIELDS: [(&str, usize); 5] = [
    ("session_id", PRODUCT_EVENT_MAX_ID_BYTES),
    ("visitor_id", PRODUCT_EVENT_MAX_ID_BYTES),
    ("user_id", PRODUCT_EVENT_MAX_ID_BYTES),
    ("group_id", PRODUCT_EVENT_MAX_ID_BYTES),
    ("service_name", PRODUCT_EVENT_MAX_SERVICE_NAME_BYTES),
];

/// Wire format `product_events.Timestamp` is written in: the ClickHouse
/// `DateTime64(9)` text form, always UTC. Tinybird and the ClickHouse insert
/// path both parse it, and it is what the browser SDK already sends for
/// `session_events`, so every row in the table has one shape regardless of
/// which client produced it.
const PRODUCT_EVENT_TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S%.9f";

/// How far a client-supplied `timestamp` may sit from the moment the gateway
/// received it before the row is dropped.
///
/// The timestamp is otherwise the one unbounded field on the row, and it is the
/// one that decides physical layout: `product_events` is
/// `PARTITION BY toDate(Timestamp)`, so a backfill stamped across five years of
/// history mints ~2,000 single-row partitions for that org, and a far-FUTURE
/// stamp is worse still — `TTL toDate(Timestamp) + INTERVAL 365 DAY` never
/// fires, so the row is resident forever while sitting outside every funnel
/// window that could show it. The window is asymmetric because the two
/// directions mean different things: trailing a little is a buffered backend
/// flush or a clock behind, leading is always a bug.
const PRODUCT_EVENT_MAX_BACKDATE_DAYS: i64 = 30;
const PRODUCT_EVENT_MAX_FUTURE_DAYS: i64 = 1;

/// Parse a client-supplied product-event timestamp.
///
/// Accepts RFC 3339 (`2026-08-17T10:15:30.123Z`, offsets allowed) or the
/// ClickHouse text form (`2026-08-17 10:15:30[.fff]`, read as UTC). Anything
/// else — numbers, epoch strings, other layouts — is `None` so the caller drops
/// the row: silently substituting receipt time would misplace the event in
/// every funnel window, which is worse than losing it.
fn parse_product_event_timestamp(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let trimmed = value.trim();
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&chrono::Utc));
    }
    chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S%.f")
        .ok()
        .map(|naive| naive.and_utc())
}

/// Whether a parsed timestamp is close enough to receipt time to store.
fn product_event_timestamp_in_range(
    at: chrono::DateTime<chrono::Utc>,
    received_at: chrono::DateTime<chrono::Utc>,
) -> bool {
    let behind = chrono::TimeDelta::try_days(PRODUCT_EVENT_MAX_BACKDATE_DAYS);
    let ahead = chrono::TimeDelta::try_days(PRODUCT_EVENT_MAX_FUTURE_DAYS);
    match (behind, ahead) {
        (Some(behind), Some(ahead)) => at >= received_at - behind && at <= received_at + ahead,
        // Unreachable for these constants; keep the row rather than invent a bound.
        _ => true,
    }
}

fn format_product_event_timestamp(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format(PRODUCT_EVENT_TIMESTAMP_FORMAT).to_string()
}

/// `(host, page_path)` for a product-event `url`, matching what
/// `product_events_mv` computes for browser rows with ClickHouse's
/// `domain(Url)` / `path(Url)`: the lowercase host without port or userinfo,
/// and the pathname without query string or fragment. A URL that does not
/// parse as absolute contributes no host, and its path is whatever precedes
/// the first `?`/`#` — the same shape `path()` yields for a bare `/pricing`.
fn derive_url_parts(url: &str) -> (String, String) {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            return (host, parsed.path().to_string());
        }
    }
    let end = url.find(['?', '#']).unwrap_or(url.len());
    (String::new(), url[..end].to_string())
}

/// Optional string field from an untrusted object: `None` when absent, blank,
/// or not a string. Off-type values are treated as absent rather than
/// stringified so a JSON number never becomes an identifier by accident.
fn optional_str<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Option<&'a str> {
    obj.get(field)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Rewrite one direct-ingested product event (`POST /v1/events`) into the exact
/// row shape `product_events` is written in. Returns false when the row must be
/// dropped: missing/over-long/reserved `name`, unknown `source`, or an
/// unparseable `timestamp`.
///
/// On success `obj` holds only the output fields (`timestamp`, `source`,
/// `session_id`, `seq`, `visitor_id`, `user_id`, `group_id`, `kind`,
/// `event_name`, `host`, `page_path`, `url`, `service_name`, `attributes`) —
/// the caller adds `org_id` from the authenticated key. As with session events,
/// a bad row is counted and skipped rather than failing the batch: a backend
/// flushing a buffer of events must not lose the good ones to one malformed
/// line.
pub fn sanitize_product_event(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    received_at: chrono::DateTime<chrono::Utc>,
) -> bool {
    let Some(name) = optional_str(obj, "name") else {
        return false;
    };
    if name.len() > PRODUCT_EVENT_MAX_NAME_BYTES {
        // Truncating a step key would silently mint a *different* event name;
        // dropping keeps `EventName` exactly what the caller intended, or nothing.
        return false;
    }
    if name.starts_with('$') && name != PRODUCT_EVENT_SCREEN_NAME {
        return false;
    }
    let kind = if name == PRODUCT_EVENT_SCREEN_NAME {
        "screen"
    } else {
        "custom"
    };
    let name = name.to_string();

    let source = match obj.get("source") {
        None | Some(serde_json::Value::Null) => "server".to_string(),
        Some(serde_json::Value::String(source))
            if PRODUCT_EVENT_SOURCES.contains(&source.as_str()) =>
        {
            source.clone()
        }
        Some(_) => return false,
    };

    let timestamp = match obj.get("timestamp") {
        None | Some(serde_json::Value::Null) => received_at,
        Some(serde_json::Value::String(raw)) => match parse_product_event_timestamp(raw) {
            // Parseable but implausible is dropped like unparseable: clamping to
            // the window edge would pile the whole replay onto one partition and
            // report every event at a time it did not happen.
            Some(parsed) if !product_event_timestamp_in_range(parsed, received_at) => return false,
            Some(parsed) => parsed,
            None => return false,
        },
        Some(_) => return false,
    };

    let url = optional_str(obj, "url")
        .map(|u| truncate_str(u, PRODUCT_EVENT_MAX_URL_BYTES))
        .unwrap_or_default();
    let (derived_host, derived_path) = if url.is_empty() {
        (String::new(), String::new())
    } else {
        derive_url_parts(&url)
    };
    // An explicit `page_path` wins over the one derived from `url`: mobile
    // `$screen` events have no URL and carry the screen name here.
    let page_path = optional_str(obj, "page_path")
        .map(str::to_string)
        .unwrap_or(derived_path);

    let mut row = serde_json::Map::new();
    row.insert(
        "timestamp".to_string(),
        serde_json::Value::String(format_product_event_timestamp(timestamp)),
    );
    row.insert("source".to_string(), serde_json::Value::String(source));
    for (field, max_bytes) in PRODUCT_EVENT_ID_FIELDS {
        let value = optional_str(obj, field)
            .map(|v| truncate_str(v, max_bytes))
            .unwrap_or_default();
        row.insert(field.to_string(), serde_json::Value::String(value));
    }
    row.insert("seq".to_string(), serde_json::json!(0));
    row.insert(
        "kind".to_string(),
        serde_json::Value::String(kind.to_string()),
    );
    row.insert("event_name".to_string(), serde_json::Value::String(name));
    row.insert(
        "host".to_string(),
        serde_json::Value::String(truncate_str(&derived_host, PRODUCT_EVENT_MAX_HOST_BYTES)),
    );
    row.insert(
        "page_path".to_string(),
        serde_json::Value::String(truncate_str(&page_path, PRODUCT_EVENT_MAX_PAGE_PATH_BYTES)),
    );
    row.insert("url".to_string(), serde_json::Value::String(url));

    let attributes = match obj.remove("attributes") {
        Some(serde_json::Value::Object(mut attributes)) => {
            // Same caps as `track()` props on session events: customer-chosen
            // keys into a Map(String, String) column.
            clamp_string_map(
                &mut attributes,
                SESSION_EVENT_MAX_ATTRIBUTES,
                SESSION_EVENT_MAX_ATTRIBUTE_KEY_BYTES,
                SESSION_EVENT_MAX_ATTRIBUTE_VALUE_BYTES,
            );
            attributes
        }
        // Off-type `attributes` fall back to the column default rather than
        // quarantining the row.
        _ => serde_json::Map::new(),
    };
    row.insert(
        "attributes".to_string(),
        serde_json::Value::Object(attributes),
    );

    *obj = row;
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
        obj.insert(
            "utm_campaign".to_owned(),
            serde_json::json!("c".repeat(512)),
        );
        obj.insert("host".to_owned(), serde_json::json!("app.example.com"));
        obj.insert("referrer".to_owned(), serde_json::json!("r".repeat(4096)));
        obj.insert("entry_path".to_owned(), serde_json::json!("/pricing"));

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
        obj.insert("utm_source".to_owned(), serde_json::json!(42));
        obj.insert("user_traits".to_owned(), serde_json::json!("not-a-map"));

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
        traits.insert("long".to_owned(), serde_json::json!("x".repeat(4096)));
        traits.insert("numeric".to_owned(), serde_json::json!(7));

        let mut obj = serde_json::Map::new();
        obj.insert("user_traits".to_owned(), serde_json::Value::Object(traits));
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
        traits.insert("big".to_owned(), serde_json::json!("y".repeat(4096)));
        traits.insert("flag".to_owned(), serde_json::json!(false));

        let mut obj = serde_json::Map::new();
        obj.insert("user_traits".to_owned(), serde_json::Value::Object(traits));
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
            obj.insert("type".to_owned(), serde_json::json!(accepted));
            assert!(sanitize_session_event(&mut obj), "{accepted} should be kept");
        }

        let mut unknown = serde_json::Map::new();
        unknown.insert("type".to_owned(), serde_json::json!("uniqueish-per-event"));
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
        attributes.insert("long".to_owned(), serde_json::json!("x".repeat(4096)));
        attributes.insert("numeric".to_owned(), serde_json::json!(42));

        let mut obj = serde_json::Map::new();
        obj.insert("type".to_owned(), serde_json::json!("custom"));
        obj.insert("message".to_owned(), serde_json::json!("n".repeat(4096)));
        obj.insert(
            "attributes".to_owned(),
            serde_json::Value::Object(attributes),
        );

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
        attributes.insert("big".to_owned(), serde_json::json!("y".repeat(4096)));
        attributes.insert("flag".to_owned(), serde_json::json!(true));

        let mut obj = serde_json::Map::new();
        obj.insert("type".to_owned(), serde_json::json!("custom"));
        obj.insert(
            "attributes".to_owned(),
            serde_json::Value::Object(attributes),
        );

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

    fn received_at() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-08-17T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn product_event(json: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        json.as_object().cloned().unwrap()
    }

    #[test]
    fn product_event_name_rules() {
        // Plain custom name → kind custom, event_name verbatim.
        let mut ok = product_event(serde_json::json!({ "name": "plan_started" }));
        assert!(sanitize_product_event(&mut ok, received_at()));
        assert_eq!(ok["event_name"], "plan_started");
        assert_eq!(ok["kind"], "custom");

        // `$screen` is the one reserved name direct ingest accepts.
        let mut screen = product_event(
            serde_json::json!({ "name": "$screen", "source": "mobile", "page_path": "Checkout" }),
        );
        assert!(sanitize_product_event(&mut screen, received_at()));
        assert_eq!(screen["kind"], "screen");
        assert_eq!(screen["event_name"], "$screen");
        assert_eq!(screen["page_path"], "Checkout");

        for rejected in [
            serde_json::json!({}),
            serde_json::json!({ "name": "" }),
            serde_json::json!({ "name": "   " }),
            serde_json::json!({ "name": 42 }),
            serde_json::json!({ "name": "$pageview" }),
            serde_json::json!({ "name": "$identify" }),
            serde_json::json!({ "name": "x".repeat(PRODUCT_EVENT_MAX_NAME_BYTES + 1) }),
        ] {
            let mut obj = product_event(rejected.clone());
            assert!(
                !sanitize_product_event(&mut obj, received_at()),
                "{rejected} should be dropped"
            );
        }

        let mut max = product_event(
            serde_json::json!({ "name": "x".repeat(PRODUCT_EVENT_MAX_NAME_BYTES) }),
        );
        assert!(sanitize_product_event(&mut max, received_at()));
    }

    #[test]
    fn product_event_source_defaults_to_server_and_rejects_unknown() {
        let mut default = product_event(serde_json::json!({ "name": "signup_completed" }));
        assert!(sanitize_product_event(&mut default, received_at()));
        assert_eq!(default["source"], "server");

        let mut mobile =
            product_event(serde_json::json!({ "name": "purchase", "source": "mobile" }));
        assert!(sanitize_product_event(&mut mobile, received_at()));
        assert_eq!(mobile["source"], "mobile");

        for source in [
            serde_json::json!("browser"),
            serde_json::json!("Server"),
            serde_json::json!(""),
            serde_json::json!(1),
        ] {
            let mut obj = product_event(serde_json::json!({ "name": "purchase", "source": source }));
            assert!(
                !sanitize_product_event(&mut obj, received_at()),
                "source {source} should be dropped"
            );
        }
    }

    #[test]
    fn product_event_timestamp_is_normalized_to_clickhouse_form() {
        // Missing → gateway receipt time.
        let mut missing = product_event(serde_json::json!({ "name": "e" }));
        assert!(sanitize_product_event(&mut missing, received_at()));
        assert_eq!(missing["timestamp"], "2026-08-17 12:00:00.000000000");

        // RFC 3339 with an offset is converted to UTC.
        let mut rfc = product_event(
            serde_json::json!({ "name": "e", "timestamp": "2026-08-17T14:15:30.123+02:00" }),
        );
        assert!(sanitize_product_event(&mut rfc, received_at()));
        assert_eq!(rfc["timestamp"], "2026-08-17 12:15:30.123000000");

        // ClickHouse text form, with and without fractional seconds.
        let mut ch = product_event(
            serde_json::json!({ "name": "e", "timestamp": "2026-08-17 10:15:30.123" }),
        );
        assert!(sanitize_product_event(&mut ch, received_at()));
        assert_eq!(ch["timestamp"], "2026-08-17 10:15:30.123000000");
        let mut ch_whole =
            product_event(serde_json::json!({ "name": "e", "timestamp": "2026-08-17 10:15:30" }));
        assert!(sanitize_product_event(&mut ch_whole, received_at()));
        assert_eq!(ch_whole["timestamp"], "2026-08-17 10:15:30.000000000");

        for bad in [
            serde_json::json!("yesterday"),
            serde_json::json!("1755432000000"),
            serde_json::json!(1755432000000u64),
        ] {
            let mut obj = product_event(serde_json::json!({ "name": "e", "timestamp": bad }));
            assert!(
                !sanitize_product_event(&mut obj, received_at()),
                "timestamp {bad} should be dropped"
            );
        }
    }

    #[test]
    fn product_event_timestamp_outside_the_window_is_dropped() {
        // Inside: a buffered backend flush from last week, the far edge of the
        // backdate window, and a clock a few hours ahead.
        for ok in [
            serde_json::json!("2026-08-10T12:00:00Z"),
            serde_json::json!("2026-07-19T12:00:00Z"),
            serde_json::json!("2026-08-18T06:00:00Z"),
        ] {
            let mut obj = product_event(serde_json::json!({ "name": "e", "timestamp": ok }));
            assert!(
                sanitize_product_event(&mut obj, received_at()),
                "timestamp {ok} should be kept"
            );
        }

        // Outside: a five-year historical replay (one partition per day) and a
        // far-future stamp the 365-day TTL would never reach.
        for bad in [
            serde_json::json!("2019-01-01T00:00:00Z"),
            serde_json::json!("2026-07-17T11:59:59Z"),
            serde_json::json!("2026-08-19T00:00:00Z"),
            serde_json::json!("2999-01-01T00:00:00Z"),
        ] {
            let mut obj = product_event(serde_json::json!({ "name": "e", "timestamp": bad }));
            assert!(
                !sanitize_product_event(&mut obj, received_at()),
                "timestamp {bad} should be dropped"
            );
        }
    }

    #[test]
    fn product_event_url_derives_host_and_page_path() {
        let mut obj = product_event(serde_json::json!({
            "name": "checkout_viewed",
            "url": "https://App.Example.COM:8443/checkout/123?step=2#pay",
        }));
        assert!(sanitize_product_event(&mut obj, received_at()));
        assert_eq!(obj["host"], "app.example.com");
        assert_eq!(obj["page_path"], "/checkout/123");
        assert_eq!(
            obj["url"],
            "https://App.Example.COM:8443/checkout/123?step=2#pay"
        );

        // Explicit page_path overrides the derived one.
        let mut explicit = product_event(serde_json::json!({
            "name": "checkout_viewed",
            "url": "https://app.example.com/checkout/123",
            "page_path": "/checkout/:id",
        }));
        assert!(sanitize_product_event(&mut explicit, received_at()));
        assert_eq!(explicit["page_path"], "/checkout/:id");
        assert_eq!(explicit["host"], "app.example.com");

        // Relative URL: no host, path up to the query string.
        let mut relative =
            product_event(serde_json::json!({ "name": "e", "url": "/pricing?ref=x" }));
        assert!(sanitize_product_event(&mut relative, received_at()));
        assert_eq!(relative["host"], "");
        assert_eq!(relative["page_path"], "/pricing");

        // No URL at all: both empty.
        let mut none = product_event(serde_json::json!({ "name": "e" }));
        assert!(sanitize_product_event(&mut none, received_at()));
        assert_eq!(none["host"], "");
        assert_eq!(none["page_path"], "");
        assert_eq!(none["url"], "");
    }

    #[test]
    fn product_event_row_shape_and_id_clamps() {
        let mut obj = product_event(serde_json::json!({
            "name": "plan_started",
            "user_id": "u".repeat(1000),
            "group_id": "org_1",
            "visitor_id": 123,
            "service_name": "s".repeat(1000),
            "org_id": "forged",
            "seq": 7,
            "kind": "navigation",
            "unknown_field": true,
        }));
        assert!(sanitize_product_event(&mut obj, received_at()));

        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "attributes",
                "event_name",
                "group_id",
                "host",
                "kind",
                "page_path",
                "seq",
                "service_name",
                "session_id",
                "source",
                "timestamp",
                "url",
                "user_id",
                "visitor_id",
            ]
        );
        assert_eq!(obj["seq"], 0);
        assert_eq!(obj["kind"], "custom");
        assert_eq!(obj["user_id"].as_str().unwrap().len(), PRODUCT_EVENT_MAX_ID_BYTES);
        assert_eq!(
            obj["service_name"].as_str().unwrap().len(),
            PRODUCT_EVENT_MAX_SERVICE_NAME_BYTES
        );
        // Off-type identifiers fall back to the column default.
        assert_eq!(obj["visitor_id"], "");
        assert_eq!(obj["session_id"], "");
        assert!(obj["attributes"].as_object().unwrap().is_empty());
    }

    #[test]
    fn product_event_attributes_are_clamped_like_session_events() {
        let mut attributes = serde_json::Map::new();
        attributes.insert("a".repeat(500), serde_json::json!("v"));
        for i in 0..100 {
            attributes.insert(format!("k{i}"), serde_json::json!("v"));
        }
        attributes.insert("k0".to_string(), serde_json::json!("y".repeat(4096)));
        attributes.insert("k1".to_string(), serde_json::json!(42));

        let mut obj = product_event(serde_json::json!({ "name": "e" }));
        obj.insert("attributes".to_string(), serde_json::Value::Object(attributes));
        assert!(sanitize_product_event(&mut obj, received_at()));

        let attributes = obj["attributes"].as_object().unwrap();
        assert_eq!(attributes.len(), SESSION_EVENT_MAX_ATTRIBUTES);
        assert!(attributes.contains_key(&"a".repeat(SESSION_EVENT_MAX_ATTRIBUTE_KEY_BYTES)));
        assert_eq!(
            attributes["k0"].as_str().unwrap().len(),
            SESSION_EVENT_MAX_ATTRIBUTE_VALUE_BYTES
        );
        assert_eq!(attributes["k1"], "42");
        assert!(attributes.contains_key("k2"));
        assert!(!attributes.contains_key("k99"));

        // Non-object attributes → empty map, row kept.
        let mut off_type = product_event(serde_json::json!({ "name": "e", "attributes": "nope" }));
        assert!(sanitize_product_event(&mut off_type, received_at()));
        assert!(off_type["attributes"].as_object().unwrap().is_empty());
    }
}
