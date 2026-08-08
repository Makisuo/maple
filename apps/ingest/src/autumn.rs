use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use maple_ingest::metrics;
use reqwest::Client;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{error, info, warn, Instrument};
use uuid::Uuid;

const AUTUMN_API_VERSION: &str = "2.3.0";
const AUTUMN_TRACK_PATH: &str = "/v1/balances.track";
const AUTUMN_CHECK_PATH: &str = "/v1/balances.check";
const AUTUMN_FINALIZE_PATH: &str = "/v1/balances.finalize";

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
    /// Once a batch has been attempted, its value and key are immutable. New
    /// usage waits here until that batch succeeds, then starts under a new key.
    queued_value: f64,
    sealed: bool,
}

impl PendingUsage {
    fn new(value: f64) -> Self {
        Self {
            value,
            idempotency_key: Uuid::new_v4().to_string(),
            queued_value: 0.0,
            sealed: false,
        }
    }

    fn total(&self) -> f64 {
        self.value + self.queued_value
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
                    .iter_mut()
                    .map(|(key, pending)| {
                        pending.sealed = true;
                        (key.clone(), pending.value, pending.idempotency_key.clone())
                    })
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
                        .post(format!("{}{}", api_url, AUTUMN_TRACK_PATH))
                        .header("Authorization", format!("Bearer {}", secret_key))
                        .header("x-api-version", AUTUMN_API_VERSION)
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
                    if let Some(completed) = accumulator.remove(key) {
                        if completed.queued_value > 0.0 {
                            accumulator.insert(
                                key.clone(),
                                PendingUsage::new(completed.queued_value),
                            );
                        }
                    }
                }

                let flush_duration = flush_start.elapsed();

                if all_ok {
                    consecutive_failures = 0;
                    metrics::autumn_flush("ok", flush_duration.as_secs_f64());
                } else {
                    consecutive_failures += 1;
                    metrics::autumn_flush("error", flush_duration.as_secs_f64());

                    if consecutive_failures >= critical_threshold {
                        let total_pending_gb: f64 = accumulator.values().map(PendingUsage::total).sum();
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
                let total_pending: f64 = accumulator.values().map(PendingUsage::total).sum();
                metrics::autumn_pending_gb(total_pending);
            }

            event = rx.recv() => {
                match event {
                    Some(event) => {
                        let pending = accumulator
                            .entry((event.org_id, event.feature_id))
                            .or_insert_with(|| PendingUsage::new(0.0));
                        if pending.sealed {
                            pending.queued_value += event.value;
                        } else {
                            pending.value += event.value;
                        }
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
            .post(format!("{}{}", api_url, AUTUMN_TRACK_PATH))
            .header("Authorization", format!("Bearer {}", secret_key))
            .header("x-api-version", AUTUMN_API_VERSION)
            .json(&body)
            .send()
            .instrument(span)
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                let key = (org_id.clone(), *feature_id);
                if let Some(completed) = accumulator.remove(&key) {
                    if completed.queued_value > 0.0 {
                        accumulator.insert(key, PendingUsage::new(completed.queued_value));
                    }
                }
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

/// Autumn-native entitlement and atomic usage meter.
///
/// Billable handlers reserve their exact quantity with `balances.check`, commit
/// data to Maple's WAL, then confirm the lock. A rejected check never reaches
/// storage; a failed storage write releases the lock. Plain `is_allowed` remains
/// for replay payloads that belong to an already-metered browser session.
#[derive(Clone)]
pub struct AutumnEntitlements {
    client: Client,
    secret_key: String,
    api_url: String,
}

#[derive(Serialize)]
struct CheckRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    required_balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    send_event: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock: Option<CheckLockRequest<'a>>,
}

#[derive(Serialize)]
struct CheckLockRequest<'a> {
    lock_id: &'a str,
    enabled: bool,
    expires_at: u64,
}

#[derive(Serialize)]
struct FinalizeRequest<'a> {
    lock_id: &'a str,
    action: &'a str,
}

#[derive(Debug)]
pub struct AutumnReservation {
    lock_id: String,
}

pub enum AutumnReserveOutcome {
    Reserved(AutumnReservation),
    Denied,
    /// Autumn could not give a confirmed answer. The ingest path fails open and
    /// uses the retrying tracker after the WAL commit.
    Unavailable,
}

impl AutumnEntitlements {
    pub fn new(client: Client, secret_key: String, api_url: &str) -> Self {
        let api_url = api_url.trim_end_matches('/').to_string();
        info!("Autumn native billing enforcement enabled");

        Self {
            client,
            secret_key,
            api_url,
        }
    }

    /// Check without consuming usage. Decisions are intentionally not cached:
    /// Autumn customer controls can change, or cross a limit, on any event.
    pub async fn is_allowed(&self, org_id: &str, feature_id: &str) -> bool {
        tracing::Span::current().record("maple.ingest.cache_hit", false);
        self.post_check(org_id, feature_id, None, None)
            .await
            .and_then(|value| decide_allowed(&value, None))
            .unwrap_or(true)
    }

    /// Atomically check and reserve an exact usage quantity.
    pub async fn reserve(
        &self,
        org_id: &str,
        feature_id: &str,
        value: f64,
    ) -> AutumnReserveOutcome {
        let lock_id = Uuid::new_v4().to_string();
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            + 120_000;
        let lock = CheckLockRequest {
            lock_id: &lock_id,
            enabled: true,
            expires_at,
        };
        match self
            .post_check(org_id, feature_id, Some(value), Some(lock))
            .await
            .and_then(|response| decide_allowed(&response, Some(value)))
        {
            Some(true) => AutumnReserveOutcome::Reserved(AutumnReservation { lock_id }),
            Some(false) => AutumnReserveOutcome::Denied,
            None => AutumnReserveOutcome::Unavailable,
        }
    }

    /// Confirm a committed WAL write or release a failed one. A short retry
    /// handles transient downstream errors while the two-minute lock is valid.
    pub async fn finalize(&self, reservation: &AutumnReservation, confirm: bool) -> bool {
        let action = if confirm { "confirm" } else { "release" };
        let body = FinalizeRequest {
            lock_id: &reservation.lock_id,
            action,
        };
        for attempt in 1..=3 {
            let span = tracing::info_span!(
                "autumn.finalize",
                otel.kind = "client",
                "http.request.method" = "POST",
                "server.address" = "api.useautumn.com",
                "peer.service" = "autumn",
            );
            let result = self
                .client
                .post(format!("{}{}", self.api_url, AUTUMN_FINALIZE_PATH))
                .header("Authorization", format!("Bearer {}", self.secret_key))
                .header("x-api-version", AUTUMN_API_VERSION)
                .timeout(Duration::from_secs(5))
                .json(&body)
                .send()
                .instrument(span)
                .await;
            match result {
                Ok(response) if response.status().is_success() => return true,
                Ok(response) => warn!(
                    lock_id = %reservation.lock_id,
                    action,
                    attempt,
                    status = %response.status(),
                    "Autumn finalize returned non-success"
                ),
                Err(error) => warn!(
                    lock_id = %reservation.lock_id,
                    action,
                    attempt,
                    error = %error,
                    "Autumn finalize request failed"
                ),
            }
            tokio::time::sleep(Duration::from_millis(100 * attempt)).await;
        }
        error!(
            lock_id = %reservation.lock_id,
            action,
            "CRITICAL: Autumn reservation could not be finalized before lock expiry"
        );
        false
    }

    async fn post_check(
        &self,
        org_id: &str,
        feature_id: &str,
        required_balance: Option<f64>,
        lock: Option<CheckLockRequest<'_>>,
    ) -> Option<serde_json::Value> {
        let body = CheckRequest {
            customer_id: org_id,
            feature_id,
            required_balance,
            send_event: required_balance.map(|_| true),
            lock,
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
            .post(format!("{}{}", self.api_url, AUTUMN_CHECK_PATH))
            .header("Authorization", format!("Bearer {}", self.secret_key))
            .header("x-api-version", AUTUMN_API_VERSION)
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
        // `/v1/balances.check` body has shifted shape across versions (the
        // hosted REST body is flat with a numeric `balance`; the SDK's typed
        // view nests a `balance` object with `remaining`). A struct that assumes
        // one shape fails to decode the other and silently fails us open —
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

        if decide_allowed(&value, required_balance).is_none() {
            // Valid JSON we didn't recognize. Fail open, but log the body so
            // the real shape is visible and we can adapt decide_allowed.
            warn!(
                org_id,
                feature_id,
                body = %truncate_for_log(&text),
                "Unrecognized Autumn check response shape; failing open"
            );
        }
        Some(value)
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

/// Decide whether an org may ingest, from Autumn's `/v1/balances.check` body.
/// Tolerant of both the flat hosted REST shape (`balance` is a number,
/// `unlimited` / `overage_allowed` top-level) and the SDK's nested shape
/// (`balance` is an object carrying `remaining` / `unlimited` /
/// `overage_allowed`).
///
/// Returns `None` when the JSON carries none of the fields we understand, so the
/// caller can log the body and fail open rather than guess.
///
/// Autumn's explicit `allowed` field is authoritative. This matters for native
/// customer spend limits: a plan can allow overage generally while a customer
/// control denies the next event. Older response shapes without `allowed` fall
/// back to unlimited/overage/remaining for compatibility.
fn decide_allowed(value: &serde_json::Value, required_balance: Option<f64>) -> Option<bool> {
    let as_bool = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_bool());

    if let Some(allowed) = as_bool(value, "allowed") {
        return Some(allowed);
    }

    let mut understood = false;
    let mut unlimited = as_bool(value, "unlimited").unwrap_or(false);
    let mut overage = as_bool(value, "overage_allowed").unwrap_or(false);
    let mut remaining: Option<f64> = None;

    if unlimited || overage {
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
        return Some(match required_balance {
            Some(required) => remaining >= required,
            None => remaining > 0.0,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::Router;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn decide(json: &str) -> Option<bool> {
        let value = serde_json::from_str::<serde_json::Value>(json).expect("valid json");
        decide_allowed(&value, None)
    }

    fn decide_for(json: &str, required_balance: f64) -> Option<bool> {
        let value = serde_json::from_str::<serde_json::Value>(json).expect("valid json");
        decide_allowed(&value, Some(required_balance))
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
    fn legacy_shape_requires_the_full_reserved_quantity() {
        assert_eq!(
            decide_for(
                r#"{"balance": 0.5, "unlimited": false, "overage_allowed": false}"#,
                0.75,
            ),
            Some(false)
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
    fn explicit_denial_wins_even_when_balance_remains() {
        assert_eq!(
            decide(
                r#"{"allowed": false, "balance": 0.5, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(false)
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
    fn native_customer_cap_denial_wins_over_plan_overage() {
        let json = r#"{"allowed": false, "balance": {"remaining": -5, "unlimited": false, "overage_allowed": true}}"#;
        assert_eq!(decide(json), Some(false));
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
        let entitlements =
            AutumnEntitlements::new(Client::new(), "sk_test".to_string(), "http://127.0.0.1:1");
        assert!(entitlements.is_allowed("org_123", "logs").await);
    }

    async fn record_check(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<(serde_json::Value, Option<String>)>>,
        headers: axum::http::HeaderMap,
        body: String,
    ) -> axum::Json<serde_json::Value> {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let _ = tx.send((serde_json::from_str(&body).unwrap(), api_version));
        axum::Json(serde_json::json!({
            "allowed": true,
            "balance": {
                "remaining": 12.5,
                "unlimited": false,
                "overage_allowed": false
            }
        }))
    }

    #[tokio::test]
    async fn check_uses_v23_canonical_route_and_header() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_CHECK_PATH, post(record_check))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_string(),
            &format!("http://{addr}"),
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);

        let (body, api_version) = rx.recv().await.expect("check request");
        assert_eq!(body["customer_id"], "org_123");
        assert_eq!(body["feature_id"], "logs");
        assert_eq!(api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    async fn record_atomic_check(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<(String, serde_json::Value)>>,
        body: String,
    ) -> axum::Json<serde_json::Value> {
        let _ = tx.send(("check".to_string(), serde_json::from_str(&body).unwrap()));
        axum::Json(serde_json::json!({ "allowed": true, "balance": 10 }))
    }

    async fn record_finalize(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<(String, serde_json::Value)>>,
        body: String,
    ) -> axum::Json<serde_json::Value> {
        let _ = tx.send(("finalize".to_string(), serde_json::from_str(&body).unwrap()));
        axum::Json(serde_json::json!({ "success": true }))
    }

    #[tokio::test]
    async fn reserve_tracks_exact_usage_under_a_lock_then_confirms() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_CHECK_PATH, post(record_atomic_check))
            .route(AUTUMN_FINALIZE_PATH, post(record_finalize))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_string(),
            &format!("http://{addr}"),
        );
        let reservation = match entitlements.reserve("org_123", "logs", 0.125).await {
            AutumnReserveOutcome::Reserved(reservation) => reservation,
            _ => panic!("usage should be reserved"),
        };
        assert!(entitlements.finalize(&reservation, true).await);

        let (_, check) = rx.recv().await.expect("check request");
        let (_, finalize) = rx.recv().await.expect("finalize request");
        assert_eq!(check["customer_id"], "org_123");
        assert_eq!(check["feature_id"], "logs");
        assert_eq!(check["required_balance"], 0.125);
        assert_eq!(check["send_event"], true);
        assert_eq!(check["lock"]["enabled"], true);
        assert_eq!(finalize["lock_id"], check["lock"]["lock_id"]);
        assert_eq!(finalize["action"], "confirm");
    }

    // --- Idempotency: one key per accumulated entry, stable across retries. ---

    /// Stand-in for Autumn's `/v1/balances.track`. Records every body and API
    /// version it receives and answers with `status`, so a test can drive the
    /// flush loop through a failure and inspect what the retry sent.
    async fn record_track(
        State((tx, status)): State<(
            tokio::sync::mpsc::UnboundedSender<(serde_json::Value, Option<String>)>,
            StatusCode,
        )>,
        headers: axum::http::HeaderMap,
        body: String,
    ) -> StatusCode {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let _ = tx.send((serde_json::from_str(&body).unwrap(), api_version));
        status
    }

    async fn spawn_autumn_stub(
        status: StatusCode,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(serde_json::Value, Option<String>)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_TRACK_PATH, post(record_track))
            .with_state((tx, status));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    async fn record_track_fail_once(
        State((tx, attempts)): State<(
            tokio::sync::mpsc::UnboundedSender<(serde_json::Value, Option<String>)>,
            Arc<AtomicUsize>,
        )>,
        headers: axum::http::HeaderMap,
        body: String,
    ) -> StatusCode {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let _ = tx.send((serde_json::from_str(&body).unwrap(), api_version));
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            StatusCode::INTERNAL_SERVER_ERROR
        } else {
            StatusCode::OK
        }
    }

    async fn spawn_fail_once_autumn_stub() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(serde_json::Value, Option<String>)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_TRACK_PATH, post(record_track_fail_once))
            .with_state((tx, Arc::new(AtomicUsize::new(0))));
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

        let (first, first_api_version) = rx.recv().await.expect("first flush attempt");
        let (second, second_api_version) = rx.recv().await.expect("retry after the 500");

        assert_eq!(
            first["idempotency_key"], second["idempotency_key"],
            "retry must reuse the key so Autumn can dedupe it"
        );
        // The entry survived the failure intact, so the retry re-sends the same
        // accumulated value rather than a fragment of it.
        assert_eq!(first["value"], second["value"]);
        assert_eq!(first["customer_id"], "org_retry");
        assert_eq!(first["feature_id"], "logs");
        assert_eq!(first_api_version.as_deref(), Some(AUTUMN_API_VERSION));
        assert_eq!(second_api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    #[tokio::test]
    async fn usage_after_a_successful_flush_gets_a_fresh_key() {
        // The other half: once an entry is acknowledged it is gone, so later
        // usage for the same (org, feature) must not reuse its key — Autumn
        // would dedupe it away and we'd under-bill.
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let tracker = AutumnTracker::spawn("sk_test".to_string(), &api_url, 1);

        tracker.track("org_fresh", "traces", 2.0);
        let (first, first_api_version) = rx.recv().await.expect("first flush");
        tracker.track("org_fresh", "traces", 3.0);
        let (second, second_api_version) = rx.recv().await.expect("second flush");

        assert_ne!(first["idempotency_key"], second["idempotency_key"]);
        assert_eq!(first["value"], 2.0);
        assert_eq!(second["value"], 3.0);
        assert_eq!(first_api_version.as_deref(), Some(AUTUMN_API_VERSION));
        assert_eq!(second_api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    #[tokio::test]
    async fn usage_after_a_failed_flush_waits_for_a_fresh_batch_key() {
        let (api_url, mut rx) = spawn_fail_once_autumn_stub().await;
        let tracker = AutumnTracker::spawn("sk_test".to_string(), &api_url, 1);

        tracker.track("org_queued", "metrics", 1.5);
        let (failed, _) = rx.recv().await.expect("failed first flush");
        tokio::time::sleep(Duration::from_millis(50)).await;
        tracker.track("org_queued", "metrics", 2.0);

        let (retry, _) = rx.recv().await.expect("retry of sealed batch");
        let (queued, _) = rx
            .recv()
            .await
            .expect("fresh batch for newly arrived usage");

        assert_eq!(failed["idempotency_key"], retry["idempotency_key"]);
        assert_eq!(failed["value"], 1.5);
        assert_eq!(retry["value"], 1.5);
        assert_ne!(retry["idempotency_key"], queued["idempotency_key"]);
        assert_eq!(queued["value"], 2.0);
    }
}
