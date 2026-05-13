use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::header::CONTENT_ENCODING;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use flate2::read::GzDecoder;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message;
use reqwest::Client;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const INGEST_KEY: &str = "maple_pk_loadtest";

#[derive(Clone, Debug)]
struct LoadConfig {
    ingest_mode: IngestMode,
    requests: u64,
    concurrency: usize,
    batch_logs: usize,
    target_rps: Option<u64>,
    ingest_port: u16,
    ingest_bin: PathBuf,
    max_rss_mb: Option<u64>,
    min_rps: Option<f64>,
    queue_dir: PathBuf,
}

#[derive(Clone, Copy, Debug)]
enum IngestMode {
    Tinybird,
    Forward,
}

#[derive(Clone)]
struct FakeTinybirdState {
    imports: Arc<AtomicU64>,
    rows: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ProcessSample {
    rss_kib: u64,
    cpu_percent: f64,
}

#[derive(Debug, Default)]
struct MonitorSummary {
    samples: u64,
    max_rss_kib: u64,
    max_cpu_percent: f64,
    avg_cpu_percent: f64,
}

#[derive(Debug, Serialize)]
struct LoadSummary {
    ingest_mode: &'static str,
    requests: u64,
    successes: u64,
    failures: u64,
    rows_sent: u64,
    rows_exported: u64,
    imports: u64,
    duration_seconds: f64,
    export_catchup_seconds: f64,
    request_rps: f64,
    row_rps: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_rss_mb: f64,
    max_cpu_percent: f64,
    avg_cpu_percent: f64,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), DynError> {
    let cfg = LoadConfig::from_env()?;
    let fake_state = FakeTinybirdState::default();
    let fake_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let fake_addr = fake_listener.local_addr()?;
    let fake_app = Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/v0/events", post(fake_tinybird_import))
        .route("/v1/logs", post(fake_collector_logs))
        .with_state(fake_state.clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(fake_listener, fake_app).await {
            eprintln!("fake Tinybird server failed: {error}");
        }
    });

    let mut ingest = spawn_ingest(&cfg, &format!("http://{fake_addr}"))?;
    wait_for_ingest_health(cfg.ingest_port).await?;

    let (sample_tx, sample_rx) = mpsc::unbounded_channel();
    let monitor_pid = ingest.id();
    let monitor = tokio::spawn(async move { monitor_process(monitor_pid, sample_tx).await });

    let payload = build_logs_payload(cfg.batch_logs)?;
    let started = Instant::now();
    let (successes, failures, mut latencies) = run_load(&cfg, payload).await?;
    let request_duration = started.elapsed();

    let catchup_started = Instant::now();
    let expected_rows = successes.saturating_mul(cfg.batch_logs as u64);
    wait_for_exported_rows(&fake_state, expected_rows).await?;
    let export_catchup = catchup_started.elapsed();

    let _ = ingest.kill();
    let _ = ingest.wait();
    monitor.abort();

    let monitor_summary = summarize_samples(sample_rx);
    latencies.sort_unstable();
    let summary = LoadSummary {
        ingest_mode: cfg.ingest_mode.as_str(),
        requests: cfg.requests,
        successes,
        failures,
        rows_sent: expected_rows,
        rows_exported: fake_state.rows.load(Ordering::Relaxed),
        imports: fake_state.imports.load(Ordering::Relaxed),
        duration_seconds: request_duration.as_secs_f64(),
        export_catchup_seconds: export_catchup.as_secs_f64(),
        request_rps: successes as f64 / request_duration.as_secs_f64().max(0.001),
        row_rps: expected_rows as f64 / request_duration.as_secs_f64().max(0.001),
        p50_ms: percentile_ms(&latencies, 0.50),
        p95_ms: percentile_ms(&latencies, 0.95),
        p99_ms: percentile_ms(&latencies, 0.99),
        max_rss_mb: monitor_summary.max_rss_kib as f64 / 1024.0,
        max_cpu_percent: monitor_summary.max_cpu_percent,
        avg_cpu_percent: monitor_summary.avg_cpu_percent,
    };

    println!("{}", serde_json::to_string_pretty(&summary)?);
    enforce_thresholds(&cfg, &summary)?;
    let _ = std::fs::remove_dir_all(&cfg.queue_dir);
    Ok(())
}

impl LoadConfig {
    fn from_env() -> Result<Self, DynError> {
        let ingest_bin = std::env::var("LOAD_TEST_INGEST_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::current_exe()
                    .expect("current executable path")
                    .with_file_name(format!("maple-ingest{}", std::env::consts::EXE_SUFFIX))
            });

        Ok(Self {
            ingest_mode: IngestMode::from_env()?,
            requests: env_u64("LOAD_TEST_REQUESTS", 10_000)?,
            concurrency: env_usize("LOAD_TEST_CONCURRENCY", 128)?,
            batch_logs: env_usize("LOAD_TEST_BATCH_LOGS", 10)?,
            target_rps: env_optional_u64("LOAD_TEST_TARGET_RPS")?,
            ingest_port: env_u16("LOAD_TEST_INGEST_PORT", 3475)?,
            ingest_bin,
            max_rss_mb: env_optional_u64("LOAD_TEST_MAX_RSS_MB")?,
            min_rps: env_optional_f64("LOAD_TEST_MIN_RPS")?,
            queue_dir: std::env::var("LOAD_TEST_QUEUE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| unique_temp_dir("maple-ingest-load-wal")),
        })
    }
}

impl IngestMode {
    fn from_env() -> Result<Self, DynError> {
        let raw = std::env::var("LOAD_TEST_INGEST_MODE")
            .unwrap_or_else(|_| "tinybird".to_string())
            .trim()
            .to_ascii_lowercase();
        match raw.as_str() {
            "tinybird" | "native" => Ok(Self::Tinybird),
            "forward" | "collector" => Ok(Self::Forward),
            _ => Err("LOAD_TEST_INGEST_MODE must be tinybird or forward".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Tinybird => "tinybird",
            Self::Forward => "forward",
        }
    }
}

impl Default for FakeTinybirdState {
    fn default() -> Self {
        Self {
            imports: Arc::new(AtomicU64::new(0)),
            rows: Arc::new(AtomicU64::new(0)),
            bytes: Arc::new(AtomicU64::new(0)),
        }
    }
}

async fn fake_tinybird_import(
    State(state): State<FakeTinybirdState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    if !query.contains_key("name") {
        return StatusCode::BAD_REQUEST;
    }

    let Some(decoded) = decode_body(&headers, &body) else {
        return StatusCode::BAD_REQUEST;
    };

    state.imports.fetch_add(1, Ordering::Relaxed);
    state.bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
    state.rows.fetch_add(
        decoded.lines().filter(|line| !line.is_empty()).count() as u64,
        Ordering::Relaxed,
    );
    StatusCode::OK
}

async fn fake_collector_logs(State(state): State<FakeTinybirdState>, body: Bytes) -> StatusCode {
    let Ok(request) = ExportLogsServiceRequest::decode(&body[..]) else {
        return StatusCode::BAD_REQUEST;
    };
    let rows = request
        .resource_logs
        .iter()
        .flat_map(|resource_logs| &resource_logs.scope_logs)
        .map(|scope_logs| scope_logs.log_records.len() as u64)
        .sum::<u64>();
    state.imports.fetch_add(1, Ordering::Relaxed);
    state.bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
    state.rows.fetch_add(rows, Ordering::Relaxed);
    StatusCode::OK
}

fn decode_body(headers: &HeaderMap, body: &[u8]) -> Option<String> {
    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase());
    if content_encoding.as_deref() == Some("gzip") {
        let mut decoded = String::new();
        GzDecoder::new(body).read_to_string(&mut decoded).ok()?;
        Some(decoded)
    } else {
        String::from_utf8(body.to_vec()).ok()
    }
}

fn spawn_ingest(cfg: &LoadConfig, tinybird_host: &str) -> Result<Child, DynError> {
    if !cfg.ingest_bin.exists() {
        return Err(format!(
            "ingest binary not found at {}. Run `cargo build --release --bin maple-ingest --bin load_test` first, or set LOAD_TEST_INGEST_BIN.",
            cfg.ingest_bin.display()
        )
        .into());
    }

    std::fs::create_dir_all(&cfg.queue_dir)?;
    let mut command = Command::new(&cfg.ingest_bin);
    command
        .env("INGEST_PORT", cfg.ingest_port.to_string())
        .env("INGEST_WRITE_MODE", cfg.ingest_mode.as_str())
        .env("INGEST_FORWARD_OTLP_ENDPOINT", tinybird_host)
        .env("TINYBIRD_HOST", tinybird_host)
        .env("TINYBIRD_TOKEN", "load-test-token")
        .env("INGEST_KEY_STORE_BACKEND", "static")
        .env("MAPLE_ORG_ID_OVERRIDE", "org_load_test")
        .env("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY", "load-test-hmac-secret")
        .env("INGEST_QUEUE_DIR", &cfg.queue_dir)
        .env("INGEST_WAL_SHARDS", "4")
        .env("INGEST_QUEUE_CHANNEL_CAPACITY", "100000")
        .env("INGEST_QUEUE_MAX_BYTES", "1073741824")
        .env("INGEST_ORG_QUEUE_MAX_BYTES", "1073741824")
        .env("INGEST_BATCH_MAX_ROWS", "5000")
        .env("INGEST_BATCH_MAX_BYTES", "4194304")
        .env("INGEST_BATCH_MAX_WAIT_MS", "10")
        .env("INGEST_ORG_MAX_IN_FLIGHT", "100000")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command.spawn()?)
}

async fn wait_for_ingest_health(port: u16) -> Result<(), DynError> {
    let client = Client::new();
    let url = format!("http://127.0.0.1:{port}/health");
    timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(response) = client.get(&url).send().await {
                if response.status().is_success() {
                    return Ok::<(), DynError>(());
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await?
}

async fn run_load(cfg: &LoadConfig, payload: Vec<u8>) -> Result<(u64, u64, Vec<u128>), DynError> {
    let client = Client::builder()
        .pool_max_idle_per_host(cfg.concurrency)
        .timeout(Duration::from_secs(30))
        .build()?;
    let url = format!("http://127.0.0.1:{}/v1/logs", cfg.ingest_port);
    let next_request = Arc::new(AtomicU64::new(0));
    let successes = Arc::new(AtomicU64::new(0));
    let failures = Arc::new(AtomicU64::new(0));
    let latencies = Arc::new(Mutex::new(Vec::with_capacity(cfg.requests as usize)));
    let started = Instant::now();

    let mut tasks = Vec::with_capacity(cfg.concurrency);
    for _ in 0..cfg.concurrency {
        let client = client.clone();
        let url = url.clone();
        let payload = payload.clone();
        let next_request = Arc::clone(&next_request);
        let successes = Arc::clone(&successes);
        let failures = Arc::clone(&failures);
        let latencies = Arc::clone(&latencies);
        let requests = cfg.requests;
        let target_rps = cfg.target_rps;
        tasks.push(tokio::spawn(async move {
            loop {
                let request_index = next_request.fetch_add(1, Ordering::Relaxed);
                if request_index >= requests {
                    break;
                }
                if let Some(target_rps) = target_rps {
                    pace_request(started, request_index, target_rps).await;
                }

                let request_started = Instant::now();
                let result = client
                    .post(&url)
                    .header(
                        reqwest::header::AUTHORIZATION,
                        format!("Bearer {INGEST_KEY}"),
                    )
                    .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
                    .body(payload.clone())
                    .send()
                    .await;
                let elapsed = request_started.elapsed().as_micros();
                latencies.lock().expect("latencies mutex").push(elapsed);

                match result {
                    Ok(response) if response.status().is_success() => {
                        successes.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {
                        failures.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }));
    }

    for task in tasks {
        task.await?;
    }

    let latencies = Arc::try_unwrap(latencies)
        .map_err(|_| "latencies still shared")?
        .into_inner()
        .map_err(|_| "latencies mutex poisoned")?;
    Ok((
        successes.load(Ordering::Relaxed),
        failures.load(Ordering::Relaxed),
        latencies,
    ))
}

async fn pace_request(started: Instant, request_index: u64, target_rps: u64) {
    if target_rps == 0 {
        return;
    }
    let target_elapsed = Duration::from_secs_f64(request_index as f64 / target_rps as f64);
    let elapsed = started.elapsed();
    if target_elapsed > elapsed {
        sleep(target_elapsed - elapsed).await;
    }
}

async fn wait_for_exported_rows(
    fake_state: &FakeTinybirdState,
    expected_rows: u64,
) -> Result<(), DynError> {
    timeout(Duration::from_secs(30), async {
        loop {
            let rows = fake_state.rows.load(Ordering::Relaxed);
            if rows >= expected_rows {
                return Ok::<(), DynError>(());
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

async fn monitor_process(pid: u32, tx: mpsc::UnboundedSender<ProcessSample>) {
    loop {
        if let Some(sample) = sample_process(pid) {
            let _ = tx.send(sample);
        }
        sleep(Duration::from_millis(500)).await;
    }
}

fn sample_process(pid: u32) -> Option<ProcessSample> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "rss=", "-o", "%cpu="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let mut parts = stdout.split_whitespace();
    let rss_kib = parts.next()?.parse::<u64>().ok()?;
    let cpu_percent = parts.next()?.parse::<f64>().ok()?;
    Some(ProcessSample {
        rss_kib,
        cpu_percent,
    })
}

fn summarize_samples(mut rx: mpsc::UnboundedReceiver<ProcessSample>) -> MonitorSummary {
    let mut summary = MonitorSummary::default();
    let mut cpu_total = 0.0;
    while let Ok(sample) = rx.try_recv() {
        summary.samples += 1;
        summary.max_rss_kib = summary.max_rss_kib.max(sample.rss_kib);
        summary.max_cpu_percent = summary.max_cpu_percent.max(sample.cpu_percent);
        cpu_total += sample.cpu_percent;
    }
    if summary.samples > 0 {
        summary.avg_cpu_percent = cpu_total / summary.samples as f64;
    }
    summary
}

fn build_logs_payload(batch_logs: usize) -> Result<Vec<u8>, DynError> {
    let records = (0..batch_logs)
        .map(|index| LogRecord {
            time_unix_nano: 1_700_000_000_000_000_000 + index as u64,
            observed_time_unix_nano: 1_700_000_000_000_000_000 + index as u64,
            severity_number: 9,
            severity_text: "INFO".to_string(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue(format!(
                    "load test log {index}"
                ))),
            }),
            attributes: vec![string_kv("load_test", "true")],
            ..Default::default()
        })
        .collect();

    let request = ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: vec![string_kv("service.name", "ingest-load-test")],
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: "maple-ingest-load-test".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                log_records: records,
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    };
    Ok(request.encode_to_vec())
}

fn string_kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    }
}

fn percentile_ms(latencies_us: &[u128], percentile: f64) -> f64 {
    if latencies_us.is_empty() {
        return 0.0;
    }
    let index = ((latencies_us.len() - 1) as f64 * percentile).round() as usize;
    latencies_us[index.min(latencies_us.len() - 1)] as f64 / 1000.0
}

fn enforce_thresholds(cfg: &LoadConfig, summary: &LoadSummary) -> Result<(), DynError> {
    if summary.failures > 0 {
        return Err(format!("load test had {} failed requests", summary.failures).into());
    }
    if let Some(min_rps) = cfg.min_rps {
        if summary.request_rps < min_rps {
            return Err(format!(
                "request RPS {:.2} was below LOAD_TEST_MIN_RPS {:.2}",
                summary.request_rps, min_rps
            )
            .into());
        }
    }
    if let Some(max_rss_mb) = cfg.max_rss_mb {
        if summary.max_rss_mb > max_rss_mb as f64 {
            return Err(format!(
                "max RSS {:.2} MiB exceeded LOAD_TEST_MAX_RSS_MB {} MiB",
                summary.max_rss_mb, max_rss_mb
            )
            .into());
        }
    }
    Ok(())
}

fn env_u64(name: &str, default: u64) -> Result<u64, DynError> {
    Ok(match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value.trim().parse()?,
        _ => default,
    })
}

fn env_usize(name: &str, default: usize) -> Result<usize, DynError> {
    Ok(match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value.trim().parse()?,
        _ => default,
    })
}

fn env_u16(name: &str, default: u16) -> Result<u16, DynError> {
    Ok(match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value.trim().parse()?,
        _ => default,
    })
}

fn env_optional_u64(name: &str) -> Result<Option<u64>, DynError> {
    Ok(match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().parse()?),
        _ => None,
    })
}

fn env_optional_f64(name: &str) -> Result<Option<f64>, DynError> {
    Ok(match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().parse()?),
        _ => None,
    })
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
