use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::clickhouse_insert_mappings::{self, InsertMapping};
use crate::metrics;
use crc32fast::Hasher as Crc32;
use dashmap::DashMap;
use flate2::write::GzEncoder;
use flate2::Compression;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use opentelemetry_proto::tonic::metrics::v1::{
    metric, number_data_point, Exemplar, NumberDataPoint,
};
use opentelemetry_proto::tonic::trace::v1::{span, status, Span};
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::{error, info, warn};

const WAL_MAGIC: &[u8; 4] = b"MTW1";
const WAL_V1_HEADER_LEN: usize = 20;
const WAL_V2_HEADER_LEN: usize = 22;
const WAL_V3_HEADER_LEN: usize = 23;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ExportDestination {
    Tinybird,
    ClickHouse,
}

impl ExportDestination {
    /// Every export destination, in lane order. A frame's lane within its WAL
    /// shard is `shard * LANES_PER_SHARD + destination.lane_ordinal()`, so the
    /// position in this slice is load-bearing — do not reorder.
    pub const ALL: [ExportDestination; 2] = [Self::Tinybird, Self::ClickHouse];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tinybird => "tinybird",
            Self::ClickHouse => "clickhouse",
        }
    }

    /// Offset of this destination's lane within a shard. Must match `ALL`.
    fn lane_ordinal(self) -> usize {
        match self {
            Self::Tinybird => 0,
            Self::ClickHouse => 1,
        }
    }
}

/// Number of independent export lanes per WAL shard — one per destination. Each
/// lane has its own WAL file, cursor, bounded channel, and worker so a stalled
/// destination (e.g. a slow BYO-ClickHouse target) can only back-pressure its
/// own lane and never head-of-line-blocks a co-sharded org on the other
/// destination.
const LANES_PER_SHARD: usize = ExportDestination::ALL.len();

/// Flat lane index for `(shard, destination)`. Lanes are laid out shard-major:
/// `[shard0:tinybird, shard0:clickhouse, shard1:tinybird, ...]`.
fn lane_index(shard: usize, destination: ExportDestination) -> usize {
    shard * LANES_PER_SHARD + destination.lane_ordinal()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClickHouseTarget {
    pub endpoint: String,
    pub user: String,
    pub password: String,
    pub database: String,
}

#[async_trait::async_trait]
pub trait ClickHouseTargetProvider: Send + Sync {
    async fn resolve_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTarget>, String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClickHouseExportOutcome {
    Delivered,
    Dropped,
}

/// Tuning for the per-org ClickHouse circuit breaker.
#[derive(Clone, Copy, Debug)]
pub struct ClickHouseBreakerConfig {
    /// Consecutive export failures that trip the breaker into the open state.
    /// `0` disables the breaker entirely (every batch is allowed to run its
    /// full retry budget).
    pub failure_threshold: u32,
    /// How long the breaker stays open (fast-shedding batches) before it lets a
    /// single probe batch through to re-test the target.
    pub cooldown: Duration,
}

impl Default for ClickHouseBreakerConfig {
    fn default() -> Self {
        Self {
            // Trip after 2 consecutive failures (not 4) so a stalled BYO-ClickHouse
            // target enters fast-shed quickly, keeping the single-threaded lane
            // worker draining instead of holding batches through the retry budget
            // (which backs the bounded channel up into accept-path 503s).
            failure_threshold: 2,
            cooldown: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BreakerDecision {
    /// The target looks healthy enough to attempt an export.
    Allow,
    /// The target is in the open state; drop the batch immediately instead of
    /// holding the lane worker through the retry budget.
    Shed,
}

#[derive(Debug, Default)]
struct BreakerState {
    consecutive_failures: u32,
    /// When the breaker last tripped open. `None` while closed.
    opened_at: Option<Instant>,
}

/// Pure transition: should the next attempt run, given the current state? Kept
/// free of `Instant::now()` so the state machine is unit-testable with a
/// synthetic clock.
fn breaker_decision(
    state: &BreakerState,
    cfg: ClickHouseBreakerConfig,
    now: Instant,
) -> BreakerDecision {
    match state.opened_at {
        // Still within the cooldown window → keep shedding.
        Some(opened) if now.duration_since(opened) < cfg.cooldown => BreakerDecision::Shed,
        // Closed, or cooldown elapsed (half-open) → allow. Note half-open is not
        // single-probe gated: while cooldown is elapsed, every batch that checks
        // is allowed, so several lane workers can probe a recovering target
        // concurrently until one records on_success/on_failure. Harmless here —
        // the extra probes just re-confirm health or re-open the breaker.
        _ => BreakerDecision::Allow,
    }
}

/// Per-org ClickHouse circuit breakers. An org's CH frames may span several
/// shards (traces shard by trace id), so breaker state is shared across all
/// lane workers rather than living inside one worker — the first worker to
/// observe an unhealthy target trips it for the rest.
struct ClickHouseBreakerRegistry {
    cfg: ClickHouseBreakerConfig,
    states: DashMap<String, Arc<Mutex<BreakerState>>>,
}

impl ClickHouseBreakerRegistry {
    fn new(cfg: ClickHouseBreakerConfig) -> Self {
        Self {
            cfg,
            states: DashMap::new(),
        }
    }

    fn enabled(&self) -> bool {
        self.cfg.failure_threshold > 0
    }

    fn state_for(&self, org_id: &str) -> Arc<Mutex<BreakerState>> {
        self.states
            .entry(org_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(BreakerState::default())))
            .clone()
    }

    /// Decide whether to attempt an export for `org_id`. Read-only: never
    /// allocates breaker state for an org that has only ever succeeded.
    fn decide(&self, org_id: &str, now: Instant) -> BreakerDecision {
        if !self.enabled() {
            return BreakerDecision::Allow;
        }
        let Some(state) = self.states.get(org_id) else {
            return BreakerDecision::Allow;
        };
        let guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
        breaker_decision(&guard, self.cfg, now)
    }

    fn on_success(&self, org_id: &str) {
        if !self.enabled() {
            return;
        }
        if let Some(state) = self.states.get(org_id) {
            let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
            guard.consecutive_failures = 0;
            guard.opened_at = None;
        }
    }

    fn on_failure(&self, org_id: &str, now: Instant) {
        if !self.enabled() {
            return;
        }
        let state = self.state_for(org_id);
        let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.consecutive_failures = guard.consecutive_failures.saturating_add(1);
        if guard.consecutive_failures >= self.cfg.failure_threshold {
            guard.opened_at = Some(now);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TelemetrySignal {
    Traces,
    Logs,
    Metrics,
    /// Session-replay metadata + rrweb event chunks (NDJSON written directly by
    /// the ingest gateway, not derived from OTLP). Events land in ClickHouse.
    SessionReplays,
    /// Distilled session-event rows (NDJSON written directly by the gateway).
    /// Carried separately from `SessionReplays` so per-signal metrics label it
    /// as `session_events` (matching its `maple.signal` span attribute).
    SessionEvents,
}

impl TelemetrySignal {
    /// Canonical lowercase label for metric/log dimensions, matching the HTTP
    /// `Signal::path()` vocabulary ("traces"/"logs"/"metrics") and the
    /// `maple.signal` span attribute ("session_replays"/"session_events") so
    /// per-signal metrics correlate across the codebase. Prefer this over the
    /// `Debug` derive, which yields PascalCase.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Traces => "traces",
            Self::Logs => "logs",
            Self::Metrics => "metrics",
            Self::SessionReplays => "session_replays",
            Self::SessionEvents => "session_events",
        }
    }
}

/// Datasource (ClickHouse/Tinybird table) names the OTLP→NDJSON encoders write
/// to. This is the entire config surface the encoders depend on — kept separate
/// so the local chDB path can encode without fabricating a full pipeline config.
/// Session-replay datasources live on `TinybirdConfig`, not here: they're written
/// by the gateway's direct NDJSON path, not derived from OTLP.
#[derive(Clone, Debug)]
pub struct DatasourceNames {
    pub traces: String,
    pub logs: String,
    pub metrics_sum: String,
    pub metrics_gauge: String,
    pub metrics_histogram: String,
    pub metrics_exponential_histogram: String,
}

impl DatasourceNames {
    /// Canonical datasource names (match the deployed Tinybird datasources and
    /// the embedded chDB schema). Single source of truth for local + tests.
    pub fn defaults() -> Self {
        Self {
            traces: "traces".into(),
            logs: "logs".into(),
            metrics_sum: "metrics_sum".into(),
            metrics_gauge: "metrics_gauge".into(),
            metrics_histogram: "metrics_histogram".into(),
            metrics_exponential_histogram: "metrics_exponential_histogram".into(),
        }
    }

    /// Read overrides from `INGEST_TINYBIRD_DATASOURCE_*`, falling back to defaults.
    pub fn from_env() -> Self {
        let d = Self::defaults();
        Self {
            traces: std::env::var("INGEST_TINYBIRD_DATASOURCE_TRACES").unwrap_or(d.traces),
            logs: std::env::var("INGEST_TINYBIRD_DATASOURCE_LOGS").unwrap_or(d.logs),
            metrics_sum: std::env::var("INGEST_TINYBIRD_DATASOURCE_METRICS_SUM")
                .unwrap_or(d.metrics_sum),
            metrics_gauge: std::env::var("INGEST_TINYBIRD_DATASOURCE_METRICS_GAUGE")
                .unwrap_or(d.metrics_gauge),
            metrics_histogram: std::env::var("INGEST_TINYBIRD_DATASOURCE_METRICS_HISTOGRAM")
                .unwrap_or(d.metrics_histogram),
            metrics_exponential_histogram: std::env::var(
                "INGEST_TINYBIRD_DATASOURCE_METRICS_EXPONENTIAL_HISTOGRAM",
            )
            .unwrap_or(d.metrics_exponential_histogram),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TinybirdConfig {
    pub endpoint: String,
    pub token: String,
    pub queue_dir: PathBuf,
    pub queue_max_bytes: u64,
    pub org_queue_max_bytes: u64,
    pub queue_channel_capacity: usize,
    pub wal_shards: usize,
    pub batch_max_rows: usize,
    pub batch_max_bytes: usize,
    pub batch_max_wait: Duration,
    pub export_concurrency_per_shard: usize,
    pub export_max_attempts: u32,
    /// Per-attempt timeout for a direct ClickHouse export POST. Kept short and
    /// separate from `forward_timeout` so a hanging BYO-ClickHouse target fails
    /// fast and the breaker trips quickly — otherwise the single-threaded lane
    /// worker holds the batch through the retry budget while new frames back the
    /// bounded channel up into accept-path backpressure.
    pub clickhouse_export_timeout: Duration,
    pub clickhouse_breaker: ClickHouseBreakerConfig,
    pub datasources: DatasourceNames,
    pub datasource_session_replays: String,
    pub datasource_session_replay_events: String,
    pub datasource_session_events: String,
}

impl TinybirdConfig {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_for_pipeline(true)
    }

    pub fn validate_for_pipeline(&self, require_tinybird_credentials: bool) -> Result<(), String> {
        if self.endpoint.is_empty() {
            if require_tinybird_credentials {
                return Err(
                    "TINYBIRD_HOST is required when INGEST_WRITE_MODE uses tinybird".to_string(),
                );
            }
        }
        if self.token.is_empty() {
            if require_tinybird_credentials {
                return Err(
                    "TINYBIRD_TOKEN is required when INGEST_WRITE_MODE uses tinybird".to_string(),
                );
            }
        }
        if self.wal_shards == 0 {
            return Err("INGEST_WAL_SHARDS must be greater than 0".to_string());
        }
        if self.batch_max_rows == 0 || self.batch_max_bytes == 0 {
            return Err(
                "INGEST_BATCH_MAX_ROWS and INGEST_BATCH_MAX_BYTES must be greater than 0"
                    .to_string(),
            );
        }
        if self.queue_max_bytes == 0 {
            return Err("INGEST_QUEUE_MAX_BYTES must be greater than 0".to_string());
        }
        if self.org_queue_max_bytes == 0 {
            return Err("INGEST_ORG_QUEUE_MAX_BYTES must be greater than 0".to_string());
        }
        if self.export_concurrency_per_shard == 0 {
            return Err("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD must be greater than 0".to_string());
        }
        if self.export_max_attempts == 0 {
            return Err("INGEST_EXPORT_MAX_ATTEMPTS must be greater than 0".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct SamplingPolicy {
    pub trace_sample_ratio: f64,
    pub always_keep_error_spans: bool,
    pub always_keep_slow_spans_ms: Option<u64>,
}

impl Default for SamplingPolicy {
    fn default() -> Self {
        Self {
            trace_sample_ratio: 1.0,
            always_keep_error_spans: true,
            always_keep_slow_spans_ms: None,
        }
    }
}

impl SamplingPolicy {
    fn clamped_ratio(&self) -> f64 {
        if !self.trace_sample_ratio.is_finite() {
            return 1.0;
        }
        self.trace_sample_ratio.clamp(0.000001, 1.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MappingSourceContext {
    Span,
    Resource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MappingOperation {
    Move,
    Copy,
}

/// One org-configured attribute remapping rule. The target is always a span
/// attribute; `source_context` selects whether the value is read from the
/// span's own attributes or from its resource attributes.
#[derive(Clone, Debug)]
pub struct AttributeMappingRule {
    pub source_context: MappingSourceContext,
    pub source_key: String,
    pub target_key: String,
    pub operation: MappingOperation,
}

/// Rewrites a single span's attribute map per the org's mapping rules. Rules
/// apply in order; an existing target key is never overwritten so customer-set
/// values win. `Move` deletes the source only when the source is a span
/// attribute — a resource attribute is shared across every span in the batch,
/// so deleting it per-span is ill-defined and is treated as `Copy`.
fn apply_attribute_mappings(
    rules: &[AttributeMappingRule],
    resource_attrs: &Map<String, Value>,
    span_attrs: &mut Map<String, Value>,
) {
    for rule in rules {
        if span_attrs.contains_key(&rule.target_key) {
            continue;
        }
        match rule.source_context {
            MappingSourceContext::Span => {
                let Some(value) = span_attrs.get(&rule.source_key).cloned() else {
                    continue;
                };
                span_attrs.insert(rule.target_key.clone(), value);
                if rule.operation == MappingOperation::Move {
                    span_attrs.remove(&rule.source_key);
                }
            }
            MappingSourceContext::Resource => {
                if let Some(value) = resource_attrs.get(&rule.source_key) {
                    span_attrs.insert(rule.target_key.clone(), value.clone());
                }
            }
        }
    }
}

#[derive(Debug)]
pub enum PipelineError {
    Backpressure(&'static str),
    Throttled(&'static str),
    QueueUnavailable(String),
    Encode(String),
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Backpressure(message) => f.write_str(message),
            Self::Throttled(message) => f.write_str(message),
            Self::QueueUnavailable(message) => f.write_str(message),
            Self::Encode(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for PipelineError {}

#[derive(Clone, Debug, Default)]
pub struct AcceptStats {
    pub rows: usize,
    pub dropped: usize,
}

#[derive(Clone)]
pub struct TelemetryPipeline {
    inner: Arc<PipelineInner>,
}

struct PipelineInner {
    cfg: Arc<TinybirdConfig>,
    wal: Arc<ShardedWal>,
    /// One bounded channel per lane (`shard × destination`), indexed by
    /// `lane_index`. A full ClickHouse lane can no longer back-pressure the
    /// co-sharded Tinybird lane.
    lane_senders: Vec<mpsc::Sender<QueuedFrame>>,
    org_queue_bytes: Arc<DashMap<String, Arc<AtomicU64>>>,
}

#[derive(Clone, Debug)]
struct QueuedFrame {
    /// WAL shard the frame routed to (for metric labelling). The lane it belongs
    /// to is implied by the worker draining it (one worker per lane).
    shard: usize,
    start: u64,
    end: u64,
    org_id: String,
    queued_bytes: u64,
    signal: TelemetrySignal,
    destination: ExportDestination,
    datasource: String,
    row_count: usize,
    payload: Vec<u8>,
}

#[derive(Debug)]
struct EncodedFrame {
    routing_key: u64,
    org_id: String,
    signal: TelemetrySignal,
    destination: ExportDestination,
    datasource: String,
    row_count: usize,
    payload: Vec<u8>,
}

impl TelemetryPipeline {
    pub async fn new(cfg: TinybirdConfig, http: Client) -> Result<Self, String> {
        Self::new_with_clickhouse(cfg, http, None).await
    }

    pub async fn new_with_clickhouse(
        cfg: TinybirdConfig,
        http: Client,
        clickhouse_targets: Option<Arc<dyn ClickHouseTargetProvider>>,
    ) -> Result<Self, String> {
        Self::new_with_clickhouse_validation(cfg, http, clickhouse_targets, true).await
    }

    pub async fn new_with_clickhouse_validation(
        cfg: TinybirdConfig,
        http: Client,
        clickhouse_targets: Option<Arc<dyn ClickHouseTargetProvider>>,
        require_tinybird_credentials: bool,
    ) -> Result<Self, String> {
        cfg.validate_for_pipeline(require_tinybird_credentials)?;
        std::fs::create_dir_all(&cfg.queue_dir)
            .map_err(|error| format!("create ingest WAL dir: {error}"))?;
        let cfg = Arc::new(cfg);
        let wal = Arc::new(ShardedWal::open(&cfg)?);
        // Relocate any single-file-per-shard WAL left by a pre-lanes binary into
        // the new per-destination lanes before workers start draining them.
        wal.migrate_legacy_shards(&cfg).await;
        let org_queue_bytes = Arc::new(DashMap::new());
        let clickhouse_breakers = Arc::new(ClickHouseBreakerRegistry::new(cfg.clickhouse_breaker));
        let mut lane_senders = Vec::with_capacity(cfg.wal_shards * LANES_PER_SHARD);

        for shard in 0..cfg.wal_shards {
            for destination in ExportDestination::ALL {
                let (sender, receiver) = mpsc::channel(cfg.queue_channel_capacity);
                debug_assert_eq!(lane_senders.len(), lane_index(shard, destination));
                lane_senders.push(sender);
                let worker = ExportWorker {
                    lane: lane_index(shard, destination),
                    shard,
                    destination,
                    cfg: Arc::clone(&cfg),
                    wal: Arc::clone(&wal),
                    org_queue_bytes: Arc::clone(&org_queue_bytes),
                    clickhouse_breakers: Arc::clone(&clickhouse_breakers),
                    clickhouse_targets: clickhouse_targets.clone(),
                    http: http.clone(),
                    receiver,
                };
                tokio::spawn(worker.run());
            }
        }

        let pipeline = Self {
            inner: Arc::new(PipelineInner {
                cfg,
                wal,
                lane_senders,
                org_queue_bytes,
            }),
        };
        pipeline.replay_committed_frames().await;
        Ok(pipeline)
    }

    pub async fn accept_traces(
        &self,
        org_id: &str,
        request: &ExportTraceServiceRequest,
        sampling_policy: &SamplingPolicy,
        attribute_mappings: &[AttributeMappingRule],
    ) -> Result<AcceptStats, PipelineError> {
        self.accept_traces_to(
            org_id,
            request,
            sampling_policy,
            attribute_mappings,
            ExportDestination::Tinybird,
        )
        .await
    }

    pub async fn accept_traces_to(
        &self,
        org_id: &str,
        request: &ExportTraceServiceRequest,
        sampling_policy: &SamplingPolicy,
        attribute_mappings: &[AttributeMappingRule],
        destination: ExportDestination,
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_traces(
            &self.inner.cfg.datasources,
            org_id,
            request,
            sampling_policy,
            attribute_mappings,
        )?;
        self.commit_frames(frames, destination).await?;
        Ok(stats)
    }

    pub async fn accept_logs(
        &self,
        org_id: &str,
        request: &ExportLogsServiceRequest,
    ) -> Result<AcceptStats, PipelineError> {
        self.accept_logs_to(org_id, request, ExportDestination::Tinybird)
            .await
    }

    pub async fn accept_logs_to(
        &self,
        org_id: &str,
        request: &ExportLogsServiceRequest,
        destination: ExportDestination,
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_logs(&self.inner.cfg.datasources, org_id, request)?;
        self.commit_frames(frames, destination).await?;
        Ok(stats)
    }

    pub async fn accept_metrics(
        &self,
        org_id: &str,
        request: &ExportMetricsServiceRequest,
    ) -> Result<AcceptStats, PipelineError> {
        self.accept_metrics_to(org_id, request, ExportDestination::Tinybird)
            .await
    }

    pub async fn accept_metrics_to(
        &self,
        org_id: &str,
        request: &ExportMetricsServiceRequest,
        destination: ExportDestination,
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_metrics(&self.inner.cfg.datasources, org_id, request)?;
        self.commit_frames(frames, destination).await?;
        Ok(stats)
    }

    /// Accept pre-serialized NDJSON rows for an arbitrary datasource. Used by
    /// the session-replay ingest path, whose rows are built directly by the
    /// gateway (not derived from OTLP). Routes by org so a session's metadata
    /// and chunk-index rows land on the same shard in order.
    pub async fn accept_rows(
        &self,
        org_id: &str,
        datasource: String,
        rows: Vec<Vec<u8>>,
        signal: TelemetrySignal,
    ) -> Result<AcceptStats, PipelineError> {
        self.accept_rows_to(org_id, datasource, rows, signal, ExportDestination::Tinybird)
            .await
    }

    pub async fn accept_rows_to(
        &self,
        org_id: &str,
        datasource: String,
        rows: Vec<Vec<u8>>,
        signal: TelemetrySignal,
        destination: ExportDestination,
    ) -> Result<AcceptStats, PipelineError> {
        let stats = AcceptStats {
            rows: rows.len(),
            dropped: 0,
        };
        let frames = rows_to_frames(org_id, hash64(org_id), signal, datasource, rows);
        self.commit_frames(frames, destination).await?;
        Ok(stats)
    }

    async fn commit_frames(
        &self,
        frames: Vec<EncodedFrame>,
        destination: ExportDestination,
    ) -> Result<(), PipelineError> {
        if frames.is_empty() {
            return Ok(());
        }

        for mut frame in frames {
            frame.destination = destination;
            let shard = (frame.routing_key as usize) % self.inner.cfg.wal_shards;
            // Route to the destination's own lane so a stalled ClickHouse export
            // cannot fill the Tinybird channel for the same shard (and vice versa).
            let lane = lane_index(shard, destination);
            let sender = self.inner.lane_senders[lane].clone();
            let permit = match sender.try_reserve_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    metrics::backpressure_shed(
                        &frame.org_id,
                        frame.destination.as_str(),
                        frame.signal.as_str(),
                    );
                    return Err(PipelineError::Backpressure("Telemetry queue is full"));
                }
            };
            let queued_bytes = frame.payload.len() as u64;
            self.reserve_org_queue_bytes(&frame.org_id, queued_bytes)?;
            let (start, end) = self.inner.wal.append(lane, &frame).await.map_err(|error| {
                self.release_org_queue_bytes(&frame.org_id, queued_bytes);
                PipelineError::QueueUnavailable(error)
            })?;
            permit.send(QueuedFrame {
                shard,
                start,
                end,
                org_id: frame.org_id,
                queued_bytes,
                signal: frame.signal,
                destination: frame.destination,
                datasource: frame.datasource,
                row_count: frame.row_count,
                payload: frame.payload,
            });
        }

        Ok(())
    }

    fn reserve_org_queue_bytes(&self, org_id: &str, bytes: u64) -> Result<(), PipelineError> {
        if org_id.is_empty() || bytes == 0 {
            return Ok(());
        }

        let counter = self
            .inner
            .org_queue_bytes
            .entry(org_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        loop {
            let current = counter.load(Ordering::Relaxed);
            if current.saturating_add(bytes) > self.inner.cfg.org_queue_max_bytes {
                metrics::org_throttled(org_id, "queue_bytes");
                return Err(PipelineError::Throttled(
                    "Telemetry org queue byte limit exceeded",
                ));
            }
            if counter
                .compare_exchange(
                    current,
                    current + bytes,
                    Ordering::AcqRel,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                metrics::org_queue_bytes(org_id, current + bytes);
                return Ok(());
            }
        }
    }

    fn release_org_queue_bytes(&self, org_id: &str, bytes: u64) {
        release_org_queue_bytes(&self.inner.org_queue_bytes, org_id, bytes);
    }

    async fn replay_committed_frames(&self) {
        for lane in 0..self.inner.lane_senders.len() {
            let frames = match self.inner.wal.replay(lane).await {
                Ok(frames) => frames,
                Err(error) => {
                    error!(lane, error = %error, "Failed to replay ingest WAL lane");
                    continue;
                }
            };
            if frames.is_empty() {
                continue;
            }
            info!(
                lane,
                frames = frames.len(),
                "Replaying committed ingest WAL frames"
            );
            for frame in frames {
                add_org_queue_bytes(
                    &self.inner.org_queue_bytes,
                    &frame.org_id,
                    frame.queued_bytes,
                );
                if self.inner.lane_senders[lane].send(frame).await.is_err() {
                    error!(lane, "Ingest WAL replay worker stopped");
                    break;
                }
            }
        }
    }
}

struct ShardedWal {
    /// One WAL file per lane (`shard × destination`), indexed by `lane_index`.
    lanes: Vec<Arc<WalShard>>,
}

struct WalShard {
    /// Real shard this lane belongs to, and its destination — carried so WAL
    /// metrics stay labelled by `(shard, destination)` rather than leaking the
    /// flat lane index as a `shard`.
    shard: usize,
    destination: ExportDestination,
    path: PathBuf,
    cursor_path: PathBuf,
    max_bytes: u64,
    file: Mutex<File>,
}

impl ShardedWal {
    fn open(cfg: &TinybirdConfig) -> Result<Self, String> {
        let num_lanes = cfg.wal_shards * LANES_PER_SHARD;
        let mut lanes = Vec::with_capacity(num_lanes);
        let max_bytes_per_lane = (cfg.queue_max_bytes / num_lanes as u64).max(1);
        for shard in 0..cfg.wal_shards {
            for destination in ExportDestination::ALL {
                let dest = destination.as_str();
                let path = cfg.queue_dir.join(format!("shard-{shard:03}-{dest}.wal"));
                let cursor_path = cfg.queue_dir.join(format!("shard-{shard:03}-{dest}.cursor"));
                let file = OpenOptions::new()
                    .create(true)
                    .read(true)
                    .append(true)
                    .open(&path)
                    .map_err(|error| format!("open ingest WAL {path:?}: {error}"))?;
                debug_assert_eq!(lanes.len(), lane_index(shard, destination));
                lanes.push(Arc::new(WalShard {
                    shard,
                    destination,
                    path,
                    cursor_path,
                    max_bytes: max_bytes_per_lane,
                    file: Mutex::new(file),
                }));
            }
        }
        Ok(Self { lanes })
    }

    /// Migrate any pre-lanes WAL (a single `shard-NNN.wal` per shard, mixing both
    /// destinations) into the per-destination lane files. Each surviving frame is
    /// durably re-appended to its destination's lane, then the legacy file + cursor
    /// are removed. Best-effort: a failed shard is logged and left in place so the
    /// next boot retries it — startup never wedges and no frame is dropped.
    async fn migrate_legacy_shards(&self, cfg: &TinybirdConfig) {
        for shard in 0..cfg.wal_shards {
            let legacy_path = cfg.queue_dir.join(format!("shard-{shard:03}.wal"));
            let legacy_cursor = cfg.queue_dir.join(format!("shard-{shard:03}.cursor"));
            if !legacy_path.exists() {
                continue;
            }
            let read_path = legacy_path.clone();
            let read_cursor = legacy_cursor.clone();
            let frames =
                match tokio::task::spawn_blocking(move || read_legacy_frames(&read_path, &read_cursor))
                    .await
                {
                    Ok(Ok(frames)) => frames,
                    Ok(Err(error)) => {
                        warn!(shard, error = %error, "Skipping unreadable legacy ingest WAL shard");
                        continue;
                    }
                    Err(error) => {
                        warn!(shard, error = %error, "Failed to read legacy ingest WAL shard");
                        continue;
                    }
                };
            let count = frames.len();
            let mut migrated = true;
            for frame in frames {
                let lane = lane_index(shard, frame.destination);
                let encoded = EncodedFrame {
                    routing_key: 0, // unused by append; the frame stays in `shard`
                    org_id: frame.org_id,
                    signal: frame.signal,
                    destination: frame.destination,
                    datasource: frame.datasource,
                    row_count: frame.row_count,
                    payload: frame.payload,
                };
                // Bypass the per-lane byte cap: these frames were already accepted
                // and are merely being relocated, so we must not reject them.
                if let Err(error) = self.append_inner(lane, &encoded, false).await {
                    warn!(shard, error = %error, "Failed to migrate legacy ingest WAL frame; will retry next boot");
                    migrated = false;
                    break;
                }
            }
            if migrated {
                let _ = std::fs::remove_file(&legacy_path);
                let _ = std::fs::remove_file(&legacy_cursor);
                if count > 0 {
                    info!(
                        shard,
                        frames = count,
                        "Migrated legacy ingest WAL shard into per-destination lanes"
                    );
                }
            }
        }
    }

    async fn append(&self, lane: usize, frame: &EncodedFrame) -> Result<(u64, u64), String> {
        self.append_inner(lane, frame, true).await
    }

    async fn append_inner(
        &self,
        lane: usize,
        frame: &EncodedFrame,
        enforce_cap: bool,
    ) -> Result<(u64, u64), String> {
        let lane_ref = Arc::clone(
            self.lanes
                .get(lane)
                .ok_or_else(|| format!("invalid WAL lane {lane}"))?,
        );
        let encoded = encode_wal_frame(frame)?;
        tokio::task::spawn_blocking(move || {
            let mut file = lane_ref
                .file
                .lock()
                .map_err(|_| "WAL lane mutex poisoned".to_string())?;
            let start = file
                .seek(SeekFrom::End(0))
                .map_err(|error| format!("seek WAL: {error}"))?;
            if enforce_cap && start.saturating_add(encoded.len() as u64) > lane_ref.max_bytes {
                metrics::wal_shard_full(lane_ref.shard, lane_ref.destination.as_str());
                return Err("Telemetry WAL lane is full".to_string());
            }
            file.write_all(&encoded)
                .map_err(|error| format!("write WAL: {error}"))?;
            file.sync_data()
                .map_err(|error| format!("sync WAL: {error}"))?;
            let end = start + encoded.len() as u64;
            metrics::wal_commit_bytes(
                lane_ref.shard,
                lane_ref.destination.as_str(),
                encoded.len() as u64,
            );
            metrics::wal_shard_bytes(lane_ref.shard, lane_ref.destination.as_str(), end);
            Ok((start, end))
        })
        .await
        .map_err(|error| format!("join WAL append: {error}"))?
    }

    async fn replay(&self, lane: usize) -> Result<Vec<QueuedFrame>, String> {
        let lane_ref = Arc::clone(
            self.lanes
                .get(lane)
                .ok_or_else(|| format!("invalid WAL lane {lane}"))?,
        );
        tokio::task::spawn_blocking(move || replay_shard(lane, &lane_ref))
            .await
            .map_err(|error| format!("join WAL replay: {error}"))?
    }

    async fn mark_exported(&self, lane: usize, offset: u64) -> Result<(), String> {
        let shard_ref = Arc::clone(
            self.lanes
                .get(lane)
                .ok_or_else(|| format!("invalid WAL lane {lane}"))?,
        );
        tokio::task::spawn_blocking(move || {
            // If the cursor has caught up to the end of the shard file, free the disk
            // by truncating the file and resetting the cursor to 0. Holding the
            // append-side mutex serialises us against concurrent appenders so we
            // never truncate bytes that a writer just committed.
            let cursor_value = {
                let mut file = shard_ref
                    .file
                    .lock()
                    .map_err(|_| "WAL shard mutex poisoned".to_string())?;
                let size = file
                    .seek(SeekFrom::End(0))
                    .map_err(|error| format!("seek WAL: {error}"))?;
                if offset >= size {
                    file.set_len(0)
                        .map_err(|error| format!("truncate WAL: {error}"))?;
                    file.sync_all()
                        .map_err(|error| format!("sync WAL truncate: {error}"))?;
                    metrics::wal_shard_bytes(shard_ref.shard, shard_ref.destination.as_str(), 0);
                    0
                } else {
                    offset
                }
            };
            let mut cursor_file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&shard_ref.cursor_path)
                .map_err(|error| format!("open WAL cursor: {error}"))?;
            cursor_file
                .write_all(cursor_value.to_string().as_bytes())
                .map_err(|error| format!("write WAL cursor: {error}"))?;
            cursor_file
                .sync_data()
                .map_err(|error| format!("sync WAL cursor: {error}"))
        })
        .await
        .map_err(|error| format!("join WAL cursor: {error}"))?
    }
}

fn read_cursor(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

fn replay_shard(lane: usize, lane_ref: &WalShard) -> Result<Vec<QueuedFrame>, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(&lane_ref.path)
        .map_err(|error| format!("open WAL replay: {error}"))?;
    let mut offset = read_cursor(&lane_ref.cursor_path);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek WAL replay: {error}"))?;

    let shard = lane / LANES_PER_SHARD;
    let mut frames = Vec::new();
    loop {
        let start = offset;
        let Some(frame) = read_wal_frame(&mut file, start)? else {
            break;
        };
        frames.push(QueuedFrame {
            shard,
            start,
            end: frame.end,
            org_id: frame.org_id,
            queued_bytes: frame.payload.len() as u64,
            signal: frame.signal,
            destination: frame.destination,
            datasource: frame.datasource,
            row_count: frame.row_count,
            payload: frame.payload,
        });
        offset = frame.end;
    }
    Ok(frames)
}

/// Read every surviving frame from a legacy single-file-per-shard WAL, starting
/// at its persisted cursor. Returns an empty vec if the file is absent. Used by
/// `migrate_legacy_shards` to relocate frames into the per-destination lanes.
fn read_legacy_frames(path: &Path, cursor_path: &Path) -> Result<Vec<DecodedWalFrame>, String> {
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("open legacy WAL: {error}")),
    };
    let mut offset = read_cursor(cursor_path);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek legacy WAL: {error}"))?;
    let mut frames = Vec::new();
    loop {
        let start = offset;
        let Some(frame) = read_wal_frame(&mut file, start)? else {
            break;
        };
        offset = frame.end;
        frames.push(frame);
    }
    Ok(frames)
}

fn encode_wal_frame(frame: &EncodedFrame) -> Result<Vec<u8>, String> {
    let datasource = frame.datasource.as_bytes();
    let org_id = frame.org_id.as_bytes();
    if datasource.len() > u16::MAX as usize {
        return Err("datasource name too long".to_string());
    }
    if org_id.len() > u16::MAX as usize {
        return Err("org id too long".to_string());
    }
    if frame.payload.len() > u32::MAX as usize {
        return Err("WAL payload too large".to_string());
    }
    let mut crc = Crc32::new();
    crc.update(&[signal_tag(frame.signal)]);
    crc.update(&[destination_tag(frame.destination)]);
    crc.update(org_id);
    crc.update(datasource);
    crc.update(&frame.payload);
    let checksum = crc.finalize();

    let mut out = Vec::with_capacity(
        WAL_V3_HEADER_LEN + org_id.len() + datasource.len() + frame.payload.len(),
    );
    out.extend_from_slice(WAL_MAGIC);
    out.push(3);
    out.push(signal_tag(frame.signal));
    out.push(destination_tag(frame.destination));
    out.extend_from_slice(&(datasource.len() as u16).to_le_bytes());
    out.extend_from_slice(&(org_id.len() as u16).to_le_bytes());
    out.extend_from_slice(&(frame.payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&(frame.row_count as u32).to_le_bytes());
    out.extend_from_slice(&checksum.to_le_bytes());
    out.extend_from_slice(org_id);
    out.extend_from_slice(datasource);
    out.extend_from_slice(&frame.payload);
    Ok(out)
}

struct DecodedWalFrame {
    end: u64,
    org_id: String,
    signal: TelemetrySignal,
    destination: ExportDestination,
    datasource: String,
    row_count: usize,
    payload: Vec<u8>,
}

fn read_wal_frame(file: &mut File, start: u64) -> Result<Option<DecodedWalFrame>, String> {
    let mut prefix = [0u8; 6];
    let read = file
        .read(&mut prefix)
        .map_err(|error| format!("read WAL header: {error}"))?;
    if read == 0 {
        return Ok(None);
    }
    if read < prefix.len() {
        warn!(offset = start, "Ignoring partial WAL header");
        return Ok(None);
    }
    if &prefix[0..4] != WAL_MAGIC {
        return Err(format!("invalid WAL magic at offset {start}"));
    }
    let version = prefix[4];
    let signal = signal_from_tag(prefix[5])
        .ok_or_else(|| format!("invalid WAL signal tag {} at offset {start}", prefix[5]))?;

    let (destination, org_id_len, datasource_len, payload_len, row_count, checksum, header_len) =
        match version {
            1 => {
                let mut rest = [0u8; WAL_V1_HEADER_LEN - 6];
                file.read_exact(&mut rest)
                    .map_err(|error| format!("read WAL v1 header: {error}"))?;
                (
                    ExportDestination::Tinybird,
                    0usize,
                    u16::from_le_bytes([rest[0], rest[1]]) as usize,
                    u32::from_le_bytes([rest[2], rest[3], rest[4], rest[5]]) as usize,
                    u32::from_le_bytes([rest[6], rest[7], rest[8], rest[9]]) as usize,
                    u32::from_le_bytes([rest[10], rest[11], rest[12], rest[13]]),
                    WAL_V1_HEADER_LEN,
                )
            }
            2 => {
                let mut rest = [0u8; WAL_V2_HEADER_LEN - 6];
                file.read_exact(&mut rest)
                    .map_err(|error| format!("read WAL v2 header: {error}"))?;
                (
                    ExportDestination::Tinybird,
                    u16::from_le_bytes([rest[2], rest[3]]) as usize,
                    u16::from_le_bytes([rest[0], rest[1]]) as usize,
                    u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize,
                    u32::from_le_bytes([rest[8], rest[9], rest[10], rest[11]]) as usize,
                    u32::from_le_bytes([rest[12], rest[13], rest[14], rest[15]]),
                    WAL_V2_HEADER_LEN,
                )
            }
            3 => {
                let mut rest = [0u8; WAL_V3_HEADER_LEN - 6];
                file.read_exact(&mut rest)
                    .map_err(|error| format!("read WAL v3 header: {error}"))?;
                let destination = destination_from_tag(rest[0]).ok_or_else(|| {
                    format!("invalid WAL destination tag {} at offset {start}", rest[0])
                })?;
                (
                    destination,
                    u16::from_le_bytes([rest[3], rest[4]]) as usize,
                    u16::from_le_bytes([rest[1], rest[2]]) as usize,
                    u32::from_le_bytes([rest[5], rest[6], rest[7], rest[8]]) as usize,
                    u32::from_le_bytes([rest[9], rest[10], rest[11], rest[12]]) as usize,
                    u32::from_le_bytes([rest[13], rest[14], rest[15], rest[16]]),
                    WAL_V3_HEADER_LEN,
                )
            }
            _ => {
                return Err(format!(
                    "unsupported WAL version {version} at offset {start}"
                ))
            }
        };

    let mut org_id = vec![0u8; org_id_len];
    if org_id_len > 0 {
        file.read_exact(&mut org_id)
            .map_err(|error| format!("read WAL org id: {error}"))?;
    }

    let mut datasource = vec![0u8; datasource_len];
    file.read_exact(&mut datasource)
        .map_err(|error| format!("read WAL datasource: {error}"))?;
    let mut payload = vec![0u8; payload_len];
    file.read_exact(&mut payload)
        .map_err(|error| format!("read WAL payload: {error}"))?;

    let mut crc = Crc32::new();
    crc.update(&[signal_tag(signal)]);
    if version >= 3 {
        crc.update(&[destination_tag(destination)]);
    }
    if version >= 2 {
        crc.update(&org_id);
    }
    crc.update(&datasource);
    crc.update(&payload);
    if crc.finalize() != checksum {
        return Err(format!("WAL checksum mismatch at offset {start}"));
    }

    let org_id =
        String::from_utf8(org_id).map_err(|error| format!("WAL org id utf8 error: {error}"))?;
    let datasource = String::from_utf8(datasource)
        .map_err(|error| format!("WAL datasource utf8 error: {error}"))?;
    let end =
        start + header_len as u64 + org_id_len as u64 + datasource_len as u64 + payload_len as u64;
    Ok(Some(DecodedWalFrame {
        end,
        org_id,
        signal,
        destination,
        datasource,
        row_count: row_count.max(1),
        payload,
    }))
}

fn signal_tag(signal: TelemetrySignal) -> u8 {
    match signal {
        TelemetrySignal::Traces => 1,
        TelemetrySignal::Logs => 2,
        TelemetrySignal::Metrics => 3,
        TelemetrySignal::SessionReplays => 4,
        TelemetrySignal::SessionEvents => 5,
    }
}

fn signal_from_tag(tag: u8) -> Option<TelemetrySignal> {
    match tag {
        1 => Some(TelemetrySignal::Traces),
        2 => Some(TelemetrySignal::Logs),
        3 => Some(TelemetrySignal::Metrics),
        4 => Some(TelemetrySignal::SessionReplays),
        5 => Some(TelemetrySignal::SessionEvents),
        _ => None,
    }
}

fn destination_tag(destination: ExportDestination) -> u8 {
    match destination {
        ExportDestination::Tinybird => 1,
        ExportDestination::ClickHouse => 2,
    }
}

fn destination_from_tag(tag: u8) -> Option<ExportDestination> {
    match tag {
        1 => Some(ExportDestination::Tinybird),
        2 => Some(ExportDestination::ClickHouse),
        _ => None,
    }
}

fn add_org_queue_bytes(counters: &Arc<DashMap<String, Arc<AtomicU64>>>, org_id: &str, bytes: u64) {
    if org_id.is_empty() || bytes == 0 {
        return;
    }
    let counter = counters
        .entry(org_id.to_string())
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone();
    let current = counter.fetch_add(bytes, Ordering::AcqRel) + bytes;
    metrics::org_queue_bytes(org_id, current);
}

fn release_org_queue_bytes(
    counters: &Arc<DashMap<String, Arc<AtomicU64>>>,
    org_id: &str,
    bytes: u64,
) {
    if org_id.is_empty() || bytes == 0 {
        return;
    }
    if let Some(counter) = counters.get(org_id).map(|entry| Arc::clone(entry.value())) {
        let mut current = counter.load(Ordering::Relaxed);
        loop {
            let next = current.saturating_sub(bytes);
            match counter.compare_exchange(current, next, Ordering::AcqRel, Ordering::Relaxed) {
                Ok(_) => {
                    metrics::org_queue_bytes(org_id, next);
                    return;
                }
                Err(observed) => current = observed,
            }
        }
    }
}

struct ExportWorker {
    /// This worker's lane (`lane_index(shard, destination)`). Drives one channel,
    /// one WAL file, and exactly one destination.
    lane: usize,
    shard: usize,
    destination: ExportDestination,
    cfg: Arc<TinybirdConfig>,
    wal: Arc<ShardedWal>,
    org_queue_bytes: Arc<DashMap<String, Arc<AtomicU64>>>,
    clickhouse_breakers: Arc<ClickHouseBreakerRegistry>,
    clickhouse_targets: Option<Arc<dyn ClickHouseTargetProvider>>,
    http: Client,
    receiver: mpsc::Receiver<QueuedFrame>,
}

impl ExportWorker {
    async fn run(mut self) {
        let mut buffer = Vec::new();
        while let Some(frame) = self.receiver.recv().await {
            buffer.push(frame);
            let deadline = sleep(self.cfg.batch_max_wait);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    maybe = self.receiver.recv(), if !batch_full(&self.cfg, &buffer) => {
                        match maybe {
                            Some(frame) => buffer.push(frame),
                            None => break,
                        }
                    }
                    _ = &mut deadline => break,
                }
            }

            let frames = std::mem::take(&mut buffer);
            if let Err(error) = self.export_and_mark(frames).await {
                error!(shard = self.shard, error = %error, "Telemetry export worker failed batch");
            }
        }
    }

    async fn export_and_mark(&self, frames: Vec<QueuedFrame>) -> Result<(), String> {
        if frames.is_empty() {
            return Ok(());
        }
        // A lane only ever carries one destination, so the cursor (a single
        // offset per lane) tracks a single export stream. This invariant is what
        // lets Tinybird and ClickHouse drain independently.
        debug_assert!(
            frames.iter().all(|frame| frame.destination == self.destination),
            "lane {} received a frame for the wrong destination",
            self.lane
        );
        let mut by_tinybird: BTreeMap<String, Vec<&QueuedFrame>> = BTreeMap::new();
        let mut by_clickhouse: BTreeMap<(String, String), Vec<&QueuedFrame>> = BTreeMap::new();
        for frame in &frames {
            match frame.destination {
                ExportDestination::Tinybird => {
                    by_tinybird
                        .entry(frame.datasource.clone())
                        .or_default()
                        .push(frame);
                }
                ExportDestination::ClickHouse => {
                    by_clickhouse
                        .entry((frame.org_id.clone(), frame.datasource.clone()))
                        .or_default()
                        .push(frame);
                }
            }
        }

        let start = Instant::now();
        let first_signal = frames[0].signal;
        let first_offset = frames[0].start;
        for (datasource, frames) in by_tinybird {
            let (body, rows) = combine_frames(frames);
            self.post_tinybird(&datasource, body, rows).await?;
        }
        for ((org_id, datasource), frames) in by_clickhouse {
            let (body, rows) = combine_frames(frames);
            let outcome = self
                .post_clickhouse(&org_id, &datasource, body, rows)
                .await?;
            if outcome == ClickHouseExportOutcome::Dropped {
                // Direct ClickHouse ingest is fail-closed to the chosen destination:
                // after the retry budget, a ClickHouse-routed batch is metered and
                // intentionally dropped rather than replayed forever or sent to Tinybird.
                warn!(
                    org_id,
                    datasource, rows, "Advancing WAL cursor after terminal ClickHouse export drop"
                );
            }
        }

        let end = frames.iter().map(|frame| frame.end).max().unwrap_or(0);
        self.wal.mark_exported(self.lane, end).await?;
        for frame in &frames {
            release_org_queue_bytes(&self.org_queue_bytes, &frame.org_id, frame.queued_bytes);
        }
        metrics::export_batch_completed(
            frames[0].shard,
            &format!("{first_signal:?}"),
            start.elapsed().as_secs_f64(),
            end.saturating_sub(first_offset),
        );
        Ok(())
    }

    async fn post_tinybird(
        &self,
        datasource: &str,
        body: Vec<u8>,
        rows: usize,
    ) -> Result<(), String> {
        let url = format!(
            "{}/v0/events?name={}",
            self.cfg.endpoint.trim_end_matches('/'),
            datasource
        );
        let compressed = bytes::Bytes::from(gzip(body)?);
        let max_attempts = self.cfg.export_max_attempts;
        let mut attempt = 0u32;
        loop {
            let started = Instant::now();
            let response = self
                .http
                .post(&url)
                .bearer_auth(&self.cfg.token)
                .header(reqwest::header::CONTENT_TYPE, "application/x-ndjson")
                .header(reqwest::header::CONTENT_ENCODING, "gzip")
                .body(compressed.clone())
                .send()
                .await;

            let last_status: String;
            match response {
                Ok(response) if response.status().is_success() => {
                    metrics::tinybird_export_succeeded(
                        datasource,
                        started.elapsed().as_secs_f64(),
                        rows as u64,
                    );
                    return Ok(());
                }
                Ok(response) if response.status().is_client_error() => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    metrics::tinybird_export_dropped(datasource, &status.to_string(), rows as u64);
                    warn!(datasource, status, body = %body, rows, "Dropping non-retryable Tinybird batch");
                    return Ok(());
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    last_status = status.to_string();
                    metrics::tinybird_export_retry(datasource, &last_status);
                    warn!(datasource, status, attempt, "Retrying Tinybird batch");
                }
                Err(error) => {
                    last_status = "transport".to_string();
                    metrics::tinybird_export_retry(datasource, &last_status);
                    warn!(datasource, attempt, error = %error, "Retrying Tinybird batch after transport error");
                }
            }

            attempt = attempt.saturating_add(1);
            if attempt >= max_attempts {
                metrics::tinybird_export_dropped(datasource, "retries_exhausted", rows as u64);
                error!(
                    datasource,
                    rows,
                    attempts = attempt,
                    last_status = %last_status,
                    "Dropping Tinybird batch after exhausting retry budget"
                );
                return Ok(());
            }
            let backoff_ms = 250u64.saturating_mul(2u64.saturating_pow(attempt.min(6)));
            sleep(Duration::from_millis(backoff_ms.min(30_000))).await;
        }
    }

    async fn post_clickhouse(
        &self,
        org_id: &str,
        datasource: &str,
        body: Vec<u8>,
        rows: usize,
    ) -> Result<ClickHouseExportOutcome, String> {
        let Some(mapping) = clickhouse_insert_mappings::mapping_for(datasource) else {
            metrics::clickhouse_export_dropped(datasource, "mapping_missing", rows as u64);
            error!(
                datasource,
                rows, "Dropping ClickHouse batch because no insert mapping exists"
            );
            return Ok(ClickHouseExportOutcome::Dropped);
        };

        let compressed = bytes::Bytes::from(gzip(body)?);
        let max_attempts = self.cfg.export_max_attempts;
        let mut attempt = 0u32;
        // Set on every retryable failure; only read when the retry budget is
        // exhausted (which can only happen after at least one failure).
        let mut last_status: String;

        loop {
            // Fast-shed before doing any work: if this org's target has been
            // failing, drop the batch instead of holding the lane worker through
            // the retry budget. This bounds how long one unhealthy BYO-ClickHouse
            // target can starve co-sharded ClickHouse orgs.
            if self.clickhouse_breakers.decide(org_id, Instant::now()) == BreakerDecision::Shed {
                metrics::clickhouse_export_dropped(datasource, "circuit_open", rows as u64);
                warn!(
                    org_id,
                    datasource, rows, attempt, "Shedding ClickHouse batch: target circuit breaker open"
                );
                return Ok(ClickHouseExportOutcome::Dropped);
            }
            // Backoff is taken here (before the attempt) so that when the breaker
            // trips mid-batch the shed-check above can bail without first sleeping
            // out the previous failure's backoff.
            if attempt > 0 {
                backoff(attempt).await;
            }

            let started = Instant::now();
            let target = match self.resolve_clickhouse_target(org_id).await {
                Ok(Some(target)) => target,
                Ok(None) => {
                    metrics::clickhouse_export_retry(datasource, "target_unavailable");
                    warn!(
                        org_id,
                        datasource,
                        attempt,
                        "Retrying ClickHouse batch because no ready target resolved"
                    );
                    self.clickhouse_breakers.on_failure(org_id, Instant::now());
                    attempt = attempt.saturating_add(1);
                    if attempt >= max_attempts {
                        metrics::clickhouse_export_dropped(
                            datasource,
                            "target_unavailable_exhausted",
                            rows as u64,
                        );
                        error!(
                            org_id,
                            datasource,
                            rows,
                            attempts = attempt,
                            "Dropping ClickHouse batch after target resolution stayed unavailable"
                        );
                        return Ok(ClickHouseExportOutcome::Dropped);
                    }
                    continue;
                }
                Err(error) => {
                    metrics::clickhouse_export_retry(datasource, "target_error");
                    warn!(
                        org_id,
                        datasource,
                        attempt,
                        error = %error,
                        "Retrying ClickHouse batch after target resolution error"
                    );
                    self.clickhouse_breakers.on_failure(org_id, Instant::now());
                    attempt = attempt.saturating_add(1);
                    if attempt >= max_attempts {
                        metrics::clickhouse_export_dropped(
                            datasource,
                            "target_error_exhausted",
                            rows as u64,
                        );
                        error!(
                            org_id,
                            datasource,
                            rows,
                            attempts = attempt,
                            error = %error,
                            "Dropping ClickHouse batch after target resolution errors"
                        );
                        return Ok(ClickHouseExportOutcome::Dropped);
                    }
                    continue;
                }
            };

            let sql = build_clickhouse_insert_sql(mapping, org_id);
            let endpoint_url = target.endpoint.trim_end_matches('/').to_string();
            let mut request_url = match url::Url::parse(&endpoint_url) {
                Ok(url) => url,
                Err(error) => {
                    metrics::clickhouse_export_dropped(datasource, "invalid_url", rows as u64);
                    error!(
                        org_id,
                        datasource,
                        endpoint = %endpoint_url,
                        error = %error,
                        rows,
                        "Dropping ClickHouse batch because endpoint URL is invalid"
                    );
                    return Ok(ClickHouseExportOutcome::Dropped);
                }
            };
            if !target.password.is_empty() && request_url.scheme() != "https" {
                metrics::clickhouse_export_dropped(datasource, "insecure_endpoint", rows as u64);
                error!(
                    org_id,
                    datasource,
                    endpoint = %endpoint_url,
                    rows,
                    "Dropping ClickHouse batch because password-authenticated endpoints must use https"
                );
                return Ok(ClickHouseExportOutcome::Dropped);
            }
            {
                let mut query = request_url.query_pairs_mut();
                query
                    .append_pair("database", target.database.as_str())
                    .append_pair("async_insert", "1")
                    .append_pair("wait_for_async_insert", "1")
                    .append_pair("input_format_skip_unknown_fields", "1")
                    .append_pair("date_time_input_format", "best_effort")
                    .append_pair("query", sql.as_str());
            }
            let mut request = self
                .http
                .post(request_url)
                .timeout(self.cfg.clickhouse_export_timeout)
                .header("X-ClickHouse-User", target.user.as_str())
                .header("X-ClickHouse-Database", target.database.as_str())
                .header(reqwest::header::CONTENT_TYPE, "application/x-ndjson")
                .header(reqwest::header::CONTENT_ENCODING, "gzip")
                .body(compressed.clone());
            if !target.password.is_empty() {
                request = request.header("X-ClickHouse-Key", target.password.as_str());
            }

            let response = request.send().await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let bucket = status_bucket(response.status().as_u16());
                    metrics::clickhouse_export_succeeded(
                        datasource,
                        bucket,
                        started.elapsed().as_secs_f64(),
                        rows as u64,
                    );
                    self.clickhouse_breakers.on_success(org_id);
                    return Ok(ClickHouseExportOutcome::Delivered);
                }
                Ok(response) => {
                    let status = response.status();
                    let status_code = status.as_u16();
                    let bucket = status_bucket(status_code);
                    let body = response.text().await.unwrap_or_default();
                    if !is_retryable_clickhouse_status(status_code) {
                        // Non-retryable (4xx) is the batch's fault, not the
                        // target's health — drop it without tripping the breaker.
                        metrics::clickhouse_export_dropped(datasource, bucket, rows as u64);
                        warn!(
                            org_id,
                            datasource,
                            status = status_code,
                            body = %body,
                            rows,
                            "Dropping non-retryable ClickHouse batch"
                        );
                        return Ok(ClickHouseExportOutcome::Dropped);
                    }
                    metrics::clickhouse_export_retry(datasource, bucket);
                    warn!(
                        org_id,
                        datasource,
                        status = status_code,
                        attempt,
                        body = %body,
                        "Retrying ClickHouse batch"
                    );
                    self.clickhouse_breakers.on_failure(org_id, Instant::now());
                    last_status = bucket.to_string();
                }
                Err(error) => {
                    metrics::clickhouse_export_retry(datasource, "transport");
                    warn!(
                        org_id,
                        datasource,
                        attempt,
                        error = %error,
                        "Retrying ClickHouse batch after transport error"
                    );
                    self.clickhouse_breakers.on_failure(org_id, Instant::now());
                    last_status = "transport".to_string();
                }
            }

            attempt = attempt.saturating_add(1);
            if attempt >= max_attempts {
                metrics::clickhouse_export_dropped(datasource, "retries_exhausted", rows as u64);
                error!(
                    org_id,
                    datasource,
                    rows,
                    attempts = attempt,
                    last_status = %last_status,
                    "Dropping ClickHouse batch after exhausting retry budget"
                );
                return Ok(ClickHouseExportOutcome::Dropped);
            }
            // backoff happens at the loop top, gated by the breaker shed-check.
        }
    }

    async fn resolve_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTarget>, String> {
        let Some(provider) = &self.clickhouse_targets else {
            return Ok(None);
        };
        provider.resolve_clickhouse_target(org_id).await
    }
}

fn combine_frames(frames: Vec<&QueuedFrame>) -> (Vec<u8>, usize) {
    let mut body = Vec::new();
    let mut rows = 0usize;
    for frame in frames {
        body.extend_from_slice(&frame.payload);
        if !body.ends_with(b"\n") {
            body.push(b'\n');
        }
        rows += frame.row_count;
    }
    (body, rows)
}

fn batch_full(cfg: &TinybirdConfig, frames: &[QueuedFrame]) -> bool {
    let rows: usize = frames.iter().map(|frame| frame.row_count).sum();
    let bytes: usize = frames.iter().map(|frame| frame.payload.len()).sum();
    rows >= cfg.batch_max_rows || bytes >= cfg.batch_max_bytes
}

fn status_bucket(status: u16) -> &'static str {
    match status {
        200..=299 => "2xx",
        400..=499 => "4xx",
        500..=599 => "5xx",
        _ => "other",
    }
}

fn is_retryable_clickhouse_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

async fn backoff(attempt: u32) {
    let backoff_ms = 250u64.saturating_mul(2u64.saturating_pow(attempt.min(6)));
    sleep(Duration::from_millis(backoff_ms.min(30_000))).await;
}

fn build_clickhouse_insert_sql(mapping: &InsertMapping, org_id: &str) -> String {
    let org_literal = format!("'{}'", escape_clickhouse_sql_literal(org_id));
    let selects = mapping
        .selects
        .iter()
        .map(|select| {
            if *select == clickhouse_insert_mappings::ORG_PLACEHOLDER {
                org_literal.clone()
            } else {
                (*select).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO {} ({}) SELECT {} FROM input('{}') FORMAT JSONEachRow",
        mapping.table,
        mapping.columns.join(", "),
        selects,
        escape_clickhouse_sql_literal(mapping.input_schema)
    )
}

fn escape_clickhouse_sql_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn gzip(body: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&body)
        .map_err(|error| format!("gzip Tinybird body: {error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("finish gzip Tinybird body: {error}"))
}

fn encode_traces(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportTraceServiceRequest,
    policy: &SamplingPolicy,
    attribute_mappings: &[AttributeMappingRule],
) -> Result<(Vec<EncodedFrame>, AcceptStats), PipelineError> {
    let mut rows = Vec::with_capacity(count_trace_rows(request));
    let mut dropped = 0usize;
    let mut routing_key = hash64(org_id);
    let sample_ratio = policy.clamped_ratio();
    let sample_rate = 1.0 / sample_ratio;

    for resource_spans in &request.resource_spans {
        let resource = resource_spans.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        for scope_spans in &resource_spans.scope_spans {
            let scope = scope_spans.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map(|scope| scope.name.as_str()).unwrap_or("");
            let scope_version = scope.map(|scope| scope.version.as_str()).unwrap_or("");

            for span in &scope_spans.spans {
                let trace_id = bytes_hex(&span.trace_id);
                if !trace_id.is_empty() {
                    routing_key = hash64(&trace_id);
                }

                let should_keep = should_keep_trace(org_id, &trace_id, span, policy);
                if !should_keep {
                    dropped += 1;
                    continue;
                }

                let mut span_attrs = attr_map(&span.attributes);
                if sample_ratio < 1.0
                    && !span_attrs.contains_key("SampleRate")
                    && !span.trace_state.contains("th:")
                {
                    span_attrs.insert(
                        "SampleRate".to_string(),
                        json!(format_sample_rate(sample_rate)),
                    );
                }
                apply_attribute_mappings(attribute_mappings, &resource_attrs, &mut span_attrs);

                let events_timestamp: Vec<Value> = span
                    .events
                    .iter()
                    .map(|event| json!(format_timestamp_nano(event.time_unix_nano)))
                    .collect();
                let events_name: Vec<Value> =
                    span.events.iter().map(|event| json!(event.name)).collect();
                let events_attributes: Vec<Value> = span
                    .events
                    .iter()
                    .map(|event| Value::Object(attr_map(&event.attributes)))
                    .collect();
                let links_trace_id: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(bytes_hex(&link.trace_id)))
                    .collect();
                let links_span_id: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(bytes_hex(&link.span_id)))
                    .collect();
                let links_trace_state: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| json!(link.trace_state))
                    .collect();
                let links_attributes: Vec<Value> = span
                    .links
                    .iter()
                    .map(|link| Value::Object(attr_map(&link.attributes)))
                    .collect();

                rows.push(json_line(json!({
                    "start_time": format_timestamp_nano(span.start_time_unix_nano),
                    "trace_id": trace_id,
                    "span_id": bytes_hex(&span.span_id),
                    "parent_span_id": bytes_hex(&span.parent_span_id),
                    "trace_state": span.trace_state,
                    "span_name": span.name,
                    "span_kind": span_kind(span.kind),
                    "service_name": service_name,
                    "resource_schema_url": resource_spans.schema_url,
                    "resource_attributes": resource_attrs,
                    "scope_schema_url": scope_spans.schema_url,
                    "scope_name": scope_name,
                    "scope_version": scope_version,
                    "scope_attributes": scope_attrs,
                    "duration": span.end_time_unix_nano.saturating_sub(span.start_time_unix_nano),
                    "status_code": status_code(span.status.as_ref().map(|status| status.code).unwrap_or_default()),
                    "status_message": span.status.as_ref().map(|status| status.message.as_str()).unwrap_or(""),
                    "span_attributes": span_attrs,
                    "events_timestamp": events_timestamp,
                    "events_name": events_name,
                    "events_attributes": events_attributes,
                    "links_trace_id": links_trace_id,
                    "links_span_id": links_span_id,
                    "links_trace_state": links_trace_state,
                    "links_attributes": links_attributes
                }))?);
            }
        }
    }

    let stats = AcceptStats {
        rows: rows.len(),
        dropped,
    };
    let frames = rows_to_frames(
        org_id,
        routing_key,
        TelemetrySignal::Traces,
        datasources.traces.clone(),
        rows,
    );
    Ok((frames, stats))
}

fn encode_logs(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportLogsServiceRequest,
) -> Result<(Vec<EncodedFrame>, AcceptStats), PipelineError> {
    let mut rows = Vec::with_capacity(count_log_rows(request));
    let mut routing_key = hash64(org_id);

    for resource_logs in &request.resource_logs {
        let resource = resource_logs.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        for scope_logs in &resource_logs.scope_logs {
            let scope = scope_logs.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map(|scope| scope.name.as_str()).unwrap_or("");
            let scope_version = scope.map(|scope| scope.version.as_str()).unwrap_or("");

            for log in &scope_logs.log_records {
                let trace_id = bytes_hex(&log.trace_id);
                if !trace_id.is_empty() {
                    routing_key = hash64(&trace_id);
                }
                rows.push(encode_log_row(
                    log,
                    &service_name,
                    &resource_logs.schema_url,
                    &resource_attrs,
                    &scope_logs.schema_url,
                    scope_name,
                    scope_version,
                    &scope_attrs,
                )?);
            }
        }
    }

    let stats = AcceptStats {
        rows: rows.len(),
        dropped: 0,
    };
    let frames = rows_to_frames(
        org_id,
        routing_key,
        TelemetrySignal::Logs,
        datasources.logs.clone(),
        rows,
    );
    Ok((frames, stats))
}

fn encode_log_row(
    log: &LogRecord,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
) -> Result<Vec<u8>, PipelineError> {
    json_line(json!({
        "timestamp": format_timestamp_nano(if log.time_unix_nano != 0 { log.time_unix_nano } else { log.observed_time_unix_nano }),
        "trace_id": bytes_hex(&log.trace_id),
        "span_id": bytes_hex(&log.span_id),
        "flags": log.flags,
        "severity_text": if log.severity_text.is_empty() { severity_number_to_text(log.severity_number) } else { log.severity_text.as_str() },
        "severity_number": log.severity_number,
        "service_name": service_name,
        "body": log.body.as_ref().map(any_value_string).unwrap_or_default(),
        "resource_schema_url": resource_schema_url,
        "resource_attributes": resource_attrs,
        "scope_schema_url": scope_schema_url,
        "scope_name": scope_name,
        "scope_version": scope_version,
        "scope_attributes": scope_attrs,
        "log_attributes": attr_map(&log.attributes)
    }))
}

fn encode_metrics(
    datasources: &DatasourceNames,
    org_id: &str,
    request: &ExportMetricsServiceRequest,
) -> Result<(Vec<EncodedFrame>, AcceptStats), PipelineError> {
    let mut by_datasource: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    let mut row_count = 0usize;
    let mut routing_key = hash64(org_id);

    for resource_metrics in &request.resource_metrics {
        let resource = resource_metrics.resource.as_ref();
        let resource_attrs = resource
            .map(|resource| attr_map(&resource.attributes))
            .unwrap_or_default();
        let service_name = resource_attrs
            .get("service.name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        for scope_metrics in &resource_metrics.scope_metrics {
            let scope = scope_metrics.scope.as_ref();
            let scope_attrs = scope
                .map(|scope| attr_map(&scope.attributes))
                .unwrap_or_default();
            let scope_name = scope.map(|scope| scope.name.as_str()).unwrap_or("");
            let scope_version = scope.map(|scope| scope.version.as_str()).unwrap_or("");

            for metric in &scope_metrics.metrics {
                routing_key = hash64(&metric.name);
                match metric.data.as_ref() {
                    Some(metric::Data::Gauge(gauge)) => {
                        for point in &gauge.data_points {
                            push_metric_number_row(
                                &mut by_datasource,
                                &datasources.metrics_gauge,
                                point,
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                None,
                                None,
                            )?;
                            row_count += 1;
                        }
                    }
                    Some(metric::Data::Sum(sum)) => {
                        for point in &sum.data_points {
                            push_metric_number_row(
                                &mut by_datasource,
                                &datasources.metrics_sum,
                                point,
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                Some(sum.aggregation_temporality),
                                Some(sum.is_monotonic),
                            )?;
                            row_count += 1;
                        }
                    }
                    Some(metric::Data::Histogram(histogram_data)) => {
                        for point in &histogram_data.data_points {
                            let row = metric_common_row(
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                &point.attributes,
                                point.start_time_unix_nano,
                                point.time_unix_nano,
                                point.flags,
                                &point.exemplars,
                            );
                            push_json(
                                &mut by_datasource,
                                &datasources.metrics_histogram,
                                extend(
                                    row,
                                    json!({
                                        "count": point.count,
                                        "sum": point.sum.unwrap_or(0.0),
                                        "bucket_counts": point.bucket_counts,
                                        "explicit_bounds": point.explicit_bounds,
                                        "min": point.min,
                                        "max": point.max,
                                        "aggregation_temporality": histogram_data.aggregation_temporality
                                    }),
                                ),
                            )?;
                            row_count += 1;
                        }
                    }
                    Some(metric::Data::ExponentialHistogram(exp)) => {
                        for point in &exp.data_points {
                            let row = metric_common_row(
                                metric,
                                &service_name,
                                &resource_metrics.schema_url,
                                &resource_attrs,
                                &scope_metrics.schema_url,
                                scope_name,
                                scope_version,
                                &scope_attrs,
                                &point.attributes,
                                point.start_time_unix_nano,
                                point.time_unix_nano,
                                point.flags,
                                &point.exemplars,
                            );
                            let positive = point.positive.as_ref();
                            let negative = point.negative.as_ref();
                            push_json(
                                &mut by_datasource,
                                &datasources.metrics_exponential_histogram,
                                extend(
                                    row,
                                    json!({
                                        "count": point.count,
                                        "sum": point.sum.unwrap_or(0.0),
                                        "scale": point.scale,
                                        "zero_count": point.zero_count,
                                        "positive_offset": positive.map(|b| b.offset).unwrap_or(0),
                                        "positive_bucket_counts": positive.map(|b| b.bucket_counts.clone()).unwrap_or_default(),
                                        "negative_offset": negative.map(|b| b.offset).unwrap_or(0),
                                        "negative_bucket_counts": negative.map(|b| b.bucket_counts.clone()).unwrap_or_default(),
                                        "min": point.min,
                                        "max": point.max,
                                        "aggregation_temporality": exp.aggregation_temporality
                                    }),
                                ),
                            )?;
                            row_count += 1;
                        }
                    }
                    Some(metric::Data::Summary(_)) | None => {
                        metrics::metrics_summary_dropped();
                    }
                }
            }
        }
    }

    let mut frames = Vec::with_capacity(by_datasource.len());
    for (datasource, rows) in by_datasource {
        frames.extend(rows_to_frames(
            org_id,
            routing_key,
            TelemetrySignal::Metrics,
            datasource,
            rows,
        ));
    }

    Ok((
        frames,
        AcceptStats {
            rows: row_count,
            dropped: 0,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn push_metric_number_row(
    by_datasource: &mut BTreeMap<String, Vec<Vec<u8>>>,
    datasource: &str,
    point: &NumberDataPoint,
    metric: &opentelemetry_proto::tonic::metrics::v1::Metric,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
    aggregation_temporality: Option<i32>,
    is_monotonic: Option<bool>,
) -> Result<(), PipelineError> {
    let value = match point.value {
        Some(number_data_point::Value::AsDouble(value)) => value,
        Some(number_data_point::Value::AsInt(value)) => value as f64,
        None => 0.0,
    };
    let mut extra = json!({ "value": value });
    if let Some(aggregation_temporality) = aggregation_temporality {
        extra["aggregation_temporality"] = json!(aggregation_temporality);
    }
    if let Some(is_monotonic) = is_monotonic {
        extra["is_monotonic"] = json!(is_monotonic);
    }
    let row = metric_common_row(
        metric,
        service_name,
        resource_schema_url,
        resource_attrs,
        scope_schema_url,
        scope_name,
        scope_version,
        scope_attrs,
        &point.attributes,
        point.start_time_unix_nano,
        point.time_unix_nano,
        point.flags,
        &point.exemplars,
    );
    push_json(by_datasource, datasource, extend(row, extra))
}

#[allow(clippy::too_many_arguments)]
fn metric_common_row(
    metric: &opentelemetry_proto::tonic::metrics::v1::Metric,
    service_name: &str,
    resource_schema_url: &str,
    resource_attrs: &Map<String, Value>,
    scope_schema_url: &str,
    scope_name: &str,
    scope_version: &str,
    scope_attrs: &Map<String, Value>,
    attributes: &[KeyValue],
    start_time_unix_nano: u64,
    time_unix_nano: u64,
    flags: u32,
    exemplars: &[Exemplar],
) -> Value {
    let (trace_ids, span_ids, timestamps, values, filtered_attributes) =
        encode_exemplars(exemplars);
    json!({
        "resource_attributes": resource_attrs,
        "resource_schema_url": resource_schema_url,
        "scope_name": scope_name,
        "scope_version": scope_version,
        "scope_attributes": scope_attrs,
        "scope_schema_url": scope_schema_url,
        "service_name": service_name,
        "metric_name": metric.name,
        "metric_description": metric.description,
        "metric_unit": metric.unit,
        "metric_attributes": attr_map(attributes),
        "start_timestamp": format_timestamp_nano(start_time_unix_nano),
        "timestamp": format_timestamp_nano(time_unix_nano),
        "flags": flags,
        "exemplars_trace_id": trace_ids,
        "exemplars_span_id": span_ids,
        "exemplars_timestamp": timestamps,
        "exemplars_value": values,
        "exemplars_filtered_attributes": filtered_attributes
    })
}

fn encode_exemplars(
    exemplars: &[Exemplar],
) -> (Vec<String>, Vec<String>, Vec<String>, Vec<f64>, Vec<Value>) {
    let mut trace_ids = Vec::with_capacity(exemplars.len());
    let mut span_ids = Vec::with_capacity(exemplars.len());
    let mut timestamps = Vec::with_capacity(exemplars.len());
    let mut values = Vec::with_capacity(exemplars.len());
    let mut filtered_attributes = Vec::with_capacity(exemplars.len());
    for exemplar in exemplars {
        trace_ids.push(bytes_hex(&exemplar.trace_id));
        span_ids.push(bytes_hex(&exemplar.span_id));
        timestamps.push(format_timestamp_nano(exemplar.time_unix_nano));
        values.push(match exemplar.value {
            Some(opentelemetry_proto::tonic::metrics::v1::exemplar::Value::AsDouble(value)) => {
                value
            }
            Some(opentelemetry_proto::tonic::metrics::v1::exemplar::Value::AsInt(value)) => {
                value as f64
            }
            None => 0.0,
        });
        filtered_attributes.push(Value::Object(attr_map(&exemplar.filtered_attributes)));
    }
    (trace_ids, span_ids, timestamps, values, filtered_attributes)
}

fn push_json(
    by_datasource: &mut BTreeMap<String, Vec<Vec<u8>>>,
    datasource: &str,
    value: Value,
) -> Result<(), PipelineError> {
    by_datasource
        .entry(datasource.to_string())
        .or_default()
        .push(json_line(value)?);
    Ok(())
}

fn extend(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn rows_to_frames(
    org_id: &str,
    routing_key: u64,
    signal: TelemetrySignal,
    datasource: String,
    rows: Vec<Vec<u8>>,
) -> Vec<EncodedFrame> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut payload = Vec::with_capacity(rows.iter().map(Vec::len).sum::<usize>() + rows.len());
    for row in &rows {
        payload.extend_from_slice(row);
        payload.push(b'\n');
    }
    vec![EncodedFrame {
        routing_key,
        org_id: org_id.to_string(),
        signal,
        destination: ExportDestination::Tinybird,
        datasource,
        row_count: rows.len(),
        payload,
    }]
}

fn json_line<T: Serialize>(value: T) -> Result<Vec<u8>, PipelineError> {
    serde_json::to_vec(&value).map_err(|error| PipelineError::Encode(error.to_string()))
}

fn should_keep_trace(org_id: &str, trace_id: &str, span: &Span, policy: &SamplingPolicy) -> bool {
    let ratio = policy.clamped_ratio();
    if ratio >= 1.0 {
        return true;
    }
    if policy.always_keep_error_spans
        && span
            .status
            .as_ref()
            .is_some_and(|status| status.code == status::StatusCode::Error as i32)
    {
        return true;
    }
    if let Some(ms) = policy.always_keep_slow_spans_ms {
        let duration_ms = span
            .end_time_unix_nano
            .saturating_sub(span.start_time_unix_nano)
            / 1_000_000;
        if duration_ms >= ms {
            return true;
        }
    }
    let key = if trace_id.is_empty() {
        format!("{org_id}:{}", bytes_hex(&span.span_id))
    } else {
        format!("{org_id}:{trace_id}")
    };
    let threshold = (ratio * u64::MAX as f64) as u64;
    hash64(&key) <= threshold
}

fn format_sample_rate(sample_rate: f64) -> String {
    if sample_rate.fract() == 0.0 {
        format!("{}", sample_rate as u64)
    } else {
        format!("{sample_rate:.6}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn attr_map(attributes: &[KeyValue]) -> Map<String, Value> {
    let mut out = Map::with_capacity(attributes.len());
    for attribute in attributes {
        out.insert(
            attribute.key.clone(),
            json!(attribute
                .value
                .as_ref()
                .map(any_value_string)
                .unwrap_or_default()),
        );
    }
    out
}

fn any_value_string(value: &AnyValue) -> String {
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(value)) => value.clone(),
        Some(any_value::Value::BoolValue(value)) => value.to_string(),
        Some(any_value::Value::IntValue(value)) => value.to_string(),
        Some(any_value::Value::DoubleValue(value)) => value.to_string(),
        Some(any_value::Value::BytesValue(value)) => bytes_hex(value),
        Some(any_value::Value::ArrayValue(value)) => {
            let values: Vec<String> = value.values.iter().map(any_value_string).collect();
            serde_json::to_string(&values).unwrap_or_default()
        }
        Some(any_value::Value::KvlistValue(value)) => {
            let attrs = attr_map(&value.values);
            serde_json::to_string(&attrs).unwrap_or_default()
        }
        None => String::new(),
    }
}

fn span_kind(kind: i32) -> &'static str {
    match kind {
        x if x == span::SpanKind::Internal as i32 => "Internal",
        x if x == span::SpanKind::Server as i32 => "Server",
        x if x == span::SpanKind::Client as i32 => "Client",
        x if x == span::SpanKind::Producer as i32 => "Producer",
        x if x == span::SpanKind::Consumer as i32 => "Consumer",
        _ => "Unspecified",
    }
}

fn status_code(code: i32) -> &'static str {
    match code {
        x if x == status::StatusCode::Ok as i32 => "Ok",
        x if x == status::StatusCode::Error as i32 => "Error",
        _ => "Unset",
    }
}

fn severity_number_to_text(n: i32) -> &'static str {
    match n {
        1..=4 => "TRACE",
        5..=8 => "DEBUG",
        9..=12 => "INFO",
        13..=16 => "WARN",
        17..=20 => "ERROR",
        21..=24 => "FATAL",
        _ => "",
    }
}

fn bytes_hex(bytes: &[u8]) -> String {
    if bytes.is_empty() || bytes.iter().all(|byte| *byte == 0) {
        return String::new();
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn format_timestamp_nano(unix_nano: u64) -> String {
    if unix_nano == 0 {
        return "1970-01-01 00:00:00.000000000".to_string();
    }
    let secs = (unix_nano / 1_000_000_000) as i64;
    let nanos = (unix_nano % 1_000_000_000) as u32;
    let Some(dt) = chrono::DateTime::from_timestamp(secs, nanos) else {
        return "1970-01-01 00:00:00.000000000".to_string();
    };
    dt.format("%Y-%m-%d %H:%M:%S.%f").to_string()
}

fn hash64(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn count_trace_rows(request: &ExportTraceServiceRequest) -> usize {
    request
        .resource_spans
        .iter()
        .flat_map(|rs| &rs.scope_spans)
        .map(|ss| ss.spans.len())
        .sum()
}

fn count_log_rows(request: &ExportLogsServiceRequest) -> usize {
    request
        .resource_logs
        .iter()
        .flat_map(|rl| &rl.scope_logs)
        .map(|sl| sl.log_records.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::{Query, State};
    use axum::http::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::Router;
    use flate2::read::GzDecoder;
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use opentelemetry_proto::tonic::metrics::v1::{
        exponential_histogram_data_point, metric, AggregationTemporality, ExponentialHistogram,
        ExponentialHistogramDataPoint, Gauge, Histogram, HistogramDataPoint, Metric, Sum,
    };
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span, Status};
    use std::collections::HashMap;

    #[derive(Debug)]
    struct FakeTinybirdImport {
        datasource: String,
        authorization: String,
        content_encoding: String,
        body: String,
    }

    #[derive(Debug)]
    struct FakeClickHouseImport {
        query: String,
        database: String,
        user: String,
        key: String,
        content_type: String,
        content_encoding: String,
        body: String,
    }

    #[derive(Clone)]
    struct StaticClickHouseTargetProvider {
        target: ClickHouseTarget,
    }

    #[async_trait::async_trait]
    impl ClickHouseTargetProvider for StaticClickHouseTargetProvider {
        async fn resolve_clickhouse_target(
            &self,
            _org_id: &str,
        ) -> Result<Option<ClickHouseTarget>, String> {
            Ok(Some(self.target.clone()))
        }
    }

    fn test_cfg() -> TinybirdConfig {
        TinybirdConfig {
            endpoint: "http://tinybird.test".to_string(),
            token: "token".to_string(),
            queue_dir: std::env::temp_dir(),
            queue_max_bytes: 1024 * 1024,
            org_queue_max_bytes: 1024 * 1024,
            queue_channel_capacity: 10,
            wal_shards: 2,
            batch_max_rows: 100,
            batch_max_bytes: 1024 * 1024,
            batch_max_wait: Duration::from_millis(10),
            export_concurrency_per_shard: 1,
            export_max_attempts: 20,
            clickhouse_export_timeout: Duration::from_secs(5),
            clickhouse_breaker: ClickHouseBreakerConfig::default(),
            datasources: DatasourceNames::defaults(),
            datasource_session_replays: "session_replays".to_string(),
            datasource_session_replay_events: "session_replay_events".to_string(),
            datasource_session_events: "session_events".to_string(),
        }
    }

    #[tokio::test]
    async fn pipeline_can_start_for_clickhouse_only_without_tinybird_credentials() {
        let queue_dir = unique_test_dir("clickhouse-only-pipeline");
        let mut cfg = test_cfg();
        cfg.endpoint = String::new();
        cfg.token = String::new();
        cfg.queue_dir = queue_dir.clone();

        let provider = Arc::new(StaticClickHouseTargetProvider {
            target: ClickHouseTarget {
                endpoint: "http://127.0.0.1:1".to_string(),
                user: "ingest".to_string(),
                password: String::new(),
                database: "maple".to_string(),
            },
        });

        TelemetryPipeline::new_with_clickhouse_validation(
            cfg,
            Client::new(),
            Some(provider),
            false,
        )
        .await
        .expect("ClickHouse-only pipeline should not require Tinybird credentials");

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "maple-ingest-{name}-{}-{}",
            std::process::id(),
            current_time_nanos_for_test()
        ))
    }

    fn current_time_nanos_for_test() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    async fn fake_tinybird_import(
        State(tx): State<mpsc::UnboundedSender<FakeTinybirdImport>>,
        Query(query): Query<HashMap<String, String>>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let mut decoded = String::new();
        GzDecoder::new(&body[..])
            .read_to_string(&mut decoded)
            .expect("fake Tinybird should receive gzip NDJSON");

        let _ = tx.send(FakeTinybirdImport {
            datasource: query.get("name").cloned().unwrap_or_default(),
            authorization: headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            content_encoding: headers
                .get(CONTENT_ENCODING)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            body: decoded,
        });

        StatusCode::OK
    }

    async fn fake_clickhouse_import(
        State(tx): State<mpsc::UnboundedSender<FakeClickHouseImport>>,
        Query(query): Query<HashMap<String, String>>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let mut decoded = String::new();
        GzDecoder::new(&body[..])
            .read_to_string(&mut decoded)
            .expect("fake ClickHouse should receive gzip NDJSON");

        let _ = tx.send(FakeClickHouseImport {
            query: query.get("query").cloned().unwrap_or_default(),
            database: query.get("database").cloned().unwrap_or_default(),
            user: headers
                .get("x-clickhouse-user")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            key: headers
                .get("x-clickhouse-key")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            content_type: headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            content_encoding: headers
                .get(CONTENT_ENCODING)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            body: decoded,
        });

        StatusCode::OK
    }

    async fn wait_for_export_drain(
        queue_dir: PathBuf,
        shard: usize,
        destination: ExportDestination,
    ) {
        let dest = destination.as_str();
        let cursor_path = queue_dir.join(format!("shard-{shard:03}-{dest}.cursor"));
        let shard_path = queue_dir.join(format!("shard-{shard:03}-{dest}.wal"));
        tokio::time::timeout(Duration::from_secs(2), async move {
            loop {
                // Success is either (a) cursor ahead of zero while writer is
                // still ahead of reader, or (b) shard file truncated to zero
                // because mark_exported() caught up to EOF and reclaimed disk.
                let cursor_offset = std::fs::read_to_string(&cursor_path)
                    .ok()
                    .and_then(|raw| raw.trim().parse::<u64>().ok())
                    .unwrap_or(0);
                let shard_size = std::fs::metadata(&shard_path)
                    .map(|meta| meta.len())
                    .unwrap_or(u64::MAX);
                if cursor_offset > 0 || shard_size == 0 {
                    return;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("export worker should drain the shard (cursor advance or truncation) after Tinybird success")
    }

    fn string_kv(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_string())),
            }),
        }
    }

    fn bool_kv(key: &str, value: bool) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue {
                value: Some(any_value::Value::BoolValue(value)),
            }),
        }
    }

    fn frame_row(frame: &EncodedFrame) -> Value {
        let payload = std::str::from_utf8(&frame.payload).unwrap();
        serde_json::from_str(payload.trim()).unwrap()
    }

    fn frame_rows_by_datasource(frames: Vec<EncodedFrame>) -> BTreeMap<String, Value> {
        frames
            .into_iter()
            .map(|frame| (frame.datasource.clone(), frame_row(&frame)))
            .collect()
    }

    #[test]
    fn hex_empty_for_zero_ids() {
        assert_eq!(bytes_hex(&[]), "");
        assert_eq!(bytes_hex(&[0; 8]), "");
        assert_eq!(bytes_hex(&[0xab, 0xcd]), "abcd");
    }

    #[test]
    fn timestamp_has_nano_precision() {
        assert_eq!(
            format_timestamp_nano(1_700_000_000_123_456_789),
            "2023-11-14 22:13:20.123456789"
        );
    }

    #[test]
    fn sampling_keeps_errors_even_when_ratio_low() {
        let policy = SamplingPolicy {
            trace_sample_ratio: 0.000001,
            always_keep_error_spans: true,
            always_keep_slow_spans_ms: None,
        };
        let span = Span {
            trace_id: vec![1; 16],
            span_id: vec![2; 8],
            status: Some(Status {
                code: status::StatusCode::Error as i32,
                message: String::new(),
            }),
            ..Default::default()
        };
        assert!(should_keep_trace("org_1", "trace", &span, &policy));
    }

    #[test]
    fn wal_round_trips_frame() {
        let frame = EncodedFrame {
            routing_key: 1,
            org_id: "org_1".to_string(),
            signal: TelemetrySignal::Traces,
            destination: ExportDestination::ClickHouse,
            datasource: "traces".to_string(),
            row_count: 1,
            payload: br#"{"a":1}"#.to_vec(),
        };
        let encoded = encode_wal_frame(&frame).unwrap();
        let path = std::env::temp_dir().join(format!("maple-wal-test-{}.wal", std::process::id()));
        std::fs::write(&path, encoded).unwrap();
        let mut file = File::open(&path).unwrap();
        let decoded = read_wal_frame(&mut file, 0).unwrap().unwrap();
        assert_eq!(decoded.signal, TelemetrySignal::Traces);
        assert_eq!(decoded.destination, ExportDestination::ClickHouse);
        assert_eq!(decoded.org_id, "org_1");
        assert_eq!(decoded.datasource, "traces");
        assert_eq!(decoded.payload, br#"{"a":1}"#);
        assert!(decoded.end > 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trace_encoder_matches_tinybird_row_shape() {
        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![
                        string_kv("service.name", "checkout"),
                        string_kv("maple_org_id", "org_1"),
                    ],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope {
                        name: "maple-sdk".to_string(),
                        version: "1.2.3".to_string(),
                        attributes: vec![string_kv("scope.attr", "scope-value")],
                        dropped_attributes_count: 0,
                    }),
                    spans: vec![Span {
                        trace_id: vec![0x11; 16],
                        span_id: vec![0x22; 8],
                        parent_span_id: vec![0x33; 8],
                        name: "POST /checkout".to_string(),
                        kind: span::SpanKind::Server as i32,
                        start_time_unix_nano: 1_700_000_000_000_000_000,
                        end_time_unix_nano: 1_700_000_000_250_000_000,
                        attributes: vec![string_kv("http.route", "/checkout")],
                        status: Some(Status {
                            code: status::StatusCode::Ok as i32,
                            message: "ok".to_string(),
                        }),
                        ..Default::default()
                    }],
                    schema_url: "https://scope.schema".to_string(),
                }],
                schema_url: "https://resource.schema".to_string(),
            }],
        };

        let (frames, stats) = encode_traces(
            &test_cfg().datasources,
            "org_1",
            &request,
            &SamplingPolicy::default(),
            &[],
        )
        .unwrap();
        assert_eq!(stats.rows, 1);
        assert_eq!(stats.dropped, 0);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].datasource, "traces");

        let row = frame_row(&frames[0]);
        assert_eq!(row["start_time"], "2023-11-14 22:13:20.000000000");
        assert_eq!(row["trace_id"], "11111111111111111111111111111111");
        assert_eq!(row["span_id"], "2222222222222222");
        assert_eq!(row["parent_span_id"], "3333333333333333");
        assert_eq!(row["span_name"], "POST /checkout");
        assert_eq!(row["span_kind"], "Server");
        assert_eq!(row["service_name"], "checkout");
        assert_eq!(row["duration"], 250_000_000);
        assert_eq!(row["status_code"], "Ok");
        assert_eq!(row["resource_attributes"]["maple_org_id"], "org_1");
        assert_eq!(row["span_attributes"]["http.route"], "/checkout");
        assert!(row["span_attributes"].get("SampleRate").is_none());
    }

    #[test]
    fn apply_attribute_mappings_rewrites_span_attributes() {
        let rule =
            |source_context, source_key: &str, target_key: &str, operation| AttributeMappingRule {
                source_context,
                source_key: source_key.to_string(),
                target_key: target_key.to_string(),
                operation,
            };

        // span -> span copy keeps the source key.
        let mut span_attrs = Map::new();
        span_attrs.insert("http.status_code".to_string(), json!("200"));
        apply_attribute_mappings(
            &[rule(
                MappingSourceContext::Span,
                "http.status_code",
                "http.response.status_code",
                MappingOperation::Copy,
            )],
            &Map::new(),
            &mut span_attrs,
        );
        assert_eq!(span_attrs["http.response.status_code"], json!("200"));
        assert_eq!(span_attrs["http.status_code"], json!("200"));

        // span -> span move deletes the source key.
        let mut span_attrs = Map::new();
        span_attrs.insert("old.key".to_string(), json!("v"));
        apply_attribute_mappings(
            &[rule(
                MappingSourceContext::Span,
                "old.key",
                "new.key",
                MappingOperation::Move,
            )],
            &Map::new(),
            &mut span_attrs,
        );
        assert_eq!(span_attrs["new.key"], json!("v"));
        assert!(span_attrs.get("old.key").is_none());

        // resource -> span promotes a resource attribute onto the span.
        let mut resource_attrs = Map::new();
        resource_attrs.insert("deployment.env".to_string(), json!("prod"));
        let mut span_attrs = Map::new();
        apply_attribute_mappings(
            &[rule(
                MappingSourceContext::Resource,
                "deployment.env",
                "deployment.environment",
                MappingOperation::Move,
            )],
            &resource_attrs,
            &mut span_attrs,
        );
        assert_eq!(span_attrs["deployment.environment"], json!("prod"));
        // resource source is never deleted, even for a Move rule.
        assert_eq!(resource_attrs["deployment.env"], json!("prod"));

        // an existing target key is never overwritten.
        let mut span_attrs = Map::new();
        span_attrs.insert("src".to_string(), json!("from-src"));
        span_attrs.insert("dst".to_string(), json!("customer-set"));
        apply_attribute_mappings(
            &[rule(
                MappingSourceContext::Span,
                "src",
                "dst",
                MappingOperation::Move,
            )],
            &Map::new(),
            &mut span_attrs,
        );
        assert_eq!(span_attrs["dst"], json!("customer-set"));
        assert_eq!(span_attrs["src"], json!("from-src"));

        // a missing source key is a no-op.
        let mut span_attrs = Map::new();
        apply_attribute_mappings(
            &[rule(
                MappingSourceContext::Span,
                "absent",
                "dst",
                MappingOperation::Copy,
            )],
            &Map::new(),
            &mut span_attrs,
        );
        assert!(span_attrs.is_empty());
    }

    #[test]
    fn log_encoder_matches_tinybird_row_shape() {
        let log = LogRecord {
            time_unix_nano: 1_700_000_001_123_456_789,
            observed_time_unix_nano: 1_700_000_001_123_456_789,
            severity_number: 17,
            severity_text: String::new(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue("payment failed".to_string())),
            }),
            attributes: vec![bool_kv("retryable", true)],
            trace_id: vec![0xaa; 16],
            span_id: vec![0xbb; 8],
            flags: 1,
            ..Default::default()
        };
        let request = ExportLogsServiceRequest {
            resource_logs: vec![opentelemetry_proto::tonic::logs::v1::ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![string_kv("service.name", "worker")],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_logs: vec![opentelemetry_proto::tonic::logs::v1::ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "logger".to_string(),
                        version: "4.5.6".to_string(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    log_records: vec![log],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let (frames, stats) = encode_logs(&test_cfg().datasources, "org_1", &request).unwrap();
        assert_eq!(stats.rows, 1);
        assert_eq!(frames[0].datasource, "logs");

        let row = frame_row(&frames[0]);
        assert_eq!(row["timestamp"], "2023-11-14 22:13:21.123456789");
        assert_eq!(row["severity_text"], "ERROR");
        assert_eq!(row["severity_number"], 17);
        assert_eq!(row["service_name"], "worker");
        assert_eq!(row["body"], "payment failed");
        assert_eq!(row["log_attributes"]["retryable"], "true");
        assert_eq!(row["trace_id"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(row["span_id"], "bbbbbbbbbbbbbbbb");
    }

    #[tokio::test]
    async fn pipeline_e2e_exports_gzip_ndjson_to_fake_tinybird() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_test_dir("fake-tinybird");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{addr}");
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);

        let pipeline = TelemetryPipeline::new(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        )
        .await
        .unwrap();

        let request = ExportLogsServiceRequest {
            resource_logs: vec![opentelemetry_proto::tonic::logs::v1::ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![string_kv("service.name", "fake-e2e")],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_logs: vec![opentelemetry_proto::tonic::logs::v1::ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "e2e-logger".to_string(),
                        version: "1.0.0".to_string(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    log_records: vec![LogRecord {
                        time_unix_nano: 1_700_000_002_000_000_000,
                        observed_time_unix_nano: 1_700_000_002_000_000_000,
                        severity_number: 9,
                        severity_text: "INFO".to_string(),
                        body: Some(AnyValue {
                            value: Some(any_value::Value::StringValue(
                                "hello fake tinybird".to_string(),
                            )),
                        }),
                        attributes: vec![string_kv("component", "pipeline-e2e")],
                        trace_id: vec![0xcc; 16],
                        span_id: vec![0xdd; 8],
                        ..Default::default()
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let stats = pipeline.accept_logs("org_e2e", &request).await.unwrap();
        assert_eq!(stats.rows, 1);

        let import = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("fake Tinybird should receive an import")
            .expect("fake Tinybird channel should stay open");

        assert_eq!(import.datasource, "logs");
        assert_eq!(import.authorization, "Bearer token");
        assert_eq!(import.content_encoding, "gzip");

        let row: Value = serde_json::from_str(import.body.trim()).unwrap();
        assert_eq!(row["timestamp"], "2023-11-14 22:13:22.000000000");
        assert_eq!(row["service_name"], "fake-e2e");
        assert_eq!(row["scope_name"], "e2e-logger");
        assert_eq!(row["body"], "hello fake tinybird");
        assert_eq!(row["log_attributes"]["component"], "pipeline-e2e");
        assert_eq!(row["trace_id"], "cccccccccccccccccccccccccccccccc");
        assert_eq!(row["span_id"], "dddddddddddddddd");

        wait_for_export_drain(queue_dir.clone(), 0, ExportDestination::Tinybird).await;
        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn pipeline_exports_ready_org_to_clickhouse_without_tinybird_calls() {
        let (ch_tx, mut ch_rx) = mpsc::unbounded_channel();
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new()
            .route("/", post(fake_clickhouse_import))
            .with_state(ch_tx);
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let (tb_tx, mut tb_rx) = mpsc::unbounded_channel();
        let tb_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let tb_addr = tb_listener.local_addr().unwrap();
        let tb_app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tb_tx);
        tokio::spawn(async move {
            axum::serve(tb_listener, tb_app).await.unwrap();
        });

        let queue_dir = unique_test_dir("fake-clickhouse");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{tb_addr}");
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);
        cfg.export_max_attempts = 1;

        let provider = Arc::new(StaticClickHouseTargetProvider {
            target: ClickHouseTarget {
                endpoint: format!("http://{ch_addr}"),
                user: "ingest".to_string(),
                password: String::new(),
                database: "maple".to_string(),
            },
        });
        let pipeline = TelemetryPipeline::new_with_clickhouse(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            Some(provider),
        )
        .await
        .unwrap();

        pipeline
            .accept_traces_to(
                "org_ready",
                &populated_trace_request(),
                &SamplingPolicy::default(),
                &[],
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();
        pipeline
            .accept_logs_to(
                "org_ready",
                &populated_log_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();
        pipeline
            .accept_metrics_to(
                "org_ready",
                &one_of_each_metric_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();

        let mut imports = Vec::new();
        for _ in 0..6 {
            let import = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
                .await
                .expect("fake ClickHouse should receive an import")
                .expect("fake ClickHouse channel should stay open");
            imports.push(import);
        }

        let datasources: std::collections::BTreeSet<_> = imports
            .iter()
            .filter_map(|import| {
                clickhouse_insert_mappings::DATASOURCES
                    .iter()
                    .find(|mapping| {
                        import
                            .query
                            .starts_with(&format!("INSERT INTO {}", mapping.table))
                    })
                    .map(|mapping| mapping.datasource)
            })
            .collect();
        assert_eq!(
            datasources,
            std::collections::BTreeSet::from([
                "logs",
                "metrics_exponential_histogram",
                "metrics_gauge",
                "metrics_histogram",
                "metrics_sum",
                "traces",
            ])
        );
        for import in &imports {
            assert_eq!(import.database, "maple");
            assert_eq!(import.user, "ingest");
            assert_eq!(import.key, "");
            assert_eq!(import.content_type, "application/x-ndjson");
            assert_eq!(import.content_encoding, "gzip");
            assert!(import.query.contains(" FROM input('"));
            assert!(import.query.ends_with(" FORMAT JSONEachRow"));
            assert!(import.query.contains("'org_ready'"));
            assert!(!import.body.trim().is_empty());
            assert!(!import.query.contains(import.body.trim()));
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            tb_rx.try_recv().is_err(),
            "ready org should not export native frames to Tinybird"
        );

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn clickhouse_export_drops_passworded_non_https_endpoint_without_sending() {
        let (ch_tx, mut ch_rx) = mpsc::unbounded_channel();
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new()
            .route("/", post(fake_clickhouse_import))
            .with_state(ch_tx);
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let (tb_tx, mut tb_rx) = mpsc::unbounded_channel();
        let tb_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let tb_addr = tb_listener.local_addr().unwrap();
        let tb_app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tb_tx);
        tokio::spawn(async move {
            axum::serve(tb_listener, tb_app).await.unwrap();
        });

        let queue_dir = unique_test_dir("fake-clickhouse-insecure");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{tb_addr}");
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);
        cfg.export_max_attempts = 1;

        let provider = Arc::new(StaticClickHouseTargetProvider {
            target: ClickHouseTarget {
                endpoint: format!("http://{ch_addr}"),
                user: "ingest".to_string(),
                password: "secret".to_string(),
                database: "maple".to_string(),
            },
        });
        let pipeline = TelemetryPipeline::new_with_clickhouse(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            Some(provider),
        )
        .await
        .unwrap();

        pipeline
            .accept_logs_to(
                "org_ready",
                &populated_log_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();

        wait_for_export_drain(queue_dir.clone(), 0, ExportDestination::ClickHouse).await;
        assert!(
            ch_rx.try_recv().is_err(),
            "passworded http ClickHouse target should be dropped before sending"
        );
        assert!(
            tb_rx.try_recv().is_err(),
            "ClickHouse-routed frames should not fall back to Tinybird"
        );

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    /// Holds the request open ~forever so the ClickHouse lane worker stays
    /// blocked in-flight, mimicking a slow/stalled BYO-ClickHouse target.
    async fn slow_clickhouse_handler(_body: Bytes) -> StatusCode {
        sleep(Duration::from_secs(30)).await;
        StatusCode::OK
    }

    /// Always-503 (retryable) ClickHouse target that counts how many requests
    /// actually reached it, so a test can assert the breaker sheds.
    async fn counting_failing_clickhouse_handler(
        State(count): State<Arc<std::sync::atomic::AtomicUsize>>,
        _body: Bytes,
    ) -> StatusCode {
        count.fetch_add(1, Ordering::SeqCst);
        StatusCode::SERVICE_UNAVAILABLE
    }

    #[tokio::test]
    async fn slow_clickhouse_lane_does_not_block_cosharded_tinybird_org() {
        // Regression for the 2026-06-24 incident: a stalled BYO-ClickHouse export
        // head-of-line-blocked co-sharded Tinybird orgs because both destinations
        // shared one shard channel + worker. With per-destination lanes a slow
        // ClickHouse target can only back-pressure its own lane, so a Tinybird org
        // on the same shard drains independently.
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new().route("/", post(slow_clickhouse_handler));
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let (tb_tx, mut tb_rx) = mpsc::unbounded_channel();
        let tb_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let tb_addr = tb_listener.local_addr().unwrap();
        let tb_app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tb_tx);
        tokio::spawn(async move {
            axum::serve(tb_listener, tb_app).await.unwrap();
        });

        let queue_dir = unique_test_dir("hol-blocking");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{tb_addr}");
        cfg.queue_dir = queue_dir.clone();
        // One shard forces both orgs to co-shard; only the per-destination lane
        // split keeps them isolated.
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);

        let provider = Arc::new(StaticClickHouseTargetProvider {
            target: ClickHouseTarget {
                endpoint: format!("http://{ch_addr}"),
                user: "ingest".to_string(),
                password: String::new(),
                database: "maple".to_string(),
            },
        });
        let pipeline = TelemetryPipeline::new_with_clickhouse(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap(),
            Some(provider),
        )
        .await
        .unwrap();

        // Wedge the ClickHouse lane first, then wait long enough that its worker
        // is parked in the in-flight POST to the slow target before the Tinybird
        // frame is enqueued. This is what makes the test reproduce the original
        // bug: on the pre-lanes single-channel design the Tinybird frame would
        // queue behind the blocked worker and never drain within the window.
        pipeline
            .accept_logs_to(
                "org_byo_ch",
                &populated_log_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();
        sleep(Duration::from_millis(250)).await;
        // ...now enqueue a co-sharded managed (Tinybird) org.
        pipeline
            .accept_logs_to(
                "org_managed",
                &populated_log_request(),
                ExportDestination::Tinybird,
            )
            .await
            .unwrap();

        // The Tinybird org must drain promptly despite the ClickHouse lane being
        // stuck on the slow target — pre-fix this timed out.
        let import = tokio::time::timeout(Duration::from_secs(5), tb_rx.recv())
            .await
            .expect("co-sharded Tinybird org should drain while the ClickHouse lane is stalled")
            .expect("fake Tinybird channel should stay open");
        assert_eq!(import.datasource, "logs");

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn clickhouse_breaker_sheds_after_threshold_failures() {
        // A persistently failing target must not burn the full retry budget on
        // every batch: after `failure_threshold` failures the breaker bails the
        // current batch and fast-sheds subsequent batches without touching the
        // target, bounding how long it can hold the lane worker.
        let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ch_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let ch_addr = ch_listener.local_addr().unwrap();
        let ch_app = Router::new()
            .route("/", post(counting_failing_clickhouse_handler))
            .with_state(Arc::clone(&request_count));
        tokio::spawn(async move {
            axum::serve(ch_listener, ch_app).await.unwrap();
        });

        let queue_dir = unique_test_dir("ch-breaker-sheds");
        let mut cfg = test_cfg();
        cfg.endpoint = String::new();
        cfg.token = String::new();
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);
        // Generous retry budget so the breaker — not the budget — is what stops
        // the hammering.
        cfg.export_max_attempts = 20;
        cfg.clickhouse_breaker = ClickHouseBreakerConfig {
            failure_threshold: 2,
            cooldown: Duration::from_secs(30),
        };

        let provider = Arc::new(StaticClickHouseTargetProvider {
            target: ClickHouseTarget {
                endpoint: format!("http://{ch_addr}"),
                user: "ingest".to_string(),
                password: String::new(),
                database: "maple".to_string(),
            },
        });
        let pipeline = TelemetryPipeline::new_with_clickhouse_validation(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            Some(provider),
            false,
        )
        .await
        .unwrap();

        pipeline
            .accept_logs_to(
                "org_flap",
                &populated_log_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();
        wait_for_export_drain(queue_dir.clone(), 0, ExportDestination::ClickHouse).await;

        // The first batch tripped the breaker after exactly `failure_threshold`
        // attempts instead of running all 20.
        assert_eq!(
            request_count.load(Ordering::SeqCst),
            2,
            "breaker should bail the batch after the failure threshold, not the full retry budget"
        );

        // A second batch for the same org sheds at the breaker without a request.
        pipeline
            .accept_logs_to(
                "org_flap",
                &populated_log_request(),
                ExportDestination::ClickHouse,
            )
            .await
            .unwrap();
        sleep(Duration::from_millis(200)).await;
        assert_eq!(
            request_count.load(Ordering::SeqCst),
            2,
            "breaker-open batches must shed without hitting the target"
        );

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[test]
    fn telemetry_signal_as_str_is_canonical_lowercase() {
        // Metric/log dimensions must match the lowercase `signal.path()` /
        // `maple.signal` vocabulary so `ingest_backpressure_shed_total` correlates
        // with other per-signal metrics (Debug derive would give PascalCase).
        assert_eq!(TelemetrySignal::Traces.as_str(), "traces");
        assert_eq!(TelemetrySignal::Logs.as_str(), "logs");
        assert_eq!(TelemetrySignal::Metrics.as_str(), "metrics");
        assert_eq!(TelemetrySignal::SessionReplays.as_str(), "session_replays");
        assert_eq!(TelemetrySignal::SessionEvents.as_str(), "session_events");
    }

    #[test]
    fn signal_tag_round_trips_all_variants() {
        // WAL on-disk format: every signal must survive tag encode/decode so
        // committed frames replay to the right signal after a restart.
        for signal in [
            TelemetrySignal::Traces,
            TelemetrySignal::Logs,
            TelemetrySignal::Metrics,
            TelemetrySignal::SessionReplays,
            TelemetrySignal::SessionEvents,
        ] {
            assert_eq!(signal_from_tag(signal_tag(signal)), Some(signal));
        }
    }

    #[test]
    fn breaker_default_failure_threshold_is_two() {
        // Lowered from 4 → 2 so a stalled BYO-ClickHouse target enters fast-shed
        // sooner, keeping the single-threaded lane worker draining instead of
        // holding batches through the retry budget (which backs the bounded
        // channel up into accept-path backpressure 503s).
        assert_eq!(ClickHouseBreakerConfig::default().failure_threshold, 2);
    }

    #[test]
    fn clickhouse_breaker_trips_sheds_and_recovers() {
        let registry = ClickHouseBreakerRegistry::new(ClickHouseBreakerConfig {
            failure_threshold: 3,
            cooldown: Duration::from_secs(30),
        });
        let t0 = Instant::now();

        // Unknown org: allowed, and no state is allocated.
        assert_eq!(registry.decide("org", t0), BreakerDecision::Allow);

        // Below threshold stays closed.
        registry.on_failure("org", t0);
        registry.on_failure("org", t0);
        assert_eq!(registry.decide("org", t0), BreakerDecision::Allow);

        // Threshold-th failure trips it open → shed for the whole cooldown.
        registry.on_failure("org", t0);
        assert_eq!(registry.decide("org", t0), BreakerDecision::Shed);
        assert_eq!(
            registry.decide("org", t0 + Duration::from_secs(29)),
            BreakerDecision::Shed
        );

        // After the cooldown a single probe is allowed (half-open).
        let after_cooldown = t0 + Duration::from_secs(31);
        assert_eq!(
            registry.decide("org", after_cooldown),
            BreakerDecision::Allow
        );

        // A failed probe re-opens for another cooldown.
        registry.on_failure("org", after_cooldown);
        assert_eq!(
            registry.decide("org", after_cooldown + Duration::from_secs(1)),
            BreakerDecision::Shed
        );

        // Success closes the breaker and resets the failure count, so it takes a
        // full `failure_threshold` again to re-trip.
        registry.on_success("org");
        let recovered = after_cooldown + Duration::from_secs(2);
        assert_eq!(registry.decide("org", recovered), BreakerDecision::Allow);
        registry.on_failure("org", recovered);
        registry.on_failure("org", recovered);
        assert_eq!(registry.decide("org", recovered), BreakerDecision::Allow);
    }

    #[test]
    fn clickhouse_breaker_disabled_when_threshold_zero() {
        let registry = ClickHouseBreakerRegistry::new(ClickHouseBreakerConfig {
            failure_threshold: 0,
            cooldown: Duration::from_secs(30),
        });
        let t0 = Instant::now();
        for _ in 0..10 {
            registry.on_failure("org", t0);
        }
        assert_eq!(registry.decide("org", t0), BreakerDecision::Allow);
    }

    #[tokio::test]
    async fn migrate_legacy_shard_relocates_frames_into_lanes() {
        // A pre-lanes binary wrote a single `shard-NNN.wal` mixing destinations.
        // On startup we must relocate each surviving frame into its destination
        // lane and remove the legacy file — without dropping anything.
        let queue_dir = unique_test_dir("legacy-migration");
        std::fs::create_dir_all(&queue_dir).unwrap();
        let mut cfg = test_cfg();
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;

        let tb_frame = EncodedFrame {
            routing_key: 0,
            org_id: "org_a".to_string(),
            signal: TelemetrySignal::Traces,
            destination: ExportDestination::Tinybird,
            datasource: "traces".to_string(),
            row_count: 1,
            payload: br#"{"a":1}"#.to_vec(),
        };
        let ch_frame = EncodedFrame {
            routing_key: 0,
            org_id: "org_b".to_string(),
            signal: TelemetrySignal::Logs,
            destination: ExportDestination::ClickHouse,
            datasource: "logs".to_string(),
            row_count: 1,
            payload: br#"{"b":2}"#.to_vec(),
        };
        let mut legacy = Vec::new();
        legacy.extend(encode_wal_frame(&tb_frame).unwrap());
        legacy.extend(encode_wal_frame(&ch_frame).unwrap());
        std::fs::write(queue_dir.join("shard-000.wal"), &legacy).unwrap();

        let wal = ShardedWal::open(&cfg).expect("open WAL");
        wal.migrate_legacy_shards(&cfg).await;

        assert!(
            !queue_dir.join("shard-000.wal").exists(),
            "legacy shard file should be removed after a successful migration"
        );

        let tb_frames = wal
            .replay(lane_index(0, ExportDestination::Tinybird))
            .await
            .unwrap();
        let ch_frames = wal
            .replay(lane_index(0, ExportDestination::ClickHouse))
            .await
            .unwrap();
        assert_eq!(tb_frames.len(), 1);
        assert_eq!(tb_frames[0].org_id, "org_a");
        assert_eq!(tb_frames[0].destination, ExportDestination::Tinybird);
        assert_eq!(tb_frames[0].payload, br#"{"a":1}"#);
        assert_eq!(ch_frames.len(), 1);
        assert_eq!(ch_frames[0].org_id, "org_b");
        assert_eq!(ch_frames[0].destination, ExportDestination::ClickHouse);
        assert_eq!(ch_frames[0].datasource, "logs");
        assert_eq!(ch_frames[0].payload, br#"{"b":2}"#);

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[test]
    fn metric_encoder_matches_all_tinybird_datasource_shapes() {
        let base_point = NumberDataPoint {
            attributes: vec![string_kv("route", "/checkout")],
            start_time_unix_nano: 1_700_000_000_000_000_000,
            time_unix_nano: 1_700_000_010_000_000_000,
            flags: 0,
            value: Some(number_data_point::Value::AsInt(42)),
            ..Default::default()
        };
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![string_kv("service.name", "api")],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "meter".to_string(),
                        version: "7.8.9".to_string(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    metrics: vec![
                        Metric {
                            name: "requests_total".to_string(),
                            description: "requests".to_string(),
                            unit: "1".to_string(),
                            data: Some(metric::Data::Sum(Sum {
                                data_points: vec![base_point.clone()],
                                aggregation_temporality: AggregationTemporality::Delta as i32,
                                is_monotonic: true,
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "cpu_ratio".to_string(),
                            description: "cpu".to_string(),
                            unit: "1".to_string(),
                            data: Some(metric::Data::Gauge(Gauge {
                                data_points: vec![NumberDataPoint {
                                    value: Some(number_data_point::Value::AsDouble(0.75)),
                                    ..base_point.clone()
                                }],
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "request_duration_ms".to_string(),
                            description: "latency".to_string(),
                            unit: "ms".to_string(),
                            data: Some(metric::Data::Histogram(Histogram {
                                data_points: vec![HistogramDataPoint {
                                    attributes: vec![string_kv("route", "/checkout")],
                                    start_time_unix_nano: base_point.start_time_unix_nano,
                                    time_unix_nano: base_point.time_unix_nano,
                                    count: 3,
                                    sum: Some(123.0),
                                    bucket_counts: vec![1, 2],
                                    explicit_bounds: vec![100.0],
                                    min: Some(10.0),
                                    max: Some(90.0),
                                    ..Default::default()
                                }],
                                aggregation_temporality: AggregationTemporality::Delta as i32,
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "payload_bytes".to_string(),
                            description: "payload".to_string(),
                            unit: "By".to_string(),
                            data: Some(metric::Data::ExponentialHistogram(ExponentialHistogram {
                                data_points: vec![ExponentialHistogramDataPoint {
                                    attributes: vec![string_kv("route", "/checkout")],
                                    start_time_unix_nano: base_point.start_time_unix_nano,
                                    time_unix_nano: base_point.time_unix_nano,
                                    count: 5,
                                    sum: Some(500.0),
                                    scale: 2,
                                    zero_count: 1,
                                    positive: Some(exponential_histogram_data_point::Buckets {
                                        offset: -1,
                                        bucket_counts: vec![2, 3],
                                    }),
                                    negative: Some(exponential_histogram_data_point::Buckets {
                                        offset: 0,
                                        bucket_counts: vec![1],
                                    }),
                                    min: Some(1.0),
                                    max: Some(250.0),
                                    ..Default::default()
                                }],
                                aggregation_temporality: AggregationTemporality::Cumulative as i32,
                            })),
                            metadata: Vec::new(),
                        },
                    ],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let (frames, stats) = encode_metrics(&test_cfg().datasources, "org_1", &request).unwrap();
        assert_eq!(stats.rows, 4);
        let rows = frame_rows_by_datasource(frames);
        assert_eq!(
            rows.keys().cloned().collect::<Vec<_>>(),
            vec![
                "metrics_exponential_histogram",
                "metrics_gauge",
                "metrics_histogram",
                "metrics_sum",
            ]
        );

        let sum = &rows["metrics_sum"];
        assert_eq!(sum["metric_name"], "requests_total");
        assert_eq!(sum["value"], 42.0);
        assert_eq!(sum["aggregation_temporality"], 1);
        assert_eq!(sum["is_monotonic"], true);
        assert_eq!(sum["metric_attributes"]["route"], "/checkout");

        let gauge = &rows["metrics_gauge"];
        assert_eq!(gauge["metric_name"], "cpu_ratio");
        assert_eq!(gauge["value"], 0.75);

        let histogram = &rows["metrics_histogram"];
        assert_eq!(histogram["metric_name"], "request_duration_ms");
        assert_eq!(histogram["count"], 3);
        assert_eq!(histogram["sum"], 123.0);
        assert_eq!(histogram["bucket_counts"], json!([1, 2]));
        assert_eq!(histogram["explicit_bounds"], json!([100.0]));
        assert_eq!(histogram["min"], 10.0);
        assert_eq!(histogram["max"], 90.0);

        let exp = &rows["metrics_exponential_histogram"];
        assert_eq!(exp["metric_name"], "payload_bytes");
        assert_eq!(exp["count"], 5);
        assert_eq!(exp["sum"], 500.0);
        assert_eq!(exp["scale"], 2);
        assert_eq!(exp["zero_count"], 1);
        assert_eq!(exp["positive_offset"], -1);
        assert_eq!(exp["positive_bucket_counts"], json!([2, 3]));
        assert_eq!(exp["negative_offset"], 0);
        assert_eq!(exp["negative_bucket_counts"], json!([1]));
        assert_eq!(exp["aggregation_temporality"], 2);
    }

    // -----------------------------------------------------------------------
    // Schema-parity contract.
    //
    // The lists below are the JSON top-level keys each ingest datasource must
    // populate. They MUST stay in lockstep with the `jsonPath` declarations in
    // packages/domain/src/tinybird/datasources.ts — a TS-side test
    // (`datasources.contract.test.ts`) pins the same lists from the other
    // direction, so changing either side without updating both will fail CI.
    //
    // Keys come from the *roots* of jsonPath strings, deduplicated:
    //   "$.foo"            -> "foo"
    //   "$.foo[:]"         -> "foo"
    //   "$.foo.bar"        -> "foo"     (only the top level)
    // ResourceAttributes uses `$.resource_attributes.maple_org_id` for OrgId,
    // which is already covered by the `resource_attributes` map.
    // -----------------------------------------------------------------------
    mod schema_contract {
        pub const LOGS: &[&str] = &[
            "timestamp",
            "trace_id",
            "span_id",
            "flags",
            "severity_text",
            "severity_number",
            "service_name",
            "body",
            "resource_schema_url",
            "resource_attributes",
            "scope_schema_url",
            "scope_name",
            "scope_version",
            "scope_attributes",
            "log_attributes",
        ];

        pub const TRACES: &[&str] = &[
            "start_time",
            "trace_id",
            "span_id",
            "parent_span_id",
            "trace_state",
            "span_name",
            "span_kind",
            "service_name",
            "resource_schema_url",
            "resource_attributes",
            "scope_schema_url",
            "scope_name",
            "scope_version",
            "scope_attributes",
            "duration",
            "status_code",
            "status_message",
            "span_attributes",
            "events_timestamp",
            "events_name",
            "events_attributes",
            "links_trace_id",
            "links_span_id",
            "links_trace_state",
            "links_attributes",
        ];

        const METRIC_COMMON: &[&str] = &[
            "resource_attributes",
            "resource_schema_url",
            "scope_name",
            "scope_version",
            "scope_attributes",
            "scope_schema_url",
            "service_name",
            "metric_name",
            "metric_description",
            "metric_unit",
            "metric_attributes",
            "start_timestamp",
            "timestamp",
            "flags",
            "exemplars_trace_id",
            "exemplars_span_id",
            "exemplars_timestamp",
            "exemplars_value",
            "exemplars_filtered_attributes",
        ];

        fn with(extra: &[&'static str]) -> Vec<&'static str> {
            let mut v: Vec<&'static str> = METRIC_COMMON.to_vec();
            v.extend(extra.iter().copied());
            v
        }

        pub fn metrics_sum() -> Vec<&'static str> {
            with(&["value", "aggregation_temporality", "is_monotonic"])
        }
        pub fn metrics_gauge() -> Vec<&'static str> {
            with(&["value"])
        }
        pub fn metrics_histogram() -> Vec<&'static str> {
            with(&[
                "count",
                "sum",
                "bucket_counts",
                "explicit_bounds",
                "min",
                "max",
                "aggregation_temporality",
            ])
        }
        pub fn metrics_exponential_histogram() -> Vec<&'static str> {
            with(&[
                "count",
                "sum",
                "scale",
                "zero_count",
                "positive_offset",
                "positive_bucket_counts",
                "negative_offset",
                "negative_bucket_counts",
                "min",
                "max",
                "aggregation_temporality",
            ])
        }
    }

    fn assert_row_keys_match(row: &Value, expected: &[&str], datasource: &str) {
        use std::collections::BTreeSet;
        let obj = row
            .as_object()
            .unwrap_or_else(|| panic!("{datasource} row must be a JSON object"));
        let actual: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = expected.iter().copied().collect();
        let missing: Vec<&&str> = expected.difference(&actual).collect();
        let extra: Vec<&&str> = actual.difference(&expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "datasource '{datasource}' JSON key mismatch.\n  missing (declared in datasources.ts but not emitted): {missing:?}\n  extra (emitted but not declared in datasources.ts): {extra:?}\n  If you intentionally changed the schema, update packages/domain/src/tinybird/datasources.ts AND the schema_contract module here AND packages/domain/src/tinybird/datasources.contract.test.ts."
        );
    }

    fn populated_log() -> LogRecord {
        LogRecord {
            time_unix_nano: 1_700_000_001_123_456_789,
            observed_time_unix_nano: 1_700_000_001_123_456_789,
            severity_number: 17,
            severity_text: "ERROR".to_string(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue("payment failed".into())),
            }),
            attributes: vec![string_kv("component", "billing")],
            trace_id: vec![0xaa; 16],
            span_id: vec![0xbb; 8],
            flags: 1,
            ..Default::default()
        }
    }

    fn populated_log_request() -> ExportLogsServiceRequest {
        ExportLogsServiceRequest {
            resource_logs: vec![opentelemetry_proto::tonic::logs::v1::ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![
                        string_kv("service.name", "billing"),
                        string_kv("maple_org_id", "org_contract"),
                    ],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_logs: vec![opentelemetry_proto::tonic::logs::v1::ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "billing-logger".to_string(),
                        version: "2.0.1".to_string(),
                        attributes: vec![string_kv("scope.key", "scope-value")],
                        dropped_attributes_count: 0,
                    }),
                    log_records: vec![populated_log()],
                    schema_url: "https://scope.schema/logs".to_string(),
                }],
                schema_url: "https://resource.schema/logs".to_string(),
            }],
        }
    }

    fn populated_trace_request() -> ExportTraceServiceRequest {
        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![
                        string_kv("service.name", "checkout"),
                        string_kv("maple_org_id", "org_contract"),
                    ],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope {
                        name: "checkout-tracer".to_string(),
                        version: "3.4.5".to_string(),
                        attributes: vec![string_kv("scope.key", "scope-value")],
                        dropped_attributes_count: 0,
                    }),
                    spans: vec![Span {
                        trace_id: vec![0x11; 16],
                        span_id: vec![0x22; 8],
                        parent_span_id: vec![0x33; 8],
                        trace_state: "vendor=foo".to_string(),
                        name: "POST /checkout".to_string(),
                        kind: span::SpanKind::Server as i32,
                        start_time_unix_nano: 1_700_000_000_000_000_000,
                        end_time_unix_nano: 1_700_000_000_250_000_000,
                        attributes: vec![string_kv("http.route", "/checkout")],
                        status: Some(Status {
                            code: status::StatusCode::Ok as i32,
                            message: "ok".to_string(),
                        }),
                        ..Default::default()
                    }],
                    schema_url: "https://scope.schema/traces".to_string(),
                }],
                schema_url: "https://resource.schema/traces".to_string(),
            }],
        }
    }

    fn one_of_each_metric_request() -> ExportMetricsServiceRequest {
        let base = NumberDataPoint {
            attributes: vec![string_kv("route", "/checkout")],
            start_time_unix_nano: 1_700_000_000_000_000_000,
            time_unix_nano: 1_700_000_010_000_000_000,
            flags: 0,
            value: Some(number_data_point::Value::AsInt(42)),
            ..Default::default()
        };
        ExportMetricsServiceRequest {
            resource_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![
                        string_kv("service.name", "api"),
                        string_kv("maple_org_id", "org_contract"),
                    ],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "meter".to_string(),
                        version: "7.8.9".to_string(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    metrics: vec![
                        Metric {
                            name: "requests_total".to_string(),
                            description: "requests".to_string(),
                            unit: "1".to_string(),
                            data: Some(metric::Data::Sum(Sum {
                                data_points: vec![base.clone()],
                                aggregation_temporality: AggregationTemporality::Delta as i32,
                                is_monotonic: true,
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "cpu_ratio".to_string(),
                            description: "cpu".to_string(),
                            unit: "1".to_string(),
                            data: Some(metric::Data::Gauge(Gauge {
                                data_points: vec![NumberDataPoint {
                                    value: Some(number_data_point::Value::AsDouble(0.75)),
                                    ..base.clone()
                                }],
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "request_duration_ms".to_string(),
                            description: "latency".to_string(),
                            unit: "ms".to_string(),
                            data: Some(metric::Data::Histogram(Histogram {
                                data_points: vec![HistogramDataPoint {
                                    attributes: vec![string_kv("route", "/checkout")],
                                    start_time_unix_nano: base.start_time_unix_nano,
                                    time_unix_nano: base.time_unix_nano,
                                    count: 3,
                                    sum: Some(123.0),
                                    bucket_counts: vec![1, 2],
                                    explicit_bounds: vec![100.0],
                                    min: Some(10.0),
                                    max: Some(90.0),
                                    ..Default::default()
                                }],
                                aggregation_temporality: AggregationTemporality::Delta as i32,
                            })),
                            metadata: Vec::new(),
                        },
                        Metric {
                            name: "payload_bytes".to_string(),
                            description: "payload".to_string(),
                            unit: "By".to_string(),
                            data: Some(metric::Data::ExponentialHistogram(ExponentialHistogram {
                                data_points: vec![ExponentialHistogramDataPoint {
                                    attributes: vec![string_kv("route", "/checkout")],
                                    start_time_unix_nano: base.start_time_unix_nano,
                                    time_unix_nano: base.time_unix_nano,
                                    count: 5,
                                    sum: Some(500.0),
                                    scale: 2,
                                    zero_count: 1,
                                    positive: Some(exponential_histogram_data_point::Buckets {
                                        offset: -1,
                                        bucket_counts: vec![2, 3],
                                    }),
                                    negative: Some(exponential_histogram_data_point::Buckets {
                                        offset: 0,
                                        bucket_counts: vec![1],
                                    }),
                                    min: Some(1.0),
                                    max: Some(250.0),
                                    ..Default::default()
                                }],
                                aggregation_temporality: AggregationTemporality::Cumulative as i32,
                            })),
                            metadata: Vec::new(),
                        },
                    ],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    #[test]
    fn logs_emit_exactly_the_jsonpaths_declared_in_datasources_ts() {
        let (frames, _) = encode_logs(
            &test_cfg().datasources,
            "org_contract",
            &populated_log_request(),
        )
        .unwrap();
        let row = frame_row(&frames[0]);
        assert_row_keys_match(&row, schema_contract::LOGS, "logs");
        // Spot-check the resource_attributes carry the org id, since OrgId's
        // jsonPath in TS is `$.resource_attributes.maple_org_id`.
        assert_eq!(row["resource_attributes"]["maple_org_id"], "org_contract");
    }

    #[test]
    fn traces_emit_exactly_the_jsonpaths_declared_in_datasources_ts() {
        let (frames, _) = encode_traces(
            &test_cfg().datasources,
            "org_contract",
            &populated_trace_request(),
            &SamplingPolicy::default(),
            &[],
        )
        .unwrap();
        let row = frame_row(&frames[0]);
        assert_row_keys_match(&row, schema_contract::TRACES, "traces");
        assert_eq!(row["resource_attributes"]["maple_org_id"], "org_contract");
    }

    #[test]
    fn metrics_emit_exactly_the_jsonpaths_declared_in_datasources_ts() {
        let (frames, _) = encode_metrics(
            &test_cfg().datasources,
            "org_contract",
            &one_of_each_metric_request(),
        )
        .unwrap();
        let rows = frame_rows_by_datasource(frames);
        assert_row_keys_match(
            &rows["metrics_sum"],
            &schema_contract::metrics_sum(),
            "metrics_sum",
        );
        assert_row_keys_match(
            &rows["metrics_gauge"],
            &schema_contract::metrics_gauge(),
            "metrics_gauge",
        );
        assert_row_keys_match(
            &rows["metrics_histogram"],
            &schema_contract::metrics_histogram(),
            "metrics_histogram",
        );
        assert_row_keys_match(
            &rows["metrics_exponential_histogram"],
            &schema_contract::metrics_exponential_histogram(),
            "metrics_exponential_histogram",
        );
    }

    #[test]
    fn timestamps_match_clickhouse_datetime64_nine_format() {
        // ClickHouse `DateTime64(9)` accepts `YYYY-MM-DD HH:MM:SS.fffffffff`
        // (nanosecond precision). Every timestamp-bearing column must match.
        let pattern = |s: &str| {
            s.len() == 29
                && &s[4..5] == "-"
                && &s[7..8] == "-"
                && &s[10..11] == " "
                && &s[13..14] == ":"
                && &s[16..17] == ":"
                && &s[19..20] == "."
                && s[..4].chars().all(|c| c.is_ascii_digit())
                && s[5..7].chars().all(|c| c.is_ascii_digit())
                && s[8..10].chars().all(|c| c.is_ascii_digit())
                && s[11..13].chars().all(|c| c.is_ascii_digit())
                && s[14..16].chars().all(|c| c.is_ascii_digit())
                && s[17..19].chars().all(|c| c.is_ascii_digit())
                && s[20..].chars().all(|c| c.is_ascii_digit())
        };

        let (log_frames, _) = encode_logs(
            &test_cfg().datasources,
            "org_contract",
            &populated_log_request(),
        )
        .unwrap();
        let log_row = frame_row(&log_frames[0]);
        let ts = log_row["timestamp"].as_str().unwrap();
        assert!(pattern(ts), "logs.timestamp not DateTime64(9): {ts:?}");

        let (trace_frames, _) = encode_traces(
            &test_cfg().datasources,
            "org_contract",
            &populated_trace_request(),
            &SamplingPolicy::default(),
            &[],
        )
        .unwrap();
        let trace_row = frame_row(&trace_frames[0]);
        let ts = trace_row["start_time"].as_str().unwrap();
        assert!(pattern(ts), "traces.start_time not DateTime64(9): {ts:?}");

        let (metric_frames, _) = encode_metrics(
            &test_cfg().datasources,
            "org_contract",
            &one_of_each_metric_request(),
        )
        .unwrap();
        for frame in &metric_frames {
            let row = frame_row(frame);
            let start_ts = row["start_timestamp"].as_str().unwrap();
            let ts = row["timestamp"].as_str().unwrap();
            assert!(
                pattern(start_ts),
                "{}.start_timestamp not DateTime64(9): {start_ts:?}",
                frame.datasource
            );
            assert!(
                pattern(ts),
                "{}.timestamp not DateTime64(9): {ts:?}",
                frame.datasource
            );
        }
    }

    #[test]
    fn custom_datasource_names_propagate_to_frames() {
        // Operators can rebind each datasource via `INGEST_TINYBIRD_DATASOURCE_*`
        // env vars. The frames emitted by the encoders must carry the
        // configured name (which becomes the `name` query parameter on the
        // Tinybird import call), not the hardcoded default.
        let names = DatasourceNames {
            traces: "tenant_traces_v2".into(),
            logs: "tenant_logs_v2".into(),
            metrics_sum: "tenant_sum_v2".into(),
            metrics_gauge: "tenant_gauge_v2".into(),
            metrics_histogram: "tenant_hist_v2".into(),
            metrics_exponential_histogram: "tenant_exp_v2".into(),
        };

        let (log_frames, _) =
            encode_logs(&names, "org_contract", &populated_log_request()).unwrap();
        assert_eq!(log_frames[0].datasource, "tenant_logs_v2");

        let (trace_frames, _) = encode_traces(
            &names,
            "org_contract",
            &populated_trace_request(),
            &SamplingPolicy::default(),
            &[],
        )
        .unwrap();
        assert_eq!(trace_frames[0].datasource, "tenant_traces_v2");

        let (metric_frames, _) =
            encode_metrics(&names, "org_contract", &one_of_each_metric_request()).unwrap();
        let emitted: std::collections::BTreeSet<_> = metric_frames
            .iter()
            .map(|f| f.datasource.as_str())
            .collect();
        assert!(emitted.contains("tenant_sum_v2"));
        assert!(emitted.contains("tenant_gauge_v2"));
        assert!(emitted.contains("tenant_hist_v2"));
        assert!(emitted.contains("tenant_exp_v2"));
    }

    #[test]
    fn clickhouse_insert_mappings_cover_otlp_and_session_datasources() {
        for datasource in [
            "traces",
            "logs",
            "metrics_sum",
            "metrics_gauge",
            "metrics_histogram",
            "metrics_exponential_histogram",
            "session_replays",
            "session_replay_events",
            "session_events",
        ] {
            let mapping = clickhouse_insert_mappings::mapping_for(datasource)
                .unwrap_or_else(|| panic!("missing ClickHouse mapping for {datasource}"));
            assert_eq!(mapping.datasource, datasource);
            assert!(
                mapping.columns.contains(&"OrgId"),
                "{datasource} mapping must pin OrgId"
            );
            assert!(
                mapping
                    .selects
                    .contains(&clickhouse_insert_mappings::ORG_PLACEHOLDER),
                "{datasource} mapping must replace OrgId with authenticated org"
            );
            assert!(
                !mapping.input_schema.contains("OrgId"),
                "{datasource} input schema should read snake_case JSON, not PascalCase OrgId"
            );
        }
    }

    #[test]
    fn clickhouse_insert_sql_uses_input_table_function() {
        let mapping = clickhouse_insert_mappings::mapping_for("logs").expect("logs mapping");
        let sql = build_clickhouse_insert_sql(mapping, "org_'one");
        assert!(sql.starts_with("INSERT INTO logs (OrgId, Timestamp"));
        assert!(sql.contains("SELECT 'org_\\'one', timestamp, timestamp"));
        assert!(sql.contains("FROM input('timestamp DateTime64(9)"));
        assert!(sql.ends_with("FORMAT JSONEachRow"));
        assert!(!sql.contains("payment failed"));
    }

    #[test]
    fn logs_severity_text_falls_back_to_mapped_number() {
        // Tinybird's `SeverityText` column expects a non-empty string when the
        // SDK left only a numeric severity; the encoder maps the OTLP severity
        // number to the canonical text label.
        let mut request = populated_log_request();
        request.resource_logs[0].scope_logs[0].log_records[0]
            .severity_text
            .clear();
        request.resource_logs[0].scope_logs[0].log_records[0].severity_number = 9; // INFO
        let (frames, _) = encode_logs(&test_cfg().datasources, "org_contract", &request).unwrap();
        let row = frame_row(&frames[0]);
        assert_eq!(row["severity_text"], "INFO");
    }

    #[test]
    fn logs_use_observed_time_when_time_unix_nano_is_zero() {
        // Per OTLP spec the receiver should fall back to observed_time when the
        // emitter didn't set time_unix_nano. The encoder honors this so that
        // the `Timestamp` column is never the epoch.
        let mut request = populated_log_request();
        request.resource_logs[0].scope_logs[0].log_records[0].time_unix_nano = 0;
        request.resource_logs[0].scope_logs[0].log_records[0].observed_time_unix_nano =
            1_700_000_100_000_000_000;
        let (frames, _) = encode_logs(&test_cfg().datasources, "org_contract", &request).unwrap();
        let row = frame_row(&frames[0]);
        assert_eq!(row["timestamp"], "2023-11-14 22:15:00.000000000");
    }

    #[test]
    fn metrics_summary_data_points_are_dropped() {
        // The encoder does not support Summary metrics (no Tinybird datasource);
        // dropping silently is intentional but worth pinning so an accidental
        // schema addition is noticed.
        use opentelemetry_proto::tonic::metrics::v1::{
            summary_data_point, Summary, SummaryDataPoint,
        };
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![string_kv("service.name", "api")],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_metrics: vec![opentelemetry_proto::tonic::metrics::v1::ScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "meter".to_string(),
                        version: "1.0.0".to_string(),
                        attributes: Vec::new(),
                        dropped_attributes_count: 0,
                    }),
                    metrics: vec![Metric {
                        name: "summary_metric".to_string(),
                        description: "".into(),
                        unit: "".into(),
                        data: Some(metric::Data::Summary(Summary {
                            data_points: vec![SummaryDataPoint {
                                attributes: vec![],
                                start_time_unix_nano: 0,
                                time_unix_nano: 1_700_000_000_000_000_000,
                                count: 1,
                                sum: 1.0,
                                quantile_values: vec![summary_data_point::ValueAtQuantile {
                                    quantile: 0.5,
                                    value: 1.0,
                                }],
                                flags: 0,
                            }],
                        })),
                        metadata: Vec::new(),
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };
        let (frames, stats) =
            encode_metrics(&test_cfg().datasources, "org_contract", &request).unwrap();
        assert!(
            frames.is_empty(),
            "summary metrics should not produce frames"
        );
        assert_eq!(stats.rows, 0);
    }

    #[tokio::test]
    async fn pipeline_e2e_exports_traces_to_fake_tinybird() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_test_dir("fake-tinybird-traces");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{addr}");
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);

        let pipeline = TelemetryPipeline::new(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        )
        .await
        .unwrap();

        let request = populated_trace_request();
        let stats = pipeline
            .accept_traces("org_contract", &request, &SamplingPolicy::default(), &[])
            .await
            .unwrap();
        assert_eq!(stats.rows, 1);

        let import = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("fake Tinybird should receive a traces import")
            .expect("fake Tinybird channel should stay open");

        assert_eq!(import.datasource, "traces");
        assert_eq!(import.authorization, "Bearer token");
        assert_eq!(import.content_encoding, "gzip");

        let row: Value = serde_json::from_str(import.body.trim()).unwrap();
        assert_row_keys_match(&row, schema_contract::TRACES, "traces");
        assert_eq!(row["span_kind"], "Server");
        assert_eq!(row["status_code"], "Ok");

        wait_for_export_drain(queue_dir.clone(), 0, ExportDestination::Tinybird).await;
        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn pipeline_e2e_exports_metrics_to_fake_tinybird() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_test_dir("fake-tinybird-metrics");
        let mut cfg = test_cfg();
        cfg.endpoint = format!("http://{addr}");
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.batch_max_wait = Duration::from_millis(1);

        let pipeline = TelemetryPipeline::new(
            cfg,
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        )
        .await
        .unwrap();

        let stats = pipeline
            .accept_metrics("org_contract", &one_of_each_metric_request())
            .await
            .unwrap();
        assert_eq!(stats.rows, 4);

        // Collect 4 imports — one per metric datasource.
        let mut by_datasource: BTreeMap<String, FakeTinybirdImport> = BTreeMap::new();
        for _ in 0..4 {
            let import = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("fake Tinybird should receive each metric datasource import")
                .expect("fake Tinybird channel should stay open");
            by_datasource.insert(import.datasource.clone(), import);
        }

        for (datasource, expected_keys) in [
            ("metrics_sum", schema_contract::metrics_sum()),
            ("metrics_gauge", schema_contract::metrics_gauge()),
            ("metrics_histogram", schema_contract::metrics_histogram()),
            (
                "metrics_exponential_histogram",
                schema_contract::metrics_exponential_histogram(),
            ),
        ] {
            let import = by_datasource
                .remove(datasource)
                .unwrap_or_else(|| panic!("missing import for {datasource}"));
            assert_eq!(import.authorization, "Bearer token");
            assert_eq!(import.content_encoding, "gzip");
            let row: Value = serde_json::from_str(import.body.trim()).unwrap();
            assert_row_keys_match(&row, &expected_keys, datasource);
        }

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn wal_truncates_after_full_drain_allowing_further_appends() {
        // Regression: pre-fix, ShardedWal::append() only checked file-size-vs-max
        // and the file was never truncated. After max_bytes was hit, the shard
        // refused all further appends — even with every prior frame successfully
        // exported. Now mark_exported() truncates the data file when the cursor
        // catches up to EOF, so a steady-state pipeline never wedges.
        let queue_dir = unique_test_dir("wal-truncates-on-drain");
        std::fs::create_dir_all(&queue_dir).unwrap();
        let mut cfg = test_cfg();
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        // Per-lane budget is queue_max_bytes / LANES_PER_SHARD, so size the total
        // to leave each lane the ~512-byte budget this test exercises.
        cfg.queue_max_bytes = 512 * LANES_PER_SHARD as u64;

        let wal = ShardedWal::open(&cfg).expect("open WAL");

        let frame = EncodedFrame {
            routing_key: 0,
            org_id: "org_contract".to_string(),
            signal: TelemetrySignal::Traces,
            destination: ExportDestination::Tinybird,
            datasource: "traces".to_string(),
            row_count: 1,
            payload: vec![0u8; 200],
        };

        // First two appends fit (each ~240 bytes encoded, ≤512 budget).
        let (start_a, end_a) = wal.append(0, &frame).await.expect("first append");
        assert_eq!(start_a, 0);
        let (start_b, end_b) = wal.append(0, &frame).await.expect("second append");
        assert_eq!(start_b, end_a);

        // Third append would overflow before the fix would let us truncate.
        wal.append(0, &frame)
            .await
            .err()
            .expect("third append exceeds shard budget");

        // Drain the cursor to EOF — this should truncate the lane file.
        wal.mark_exported(0, end_b).await.expect("mark_exported");

        let shard_path = queue_dir.join("shard-000-tinybird.wal");
        let size_after_drain = std::fs::metadata(&shard_path).unwrap().len();
        assert_eq!(
            size_after_drain, 0,
            "lane file should be truncated to 0 after full drain"
        );

        let cursor_after_drain =
            std::fs::read_to_string(queue_dir.join("shard-000-tinybird.cursor")).unwrap();
        assert_eq!(
            cursor_after_drain.trim(),
            "0",
            "cursor should reset to 0 after truncate"
        );

        // The shard accepts new writes again — previously this would still fail
        // because the file size, not cursor delta, was the gating signal.
        let (start_c, _end_c) = wal
            .append(0, &frame)
            .await
            .expect("append after drain should succeed");
        assert_eq!(start_c, 0, "next append starts from a fresh file");

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[tokio::test]
    async fn wal_partial_drain_advances_cursor_without_truncating() {
        // When mark_exported() lands while writers are still ahead of the cursor,
        // we must NOT truncate — that would erase frames that haven't been
        // exported yet. We only persist the offset.
        let queue_dir = unique_test_dir("wal-partial-drain");
        std::fs::create_dir_all(&queue_dir).unwrap();
        let mut cfg = test_cfg();
        cfg.queue_dir = queue_dir.clone();
        cfg.wal_shards = 1;
        cfg.queue_max_bytes = 4096;

        let wal = ShardedWal::open(&cfg).expect("open WAL");
        let frame = EncodedFrame {
            routing_key: 0,
            org_id: "org_contract".to_string(),
            signal: TelemetrySignal::Traces,
            destination: ExportDestination::Tinybird,
            datasource: "traces".to_string(),
            row_count: 1,
            payload: vec![0u8; 100],
        };

        let (_, end_a) = wal.append(0, &frame).await.unwrap();
        let (_, end_b) = wal.append(0, &frame).await.unwrap();
        assert!(end_b > end_a);

        // Cursor advances to the first frame's end while frame B is still
        // unexported (writer is ahead of reader).
        wal.mark_exported(0, end_a).await.unwrap();

        let shard_path = queue_dir.join("shard-000-tinybird.wal");
        let size_after_partial = std::fs::metadata(&shard_path).unwrap().len();
        assert_eq!(
            size_after_partial, end_b,
            "lane file must keep unexported bytes when cursor is behind EOF"
        );
        let cursor_after_partial =
            std::fs::read_to_string(queue_dir.join("shard-000-tinybird.cursor")).unwrap();
        assert_eq!(cursor_after_partial.trim(), end_a.to_string());

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    /// Cross-language contract with the Prometheus scraper (apps/scraper).
    ///
    /// The scraper converts scraped exposition text into OTLP/JSON
    /// (`convertFamiliesToOtlp` in apps/scraper/src/prometheus/otlp.ts) and
    /// POSTs it to this gateway's `/v1/metrics` with the org's public ingest
    /// key, so scraped metrics are billed and warehouse-routed like customer
    /// traffic. The fixture below is generated by that converter and pinned
    /// on the TS side in apps/scraper/src/prometheus/otlp.test.ts ("gateway
    /// contract fixture"). If either side changes shape, both tests must be
    /// updated together.
    mod scraper_contract {
        use super::*;

        const SCRAPER_FIXTURE: &str =
            include_str!("../../scraper/src/prometheus/__fixtures__/otlp-export.json");

        fn rows_by_datasource(frames: Vec<EncodedFrame>) -> BTreeMap<String, Vec<Value>> {
            frames
                .into_iter()
                .map(|frame| {
                    let payload = std::str::from_utf8(&frame.payload)
                        .unwrap()
                        .trim()
                        .to_string();
                    let rows = payload
                        .lines()
                        .map(|line| serde_json::from_str(line).unwrap())
                        .collect();
                    (frame.datasource.clone(), rows)
                })
                .collect()
        }

        #[test]
        fn scraper_otlp_json_decodes_with_gateway_serde_and_encodes_to_rows() {
            // The deserialization itself is half the contract: it pins string
            // `timeUnixNano`, numeric histogram `count`/`bucketCounts`,
            // flattened oneofs, and camelCase keys.
            let mut request: ExportMetricsServiceRequest = serde_json::from_str(SCRAPER_FIXTURE)
                .expect("scraper OTLP JSON must deserialize with the gateway's serde types");

            // Org attribution is injected by the request handler
            // (`enrich_metrics_request` in main.rs, binary-side) from the
            // resolved ingest key — mirror that here so the row assertions
            // match what production emits.
            for resource_metric in &mut request.resource_metrics {
                let resource = resource_metric
                    .resource
                    .get_or_insert_with(Resource::default);
                resource.attributes.push(KeyValue {
                    key: "maple_org_id".to_string(),
                    value: Some(AnyValue {
                        value: Some(
                            opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(
                                "org_scraper".to_string(),
                            ),
                        ),
                    }),
                });
            }

            let (frames, _) =
                encode_metrics(&test_cfg().datasources, "org_scraper", &request).unwrap();
            let rows = rows_by_datasource(frames);

            // Counter + summary `_sum`/`_count` land in metrics_sum.
            let sums = &rows["metrics_sum"];
            assert_eq!(sums.len(), 3, "expected counter + summary sum/count rows");
            let counter = sums
                .iter()
                .find(|row| row["metric_name"] == "http_requests_total")
                .expect("counter row");
            assert_eq!(counter["value"], 100.0);
            assert_eq!(counter["is_monotonic"], true);
            assert_eq!(counter["aggregation_temporality"], 2);
            assert_eq!(counter["service_name"], "node");
            assert_eq!(counter["metric_attributes"]["code"], "200");
            assert_eq!(counter["metric_attributes"]["job"], "node");
            assert_eq!(counter["metric_attributes"]["env"], "prod");
            // scrapeTimeMs 1750000000000 in the fixture context.
            assert_eq!(counter["timestamp"], "2025-06-15 15:06:40.000000000");
            assert_eq!(counter["start_timestamp"], "1970-01-01 00:00:00.000000000");
            // org attribution comes from the gateway, never the scraper.
            assert_eq!(
                counter["resource_attributes"]["maple_org_id"],
                "org_scraper"
            );
            assert_eq!(
                counter["resource_attributes"]["maple_scrape_target_id"],
                "11111111-1111-4111-8111-111111111111"
            );
            let summary_count = sums
                .iter()
                .find(|row| row["metric_name"] == "rpc_count")
                .expect("summary count row");
            assert_eq!(summary_count["is_monotonic"], true);
            let summary_sum = sums
                .iter()
                .find(|row| row["metric_name"] == "rpc_sum")
                .expect("summary sum row");
            assert_eq!(summary_sum["is_monotonic"], false);

            // Gauge + summary quantile land in metrics_gauge.
            let gauges = &rows["metrics_gauge"];
            assert_eq!(gauges.len(), 2, "expected up + quantile gauge rows");
            let quantile = gauges
                .iter()
                .find(|row| row["metric_name"] == "rpc")
                .expect("quantile gauge row");
            assert_eq!(quantile["metric_attributes"]["quantile"], "0.5");

            // De-cumulated histogram lands in metrics_histogram.
            let histograms = &rows["metrics_histogram"];
            assert_eq!(histograms.len(), 1);
            let histogram = &histograms[0];
            assert_eq!(histogram["metric_name"], "lat");
            assert_eq!(histogram["count"], 10);
            assert_eq!(histogram["sum"], 42.5);
            assert_eq!(histogram["bucket_counts"], serde_json::json!([1, 9]));
            assert_eq!(histogram["explicit_bounds"], serde_json::json!([0.1]));
        }
    }
}
