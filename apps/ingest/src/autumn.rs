use std::collections::HashMap;
use std::time::Duration;

use metrics::{counter, gauge, histogram};
use reqwest::Client;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{error, info, warn};
use uuid::Uuid;

pub struct UsageEvent {
    pub org_id: String,
    pub feature_id: &'static str,
    pub value_gb: f64,
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

        info!(
            flush_interval_secs,
            "Autumn usage tracker started"
        );

        Self { tx }
    }

    pub fn track(&self, org_id: &str, feature_id: &'static str, value_gb: f64) {
        let _ = self.tx.send(UsageEvent {
            org_id: org_id.to_string(),
            feature_id,
            value_gb,
        });
    }
}

type AccumulatorKey = (String, &'static str); // (org_id, feature_id)

async fn flush_loop(
    mut rx: mpsc::UnboundedReceiver<UsageEvent>,
    secret_key: String,
    api_url: String,
    flush_interval: Duration,
) {
    let client = Client::new();
    let mut accumulator: HashMap<AccumulatorKey, f64> = HashMap::new();
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
                let entries: Vec<(AccumulatorKey, f64)> = accumulator
                    .iter()
                    .map(|(k, v)| (k.clone(), *v))
                    .collect();

                let mut flushed_keys: Vec<AccumulatorKey> = Vec::new();

                for ((org_id, feature_id), value_gb) in &entries {
                    let body = TrackRequest {
                        customer_id: org_id,
                        feature_id,
                        value: *value_gb,
                        idempotency_key: Uuid::new_v4().to_string(),
                    };

                    let result: Result<reqwest::Response, reqwest::Error> = client
                        .post(format!("{}/v1/track", api_url))
                        .header("Authorization", format!("Bearer {}", secret_key))
                        .json(&body)
                        .send()
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
                histogram!("autumn_track_flush_duration_seconds")
                    .record(flush_duration.as_secs_f64());

                if all_ok {
                    consecutive_failures = 0;
                    counter!("autumn_track_flushes_total", "status" => "ok")
                        .increment(1);
                } else {
                    consecutive_failures += 1;
                    counter!("autumn_track_flushes_total", "status" => "error")
                        .increment(1);

                    if consecutive_failures >= critical_threshold {
                        let total_pending_gb: f64 = accumulator.values().sum();
                        error!(
                            consecutive_failures,
                            pending_entries = accumulator.len(),
                            total_pending_gb,
                            "CRITICAL: Autumn tracking has failed for ~5 minutes. Usage data is accumulating in memory."
                        );
                    }
                }

                // Update pending gauge
                let total_pending: f64 = accumulator.values().sum();
                gauge!("autumn_track_pending_gb").set(total_pending);
            }

            event = rx.recv() => {
                match event {
                    Some(event) => {
                        *accumulator
                            .entry((event.org_id, event.feature_id))
                            .or_insert(0.0) += event.value_gb;
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
    accumulator: &mut HashMap<AccumulatorKey, f64>,
) {
    let entries: Vec<(AccumulatorKey, f64)> = accumulator
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();

    for ((org_id, feature_id), value_gb) in &entries {
        let body = TrackRequest {
            customer_id: org_id,
            feature_id,
            value: *value_gb,
            idempotency_key: Uuid::new_v4().to_string(),
        };

        let result: Result<reqwest::Response, reqwest::Error> = client
            .post(format!("{}/v1/track", api_url))
            .header("Authorization", format!("Bearer {}", secret_key))
            .json(&body)
            .send()
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
