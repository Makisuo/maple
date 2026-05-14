use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crc32fast::Hasher as Crc32;
use dashmap::DashMap;
use flate2::write::GzEncoder;
use flate2::Compression;
use metrics::{counter, gauge, histogram};
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

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TelemetrySignal {
    Traces,
    Logs,
    Metrics,
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
    pub datasource_traces: String,
    pub datasource_logs: String,
    pub datasource_metrics_sum: String,
    pub datasource_metrics_gauge: String,
    pub datasource_metrics_histogram: String,
    pub datasource_metrics_exponential_histogram: String,
}

impl TinybirdConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.endpoint.is_empty() {
            return Err(
                "TINYBIRD_HOST is required when INGEST_WRITE_MODE uses tinybird".to_string(),
            );
        }
        if self.token.is_empty() {
            return Err(
                "TINYBIRD_TOKEN is required when INGEST_WRITE_MODE uses tinybird".to_string(),
            );
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
    shard_senders: Vec<mpsc::Sender<QueuedFrame>>,
    org_queue_bytes: Arc<DashMap<String, Arc<AtomicU64>>>,
}

#[derive(Clone, Debug)]
struct QueuedFrame {
    shard: usize,
    start: u64,
    end: u64,
    org_id: String,
    queued_bytes: u64,
    signal: TelemetrySignal,
    datasource: String,
    row_count: usize,
    payload: Vec<u8>,
}

#[derive(Debug)]
struct EncodedFrame {
    routing_key: u64,
    org_id: String,
    signal: TelemetrySignal,
    datasource: String,
    row_count: usize,
    payload: Vec<u8>,
}

impl TelemetryPipeline {
    pub async fn new(cfg: TinybirdConfig, http: Client) -> Result<Self, String> {
        cfg.validate()?;
        std::fs::create_dir_all(&cfg.queue_dir)
            .map_err(|error| format!("create ingest WAL dir: {error}"))?;
        let cfg = Arc::new(cfg);
        let wal = Arc::new(ShardedWal::open(&cfg)?);
        let org_queue_bytes = Arc::new(DashMap::new());
        let mut shard_senders = Vec::with_capacity(cfg.wal_shards);

        for shard in 0..cfg.wal_shards {
            let (sender, receiver) = mpsc::channel(cfg.queue_channel_capacity);
            shard_senders.push(sender);
            let worker = ExportWorker {
                shard,
                cfg: Arc::clone(&cfg),
                wal: Arc::clone(&wal),
                org_queue_bytes: Arc::clone(&org_queue_bytes),
                http: http.clone(),
                receiver,
            };
            tokio::spawn(worker.run());
        }

        let pipeline = Self {
            inner: Arc::new(PipelineInner {
                cfg,
                wal,
                shard_senders,
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
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_traces(&self.inner.cfg, org_id, request, sampling_policy)?;
        self.commit_frames(frames).await?;
        Ok(stats)
    }

    pub async fn accept_logs(
        &self,
        org_id: &str,
        request: &ExportLogsServiceRequest,
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_logs(&self.inner.cfg, org_id, request)?;
        self.commit_frames(frames).await?;
        Ok(stats)
    }

    pub async fn accept_metrics(
        &self,
        org_id: &str,
        request: &ExportMetricsServiceRequest,
    ) -> Result<AcceptStats, PipelineError> {
        let (frames, stats) = encode_metrics(&self.inner.cfg, org_id, request)?;
        self.commit_frames(frames).await?;
        Ok(stats)
    }

    async fn commit_frames(&self, frames: Vec<EncodedFrame>) -> Result<(), PipelineError> {
        if frames.is_empty() {
            return Ok(());
        }

        for frame in frames {
            let shard = (frame.routing_key as usize) % self.inner.shard_senders.len();
            let sender = self.inner.shard_senders[shard].clone();
            let permit = sender
                .try_reserve_owned()
                .map_err(|_| PipelineError::Backpressure("Telemetry queue is full"))?;
            let queued_bytes = frame.payload.len() as u64;
            self.reserve_org_queue_bytes(&frame.org_id, queued_bytes)?;
            let (start, end) = self
                .inner
                .wal
                .append(shard, &frame)
                .await
                .map_err(|error| {
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
                counter!(
                    "ingest_org_throttled_total",
                    "org_id" => org_id.to_string(),
                    "reason" => "queue_bytes"
                )
                .increment(1);
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
                gauge!(
                    "ingest_org_queue_bytes",
                    "org_id" => org_id.to_string()
                )
                .set((current + bytes) as f64);
                return Ok(());
            }
        }
    }

    fn release_org_queue_bytes(&self, org_id: &str, bytes: u64) {
        release_org_queue_bytes(&self.inner.org_queue_bytes, org_id, bytes);
    }

    async fn replay_committed_frames(&self) {
        for shard in 0..self.inner.shard_senders.len() {
            let frames = match self.inner.wal.replay(shard).await {
                Ok(frames) => frames,
                Err(error) => {
                    error!(shard, error = %error, "Failed to replay ingest WAL shard");
                    continue;
                }
            };
            if frames.is_empty() {
                continue;
            }
            info!(
                shard,
                frames = frames.len(),
                "Replaying committed ingest WAL frames"
            );
            for frame in frames {
                add_org_queue_bytes(
                    &self.inner.org_queue_bytes,
                    &frame.org_id,
                    frame.queued_bytes,
                );
                if self.inner.shard_senders[shard].send(frame).await.is_err() {
                    error!(shard, "Ingest WAL replay worker stopped");
                    break;
                }
            }
        }
    }
}

struct ShardedWal {
    shards: Vec<Arc<WalShard>>,
}

struct WalShard {
    path: PathBuf,
    cursor_path: PathBuf,
    max_bytes: u64,
    file: Mutex<File>,
}

impl ShardedWal {
    fn open(cfg: &TinybirdConfig) -> Result<Self, String> {
        let mut shards = Vec::with_capacity(cfg.wal_shards);
        let max_bytes_per_shard = (cfg.queue_max_bytes / cfg.wal_shards as u64).max(1);
        for shard in 0..cfg.wal_shards {
            let path = cfg.queue_dir.join(format!("shard-{shard:03}.wal"));
            let cursor_path = cfg.queue_dir.join(format!("shard-{shard:03}.cursor"));
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .append(true)
                .open(&path)
                .map_err(|error| format!("open ingest WAL {path:?}: {error}"))?;
            shards.push(Arc::new(WalShard {
                path,
                cursor_path,
                max_bytes: max_bytes_per_shard,
                file: Mutex::new(file),
            }));
        }
        Ok(Self { shards })
    }

    async fn append(&self, shard: usize, frame: &EncodedFrame) -> Result<(u64, u64), String> {
        let shard_ref = Arc::clone(
            self.shards
                .get(shard)
                .ok_or_else(|| format!("invalid WAL shard {shard}"))?,
        );
        let encoded = encode_wal_frame(frame)?;
        tokio::task::spawn_blocking(move || {
            let mut file = shard_ref
                .file
                .lock()
                .map_err(|_| "WAL shard mutex poisoned".to_string())?;
            let start = file
                .seek(SeekFrom::End(0))
                .map_err(|error| format!("seek WAL: {error}"))?;
            if start.saturating_add(encoded.len() as u64) > shard_ref.max_bytes {
                return Err("Telemetry WAL shard is full".to_string());
            }
            file.write_all(&encoded)
                .map_err(|error| format!("write WAL: {error}"))?;
            file.sync_data()
                .map_err(|error| format!("sync WAL: {error}"))?;
            let end = start + encoded.len() as u64;
            histogram!("ingest_wal_commit_bytes", "shard" => shard.to_string())
                .record(encoded.len() as f64);
            Ok((start, end))
        })
        .await
        .map_err(|error| format!("join WAL append: {error}"))?
    }

    async fn replay(&self, shard: usize) -> Result<Vec<QueuedFrame>, String> {
        let shard_ref = Arc::clone(
            self.shards
                .get(shard)
                .ok_or_else(|| format!("invalid WAL shard {shard}"))?,
        );
        tokio::task::spawn_blocking(move || replay_shard(shard, &shard_ref))
            .await
            .map_err(|error| format!("join WAL replay: {error}"))?
    }

    async fn mark_exported(&self, shard: usize, offset: u64) -> Result<(), String> {
        let shard_ref = Arc::clone(
            self.shards
                .get(shard)
                .ok_or_else(|| format!("invalid WAL shard {shard}"))?,
        );
        tokio::task::spawn_blocking(move || {
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&shard_ref.cursor_path)
                .map_err(|error| format!("open WAL cursor: {error}"))?;
            file.write_all(offset.to_string().as_bytes())
                .map_err(|error| format!("write WAL cursor: {error}"))?;
            file.sync_data()
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

fn replay_shard(shard: usize, shard_ref: &WalShard) -> Result<Vec<QueuedFrame>, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(&shard_ref.path)
        .map_err(|error| format!("open WAL replay: {error}"))?;
    let mut offset = read_cursor(&shard_ref.cursor_path);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek WAL replay: {error}"))?;

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
            datasource: frame.datasource,
            row_count: frame.row_count,
            payload: frame.payload,
        });
        offset = frame.end;
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
    crc.update(org_id);
    crc.update(datasource);
    crc.update(&frame.payload);
    let checksum = crc.finalize();

    let mut out = Vec::with_capacity(
        WAL_V2_HEADER_LEN + org_id.len() + datasource.len() + frame.payload.len(),
    );
    out.extend_from_slice(WAL_MAGIC);
    out.push(2);
    out.push(signal_tag(frame.signal));
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

    let (org_id_len, datasource_len, payload_len, row_count, checksum, header_len) = match version {
        1 => {
            let mut rest = [0u8; WAL_V1_HEADER_LEN - 6];
            file.read_exact(&mut rest)
                .map_err(|error| format!("read WAL v1 header: {error}"))?;
            (
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
                u16::from_le_bytes([rest[2], rest[3]]) as usize,
                u16::from_le_bytes([rest[0], rest[1]]) as usize,
                u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize,
                u32::from_le_bytes([rest[8], rest[9], rest[10], rest[11]]) as usize,
                u32::from_le_bytes([rest[12], rest[13], rest[14], rest[15]]),
                WAL_V2_HEADER_LEN,
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
    }
}

fn signal_from_tag(tag: u8) -> Option<TelemetrySignal> {
    match tag {
        1 => Some(TelemetrySignal::Traces),
        2 => Some(TelemetrySignal::Logs),
        3 => Some(TelemetrySignal::Metrics),
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
    gauge!("ingest_org_queue_bytes", "org_id" => org_id.to_string()).set(current as f64);
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
                    gauge!("ingest_org_queue_bytes", "org_id" => org_id.to_string())
                        .set(next as f64);
                    return;
                }
                Err(observed) => current = observed,
            }
        }
    }
}

struct ExportWorker {
    shard: usize,
    cfg: Arc<TinybirdConfig>,
    wal: Arc<ShardedWal>,
    org_queue_bytes: Arc<DashMap<String, Arc<AtomicU64>>>,
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
                error!(shard = self.shard, error = %error, "Tinybird export worker failed batch");
            }
        }
    }

    async fn export_and_mark(&self, frames: Vec<QueuedFrame>) -> Result<(), String> {
        if frames.is_empty() {
            return Ok(());
        }
        let mut by_datasource: BTreeMap<String, Vec<&QueuedFrame>> = BTreeMap::new();
        for frame in &frames {
            by_datasource
                .entry(frame.datasource.clone())
                .or_default()
                .push(frame);
        }

        let start = Instant::now();
        let first_signal = frames[0].signal;
        let first_shard = frames[0].shard;
        let first_offset = frames[0].start;
        for (datasource, frames) in by_datasource {
            let mut body = Vec::new();
            let mut rows = 0usize;
            for frame in frames {
                body.extend_from_slice(&frame.payload);
                if !body.ends_with(b"\n") {
                    body.push(b'\n');
                }
                rows += frame.row_count;
            }
            self.post_tinybird(&datasource, body, rows).await?;
        }

        let end = frames.iter().map(|frame| frame.end).max().unwrap_or(0);
        self.wal.mark_exported(self.shard, end).await?;
        for frame in &frames {
            release_org_queue_bytes(&self.org_queue_bytes, &frame.org_id, frame.queued_bytes);
        }
        histogram!("ingest_export_batch_duration_seconds", "shard" => self.shard.to_string())
            .record(start.elapsed().as_secs_f64());
        histogram!(
            "ingest_wal_exported_bytes",
            "signal" => format!("{first_signal:?}"),
            "shard" => first_shard.to_string()
        )
        .record(end.saturating_sub(first_offset) as f64);
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
        let compressed = gzip(body)?;
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

            match response {
                Ok(response) if response.status().is_success() => {
                    histogram!("ingest_tinybird_export_duration_seconds", "datasource" => datasource.to_string(), "status" => "2xx")
                        .record(started.elapsed().as_secs_f64());
                    counter!("ingest_tinybird_export_rows_total", "datasource" => datasource.to_string())
                        .increment(rows as u64);
                    return Ok(());
                }
                Ok(response) if response.status().is_client_error() => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    counter!("ingest_tinybird_export_dropped_total", "datasource" => datasource.to_string(), "status" => status.to_string())
                        .increment(rows as u64);
                    warn!(datasource, status, body = %body, rows, "Dropping non-retryable Tinybird batch");
                    return Ok(());
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    counter!("ingest_tinybird_export_retries_total", "datasource" => datasource.to_string(), "status" => status.to_string())
                        .increment(1);
                    warn!(datasource, status, attempt, "Retrying Tinybird batch");
                }
                Err(error) => {
                    counter!("ingest_tinybird_export_retries_total", "datasource" => datasource.to_string(), "status" => "transport")
                        .increment(1);
                    warn!(datasource, attempt, error = %error, "Retrying Tinybird batch after transport error");
                }
            }

            attempt = attempt.saturating_add(1);
            let backoff_ms = 250u64.saturating_mul(2u64.saturating_pow(attempt.min(6)));
            sleep(Duration::from_millis(backoff_ms.min(30_000))).await;
        }
    }
}

fn batch_full(cfg: &TinybirdConfig, frames: &[QueuedFrame]) -> bool {
    let rows: usize = frames.iter().map(|frame| frame.row_count).sum();
    let bytes: usize = frames.iter().map(|frame| frame.payload.len()).sum();
    rows >= cfg.batch_max_rows || bytes >= cfg.batch_max_bytes
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
    cfg: &TinybirdConfig,
    org_id: &str,
    request: &ExportTraceServiceRequest,
    policy: &SamplingPolicy,
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
        cfg.datasource_traces.clone(),
        rows,
    );
    Ok((frames, stats))
}

fn encode_logs(
    cfg: &TinybirdConfig,
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
        cfg.datasource_logs.clone(),
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
    cfg: &TinybirdConfig,
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
                                &cfg.datasource_metrics_gauge,
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
                                &cfg.datasource_metrics_sum,
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
                                &cfg.datasource_metrics_histogram,
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
                                &cfg.datasource_metrics_exponential_histogram,
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
                        counter!("ingest_metrics_summary_dropped_total").increment(1);
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
    use axum::http::header::{AUTHORIZATION, CONTENT_ENCODING};
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
            datasource_traces: "traces".to_string(),
            datasource_logs: "logs".to_string(),
            datasource_metrics_sum: "metrics_sum".to_string(),
            datasource_metrics_gauge: "metrics_gauge".to_string(),
            datasource_metrics_histogram: "metrics_histogram".to_string(),
            datasource_metrics_exponential_histogram: "metrics_exponential_histogram".to_string(),
        }
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

    async fn wait_for_cursor(cursor_path: PathBuf) -> u64 {
        tokio::time::timeout(Duration::from_secs(2), async move {
            loop {
                if let Ok(cursor) = std::fs::read_to_string(&cursor_path) {
                    if let Ok(offset) = cursor.trim().parse::<u64>() {
                        if offset > 0 {
                            return offset;
                        }
                    }
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("export worker should commit a WAL cursor after Tinybird success")
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

        let (frames, stats) =
            encode_traces(&test_cfg(), "org_1", &request, &SamplingPolicy::default()).unwrap();
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

        let (frames, stats) = encode_logs(&test_cfg(), "org_1", &request).unwrap();
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

        assert!(wait_for_cursor(queue_dir.join("shard-000.cursor")).await > 0);
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

        let (frames, stats) = encode_metrics(&test_cfg(), "org_1", &request).unwrap();
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
        let (frames, _) = encode_logs(&test_cfg(), "org_contract", &populated_log_request()).unwrap();
        let row = frame_row(&frames[0]);
        assert_row_keys_match(&row, schema_contract::LOGS, "logs");
        // Spot-check the resource_attributes carry the org id, since OrgId's
        // jsonPath in TS is `$.resource_attributes.maple_org_id`.
        assert_eq!(row["resource_attributes"]["maple_org_id"], "org_contract");
    }

    #[test]
    fn traces_emit_exactly_the_jsonpaths_declared_in_datasources_ts() {
        let (frames, _) =
            encode_traces(&test_cfg(), "org_contract", &populated_trace_request(), &SamplingPolicy::default())
                .unwrap();
        let row = frame_row(&frames[0]);
        assert_row_keys_match(&row, schema_contract::TRACES, "traces");
        assert_eq!(row["resource_attributes"]["maple_org_id"], "org_contract");
    }

    #[test]
    fn metrics_emit_exactly_the_jsonpaths_declared_in_datasources_ts() {
        let (frames, _) = encode_metrics(&test_cfg(), "org_contract", &one_of_each_metric_request()).unwrap();
        let rows = frame_rows_by_datasource(frames);
        assert_row_keys_match(&rows["metrics_sum"], &schema_contract::metrics_sum(), "metrics_sum");
        assert_row_keys_match(&rows["metrics_gauge"], &schema_contract::metrics_gauge(), "metrics_gauge");
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

        let (log_frames, _) =
            encode_logs(&test_cfg(), "org_contract", &populated_log_request()).unwrap();
        let log_row = frame_row(&log_frames[0]);
        let ts = log_row["timestamp"].as_str().unwrap();
        assert!(pattern(ts), "logs.timestamp not DateTime64(9): {ts:?}");

        let (trace_frames, _) =
            encode_traces(&test_cfg(), "org_contract", &populated_trace_request(), &SamplingPolicy::default())
                .unwrap();
        let trace_row = frame_row(&trace_frames[0]);
        let ts = trace_row["start_time"].as_str().unwrap();
        assert!(pattern(ts), "traces.start_time not DateTime64(9): {ts:?}");

        let (metric_frames, _) =
            encode_metrics(&test_cfg(), "org_contract", &one_of_each_metric_request()).unwrap();
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
        let mut cfg = test_cfg();
        cfg.datasource_logs = "tenant_logs_v2".into();
        cfg.datasource_traces = "tenant_traces_v2".into();
        cfg.datasource_metrics_sum = "tenant_sum_v2".into();
        cfg.datasource_metrics_gauge = "tenant_gauge_v2".into();
        cfg.datasource_metrics_histogram = "tenant_hist_v2".into();
        cfg.datasource_metrics_exponential_histogram = "tenant_exp_v2".into();

        let (log_frames, _) = encode_logs(&cfg, "org_contract", &populated_log_request()).unwrap();
        assert_eq!(log_frames[0].datasource, "tenant_logs_v2");

        let (trace_frames, _) =
            encode_traces(&cfg, "org_contract", &populated_trace_request(), &SamplingPolicy::default())
                .unwrap();
        assert_eq!(trace_frames[0].datasource, "tenant_traces_v2");

        let (metric_frames, _) =
            encode_metrics(&cfg, "org_contract", &one_of_each_metric_request()).unwrap();
        let datasources: std::collections::BTreeSet<_> =
            metric_frames.iter().map(|f| f.datasource.as_str()).collect();
        assert!(datasources.contains("tenant_sum_v2"));
        assert!(datasources.contains("tenant_gauge_v2"));
        assert!(datasources.contains("tenant_hist_v2"));
        assert!(datasources.contains("tenant_exp_v2"));
    }

    #[test]
    fn logs_severity_text_falls_back_to_mapped_number() {
        // Tinybird's `SeverityText` column expects a non-empty string when the
        // SDK left only a numeric severity; the encoder maps the OTLP severity
        // number to the canonical text label.
        let mut request = populated_log_request();
        request.resource_logs[0].scope_logs[0].log_records[0].severity_text.clear();
        request.resource_logs[0].scope_logs[0].log_records[0].severity_number = 9; // INFO
        let (frames, _) = encode_logs(&test_cfg(), "org_contract", &request).unwrap();
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
        let (frames, _) = encode_logs(&test_cfg(), "org_contract", &request).unwrap();
        let row = frame_row(&frames[0]);
        assert_eq!(row["timestamp"], "2023-11-14 22:15:00.000000000");
    }

    #[test]
    fn metrics_summary_data_points_are_dropped() {
        // The encoder does not support Summary metrics (no Tinybird datasource);
        // dropping silently is intentional but worth pinning so an accidental
        // schema addition is noticed.
        use opentelemetry_proto::tonic::metrics::v1::{summary_data_point, Summary, SummaryDataPoint};
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
        let (frames, stats) = encode_metrics(&test_cfg(), "org_contract", &request).unwrap();
        assert!(frames.is_empty(), "summary metrics should not produce frames");
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
            .accept_traces("org_contract", &request, &SamplingPolicy::default())
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

        assert!(wait_for_cursor(queue_dir.join("shard-000.cursor")).await > 0);
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
}
