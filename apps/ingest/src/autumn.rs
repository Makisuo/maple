use std::collections::HashMap;
use std::time::Duration;

use maple_ingest::metrics;
use moka::future::Cache;
use reqwest::Client;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{error, info, warn, Instrument};
use uuid::Uuid;

pub struct UsageEvent {
    pub org_id: String,
    pub feature_id: &'static str,
    /// Quantity to bill for this event. Unit depends on `feature_id`: GB for
    /// `logs`/`traces`/`metrics`, a raw count for `browser_sessions`.
    pub value: f64,
}

#[derive(Clone)]
pub struct AutumnTracker {
    tx: mpsc::UnboundedSender<UsageEvent>,
}

#[derive(Serialize)]
struct TrackRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
    value: f64,
    idempotency_key: String,
}

impl AutumnTracker {
    pub fn spawn(secret_key: String, api_url: &str, flush_interval_secs: u64) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let api_url = api_url.trim_end_matches('/').to_string();
        let flush_interval = Duration::from_secs(flush_interval_secs);

        tokio::spawn(flush_loop(rx, secret_key, api_url, flush_interval));

        info!(flush_interval_secs, "Autumn usage tracker started");

        Self { tx }
    }

    pub fn track(&self, org_id: &str, feature_id: &'static str, value: f64) {
        let _ = self.tx.send(UsageEvent {
            org_id: org_id.to_string(),
            feature_id,
            value,
        });
    }
}

type AccumulatorKey = (String, &'static str); // (org_id, feature_id)

/// Usage accumulated for one `(org_id, feature_id)` since the last successful
/// flush, together with the idempotency key that identifies it to Autumn.
///
/// The key is minted once, when the entry is created, and reused for every
/// retry of that entry. That is the whole point: a flush whose response is lost
/// (timeout, reset, 5xx after commit) leaves the entry in the accumulator to be
/// re-sent, and only a stable key lets Autumn recognize the retry instead of
/// billing it twice. It is dropped with the entry on success, so usage that
/// arrives afterwards starts a new entry under a new key.
struct PendingUsage {
    value: f64,
    idempotency_key: String,
}

impl PendingUsage {
    fn new() -> Self {
        Self {
            value: 0.0,
            idempotency_key: Uuid::new_v4().to_string(),
        }
    }
}

async fn flush_loop(
    mut rx: mpsc::UnboundedReceiver<UsageEvent>,
    secret_key: String,
    api_url: String,
    flush_interval: Duration,
) {
    let client = Client::new();
    let mut accumulator: HashMap<AccumulatorKey, PendingUsage> = HashMap::new();
    let mut consecutive_failures: u64 = 0;
    let critical_threshold: u64 = (300 / flush_interval.as_secs().max(1)).max(1);

    let mut interval = tokio::time::interval(flush_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if accumulator.is_empty() {
                    continue;
                }

                let flush_start = Instant::now();
                let mut all_ok = true;

                // Collect entries to flush
                let entries: Vec<(AccumulatorKey, f64, String)> = accumulator
                    .iter()
                    .map(|(k, v)| (k.clone(), v.value, v.idempotency_key.clone()))
                    .collect();

                let mut flushed_keys: Vec<AccumulatorKey> = Vec::new();

                for ((org_id, feature_id), value, idempotency_key) in &entries {
                    let body = TrackRequest {
                        customer_id: org_id,
                        feature_id,
                        value: *value,
                        idempotency_key: idempotency_key.clone(),
                    };

                    let span = tracing::info_span!(
                        "autumn.track",
                        otel.kind = "client",
                        "http.request.method" = "POST",
                        "server.address" = "api.useautumn.com",
                        "peer.service" = "autumn",
                    );
                    let result: Result<reqwest::Response, reqwest::Error> = client
                        .post(format!("{}/v1/track", api_url))
                        .header("Authorization", format!("Bearer {}", secret_key))
                        .json(&body)
                        .send()
                        .instrument(span)
                        .await;

                    match result {
                        Ok(resp) if resp.status().is_success() => {
                            flushed_keys.push((org_id.clone(), feature_id));
                        }
                        Ok(resp) => {
                            let status = resp.status();
                            let body_text = resp.text().await.unwrap_or_default();
                            warn!(
                                org_id,
                                feature_id,
                                status = %status,
                                body = %body_text,
                                "Autumn track request failed"
                            );
                            all_ok = false;
                        }
                        Err(err) => {
                            warn!(
                                org_id,
                                feature_id,
                                error = %err,
                                "Autumn track request failed"
                            );
                            all_ok = false;
                        }
                    }
                }

                // Remove successfully flushed entries
                for key in &flushed_keys {
                    accumulator.remove(key);
                }

                let flush_duration = flush_start.elapsed();

                if all_ok {
                    consecutive_failures = 0;
                    metrics::autumn_flush("ok", flush_duration.as_secs_f64());
                } else {
                    consecutive_failures += 1;
                    metrics::autumn_flush("error", flush_duration.as_secs_f64());

                    if consecutive_failures >= critical_threshold {
                        let total_pending_gb: f64 = accumulator.values().map(|v| v.value).sum();
                        error!(
                            consecutive_failures,
                            pending_entries = accumulator.len(),
                            total_pending_gb,
                            "CRITICAL: Autumn tracking has failed for ~5 minutes. Usage data is accumulating in memory."
                        );
                    }
                }

                // Update pending gauge. Note: this now sums mixed units across
                // features (GB for logs/traces/metrics, counts for browser_sessions);
                // the metric name is kept as-is to avoid breaking existing dashboards.
                let total_pending: f64 = accumulator.values().map(|v| v.value).sum();
                metrics::autumn_pending_gb(total_pending);
            }

            event = rx.recv() => {
                match event {
                    Some(event) => {
                        accumulator
                            .entry((event.org_id, event.feature_id))
                            .or_insert_with(PendingUsage::new)
                            .value += event.value;
                    }
                    None => {
                        // Channel closed, do a final flush attempt
                        if !accumulator.is_empty() {
                            info!(
                                pending_entries = accumulator.len(),
                                "Autumn tracker shutting down, attempting final flush"
                            );
                            flush_all(&client, &secret_key, &api_url, &mut accumulator).await;
                        }
                        break;
                    }
                }
            }
        }
    }
}

async fn flush_all(
    client: &Client,
    secret_key: &str,
    api_url: &str,
    accumulator: &mut HashMap<AccumulatorKey, PendingUsage>,
) {
    let entries: Vec<(AccumulatorKey, f64, String)> = accumulator
        .iter()
        .map(|(k, v)| (k.clone(), v.value, v.idempotency_key.clone()))
        .collect();

    for ((org_id, feature_id), value, idempotency_key) in &entries {
        let body = TrackRequest {
            customer_id: org_id,
            feature_id,
            // Same key the interval flush would have used, so a shutdown that
            // races an in-flight retry does not bill the entry twice.
            value: *value,
            idempotency_key: idempotency_key.clone(),
        };

        let span = tracing::info_span!(
            "autumn.track",
            otel.kind = "client",
            "http.request.method" = "POST",
            "server.address" = "api.useautumn.com",
            "peer.service" = "autumn",
        );
        let result: Result<reqwest::Response, reqwest::Error> = client
            .post(format!("{}/v1/track", api_url))
            .header("Authorization", format!("Bearer {}", secret_key))
            .json(&body)
            .send()
            .instrument(span)
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                accumulator.remove(&(org_id.clone(), feature_id));
            }
            Ok(resp) => {
                warn!(
                    org_id,
                    feature_id,
                    status = %resp.status(),
                    "Final flush failed for entry"
                );
            }
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Final flush failed for entry"
                );
            }
        }
    }
}

/// Synchronous, cached entitlement check against Autumn's `POST /v1/check`.
///
/// Unlike [`AutumnTracker`] (fire-and-forget usage metering), this sits in the
/// ingest hot path and gates a request *before* it is accepted. It is only
/// constructed when `AUTUMN_ENFORCE_LIMITS=true` and `AUTUMN_SECRET_KEY` is set,
/// so local dev / self-hosted deployments are unaffected.
#[derive(Clone)]
pub struct AutumnEntitlements {
    client: Client,
    secret_key: String,
    api_url: String,
    // Keyed by `"{org_id}:{feature_id}"`. Holds *confirmed* decisions only.
    // Fail-open allows are deliberately not cached: caching them would let one
    // failed check suppress enforcement for a whole TTL window, turning a
    // momentary Autumn blip into minutes of unmetered ingest.
    cache: Cache<String, bool>,
}

#[derive(Serialize)]
struct CheckRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
}

impl AutumnEntitlements {
    pub fn new(client: Client, secret_key: String, api_url: &str, cache_ttl_secs: u64) -> Self {
        let api_url = api_url.trim_end_matches('/').to_string();
        let cache = Cache::builder()
            .time_to_live(Duration::from_secs(cache_ttl_secs.max(1)))
            .max_capacity(10_000)
            .build();

        info!(cache_ttl_secs, "Autumn entitlement enforcement enabled");

        Self {
            client,
            secret_key,
            api_url,
            cache,
        }
    }

    /// Returns whether `org_id` may ingest the given `feature_id`
    /// (`"logs" | "traces" | "metrics"`). Fails open (`true`) on any
    /// transport/decode error so a billing-provider outage never drops
    /// customer data.
    pub async fn is_allowed(&self, org_id: &str, feature_id: &str) -> bool {
        let cache_key = format!("{org_id}:{feature_id}");
        // Recorded on `ingest.entitlement_check` when this runs under the HTTP
        // path; a no-op elsewhere (the field is only declared on that span).
        if let Some(allowed) = self.cache.get(&cache_key).await {
            tracing::Span::current().record("maple.ingest.cache_hit", true);
            return allowed;
        }
        tracing::Span::current().record("maple.ingest.cache_hit", false);

        match self.fetch_allowed(org_id, feature_id).await {
            Some(allowed) => {
                self.cache.insert(cache_key, allowed).await;
                allowed
            }
            // No confirmed decision. Fail open for this request, but don't
            // remember it — the next request re-checks, so enforcement resumes
            // as soon as Autumn does rather than a TTL later.
            None => true,
        }
    }

    /// `Some(decision)` when Autumn gave us an answer we understand, `None` when
    /// it did not — transport failure, non-2xx, unreadable or non-JSON body, or
    /// a shape `decide_allowed` doesn't recognize. The caller fails open on
    /// `None`; only `Some` is cacheable.
    async fn fetch_allowed(&self, org_id: &str, feature_id: &str) -> Option<bool> {
        let body = CheckRequest {
            customer_id: org_id,
            feature_id,
        };

        let span = tracing::info_span!(
            "autumn.check",
            otel.kind = "client",
            "http.request.method" = "POST",
            "server.address" = "api.useautumn.com",
            "peer.service" = "autumn",
        );
        let result = self
            .client
            .post(format!("{}/v1/check", self.api_url))
            .header("Authorization", format!("Bearer {}", self.secret_key))
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .instrument(span)
            .await;

        let response = match result {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(resp) => {
                warn!(
                    org_id,
                    feature_id,
                    status = %resp.status(),
                    "Autumn check returned non-success; failing open"
                );
                return None;
            }
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Autumn check request failed; failing open"
                );
                return None;
            }
        };

        // Parse to an untyped Value rather than a fixed struct: Autumn's
        // `/v1/check` body has shifted shape across versions (the hosted REST
        // body is flat with a numeric `balance`; the SDK's typed view nests a
        // `balance` object with `remaining`). A struct that assumes one shape
        // fails to decode the other and silently fails us open — which is
        // exactly the bug this replaces. Value parsing only fails on non-JSON.
        let text = match response.text().await {
            Ok(text) => text,
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Failed to read Autumn check response body; failing open"
                );
                return None;
            }
        };

        let value = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    body = %truncate_for_log(&text),
                    "Autumn check response is not JSON; failing open"
                );
                return None;
            }
        };

        let decision = decide_allowed(&value);
        if decision.is_none() {
            // Valid JSON we didn't recognize. Fail open, but log the body so
            // the real shape is visible and we can adapt decide_allowed.
            warn!(
                org_id,
                feature_id,
                body = %truncate_for_log(&text),
                "Unrecognized Autumn check response shape; failing open"
            );
        }
        decision
    }
}

fn truncate_for_log(body: &str) -> String {
    const MAX: usize = 512;
    if body.len() <= MAX {
        return body.to_string();
    }
    // Step back to a char boundary so we never slice through a UTF-8 sequence.
    let mut end = MAX;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &body[..end])
}

/// Decide whether an org may ingest, from Autumn's `/v1/check` body. Tolerant of
/// both the flat hosted REST shape (`balance` is a number, `unlimited` /
/// `overage_allowed` top-level) and the SDK's nested shape (`balance` is an
/// object carrying `remaining` / `unlimited` / `overage_allowed`).
///
/// Returns `None` when the JSON carries none of the fields we understand, so the
/// caller can log the body and fail open rather than guess.
///
/// Block only when the org genuinely has no headroom:
/// - `unlimited` or `overage_allowed` (usage-based `startup` plan) → allow.
/// - a numeric remaining balance → allow while `> 0` (hard-capped `starter`
///   blocks once depleted). We gate on remaining rather than the `allowed` flag
///   because Autumn's default `required_balance` is 1, which flips `allowed`
///   false at <1 GB left (~98%) — premature for a GB-denominated meter.
/// - otherwise → defer to `allowed`. An org with no subscription gets
///   `allowed:false`, so this blocks.
fn decide_allowed(value: &serde_json::Value) -> Option<bool> {
    let as_bool = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_bool());

    let mut understood = false;
    let mut unlimited = as_bool(value, "unlimited").unwrap_or(false);
    let mut overage = as_bool(value, "overage_allowed").unwrap_or(false);
    let mut remaining: Option<f64> = None;

    if unlimited || overage || as_bool(value, "allowed").is_some() {
        understood = true;
    }

    match value.get("balance") {
        Some(serde_json::Value::Number(n)) => {
            understood = true;
            remaining = n.as_f64();
        }
        Some(serde_json::Value::Object(obj)) => {
            understood = true;
            if obj.get("unlimited").and_then(|x| x.as_bool()) == Some(true) {
                unlimited = true;
            }
            if obj.get("overage_allowed").and_then(|x| x.as_bool()) == Some(true) {
                overage = true;
            }
            remaining = obj.get("remaining").and_then(|x| x.as_f64());
        }
        Some(serde_json::Value::Null) | None => {}
        Some(_) => {}
    }

    if !understood {
        return None;
    }

    if unlimited || overage {
        return Some(true);
    }
    if let Some(remaining) = remaining {
        return Some(remaining > 0.0);
    }
    // No remaining figure to gate on → defer to Autumn's own decision.
    Some(as_bool(value, "allowed").unwrap_or(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::Router;

    fn decide(json: &str) -> Option<bool> {
        let value = serde_json::from_str::<serde_json::Value>(json).expect("valid json");
        decide_allowed(&value)
    }

    // --- Flat hosted REST shape: `balance` is a number; unlimited /
    // overage_allowed are top-level. This is the shape that broke decode before. ---

    #[test]
    fn flat_hardcap_with_remaining_allows() {
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": 12.5, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn flat_hardcap_depleted_blocks() {
        // allowed:false at remaining 0 — and even if `allowed` lagged, remaining
        // gates the decision.
        assert_eq!(
            decide(
                r#"{"allowed": false, "balance": 0, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(false)
        );
    }

    #[test]
    fn flat_sub_one_gb_remaining_still_allows() {
        // Autumn's required_balance:1 makes `allowed:false` here, but 0.5 GB left
        // is not depleted — we must still allow.
        assert_eq!(
            decide(
                r#"{"allowed": false, "balance": 0.5, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn flat_unlimited_allows() {
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": 0, "unlimited": true, "overage_allowed": false}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn flat_overage_allows() {
        // Usage-based `startup` plan: never blocked even when over included.
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": -5, "unlimited": false, "overage_allowed": true}"#
            ),
            Some(true)
        );
    }

    // --- Nested SDK shape: `balance` is an object carrying `remaining`. ---

    #[test]
    fn nested_balance_object_with_remaining_allows() {
        let json = r#"{
            "allowed": true,
            "customer_id": "org_123",
            "balance": {
                "feature_id": "logs",
                "granted": 50,
                "remaining": 12.5,
                "usage": 37.5,
                "unlimited": false,
                "overage_allowed": false,
                "next_reset_at": 1234567890
            },
            "flag": null
        }"#;
        assert_eq!(decide(json), Some(true));
    }

    #[test]
    fn nested_balance_object_depleted_blocks() {
        let json = r#"{"allowed": false, "balance": {"remaining": 0, "unlimited": false, "overage_allowed": false}, "flag": null}"#;
        assert_eq!(decide(json), Some(false));
    }

    #[test]
    fn nested_overage_allows() {
        let json = r#"{"allowed": false, "balance": {"remaining": -5, "unlimited": false, "overage_allowed": true}}"#;
        assert_eq!(decide(json), Some(true));
    }

    // --- No balance / no subscription: defer to `allowed`. ---

    #[test]
    fn null_balance_no_subscription_blocks() {
        assert_eq!(
            decide(r#"{"allowed": false, "balance": null, "flag": null}"#),
            Some(false)
        );
    }

    #[test]
    fn allowed_only_no_balance_field() {
        assert_eq!(decide(r#"{"allowed": true}"#), Some(true));
        assert_eq!(decide(r#"{"allowed": false}"#), Some(false));
    }

    // --- Unrecognized shape: None so the caller logs + fails open. ---

    #[test]
    fn unrecognized_shape_returns_none() {
        assert_eq!(decide(r#"{"error": "internal", "code": 500}"#), None);
        assert_eq!(decide(r#"{}"#), None);
    }

    #[tokio::test]
    async fn fails_open_on_transport_error() {
        // Port 1 is closed => connection refused => we must fail open (allow),
        // never dropping customer data on a billing-provider outage.
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_string(),
            "http://127.0.0.1:1",
            60,
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);
    }

    #[tokio::test]
    async fn fail_open_decisions_are_not_cached() {
        // A fail-open allow must not be remembered: caching it would let one
        // failed check suppress enforcement for the whole TTL.
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_string(),
            "http://127.0.0.1:1",
            3600,
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);
        entitlements.cache.run_pending_tasks().await;
        assert_eq!(
            entitlements.cache.get("org_123:logs").await,
            None,
            "fail-open allow must not be cached"
        );
    }

    // --- Idempotency: one key per accumulated entry, stable across retries. ---

    /// Stand-in for Autumn's `/v1/track`. Records every body it receives and
    /// answers with `status`, so a test can drive the flush loop through a
    /// failure and inspect what the retry sent.
    async fn record_track(
        State((tx, status)): State<(
            tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
            StatusCode,
        )>,
        body: String,
    ) -> StatusCode {
        let _ = tx.send(serde_json::from_str(&body).unwrap());
        status
    }

    async fn spawn_autumn_stub(
        status: StatusCode,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/track", post(record_track))
            .with_state((tx, status));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn a_failed_flush_retries_under_the_same_idempotency_key() {
        // The bug this pins: a per-attempt key means Autumn cannot recognize the
        // retry of a track it already committed, and bills the usage twice.
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::INTERNAL_SERVER_ERROR).await;
        let tracker = AutumnTracker::spawn("sk_test".to_string(), &api_url, 1);
        tracker.track("org_retry", "logs", 1.5);

        let first = rx.recv().await.expect("first flush attempt");
        let second = rx.recv().await.expect("retry after the 500");

        assert_eq!(
            first["idempotency_key"], second["idempotency_key"],
            "retry must reuse the key so Autumn can dedupe it"
        );
        // The entry survived the failure intact, so the retry re-sends the same
        // accumulated value rather than a fragment of it.
        assert_eq!(first["value"], second["value"]);
        assert_eq!(first["customer_id"], "org_retry");
        assert_eq!(first["feature_id"], "logs");
    }

    #[tokio::test]
    async fn usage_after_a_successful_flush_gets_a_fresh_key() {
        // The other half: once an entry is acknowledged it is gone, so later
        // usage for the same (org, feature) must not reuse its key — Autumn
        // would dedupe it away and we'd under-bill.
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let tracker = AutumnTracker::spawn("sk_test".to_string(), &api_url, 1);

        tracker.track("org_fresh", "traces", 2.0);
        let first = rx.recv().await.expect("first flush");
        tracker.track("org_fresh", "traces", 3.0);
        let second = rx.recv().await.expect("second flush");

        assert_ne!(first["idempotency_key"], second["idempotency_key"]);
        assert_eq!(first["value"], 2.0);
        assert_eq!(second["value"], 3.0);
    }
}
