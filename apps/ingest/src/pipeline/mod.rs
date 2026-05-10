//! In-process OTel collector replacement.
//!
//! Today the OTLP path is `apps/ingest` → otel-collector-contrib (Go) → custom
//! Maple exporter (Go) → ClickHouse / Tinybird. The middle two hops are doing
//! batching, memory-limiting, k8s metadata enrichment, and JSON row encoding —
//! that's it. This module folds the wire-encoding + storage write path into
//! the ingest binary so we can drop the contrib collector for hosted SaaS,
//! get per-org sampling / transformation / routing knobs the contrib
//! processors don't expose well, and surface pipeline-level Prometheus +
//! tracing.
//!
//! Phase 1 (this file): scaffolding + traces writer behind `INGEST_PIPELINE_MODE`.
//! Two destinations are supported from day one — ClickHouse and Tinybird —
//! because Maple ingests into both today.
//!
//! - `disabled` (default): receiver is unchanged, pipeline is a no-op.
//! - `shadow`: receiver still forwards to the upstream collector AND feeds the
//!   parsed OTLP into this pipeline, which writes rows to a *mirror* stream
//!   (`traces_shadow` etc.) so we can diff against the production path.
//! - `primary`: pipeline is the only writer (post-cutover).
//!
//! See `/Users/makisuo/.claude/plans/would-it-makes-sense-mossy-nebula.md` for
//! the full plan and phase breakdown.

use std::sync::Arc;
use std::time::{Duration, Instant};

use metrics::{counter, histogram};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use tracing::{debug, error, warn};

use self::clickhouse::ClickhouseConfig;
use self::tinybird::TinybirdConfig;
use self::writer::{Destination, Writer};

pub mod body;
pub mod clickhouse;
pub mod encoding;
pub mod tinybird;
pub mod traces;
pub mod writer;

/// Operating mode of the in-process pipeline. Source of truth: the
/// `INGEST_PIPELINE_MODE` env var, parsed in `PipelineConfig::from_env`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipelineMode {
    /// Pipeline is wired up but does nothing — the receiver behaves as before.
    /// Default so deploying the new code is a no-op.
    Disabled,
    /// Pipeline writes to mirror streams alongside the existing forward path.
    /// Used to verify parity with the Go exporter before cutover.
    Shadow,
    /// Pipeline is the only writer. Not enabled before phase 7 cutover.
    Primary,
}

impl PipelineMode {
    fn from_env_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "shadow" => Self::Shadow,
            "primary" => Self::Primary,
            _ => Self::Disabled,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Shadow => "shadow",
            Self::Primary => "primary",
        }
    }

    pub fn is_enabled(self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

/// Resolved pipeline configuration. Built from env vars at startup.
#[derive(Clone, Debug)]
pub struct PipelineConfig {
    pub mode: PipelineMode,
    /// Stream name for the traces destination. ClickHouse: table name.
    /// Tinybird: datasource name. By convention identical across destinations
    /// so the rest of the pipeline doesn't care which backend is configured.
    pub traces_stream: String,
    pub destination: Option<Destination>,
}

impl PipelineConfig {
    /// Resolve from env. Returns a disabled config when `INGEST_PIPELINE_MODE`
    /// is unset or `disabled` — the binary boots without any of the new env
    /// vars.
    ///
    /// When mode is `shadow` or `primary`, all destination-specific vars are
    /// required; missing ones return `Err` so misconfig surfaces at startup
    /// rather than as silent drops at request time.
    pub fn from_env() -> Result<Self, String> {
        let mode = std::env::var("INGEST_PIPELINE_MODE")
            .ok()
            .as_deref()
            .map(PipelineMode::from_env_str)
            .unwrap_or(PipelineMode::Disabled);

        if !mode.is_enabled() {
            return Ok(Self {
                mode,
                traces_stream: default_traces_stream(mode),
                destination: None,
            });
        }

        let destination = parse_destination_from_env()?;

        let traces_stream = std::env::var("INGEST_PIPELINE_TRACES_STREAM")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default_traces_stream(mode));

        Ok(Self {
            mode,
            traces_stream,
            destination: Some(destination),
        })
    }
}

fn default_traces_stream(mode: PipelineMode) -> String {
    match mode {
        // Shadow writes to a mirror stream so the diff job can compare against
        // the production `traces` table/datasource without double-counting.
        PipelineMode::Shadow => "traces_shadow".to_string(),
        _ => "traces".to_string(),
    }
}

/// Read destination-specific env vars based on `INGEST_PIPELINE_DESTINATION`.
/// Defaults to `clickhouse` for backwards compatibility — existing deployments
/// that only set the ClickHouse vars get the old behavior.
fn parse_destination_from_env() -> Result<Destination, String> {
    let kind = std::env::var("INGEST_PIPELINE_DESTINATION")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "clickhouse".to_string());

    let timeout_ms = std::env::var("INGEST_PIPELINE_DESTINATION_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30_000);
    let timeout = Duration::from_millis(timeout_ms);

    match kind.as_str() {
        "clickhouse" => Ok(Destination::Clickhouse(ClickhouseConfig {
            endpoint: require_env("INGEST_PIPELINE_CLICKHOUSE_ENDPOINT")?,
            user: optional_env("INGEST_PIPELINE_CLICKHOUSE_USER"),
            password: optional_env("INGEST_PIPELINE_CLICKHOUSE_PASSWORD"),
            database: optional_env("INGEST_PIPELINE_CLICKHOUSE_DATABASE"),
            timeout,
        })),
        "tinybird" => Ok(Destination::Tinybird(TinybirdConfig {
            // Default host matches Tinybird's global API. Customers on a
            // regional workspace override with `api.us-east.tinybird.co`,
            // `api.eu-central-1.tinybird.co`, etc.
            host: std::env::var("INGEST_PIPELINE_TINYBIRD_HOST")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "https://api.tinybird.co".to_string()),
            token: require_env("INGEST_PIPELINE_TINYBIRD_TOKEN")?,
            timeout,
            // wait=false: HFI hot path. Flip to true via env only for
            // diagnostic / parity-diff jobs where you want synchronous
            // confirmation of ingest.
            wait: parse_bool_env("INGEST_PIPELINE_TINYBIRD_WAIT", false),
        })),
        other => Err(format!(
            "unknown INGEST_PIPELINE_DESTINATION {other:?} (expected \"clickhouse\" or \"tinybird\")"
        )),
    }
}

fn require_env(key: &str) -> Result<String, String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{key} is required when INGEST_PIPELINE_MODE is set"))
}

fn optional_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_bool_env(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

/// Pipeline orchestrator. One instance per process, shared via `Arc`. Holds
/// the destination writer (when enabled) and the resolved config.
///
/// Future stages — sampler, transformer, router, batcher — will be added as
/// fields on this struct in subsequent phases. Keeping the public surface
/// (`ingest_traces` etc.) stable means `main.rs` won't need to change shape
/// each phase.
pub struct Pipeline {
    cfg: PipelineConfig,
    writer: Option<Writer>,
}

impl Pipeline {
    /// Construct from a resolved config. Builds the destination writer
    /// eagerly so any builder errors surface at startup.
    pub fn new(cfg: PipelineConfig) -> Result<Arc<Self>, String> {
        let writer = match (&cfg.destination, cfg.mode.is_enabled()) {
            (Some(dest), true) => Some(
                Writer::from_destination(dest.clone())
                    .map_err(|e| format!("pipeline destination init: {e}"))?,
            ),
            _ => None,
        };
        Ok(Arc::new(Self { cfg, writer }))
    }

    pub fn mode(&self) -> PipelineMode {
        self.cfg.mode
    }

    /// Used by the startup log + future per-destination metrics; held off
    /// `dead_code` so a future caller addition doesn't require an API tweak.
    #[allow(dead_code)]
    pub fn destination_kind(&self) -> Option<&'static str> {
        self.writer.as_ref().map(Writer::kind)
    }

    /// Encode + write all spans in `request` to the configured traces
    /// stream. `org_id` is the resolved ingest-key org (always wins over any
    /// `maple_org_id` resource attribute, matching the Go exporter's default
    /// mode).
    ///
    /// In shadow mode this is a side-channel: the caller has already
    /// forwarded the same OTLP payload upstream, so any error here is logged
    /// + counted but does NOT propagate to the receiver response.
    pub async fn ingest_traces(&self, org_id: &str, request: &ExportTraceServiceRequest) {
        if !self.cfg.mode.is_enabled() {
            return;
        }
        let Some(writer) = &self.writer else {
            warn!("pipeline ingest_traces called without a destination writer");
            return;
        };

        let start = Instant::now();
        let rows = traces::encode_trace_rows(org_id, request);
        let row_count = rows.len();
        if rows.is_empty() {
            debug!(org_id, "pipeline traces: no rows");
            return;
        }

        let dest = writer.kind();
        match writer.write(&self.cfg.traces_stream, &rows).await {
            Ok(()) => {
                histogram!(
                    "pipeline_destination_request_seconds",
                    "signal" => "traces",
                    "destination" => dest,
                    "status" => "ok",
                )
                .record(start.elapsed().as_secs_f64());
                counter!(
                    "pipeline_rows_written_total",
                    "signal" => "traces",
                    "destination" => dest,
                    "org_id" => org_id.to_string(),
                )
                .increment(row_count as u64);
                debug!(
                    org_id,
                    rows = row_count,
                    elapsed_ms = start.elapsed().as_millis() as u64,
                    stream = %self.cfg.traces_stream,
                    mode = self.cfg.mode.as_str(),
                    destination = dest,
                    "pipeline traces written"
                );
            }
            Err(e) => {
                histogram!(
                    "pipeline_destination_request_seconds",
                    "signal" => "traces",
                    "destination" => dest,
                    "status" => "error",
                )
                .record(start.elapsed().as_secs_f64());
                counter!(
                    "pipeline_rows_dropped_total",
                    "signal" => "traces",
                    "destination" => dest,
                    "org_id" => org_id.to_string(),
                    "reason" => "destination_error",
                )
                .increment(row_count as u64);
                error!(
                    error = %e,
                    org_id,
                    rows = row_count,
                    stream = %self.cfg.traces_stream,
                    mode = self.cfg.mode.as_str(),
                    destination = dest,
                    "pipeline traces write failed"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parsing_is_lenient() {
        assert_eq!(PipelineMode::from_env_str(""), PipelineMode::Disabled);
        assert_eq!(PipelineMode::from_env_str("disabled"), PipelineMode::Disabled);
        assert_eq!(PipelineMode::from_env_str("Shadow"), PipelineMode::Shadow);
        assert_eq!(PipelineMode::from_env_str("PRIMARY"), PipelineMode::Primary);
        assert_eq!(PipelineMode::from_env_str("garbage"), PipelineMode::Disabled);
    }

    #[test]
    fn default_stream_depends_on_mode() {
        assert_eq!(default_traces_stream(PipelineMode::Shadow), "traces_shadow");
        assert_eq!(default_traces_stream(PipelineMode::Primary), "traces");
        assert_eq!(default_traces_stream(PipelineMode::Disabled), "traces");
    }
}
