//! ECS task scale-in protection driven by WAL backlog.
//!
//! The WAL lives on Fargate ephemeral storage, which is destroyed with the
//! task — so a scale-in that lands on a task holding unexported frames loses
//! them. Backlog is largest exactly when the autoscaler wants to scale in
//! (after a burst or a warehouse outage), so this loop marks the task
//! protected via the ECS agent's task-protection endpoint while the primary
//! lanes hold meaningful backlog, and releases it once they drain.
//!
//! The endpoint is signed by the agent itself; the task role only needs
//! `ecs:UpdateTaskProtection` (granted in `apps/ingest/alchemy.run.ts`).
//! Off-ECS (local dev, tests) `ECS_AGENT_URI` is absent and nothing spawns.

use std::time::Duration;

use maple_ingest::telemetry::TelemetryPipeline;
use serde::Serialize;
use tracing::{info, warn};

const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Backlog below this is steady-state churn — frames sitting between append
/// and export for a few milliseconds. Protecting on it would flap a protection
/// update against the ECS API on every poll.
const PROTECT_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;

/// Refreshed on every protected poll, so expiry only matters if the process
/// dies without unprotecting — after which the task is fair game anyway.
const PROTECT_EXPIRES_MINUTES: u32 = 15;

/// Polls this many times below the threshold before releasing protection, so
/// a backlog oscillating around the threshold doesn't flap the ECS API.
const RELEASE_AFTER_CLEAR_POLLS: u32 = 2;

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct ProtectionRequest {
    protection_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in_minutes: Option<u32>,
}

pub(crate) fn spawn(pipeline: TelemetryPipeline) {
    let Some(agent_uri) = std::env::var("ECS_AGENT_URI")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_owned())
        .filter(|v| !v.is_empty())
    else {
        return;
    };
    let endpoint = format!("{agent_uri}/task-protection/v1/state");
    info!(endpoint = %endpoint, "WAL-backlog scale-in protection started");
    tokio::spawn(run(pipeline, endpoint));
}

async fn run(pipeline: TelemetryPipeline, endpoint: String) {
    let client = reqwest::Client::new();
    let mut protected = false;
    let mut clear_polls: u32 = 0;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let backlog = pipeline.wal_backlog_bytes();
        if backlog >= PROTECT_THRESHOLD_BYTES {
            clear_polls = 0;
            // Re-sent every poll while backlogged: the same call both acquires
            // protection and pushes the expiry window out.
            if set_protection(&client, &endpoint, true, backlog).await && !protected {
                protected = true;
                info!(backlog_bytes = backlog, "WAL backlog above threshold; task protected from scale-in");
            }
        } else if protected {
            clear_polls += 1;
            if clear_polls >= RELEASE_AFTER_CLEAR_POLLS
                && set_protection(&client, &endpoint, false, backlog).await
            {
                protected = false;
                info!("WAL drained; task scale-in protection released");
            }
        }
    }
}

/// Returns whether the agent accepted the state change. Failures are logged
/// and retried on the next poll — protection is an optimization over losing
/// data, not a correctness gate, so it must never take the process down.
async fn set_protection(
    client: &reqwest::Client,
    endpoint: &str,
    enabled: bool,
    backlog_bytes: u64,
) -> bool {
    let body = ProtectionRequest {
        protection_enabled: enabled,
        expires_in_minutes: enabled.then_some(PROTECT_EXPIRES_MINUTES),
    };
    let result = client
        .put(endpoint)
        .timeout(Duration::from_secs(5))
        .json(&body)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            warn!(
                enabled,
                backlog_bytes,
                status = %status,
                body = %body_text,
                "ECS task-protection update rejected"
            );
            false
        }
        Err(error) => {
            warn!(enabled, backlog_bytes, error = %error, "ECS task-protection update failed");
            false
        }
    }
}
