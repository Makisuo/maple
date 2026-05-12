#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod autumn;
mod telemetry;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use autumn::AutumnTracker;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::header::{HeaderName, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::DateTime;
use dashmap::DashMap;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use metrics::{counter, gauge, histogram};
use moka::future::Cache;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue as OtelKeyValue;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_sdk::runtime::Tokio as OtelTokio;
use opentelemetry_sdk::trace::span_processor_with_async_runtime::BatchSpanProcessor;
use opentelemetry_sdk::trace::{BatchConfigBuilder, SdkTracerProvider};
use opentelemetry_sdk::Resource as OtelResource;
use prost::Message;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::Sha256;
use telemetry::{PipelineError, SamplingPolicy, TelemetryPipeline, TinybirdConfig};
use tower_http::cors::{Any, CorsLayer};
use tracing::Instrument;
use tracing::{debug, error, info, warn, Span};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const INGEST_SOURCE: &str = "maple-ingest-gateway";
const CLOUDFLARE_LOGPUSH_SOURCE: &str = "cloudflare-logpush";

/// Bearer token literal that the maple-onboard skill (and our docs) inline as a
/// placeholder while the user hasn't created a real ingest key yet. The
/// gateway accepts it from anyone, returns 200, and discards the body — so the
/// instrumented app's full bootstrap path can run end-to-end before the user
/// has signed up. See `skills/maple-onboard/SKILL.md`.
const SENTINEL_TOKEN: &str = "MAPLE_TEST";
const SENTINEL_ORG_ID: &str = "sentinel";

/// Fixed input for the startup HMAC fingerprint. Hashing this with the
/// configured `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` yields a value that operators
/// can diff against the API's fingerprint to detect env-var drift between the
/// two services. The sentinel must stay byte-identical with the API
/// (`packages/db/src/ingest-key-hash.ts`); changing it on one side without the
/// other defeats the comparison.
const HMAC_FINGERPRINT_SENTINEL: &str = "MAPLE_HMAC_FINGERPRINT_V1";

fn is_sentinel_token(token: &str) -> bool {
    token == SENTINEL_TOKEN
}

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct AppConfig {
    port: u16,
    otlp_grpc_port: Option<u16>,
    forward_endpoint: String,
    forward_self_managed_endpoint: Option<String>,
    forward_timeout: Duration,
    write_mode: WriteMode,
    tinybird: TinybirdConfig,
    max_request_body_bytes: usize,
    org_max_in_flight: u64,
    require_tls: bool,
    key_store_backend: KeyStoreBackend,
    lookup_hmac_key: String,
    autumn_secret_key: Option<String>,
    autumn_api_url: String,
    autumn_flush_interval_secs: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WriteMode {
    Tinybird,
    Forward,
    Dual,
}

impl WriteMode {
    fn from_env() -> Result<Self, String> {
        let raw = std::env::var("INGEST_WRITE_MODE")
            .unwrap_or_else(|_| "tinybird".to_string())
            .trim()
            .to_ascii_lowercase();
        match raw.as_str() {
            "tinybird" | "native" => Ok(Self::Tinybird),
            "forward" | "collector" => Ok(Self::Forward),
            "dual" | "dual_write" => Ok(Self::Dual),
            _ => Err("INGEST_WRITE_MODE must be tinybird, forward, or dual".to_string()),
        }
    }

    fn uses_tinybird(self) -> bool {
        matches!(self, Self::Tinybird | Self::Dual)
    }

    fn uses_forward(self) -> bool {
        matches!(self, Self::Forward | Self::Dual)
    }
}

#[derive(Clone)]
enum KeyStoreBackend {
    // No-DB local backend: every well-formed ingest key resolves to a single
    // override org. Selected for single-tenant local dev so contributors don't
    // need CF D1 credentials to boot the service.
    Static {
        org_id: String,
    },
    // Cloudflare D1 REST backend used in multi-tenant / production deploys.
    D1 {
        cf_account_id: String,
        d1_database_id: String,
        d1_api_token: String,
    },
}

impl AppConfig {
    fn from_env() -> Result<Self, String> {
        let port = parse_u16(
            "INGEST_PORT",
            std::env::var("INGEST_PORT")
                .ok()
                .or_else(|| std::env::var("PORT").ok()),
            3474,
        )?;
        let otlp_grpc_port = parse_optional_u16(
            "INGEST_OTLP_GRPC_PORT",
            std::env::var("INGEST_OTLP_GRPC_PORT").ok(),
        )?;
        let write_mode = WriteMode::from_env()?;

        let forward_endpoint = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT")
            .unwrap_or_else(|_| "http://127.0.0.1:4318".to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();

        if forward_endpoint.is_empty() {
            return Err("INGEST_FORWARD_OTLP_ENDPOINT is required".to_string());
        }

        // Optional: endpoint for the self-managed collector pool. When unset, self-managed
        // orgs fall back to the shared pool so a missing env var degrades to "current
        // behavior" rather than dropping traffic.
        let forward_self_managed_endpoint = std::env::var("INGEST_FORWARD_SELF_MANAGED_ENDPOINT")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());

        let forward_timeout_ms = parse_u64(
            "INGEST_FORWARD_TIMEOUT_MS",
            std::env::var("INGEST_FORWARD_TIMEOUT_MS").ok(),
            10_000,
        )?;

        let tinybird = TinybirdConfig {
            endpoint: std::env::var("TINYBIRD_HOST")
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_string(),
            token: std::env::var("TINYBIRD_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_string(),
            queue_dir: PathBuf::from(
                std::env::var("INGEST_QUEUE_DIR")
                    .unwrap_or_else(|_| "/var/lib/maple-ingest/wal".to_string()),
            ),
            queue_max_bytes: parse_u64(
                "INGEST_QUEUE_MAX_BYTES",
                std::env::var("INGEST_QUEUE_MAX_BYTES").ok(),
                20 * 1024 * 1024 * 1024,
            )?,
            org_queue_max_bytes: parse_u64(
                "INGEST_ORG_QUEUE_MAX_BYTES",
                std::env::var("INGEST_ORG_QUEUE_MAX_BYTES").ok(),
                1024 * 1024 * 1024,
            )?,
            queue_channel_capacity: parse_usize(
                "INGEST_QUEUE_CHANNEL_CAPACITY",
                std::env::var("INGEST_QUEUE_CHANNEL_CAPACITY").ok(),
                100_000,
            )?,
            wal_shards: parse_usize(
                "INGEST_WAL_SHARDS",
                std::env::var("INGEST_WAL_SHARDS").ok(),
                (num_cpus::get().max(1) * 2).max(2),
            )?,
            batch_max_rows: parse_usize(
                "INGEST_BATCH_MAX_ROWS",
                std::env::var("INGEST_BATCH_MAX_ROWS").ok(),
                5_000,
            )?,
            batch_max_bytes: parse_usize(
                "INGEST_BATCH_MAX_BYTES",
                std::env::var("INGEST_BATCH_MAX_BYTES").ok(),
                4 * 1024 * 1024,
            )?,
            batch_max_wait: Duration::from_millis(parse_u64(
                "INGEST_BATCH_MAX_WAIT_MS",
                std::env::var("INGEST_BATCH_MAX_WAIT_MS").ok(),
                100,
            )?),
            export_concurrency_per_shard: parse_usize(
                "INGEST_TINYBIRD_CONCURRENCY_PER_SHARD",
                std::env::var("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD").ok(),
                1,
            )?,
            datasource_traces: std::env::var("INGEST_TINYBIRD_DATASOURCE_TRACES")
                .unwrap_or_else(|_| "traces".to_string()),
            datasource_logs: std::env::var("INGEST_TINYBIRD_DATASOURCE_LOGS")
                .unwrap_or_else(|_| "logs".to_string()),
            datasource_metrics_sum: std::env::var("INGEST_TINYBIRD_DATASOURCE_METRICS_SUM")
                .unwrap_or_else(|_| "metrics_sum".to_string()),
            datasource_metrics_gauge: std::env::var("INGEST_TINYBIRD_DATASOURCE_METRICS_GAUGE")
                .unwrap_or_else(|_| "metrics_gauge".to_string()),
            datasource_metrics_histogram: std::env::var(
                "INGEST_TINYBIRD_DATASOURCE_METRICS_HISTOGRAM",
            )
            .unwrap_or_else(|_| "metrics_histogram".to_string()),
            datasource_metrics_exponential_histogram: std::env::var(
                "INGEST_TINYBIRD_DATASOURCE_METRICS_EXPONENTIAL_HISTOGRAM",
            )
            .unwrap_or_else(|_| "metrics_exponential_histogram".to_string()),
        };
        if write_mode.uses_tinybird() {
            tinybird.validate()?;
        }

        let max_request_body_bytes = parse_usize(
            "INGEST_MAX_REQUEST_BODY_BYTES",
            std::env::var("INGEST_MAX_REQUEST_BODY_BYTES").ok(),
            20 * 1024 * 1024,
        )?;
        let org_max_in_flight = parse_u64(
            "INGEST_ORG_MAX_IN_FLIGHT",
            std::env::var("INGEST_ORG_MAX_IN_FLIGHT").ok(),
            1_000,
        )?;
        if org_max_in_flight == 0 {
            return Err("INGEST_ORG_MAX_IN_FLIGHT must be greater than 0".to_string());
        }

        let require_tls = parse_bool(
            "INGEST_REQUIRE_TLS",
            std::env::var("INGEST_REQUIRE_TLS").ok(),
            false,
        )?;

        if require_tls && !forward_endpoint.starts_with("https://") {
            return Err(
                "INGEST_REQUIRE_TLS=true requires an https INGEST_FORWARD_OTLP_ENDPOINT"
                    .to_string(),
            );
        }

        if require_tls {
            if let Some(endpoint) = forward_self_managed_endpoint.as_ref() {
                if !endpoint.starts_with("https://") {
                    return Err(
                        "INGEST_REQUIRE_TLS=true requires an https INGEST_FORWARD_SELF_MANAGED_ENDPOINT"
                            .to_string(),
                    );
                }
            }
        }

        let key_store_backend = resolve_key_store_backend()?;

        let lookup_hmac_key = std::env::var("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")
            .map_err(|_| "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required".to_string())?
            .trim()
            .to_string();

        if lookup_hmac_key.is_empty() {
            return Err("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required".to_string());
        }

        let autumn_secret_key = std::env::var("AUTUMN_SECRET_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let autumn_api_url = std::env::var("AUTUMN_API_URL")
            .unwrap_or_else(|_| "https://api.useautumn.com".to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();

        let autumn_flush_interval_secs = parse_u64(
            "AUTUMN_FLUSH_INTERVAL_SECS",
            std::env::var("AUTUMN_FLUSH_INTERVAL_SECS").ok(),
            1,
        )?;

        Ok(Self {
            port,
            otlp_grpc_port,
            forward_endpoint,
            forward_self_managed_endpoint,
            forward_timeout: Duration::from_millis(forward_timeout_ms),
            write_mode,
            tinybird,
            max_request_body_bytes,
            org_max_in_flight,
            require_tls,
            key_store_backend,
            lookup_hmac_key,
            autumn_secret_key,
            autumn_api_url,
            autumn_flush_interval_secs,
        })
    }
}

// Pick a KeyStore backend from env. `INGEST_KEY_STORE_BACKEND` (static|d1) wins
// when set; otherwise `MAPLE_SELF_HOSTED_MODE=single_tenant` implies static; in
// all other cases we require the three CF env vars and use D1.
fn resolve_key_store_backend() -> Result<KeyStoreBackend, String> {
    let backend_override = std::env::var("INGEST_KEY_STORE_BACKEND")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    let self_hosted_mode = std::env::var("MAPLE_SELF_HOSTED_MODE")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    let want_static = match backend_override.as_deref() {
        Some("static") => true,
        Some("d1") => false,
        Some(other) => {
            return Err(format!(
                "INGEST_KEY_STORE_BACKEND must be `static` or `d1`, got `{other}`"
            ));
        }
        None => self_hosted_mode.as_deref() == Some("single_tenant"),
    };

    if want_static {
        let org_id = std::env::var("MAPLE_ORG_ID_OVERRIDE")
            .map_err(|_| {
                "MAPLE_ORG_ID_OVERRIDE is required for the static key store backend".to_string()
            })?
            .trim()
            .to_string();
        if org_id.is_empty() {
            return Err(
                "MAPLE_ORG_ID_OVERRIDE is required for the static key store backend".to_string(),
            );
        }
        return Ok(KeyStoreBackend::Static { org_id });
    }

    let cf_account_id = std::env::var("CLOUDFLARE_ACCOUNT_ID")
        .map_err(|_| "CLOUDFLARE_ACCOUNT_ID is required".to_string())?
        .trim()
        .to_string();
    if cf_account_id.is_empty() {
        return Err("CLOUDFLARE_ACCOUNT_ID is required".to_string());
    }

    let d1_database_id = std::env::var("MAPLE_DB_ID")
        .map_err(|_| "MAPLE_DB_ID is required".to_string())?
        .trim()
        .to_string();
    if d1_database_id.is_empty() {
        return Err("MAPLE_DB_ID is required".to_string());
    }

    let d1_api_token = std::env::var("CLOUDFLARE_API_TOKEN")
        .map_err(|_| "CLOUDFLARE_API_TOKEN is required".to_string())?
        .trim()
        .to_string();
    if d1_api_token.is_empty() {
        return Err("CLOUDFLARE_API_TOKEN is required".to_string());
    }

    Ok(KeyStoreBackend::D1 {
        cf_account_id,
        d1_database_id,
        d1_api_token,
    })
}

struct IngestKeyResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, ResolvedIngestKey>,
}

struct CloudflareConnectorResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, ResolvedCloudflareConnector>,
}

struct SamplingPolicyResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, SamplingPolicy>,
}

/// Database-agnostic surface used by the two resolvers. Implementations:
/// `LibsqlKeyStore` (local dev / legacy) and `D1KeyStore` (Cloudflare D1 REST
/// in production, where the API service writes ingest-key rows). Both back
/// the same four operations.
#[async_trait::async_trait]
trait KeyStore: Send + Sync {
    async fn fetch_ingest_key(
        &self,
        key_hash: &str,
        hash_column: &'static str,
    ) -> Result<Option<KeyRow>, String>;

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String>;

    async fn fetch_sampling_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String>;

    async fn record_connector_success(&self, connector_id: &str, now_ms: i64)
        -> Result<(), String>;

    async fn record_connector_failure(
        &self,
        connector_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), String>;
}

#[derive(Clone, Debug)]
struct KeyRow {
    org_id: String,
    self_managed: bool,
}

#[derive(Clone, Debug)]
struct ConnectorRow {
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    self_managed: bool,
}

#[derive(Clone, Debug)]
struct SamplingPolicyRow {
    trace_sample_ratio: f64,
    always_keep_error_spans: bool,
    always_keep_slow_spans_ms: Option<u64>,
}

struct AppState {
    config: AppConfig,
    http_client: Client,
    telemetry_pipeline: Option<TelemetryPipeline>,
    resolver: IngestKeyResolver,
    org_inflight_limiter: OrgInFlightLimiter,
    sampling_resolver: SamplingPolicyResolver,
    cloudflare_resolver: CloudflareConnectorResolver,
    metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    autumn_tracker: Option<AutumnTracker>,
}

#[derive(Clone)]
struct ResolvedIngestKey {
    org_id: String,
    key_type: IngestKeyType,
    key_id: String,
    // When true, the org has an active BYO Tinybird configuration and its OTLP
    // payloads must be routed to the self-managed collector pool rather than the
    // shared pool. Computed from a LEFT JOIN with `org_clickhouse_settings` at
    // resolve time; cached alongside the rest of the key so the hot path stays
    // branch-free beyond a single boolean check.
    self_managed: bool,
}

#[derive(Clone)]
struct ResolvedCloudflareConnector {
    connector_id: String,
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    secret_key_id: String,
    // Mirrors ResolvedIngestKey.self_managed so Cloudflare Logpush payloads route
    // to the self-managed pool when the owning org has BYO Tinybird active.
    self_managed: bool,
}

#[derive(Clone, Copy)]
enum IngestKeyType {
    Public,
    Private,
    Connector,
}

impl IngestKeyType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
            Self::Connector => "connector",
        }
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Traces,
    Logs,
    Metrics,
}

impl Signal {
    fn path(self) -> &'static str {
        match self {
            Self::Traces => "traces",
            Self::Logs => "logs",
            Self::Metrics => "metrics",
        }
    }
}

enum DecodedPayload {
    Traces(ExportTraceServiceRequest),
    Logs(ExportLogsServiceRequest),
    Metrics(ExportMetricsServiceRequest),
}

impl DecodedPayload {
    fn item_count(&self) -> usize {
        match self {
            Self::Traces(request) => count_trace_items(request),
            Self::Logs(request) => count_log_items(request),
            Self::Metrics(request) => count_metric_items(request),
        }
    }

    fn encode(&self, payload_format: PayloadFormat) -> Result<Vec<u8>, ApiError> {
        match (self, payload_format) {
            (Self::Traces(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Logs(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Metrics(request), PayloadFormat::Protobuf) => Ok(request.encode_to_vec()),
            (Self::Traces(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize traces payload")),
            (Self::Logs(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize logs payload")),
            (Self::Metrics(request), PayloadFormat::Json) => serde_json::to_vec(request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize metrics payload")),
        }
    }
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        gauge!("ingest_requests_in_flight").decrement(1.0);
    }
}

#[derive(Clone)]
struct OrgInFlightLimiter {
    max_per_org: u64,
    counts: Arc<DashMap<String, Arc<AtomicU64>>>,
}

struct OrgInFlightPermit {
    org_id: String,
    counter: Arc<AtomicU64>,
}

impl OrgInFlightLimiter {
    fn new(max_per_org: u64) -> Self {
        Self {
            max_per_org,
            counts: Arc::new(DashMap::new()),
        }
    }

    fn try_acquire(&self, org_id: &str) -> Option<OrgInFlightPermit> {
        let counter = self
            .counts
            .entry(org_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();

        loop {
            let current = counter.load(Ordering::Relaxed);
            if current >= self.max_per_org {
                counter!(
                    "ingest_org_throttled_total",
                    "org_id" => org_id.to_string(),
                    "reason" => "in_flight"
                )
                .increment(1);
                return None;
            }
            if counter
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                gauge!(
                    "ingest_org_requests_in_flight",
                    "org_id" => org_id.to_string()
                )
                .set((current + 1) as f64);
                return Some(OrgInFlightPermit {
                    org_id: org_id.to_string(),
                    counter,
                });
            }
        }
    }
}

impl Drop for OrgInFlightPermit {
    fn drop(&mut self) {
        let current = self.counter.fetch_sub(1, Ordering::AcqRel);
        let next = current.saturating_sub(1);
        gauge!(
            "ingest_org_requests_in_flight",
            "org_id" => self.org_id.clone()
        )
        .set(next as f64);
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unsupported_media_type(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, message)
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            axum::Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

fn init_tracing(forward_endpoint: &str, bind_port: u16) -> Option<SdkTracerProvider> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "maple_ingest=info,tower_http=info".into());

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .compact();

    // Resolve the deployment environment in maple's canonical priority order.
    // MAPLE_ENVIRONMENT is what apps/api/alchemy.run.ts and friends set via
    // resolveDeploymentEnvironment(stage); RAILWAY_ENVIRONMENT_NAME is Railway's
    // free runtime label; DEPLOYMENT_ENV is a manual override of last resort.
    let deployment_env = std::env::var("MAPLE_ENVIRONMENT")
        .or_else(|_| std::env::var("RAILWAY_ENVIRONMENT_NAME"))
        .or_else(|_| std::env::var("DEPLOYMENT_ENV"))
        .unwrap_or_else(|_| "development".to_string());
    let internal_org_id =
        std::env::var("MAPLE_INTERNAL_ORG_ID").unwrap_or_else(|_| "internal".to_string());

    let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
    let skip_dev = deployment_env == "development" && !forward_explicit;
    let loopback = endpoint_loopback_to_self(forward_endpoint, bind_port);

    if skip_dev || loopback {
        if loopback {
            eprintln!(
                "INGEST_FORWARD_OTLP_ENDPOINT={forward_endpoint} resolves to this server's bind port {bind_port}; skipping OTel exporter to avoid recursion"
            );
        }
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return None;
    }

    let resource = OtelResource::builder()
        .with_attribute(OtelKeyValue::new("service.name", "ingest"))
        .with_attribute(OtelKeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_attribute(OtelKeyValue::new(
            "service.instance.id",
            uuid::Uuid::new_v4().to_string(),
        ))
        .with_attribute(OtelKeyValue::new(
            "deployment.environment.name",
            deployment_env.clone(),
        ))
        // Dual-emit the legacy `deployment.environment` key: every Tinybird MV
        // (service_overview_spans_mv, service_map_*_mv, error_*_mv,
        // logs_aggregates_hourly_mv, service_platforms_hourly_mv) still
        // pre-extracts ResourceAttributes['deployment.environment'] at write
        // time, so omitting it leaves DeploymentEnv='' for every ingest span
        // and the services-table badge renders blank. OTel semconv permits
        // emitting both during the deployment.environment ->
        // deployment.environment.name transition.
        .with_attribute(OtelKeyValue::new("deployment.environment", deployment_env))
        .with_attribute(OtelKeyValue::new("maple_org_id", internal_org_id))
        .build();

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/traces"))
        .with_protocol(Protocol::HttpBinary)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP span exporter: {error}; falling back to stdout-only tracing"
            );
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .init();
            return None;
        }
    };

    let batch_config = BatchConfigBuilder::default()
        .with_max_queue_size(2048)
        .with_max_export_batch_size(512)
        .with_scheduled_delay(Duration::from_secs(5))
        .build();

    let processor = BatchSpanProcessor::builder(exporter, OtelTokio)
        .with_batch_config(batch_config)
        .build();

    let provider = SdkTracerProvider::builder()
        .with_resource(resource)
        .with_span_processor(processor)
        .build();

    let tracer = provider.tracer("maple-ingest");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    opentelemetry::global::set_tracer_provider(provider.clone());

    Some(provider)
}

fn endpoint_loopback_to_self(forward_endpoint: &str, bind_port: u16) -> bool {
    let Ok(parsed) = url::Url::parse(forward_endpoint) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("");
    let port = parsed.port_or_known_default().unwrap_or(0);
    let host_is_loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "0.0.0.0");
    host_is_loopback && port == bind_port
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    let prometheus_handle = metrics_exporter_prometheus::PrometheusBuilder::new()
        .install_recorder()
        .expect("Failed to install metrics recorder");

    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Configuration error: {error}");
            std::process::exit(1);
        }
    };

    let tracer_provider = init_tracing(&config.forward_endpoint, config.port);

    let http_client = match Client::builder()
        .timeout(config.forward_timeout)
        .pool_max_idle_per_host(256)
        .pool_idle_timeout(Duration::from_secs(30))
        .http2_keep_alive_interval(Duration::from_secs(20))
        .http2_keep_alive_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("HTTP client init error: {error}");
            std::process::exit(1);
        }
    };

    let telemetry_pipeline = if config.write_mode.uses_tinybird() {
        match TelemetryPipeline::new(config.tinybird.clone(), http_client.clone()).await {
            Ok(pipeline) => Some(pipeline),
            Err(error) => {
                eprintln!("Telemetry pipeline init error: {error}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Cloudflare D1 REST backend — the API writes ingest-key rows to D1, so
    // ingest reads them from the same place. We run a probe query before
    // accepting traffic; if anything is wrong (auth, schema, network) the
    // deploy fails here rather than 503'ing forever.
    let store: Arc<dyn KeyStore> = match build_key_store(&config, http_client.clone()).await {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Key store init error: {error}");
            std::process::exit(1);
        }
    };

    let autumn_tracker = config.autumn_secret_key.as_ref().map(|key| {
        AutumnTracker::spawn(
            key.clone(),
            &config.autumn_api_url,
            config.autumn_flush_interval_secs,
        )
    });

    let ingest_key_cache = Cache::builder()
        .time_to_live(Duration::from_secs(60))
        .max_capacity(1_000)
        .build();

    let cloudflare_connector_cache = Cache::builder()
        .time_to_live(Duration::from_secs(60))
        .max_capacity(1_000)
        .build();
    let sampling_policy_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();

    let state = Arc::new(AppState {
        resolver: IngestKeyResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: ingest_key_cache,
        },
        org_inflight_limiter: OrgInFlightLimiter::new(config.org_max_in_flight),
        sampling_resolver: SamplingPolicyResolver {
            store: Arc::clone(&store),
            cache: sampling_policy_cache,
        },
        cloudflare_resolver: CloudflareConnectorResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: cloudflare_connector_cache,
        },
        telemetry_pipeline,
        http_client,
        config: config.clone(),
        metrics_handle: prometheus_handle,
        autumn_tracker,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            CONTENT_ENCODING,
            HeaderName::from_static("x-maple-ingest-key"),
        ]);

    let grpc_state = Arc::clone(&state);
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(serve_metrics))
        .route("/v1/traces", post(handle_traces))
        .route("/v1/logs", post(handle_logs))
        .route("/v1/metrics", post(handle_metrics))
        .route(
            "/v1/logpush/cloudflare/http_requests/{connector_id}",
            post(handle_cloudflare_logpush_http_requests),
        )
        .layer(cors)
        .layer(DefaultBodyLimit::max(config.max_request_body_bytes))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Failed to bind ingest server: {error}");
            std::process::exit(1);
        }
    };

    // First 8 chars of HMAC(lookup_hmac_key, fixed sentinel). One-way, so safe
    // to log — operators can diff this against the API's fingerprint to detect
    // env-var drift between the two services without ever printing the secret.
    let hmac_fingerprint = hash_ingest_key(HMAC_FINGERPRINT_SENTINEL, &config.lookup_hmac_key)
        .map(|h| h.chars().take(8).collect::<String>())
        .unwrap_or_else(|_| "<error>".to_string());

    {
        // Emit a single startup span so the dashboard has an authoritative
        // "ingest is alive" signal independent of customer traffic. Lives only
        // for the duration of this block, then gets exported by the batch
        // processor.
        let span = tracing::info_span!(
            "startup",
            otel.kind = "internal",
            "maple.ingest.port" = config.port,
            "maple.ingest.forward_endpoint" = %config.forward_endpoint,
            "maple.ingest.require_tls" = config.require_tls,
            "maple.ingest.hmac_fingerprint" = %hmac_fingerprint,
        );
        let _enter = span.enter();
        info!(
            port = config.port,
            forward_endpoint = %config.forward_endpoint,
            forward_self_managed_endpoint = %config
                .forward_self_managed_endpoint
                .as_deref()
                .unwrap_or("<unset>"),
            require_tls = config.require_tls,
            max_body_bytes = config.max_request_body_bytes,
            hmac_fingerprint = %hmac_fingerprint,
            "Maple ingest server listening"
        );
    }

    if let Some(grpc_port) = config.otlp_grpc_port {
        tokio::spawn(run_grpc_server(grpc_state, grpc_port));
    }

    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    if let Some(provider) = tracer_provider {
        // Flush buffered spans on graceful exit. Errors here are non-fatal —
        // the process is shutting down anyway.
        let _ = provider.shutdown();
    }

    if let Err(error) = serve_result {
        eprintln!("Ingest server failed: {error}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

async fn run_grpc_server(state: Arc<AppState>, port: u16) {
    use opentelemetry_proto::tonic::collector::logs::v1::logs_service_server::LogsServiceServer;
    use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsServiceServer;
    use opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceServiceServer;

    let addr = ([0, 0, 0, 0], port).into();
    let server = tonic::transport::Server::builder()
        .add_service(TraceServiceServer::new(GrpcTraceService {
            state: Arc::clone(&state),
        }))
        .add_service(LogsServiceServer::new(GrpcLogsService {
            state: Arc::clone(&state),
        }))
        .add_service(MetricsServiceServer::new(GrpcMetricsService { state }));

    info!(port, "Maple OTLP gRPC server listening");
    if let Err(error) = server.serve_with_shutdown(addr, shutdown_signal()).await {
        error!(error = %error, "OTLP gRPC server failed");
    }
}

#[derive(Clone)]
struct GrpcTraceService {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct GrpcLogsService {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct GrpcMetricsService {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::TraceService
    for GrpcTraceService
{
    async fn export(
        &self,
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse,
        >,
        tonic::Status,
    > {
        let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
        let mut inner = request.into_inner();
        enrich_trace_request(&mut inner, &resolved);
        accept_grpc_decoded(
            &self.state,
            Signal::Traces,
            DecodedPayload::Traces(inner),
            &resolved,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse {
                partial_success: None,
            },
        ))
    }
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::logs::v1::logs_service_server::LogsService
    for GrpcLogsService
{
    async fn export(
        &self,
        request: tonic::Request<ExportLogsServiceRequest>,
    ) -> Result<
        tonic::Response<opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse>,
        tonic::Status,
    > {
        let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
        let mut inner = request.into_inner();
        enrich_logs_request(&mut inner, &resolved);
        accept_grpc_decoded(
            &self.state,
            Signal::Logs,
            DecodedPayload::Logs(inner),
            &resolved,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse {
                partial_success: None,
            },
        ))
    }
}

#[tonic::async_trait]
impl opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::MetricsService
    for GrpcMetricsService
{
    async fn export(
        &self,
        request: tonic::Request<ExportMetricsServiceRequest>,
    ) -> Result<
        tonic::Response<
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse,
        >,
        tonic::Status,
    > {
        let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
        let mut inner = request.into_inner();
        enrich_metrics_request(&mut inner, &resolved);
        accept_grpc_decoded(
            &self.state,
            Signal::Metrics,
            DecodedPayload::Metrics(inner),
            &resolved,
        )
        .await?;
        Ok(tonic::Response::new(
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse {
                partial_success: None,
            },
        ))
    }
}

async fn accept_grpc_decoded(
    state: &AppState,
    signal: Signal,
    decoded: DecodedPayload,
    resolved: &ResolvedIngestKey,
) -> Result<(), tonic::Status> {
    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved.org_id)
        .ok_or_else(|| tonic::Status::resource_exhausted("Per-org ingest limit exceeded"))?;
    process_decoded_payload(
        state,
        signal,
        PayloadFormat::Protobuf,
        None,
        &decoded,
        resolved,
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        if error.status == StatusCode::TOO_MANY_REQUESTS {
            tonic::Status::resource_exhausted(error.message)
        } else {
            tonic::Status::unavailable(error.message)
        }
    })
}

async fn resolve_grpc_ingest_key(
    state: &AppState,
    metadata: &tonic::metadata::MetadataMap,
) -> Result<ResolvedIngestKey, tonic::Status> {
    let token = metadata
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            if value.len() > 7 && value[..7].eq_ignore_ascii_case("Bearer ") {
                Some(value[7..].trim().to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            metadata
                .get("x-maple-ingest-key")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| tonic::Status::unauthenticated("Missing ingest key"))?;

    if is_sentinel_token(&token) {
        return Ok(ResolvedIngestKey {
            org_id: SENTINEL_ORG_ID.to_string(),
            key_type: IngestKeyType::Public,
            key_id: "sentinel".to_string(),
            self_managed: false,
        });
    }

    state
        .resolver
        .resolve_ingest_key(&token)
        .await
        .map_err(|_| tonic::Status::unavailable("Ingest authentication unavailable"))?
        .ok_or_else(|| tonic::Status::unauthenticated("Invalid ingest key"))
}

async fn health() -> &'static str {
    "OK"
}

async fn serve_metrics(State(state): State<Arc<AppState>>) -> String {
    state.metrics_handle.render()
}

async fn handle_traces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Traces).await
}

async fn handle_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Logs).await
}

async fn handle_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_signal(state, headers, body, Signal::Metrics).await
}

#[derive(Deserialize)]
struct CloudflareLogpushQuery {
    secret: Option<String>,
}

async fn handle_cloudflare_logpush_http_requests(
    State(state): State<Arc<AppState>>,
    Path(connector_id): Path<String>,
    Query(query): Query<CloudflareLogpushQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_cloudflare_logpush(state, connector_id, query.secret, headers, body).await
}

async fn handle_signal(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Bytes,
    signal: Signal,
) -> Response {
    let start = Instant::now();
    let body_bytes = body.len();

    gauge!("ingest_requests_in_flight").increment(1.0);
    let _guard = InFlightGuard;

    let route = format!("/v1/{}", signal.path());
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "ingest",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = %route,
        "http.request.body.size" = body_bytes,
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = signal.path(),
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.key_type" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.payload_format" = tracing::field::Empty,
        "maple.ingest.content_encoding" = tracing::field::Empty,
        "maple.ingest.decoded_bytes" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
    );
    let span_handle = span.clone();

    let result = handle_signal_inner(&state, &headers, body, signal)
        .instrument(span)
        .await;
    let duration = start.elapsed();
    let duration_ms = duration.as_millis() as u64;

    match result {
        Ok((response, item_count, org_id, decoded_bytes)) => {
            let status_code = response.status().as_u16();
            span_handle.record("http.response.status_code", status_code);
            span_handle.record("otel.status_code", "Ok");
            histogram!("ingest_request_duration_seconds", "signal" => signal.path(), "status" => "ok")
                .record(duration.as_secs_f64());
            counter!("ingest_requests_total", "signal" => signal.path(), "status" => "ok", "error_kind" => "none")
                .increment(1);
            if let Some(tracker) = &state.autumn_tracker {
                if org_id != SENTINEL_ORG_ID {
                    let feature_id = signal.path();
                    let value_gb = decoded_bytes as f64 / 1_000_000_000.0;
                    tracker.track(&org_id, feature_id, value_gb);
                }
            }
            info!(
                status = status_code,
                duration_ms, item_count, "Request processed"
            );
            response
        }
        Err((error, error_kind)) => {
            span_handle.record("http.response.status_code", error.status.as_u16());
            span_handle.record("error.type", error_kind);
            span_handle.record("otel.status_code", "Error");
            histogram!("ingest_request_duration_seconds", "signal" => signal.path(), "status" => "error")
                .record(duration.as_secs_f64());
            counter!("ingest_requests_total", "signal" => signal.path(), "status" => "error", "error_kind" => error_kind)
                .increment(1);
            error.into_response()
        }
    }
}

async fn handle_cloudflare_logpush(
    state: Arc<AppState>,
    connector_id: String,
    secret: Option<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let body_bytes = body.len();

    gauge!("ingest_requests_in_flight").increment(1.0);
    let _guard = InFlightGuard;

    let route = format!("/v1/logpush/cloudflare/http_requests/{connector_id}");
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "cloudflare_logpush",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/logpush/cloudflare/http_requests/{connector_id}",
        "http.request.body.size" = body_bytes,
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "logs",
        "maple.org_id" = tracing::field::Empty,
        "maple.cloudflare.connector_id" = %connector_id,
        "maple.cloudflare.dataset" = "http_requests",
        "maple.cloudflare.is_validation" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.item_count" = tracing::field::Empty,
    );
    let span_handle = span.clone();

    let result =
        handle_cloudflare_logpush_inner(&state, &connector_id, secret.as_deref(), &headers, body)
            .instrument(span)
            .await;
    let duration = start.elapsed();

    match result {
        Ok((response, item_count, org_id, is_validation)) => {
            let status_code = response.status().as_u16();
            span_handle.record("http.response.status_code", status_code);
            span_handle.record("otel.status_code", "Ok");
            span_handle.record("maple.ingest.item_count", item_count);
            span_handle.record("maple.cloudflare.is_validation", is_validation);
            histogram!("ingest_request_duration_seconds", "signal" => "logs", "status" => "ok")
                .record(duration.as_secs_f64());
            counter!("ingest_requests_total", "signal" => "logs", "status" => "ok", "error_kind" => "none")
                .increment(1);
            counter!(
                "ingest_cloudflare_batches_total",
                "dataset" => "http_requests",
                "validation" => if is_validation { "true" } else { "false" }
            )
            .increment(1);
            if is_validation {
                counter!("ingest_cloudflare_validation_total", "dataset" => "http_requests")
                    .increment(1);
            }
            info!(
                status = status_code,
                duration_ms = duration.as_millis() as u64,
                item_count,
                org_id = %org_id,
                "Cloudflare Logpush request processed"
            );
            response
        }
        Err((error, error_kind)) => {
            span_handle.record("http.response.status_code", error.status.as_u16());
            span_handle.record("error.type", error_kind);
            span_handle.record("otel.status_code", "Error");
            histogram!("ingest_request_duration_seconds", "signal" => "logs", "status" => "error")
                .record(duration.as_secs_f64());
            counter!("ingest_requests_total", "signal" => "logs", "status" => "error", "error_kind" => error_kind)
                .increment(1);
            if error_kind == "auth" {
                counter!("ingest_cloudflare_auth_failures_total", "dataset" => "http_requests")
                    .increment(1);
            }
            if error_kind == "parse" {
                counter!("ingest_cloudflare_parse_failures_total", "dataset" => "http_requests")
                    .increment(1);
            }
            error.into_response()
        }
    }
}

/// Returns Ok((response, item_count, org_id, decoded_bytes)) or Err((ApiError, error_kind_label))
async fn handle_signal_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
    signal: Signal,
) -> Result<(Response, usize, String, usize), (ApiError, &'static str)> {
    // --- Auth ---
    let ingest_key = extract_ingest_key(headers).ok_or_else(|| {
        warn!("Missing ingest key");
        (ApiError::unauthorized("Missing ingest key"), "auth")
    })?;

    if is_sentinel_token(&ingest_key) {
        counter!("ingest_sentinel_total", "signal" => signal.path()).increment(1);
        Span::current().record("maple.org_id", SENTINEL_ORG_ID);
        Span::current().record("maple.ingest.key_type", "sentinel");
        debug!("Sentinel token; skipping resolve and forward");
        return Ok((
            StatusCode::OK.into_response(),
            0,
            SENTINEL_ORG_ID.to_string(),
            0,
        ));
    }

    let key_resolve_start = Instant::now();
    let resolved_key = state
        .resolver
        .resolve_ingest_key(&ingest_key)
        .await
        .map_err(|error| {
            error!(error = %error, "Ingest key resolution failed");
            (
                ApiError::service_unavailable("Ingest authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!("Unknown ingest key");
            (ApiError::unauthorized("Invalid ingest key"), "auth")
        })?;
    histogram!("ingest_key_resolution_duration_seconds")
        .record(key_resolve_start.elapsed().as_secs_f64());

    Span::current().record("maple.org_id", &resolved_key.org_id.as_str());
    Span::current().record("maple.ingest.key_type", resolved_key.key_type.as_str());
    Span::current().record("maple.ingest.self_managed", resolved_key.self_managed);
    debug!(
        resolve_ms = key_resolve_start.elapsed().as_millis() as u64,
        "Authenticated"
    );
    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved_key.org_id)
        .ok_or_else(|| {
            warn!(
                org_id = %resolved_key.org_id,
                "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    // --- Payload validation ---
    if body.len() > state.config.max_request_body_bytes {
        warn!(
            body_bytes = body.len(),
            max_bytes = state.config.max_request_body_bytes,
            "Payload too large"
        );
        return Err((
            ApiError::payload_too_large("Request body too large"),
            "payload_too_large",
        ));
    }

    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/x-protobuf")
        .to_ascii_lowercase();

    let payload_format = detect_payload_format(&content_type).map_err(|e| {
        warn!(content_type = %content_type, "Unsupported content type");
        (e, "unsupported_media")
    })?;
    Span::current().record("maple.ingest.payload_format", payload_format.label());

    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");
    Span::current().record(
        "maple.ingest.content_encoding",
        content_encoding.as_deref().unwrap_or("identity"),
    );

    histogram!("ingest_request_body_bytes", "signal" => signal.path()).record(body.len() as f64);

    // --- Decode ---
    let decoded_payload = decode_payload(&body, content_encoding.as_deref()).map_err(|e| {
        warn!(body_bytes = body.len(), "Failed to decode payload");
        (e, "decode")
    })?;

    let encoding_label = content_encoding.as_deref().unwrap_or("identity");
    Span::current().record("maple.ingest.decoded_bytes", decoded_payload.len());
    debug!(
        decoded_bytes = decoded_payload.len(),
        encoding = encoding_label,
        "Payload decoded"
    );
    histogram!("ingest_decoded_body_bytes", "signal" => signal.path())
        .record(decoded_payload.len() as f64);

    // --- Enrich ---
    let decoded =
        decode_and_enrich_payload(signal, payload_format, &decoded_payload, &resolved_key)
            .map_err(|e| {
                warn!(
                    format = payload_format.label(),
                    signal = signal.path(),
                    org_id = resolved_key.org_id.as_str(),
                    key_type = resolved_key.key_type.as_str(),
                    decoded_bytes = decoded_payload.len(),
                    reason = %e.message,
                    "Invalid OTLP payload"
                );
                (e, "enrich")
            })?;
    let item_count = decoded.item_count();

    Span::current().record("maple.ingest.item_count", item_count);
    debug!(item_count, "Payload enriched");
    counter!(
        "ingest_items_total",
        "signal" => signal.path()
    )
    .increment(item_count as u64);

    let decoded_bytes = decoded_payload.len();

    let response = process_decoded_payload(
        state,
        signal,
        payload_format,
        content_encoding.as_deref(),
        &decoded,
        &resolved_key,
    )
    .await
    .map_err(|e| (e, "forward"))?;

    Ok((
        response,
        item_count,
        resolved_key.org_id.clone(),
        decoded_bytes,
    ))
}

async fn handle_cloudflare_logpush_inner(
    state: &AppState,
    connector_id: &str,
    secret: Option<&str>,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<(Response, usize, String, bool), (ApiError, &'static str)> {
    let secret = secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            warn!("Missing Cloudflare connector secret");
            (
                ApiError::unauthorized("Invalid connector credentials"),
                "auth",
            )
        })?;

    let resolved = state
        .cloudflare_resolver
        .resolve_connector(connector_id, secret)
        .await
        .map_err(|error| {
            error!(error = %error, connector_id, "Cloudflare connector resolution failed");
            (
                ApiError::service_unavailable("Connector authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!(connector_id, "Invalid Cloudflare connector credentials");
            (
                ApiError::unauthorized("Invalid connector credentials"),
                "auth",
            )
        })?;

    Span::current().record("maple.org_id", &resolved.org_id.as_str());
    Span::current().record("maple.ingest.self_managed", resolved.self_managed);
    debug!(
        connector_id = %resolved.connector_id,
        org_id = %resolved.org_id,
        key_id = %resolved.secret_key_id,
        "Authenticated Cloudflare Logpush connector"
    );
    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved.org_id)
        .ok_or_else(|| {
            warn!(
                org_id = %resolved.org_id,
                connector_id = %resolved.connector_id,
                "Per-org in-flight ingest limit exceeded"
            );
            (
                ApiError::too_many_requests("Per-org ingest limit exceeded"),
                "throttle",
            )
        })?;

    if body.len() > state.config.max_request_body_bytes {
        warn!(
            body_bytes = body.len(),
            max_bytes = state.config.max_request_body_bytes,
            connector_id = %resolved.connector_id,
            "Cloudflare Logpush payload too large"
        );
        let _ = state
            .cloudflare_resolver
            .record_failure(&resolved.connector_id, "Request body too large")
            .await;
        return Err((
            ApiError::payload_too_large("Request body too large"),
            "payload_too_large",
        ));
    }

    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/x-ndjson")
        .to_ascii_lowercase();

    if !is_supported_cloudflare_content_type(&content_type) {
        let _ = state
            .cloudflare_resolver
            .record_failure(&resolved.connector_id, "Unsupported content type")
            .await;
        return Err((
            ApiError::unsupported_media_type(
                "Unsupported content type for Cloudflare Logpush payload",
            ),
            "unsupported_media",
        ));
    }

    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");

    let decoded_payload = match decode_payload(&body, content_encoding.as_deref()) {
        Ok(decoded) => decoded,
        Err(error) => {
            let _ = state
                .cloudflare_resolver
                .record_failure(&resolved.connector_id, &error.message)
                .await;
            return Err((error, "decode"));
        }
    };

    let parsed = match parse_cloudflare_payload(&decoded_payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = state
                .cloudflare_resolver
                .record_failure(&resolved.connector_id, &error.message)
                .await;
            return Err((error, "parse"));
        }
    };

    match parsed {
        ParsedCloudflarePayload::Validation => {
            info!(connector_id = %resolved.connector_id, "Cloudflare validation ping accepted");
            return Ok((
                StatusCode::OK.into_response(),
                0,
                resolved.org_id.clone(),
                true,
            ));
        }
        ParsedCloudflarePayload::Records(records) => {
            let request = build_cloudflare_logs_request(&resolved, records);
            let item_count = count_log_items(&request);
            counter!(
                "ingest_cloudflare_records_total",
                "dataset" => resolved.dataset.clone()
            )
            .increment(item_count as u64);

            let resolved_key = ResolvedIngestKey {
                org_id: resolved.org_id.clone(),
                key_type: IngestKeyType::Connector,
                key_id: resolved.secret_key_id.clone(),
                self_managed: resolved.self_managed,
            };
            let decoded = DecodedPayload::Logs(request);
            let response = match process_decoded_payload(
                state,
                Signal::Logs,
                PayloadFormat::Protobuf,
                None,
                &decoded,
                &resolved_key,
            )
            .await
            {
                Ok(response) => response,
                Err(error) => {
                    let _ = state
                        .cloudflare_resolver
                        .record_failure(&resolved.connector_id, &error.message)
                        .await;
                    return Err((error, "forward"));
                }
            };

            let _ = state
                .cloudflare_resolver
                .record_success(&resolved.connector_id)
                .await;

            Ok((response, item_count, resolved.org_id.clone(), false))
        }
    }
}

enum ParsedCloudflarePayload {
    Validation,
    Records(Vec<JsonMap<String, JsonValue>>),
}

fn is_supported_cloudflare_content_type(content_type: &str) -> bool {
    content_type.contains("json")
        || content_type.contains("ndjson")
        || content_type.contains("text/plain")
        || content_type == "application/octet-stream"
}

fn parse_cloudflare_payload(payload: &[u8]) -> Result<ParsedCloudflarePayload, ApiError> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| ApiError::bad_request("Cloudflare Logpush payload must be UTF-8 JSON"))?;
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return Err(ApiError::bad_request(
            "Cloudflare Logpush payload was empty",
        ));
    }

    if trimmed.contains('\n') && !trimmed.starts_with('[') {
        let mut records = Vec::new();
        for line in trimmed.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: JsonValue = serde_json::from_str(line)
                .map_err(|_| ApiError::bad_request("Invalid Cloudflare NDJSON payload"))?;
            match value {
                JsonValue::Object(object) => records.push(object),
                _ => {
                    return Err(ApiError::bad_request(
                        "Cloudflare NDJSON payload must contain JSON objects",
                    ))
                }
            }
        }

        if records.is_empty() {
            return Err(ApiError::bad_request(
                "Cloudflare Logpush payload was empty",
            ));
        }

        return Ok(ParsedCloudflarePayload::Records(records));
    }

    if trimmed.starts_with('[') {
        let value: JsonValue = serde_json::from_str(trimmed)
            .map_err(|_| ApiError::bad_request("Invalid Cloudflare JSON array payload"))?;
        return extract_cloudflare_records(value);
    }

    if trimmed.starts_with('{') {
        let value: JsonValue = serde_json::from_str(trimmed)
            .map_err(|_| ApiError::bad_request("Invalid Cloudflare JSON payload"))?;
        return extract_cloudflare_records(value);
    }

    Err(ApiError::bad_request(
        "Cloudflare Logpush payload must be a JSON object, JSON array, or NDJSON",
    ))
}

fn extract_cloudflare_records(value: JsonValue) -> Result<ParsedCloudflarePayload, ApiError> {
    match value {
        JsonValue::Object(object) => {
            if object.len() == 1
                && object
                    .get("content")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|value| value == "tests")
            {
                return Ok(ParsedCloudflarePayload::Validation);
            }

            Ok(ParsedCloudflarePayload::Records(vec![object]))
        }
        JsonValue::Array(values) => {
            let mut records = Vec::with_capacity(values.len());
            for value in values {
                match value {
                    JsonValue::Object(object) => records.push(object),
                    _ => {
                        return Err(ApiError::bad_request(
                            "Cloudflare JSON array payload must contain JSON objects",
                        ))
                    }
                }
            }

            if records.is_empty() {
                return Err(ApiError::bad_request(
                    "Cloudflare Logpush payload was empty",
                ));
            }

            Ok(ParsedCloudflarePayload::Records(records))
        }
        _ => Err(ApiError::bad_request(
            "Cloudflare Logpush payload must be a JSON object, JSON array, or NDJSON",
        )),
    }
}

fn build_cloudflare_logs_request(
    resolved: &ResolvedCloudflareConnector,
    records: Vec<JsonMap<String, JsonValue>>,
) -> ExportLogsServiceRequest {
    let log_records = records
        .into_iter()
        .map(|record| build_cloudflare_log_record(resolved, record))
        .collect();

    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: build_cloudflare_resource_attributes(resolved),
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            schema_url: String::new(),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: "cloudflare.logpush".to_string(),
                    version: "http_requests".to_string(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                schema_url: String::new(),
                log_records,
            }],
        }],
    }
}

fn build_cloudflare_resource_attributes(resolved: &ResolvedCloudflareConnector) -> Vec<KeyValue> {
    vec![
        string_attribute("maple_org_id", &resolved.org_id),
        string_attribute("maple_ingest_source", CLOUDFLARE_LOGPUSH_SOURCE),
        string_attribute("maple_ingest_key_type", IngestKeyType::Connector.as_str()),
        string_attribute("cloud.provider", "cloudflare"),
        string_attribute("cloudflare.dataset", &resolved.dataset),
        string_attribute("cloudflare.zone_name", &resolved.zone_name),
        string_attribute("maple_cloudflare_connector_id", &resolved.connector_id),
        string_attribute("service.name", &resolved.service_name),
    ]
}

fn build_cloudflare_log_record(
    _resolved: &ResolvedCloudflareConnector,
    record: JsonMap<String, JsonValue>,
) -> LogRecord {
    let timestamp = record
        .get("EdgeStartTimestamp")
        .and_then(parse_cloudflare_timestamp)
        .or_else(|| {
            record
                .get("EdgeEndTimestamp")
                .and_then(parse_cloudflare_timestamp)
        })
        .unwrap_or_else(current_time_unix_nano);

    let status_code = record
        .get("EdgeResponseStatus")
        .and_then(parse_status_code)
        .unwrap_or(0);
    let (severity_text, severity_number) = severity_from_status(status_code);
    let body = build_cloudflare_body(&record, status_code);
    let attributes = record
        .iter()
        .filter_map(|(key, value)| json_value_to_attribute(key, value))
        .collect();

    LogRecord {
        time_unix_nano: timestamp,
        observed_time_unix_nano: timestamp,
        severity_number,
        severity_text: severity_text.to_string(),
        body: Some(AnyValue {
            value: Some(any_value::Value::StringValue(body)),
        }),
        attributes,
        dropped_attributes_count: 0,
        flags: 0,
        trace_id: Vec::new(),
        span_id: Vec::new(),
        event_name: String::new(),
    }
}

fn build_cloudflare_body(record: &JsonMap<String, JsonValue>, status_code: u16) -> String {
    let method = record
        .get("ClientRequestMethod")
        .and_then(JsonValue::as_str)
        .unwrap_or("UNKNOWN");
    let host = record
        .get("ClientRequestHost")
        .and_then(JsonValue::as_str)
        .unwrap_or("-");
    let uri = record
        .get("ClientRequestURI")
        .and_then(JsonValue::as_str)
        .unwrap_or("");

    format!("{method} {host}{uri} -> {status_code}")
}

fn parse_status_code(value: &JsonValue) -> Option<u16> {
    value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .or_else(|| value.as_str().and_then(|value| value.parse::<u16>().ok()))
}

fn severity_from_status(status_code: u16) -> (&'static str, i32) {
    if status_code >= 500 {
        return ("ERROR", 17);
    }
    if status_code >= 400 {
        return ("WARN", 13);
    }

    ("INFO", 9)
}

fn parse_cloudflare_timestamp(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(number) => number.as_u64().map(normalize_numeric_timestamp),
        JsonValue::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(value) = trimmed.parse::<u64>() {
                return Some(normalize_numeric_timestamp(value));
            }
            DateTime::parse_from_rfc3339(trimmed)
                .ok()
                .and_then(|value| value.timestamp_nanos_opt())
                .and_then(|value| u64::try_from(value).ok())
        }
        _ => None,
    }
}

fn normalize_numeric_timestamp(value: u64) -> u64 {
    if value >= 1_000_000_000_000_000 {
        return value;
    }

    value.saturating_mul(1_000_000_000)
}

fn current_time_unix_nano() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

fn string_attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    }
}

fn json_value_to_attribute(key: &str, value: &JsonValue) -> Option<KeyValue> {
    let string_value = match value {
        JsonValue::Null => return None,
        JsonValue::String(value) => value.clone(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Array(_) | JsonValue::Object(_) => serde_json::to_string(value).ok()?,
    };

    Some(string_attribute(key, &string_value))
}

fn extract_ingest_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if value.len() > 7 && value[..7].eq_ignore_ascii_case("Bearer ") {
            let token = value[7..].trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    headers
        .get("x-maple-ingest-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Copy)]
enum PayloadFormat {
    Protobuf,
    Json,
}

impl PayloadFormat {
    fn content_type(self) -> &'static str {
        match self {
            Self::Protobuf => "application/x-protobuf",
            Self::Json => "application/json",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Protobuf => "protobuf",
            Self::Json => "json",
        }
    }
}

fn detect_payload_format(content_type: &str) -> Result<PayloadFormat, ApiError> {
    if content_type.contains("json") {
        return Ok(PayloadFormat::Json);
    }

    if content_type.contains("protobuf") || content_type == "application/octet-stream" {
        return Ok(PayloadFormat::Protobuf);
    }

    Err(ApiError::unsupported_media_type(
        "Unsupported content type (expected OTLP protobuf/json)",
    ))
}

fn decode_payload(body: &Bytes, content_encoding: Option<&str>) -> Result<Vec<u8>, ApiError> {
    match content_encoding {
        None => Ok(body.to_vec()),
        Some("gzip") => {
            let mut decoder = GzDecoder::new(body.as_ref());
            let mut decompressed = Vec::new();
            decoder
                .read_to_end(&mut decompressed)
                .map_err(|_| ApiError::bad_request("Invalid gzip body"))?;
            Ok(decompressed)
        }
        Some(_) => Err(ApiError::unsupported_media_type(
            "Unsupported content-encoding",
        )),
    }
}

fn encode_payload(payload: &[u8], content_encoding: Option<&str>) -> Result<Vec<u8>, ApiError> {
    match content_encoding {
        None => Ok(payload.to_vec()),
        Some("gzip") => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder
                .write_all(payload)
                .map_err(|_| ApiError::service_unavailable("Failed to encode gzip payload"))?;
            encoder
                .finish()
                .map_err(|_| ApiError::service_unavailable("Failed to encode gzip payload"))
        }
        Some(_) => Err(ApiError::unsupported_media_type(
            "Unsupported content-encoding",
        )),
    }
}

fn decode_and_enrich_payload(
    signal: Signal,
    payload_format: PayloadFormat,
    payload: &[u8],
    resolved_key: &ResolvedIngestKey,
) -> Result<DecodedPayload, ApiError> {
    match (signal, payload_format) {
        (Signal::Traces, PayloadFormat::Protobuf) => {
            let mut request = ExportTraceServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP traces protobuf payload"))?;
            enrich_trace_request(&mut request, resolved_key);
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Protobuf) => {
            let mut request = ExportLogsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs protobuf payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Protobuf) => {
            let mut request = ExportMetricsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics protobuf payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            Ok(DecodedPayload::Metrics(request))
        }
        (Signal::Traces, PayloadFormat::Json) => {
            let mut request: ExportTraceServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP traces JSON payload"))?;
            enrich_trace_request(&mut request, resolved_key);
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Json) => {
            let mut request: ExportLogsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs JSON payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Json) => {
            let mut request: ExportMetricsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics JSON payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            Ok(DecodedPayload::Metrics(request))
        }
    }
}

fn count_trace_items(request: &ExportTraceServiceRequest) -> usize {
    request
        .resource_spans
        .iter()
        .flat_map(|rs| &rs.scope_spans)
        .map(|ss| ss.spans.len())
        .sum()
}

fn count_log_items(request: &ExportLogsServiceRequest) -> usize {
    request
        .resource_logs
        .iter()
        .flat_map(|rl| &rl.scope_logs)
        .map(|sl| sl.log_records.len())
        .sum()
}

fn count_metric_items(request: &ExportMetricsServiceRequest) -> usize {
    request
        .resource_metrics
        .iter()
        .flat_map(|rm| &rm.scope_metrics)
        .map(|sm| sm.metrics.len())
        .sum()
}

fn enrich_trace_request(request: &mut ExportTraceServiceRequest, resolved_key: &ResolvedIngestKey) {
    for resource_span in &mut request.resource_spans {
        let resource = resource_span.resource.get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key);
    }
}

fn enrich_logs_request(request: &mut ExportLogsServiceRequest, resolved_key: &ResolvedIngestKey) {
    for resource_log in &mut request.resource_logs {
        let resource = resource_log.resource.get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key);
    }
}

fn enrich_metrics_request(
    request: &mut ExportMetricsServiceRequest,
    resolved_key: &ResolvedIngestKey,
) {
    for resource_metric in &mut request.resource_metrics {
        let resource = resource_metric
            .resource
            .get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key);
    }
}

fn enrich_resource_attributes(attributes: &mut Vec<KeyValue>, resolved_key: &ResolvedIngestKey) {
    attributes.retain(|attribute| {
        let key = attribute.key.as_str();
        key != "org_id" && key != "maple_org_id"
    });

    upsert_string_attribute(attributes, "maple_org_id", &resolved_key.org_id);
    upsert_string_attribute(
        attributes,
        "maple_ingest_key_type",
        resolved_key.key_type.as_str(),
    );
    upsert_string_attribute(attributes, "maple_ingest_source", INGEST_SOURCE);
}

fn upsert_string_attribute(attributes: &mut Vec<KeyValue>, key: &str, value: &str) {
    if let Some(attribute) = attributes.iter_mut().find(|attribute| attribute.key == key) {
        attribute.value = Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        });
        return;
    }

    attributes.push(KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    });
}

/// Pick the upstream collector endpoint + pool label for a resolved ingest key.
///
/// Self-managed orgs go to the self-managed pool when it is configured; any
/// other case (shared orgs, or self-managed-but-endpoint-unset) falls through
/// to the shared pool. Kept as a pure function so the routing decision is unit
/// testable without spinning up collectors or state.
fn select_forward_endpoint<'a>(
    shared: &'a str,
    self_managed: Option<&'a str>,
    org_is_self_managed: bool,
) -> (&'a str, &'static str) {
    match (org_is_self_managed, self_managed) {
        (true, Some(url)) => (url, "self_managed"),
        _ => (shared, "shared"),
    }
}

async fn forward_to_collector(
    state: &AppState,
    signal: Signal,
    content_type: &str,
    content_encoding: Option<&str>,
    body: Vec<u8>,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    let (endpoint, upstream_pool) = select_forward_endpoint(
        state.config.forward_endpoint.as_str(),
        state.config.forward_self_managed_endpoint.as_deref(),
        resolved_key.self_managed,
    );

    let url = format!("{endpoint}/v1/{}", signal.path());
    let outbound_bytes = body.len();
    Span::current().record("maple.ingest.upstream_pool", upstream_pool);
    Span::current().record("url.full", url.as_str());
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            Span::current().record("server.address", host);
        }
    }

    debug!(url = %url, upstream_pool, outbound_bytes, "Forwarding to collector");

    let mut request_builder = state
        .http_client
        .request(Method::POST, &url)
        .header(CONTENT_TYPE, content_type)
        .body(body);

    if let Some(content_encoding) = content_encoding {
        request_builder = request_builder.header(CONTENT_ENCODING, content_encoding);
    }

    let forward_start = Instant::now();
    let response = request_builder.send().await.map_err(|error| {
        let forward_duration = forward_start.elapsed();
        Span::current().record("error.type", "transport");
        Span::current().record("otel.status_code", "Error");
        histogram!(
            "ingest_forward_duration_seconds",
            "signal" => signal.path(),
            "upstream_pool" => upstream_pool,
        )
        .record(forward_duration.as_secs_f64());
        counter!(
            "ingest_forward_responses_total",
            "signal" => signal.path(),
            "upstream_status" => "error",
            "upstream_pool" => upstream_pool,
        )
        .increment(1);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            upstream_pool,
            url = %url,
            "Collector forwarding failed"
        );
        ApiError::service_unavailable("Telemetry backend unavailable")
    })?;

    let forward_duration = forward_start.elapsed();
    histogram!(
        "ingest_forward_duration_seconds",
        "signal" => signal.path(),
        "upstream_pool" => upstream_pool,
    )
    .record(forward_duration.as_secs_f64());

    let upstream_status_code = response.status().as_u16();
    Span::current().record("http.response.status_code", upstream_status_code);
    Span::current().record(
        "otel.status_code",
        if response.status().is_success() {
            "Ok"
        } else {
            "Error"
        },
    );
    let status_bucket = match upstream_status_code {
        200..=299 => "2xx",
        400..=499 => "4xx",
        500..=599 => "5xx",
        _ => "other",
    };
    counter!(
        "ingest_forward_responses_total",
        "signal" => signal.path(),
        "upstream_status" => status_bucket,
        "upstream_pool" => upstream_pool,
    )
    .increment(1);

    debug!(
        upstream_status = upstream_status_code,
        forward_ms = forward_duration.as_millis() as u64,
        "Collector response"
    );

    if response.status().is_server_error() {
        error!(
            upstream_status = upstream_status_code,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            "Collector returned error"
        );
        return Err(ApiError::service_unavailable(
            "Telemetry backend unavailable",
        ));
    }

    let status = StatusCode::from_u16(upstream_status_code).unwrap_or(StatusCode::BAD_GATEWAY);

    let upstream_content_type = response.headers().get(CONTENT_TYPE).cloned();
    let upstream_body = response.bytes().await.map_err(|error| {
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            "Failed reading collector response"
        );
        ApiError::service_unavailable("Telemetry backend unavailable")
    })?;

    let mut response = Response::builder().status(status);
    if let Some(content_type) = upstream_content_type {
        response = response.header(CONTENT_TYPE, content_type);
    }

    response
        .body(axum::body::Body::from(upstream_body))
        .map_err(|_| ApiError::service_unavailable("Telemetry backend unavailable"))
}

async fn process_decoded_payload(
    state: &AppState,
    signal: Signal,
    payload_format: PayloadFormat,
    content_encoding: Option<&str>,
    decoded: &DecodedPayload,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    if state.config.write_mode.uses_tinybird() {
        let pipeline = state
            .telemetry_pipeline
            .as_ref()
            .ok_or_else(|| ApiError::service_unavailable("Telemetry pipeline is not configured"))?;
        let native_start = Instant::now();
        let stats = match decoded {
            DecodedPayload::Traces(request) => {
                let policy = state
                    .sampling_resolver
                    .resolve_policy(&resolved_key.org_id)
                    .await;
                pipeline
                    .accept_traces(&resolved_key.org_id, request, &policy)
                    .await
            }
            DecodedPayload::Logs(request) => {
                pipeline.accept_logs(&resolved_key.org_id, request).await
            }
            DecodedPayload::Metrics(request) => {
                pipeline.accept_metrics(&resolved_key.org_id, request).await
            }
        }
        .map_err(|error| {
            let api_error = match &error {
                PipelineError::Throttled(_) => {
                    ApiError::too_many_requests("Per-org ingest queue limit exceeded")
                }
                PipelineError::Backpressure(_) => {
                    ApiError::service_unavailable("Telemetry backend unavailable")
                }
                PipelineError::QueueUnavailable(_) | PipelineError::Encode(_) => {
                    ApiError::service_unavailable("Telemetry backend unavailable")
                }
            };
            error!(
                error = %error,
                signal = signal.path(),
                org_id = %resolved_key.org_id,
                "Native telemetry pipeline rejected payload"
            );
            api_error
        })?;
        histogram!(
            "ingest_native_accept_duration_seconds",
            "signal" => signal.path()
        )
        .record(native_start.elapsed().as_secs_f64());
        counter!(
            "ingest_native_rows_total",
            "signal" => signal.path()
        )
        .increment(stats.rows as u64);
        if stats.dropped > 0 {
            counter!(
                "ingest_native_sampled_dropped_total",
                "signal" => signal.path()
            )
            .increment(stats.dropped as u64);
        }
        Span::current().record("maple.ingest.native_rows", stats.rows as u64);
        Span::current().record("maple.ingest.sampled_dropped", stats.dropped as u64);
    }

    if state.config.write_mode.uses_forward() {
        let outbound_payload = decoded.encode(payload_format)?;
        let outbound_body = encode_payload(&outbound_payload, content_encoding)?;
        let outbound_bytes = outbound_body.len();
        let forward_span = tracing::info_span!(
            "forward",
            otel.name = "POST",
            otel.kind = "client",
            otel.status_code = tracing::field::Empty,
            "http.request.method" = "POST",
            "http.request.body.size" = outbound_bytes,
            "http.response.status_code" = tracing::field::Empty,
            "url.full" = tracing::field::Empty,
            "server.address" = tracing::field::Empty,
            "error.type" = tracing::field::Empty,
            "maple.signal" = signal.path(),
            "maple.ingest.upstream_pool" = tracing::field::Empty,
        );
        return forward_to_collector(
            state,
            signal,
            payload_format.content_type(),
            content_encoding,
            outbound_body,
            resolved_key,
        )
        .instrument(forward_span)
        .await;
    }

    Ok(StatusCode::OK.into_response())
}

impl IngestKeyResolver {
    async fn resolve_ingest_key(&self, raw_key: &str) -> Result<Option<ResolvedIngestKey>, String> {
        if let Some(cached) = self.cache.get(raw_key).await {
            return Ok(Some(cached));
        }

        let key_type = infer_ingest_key_type(raw_key);
        let Some(key_type) = key_type else {
            return Ok(None);
        };

        let key_hash = hash_ingest_key(raw_key, &self.lookup_hmac_key)?;
        let hash_column = match key_type {
            IngestKeyType::Public => "public_key_hash",
            IngestKeyType::Private => "private_key_hash",
            IngestKeyType::Connector => return Ok(None),
        };

        // LEFT JOIN against org_clickhouse_settings so the "self-managed?" flag is
        // resolved in the same roundtrip as org_id. This hits the DB only on cache
        // miss; warm cache hits (>99% of traffic) skip this entirely.
        let Some(row) = self.store.fetch_ingest_key(&key_hash, hash_column).await? else {
            return Ok(None);
        };

        let resolved = ResolvedIngestKey {
            org_id: row.org_id,
            key_type,
            key_id: key_hash.chars().take(16).collect(),
            self_managed: row.self_managed,
        };

        self.cache
            .insert(raw_key.to_string(), resolved.clone())
            .await;

        Ok(Some(resolved))
    }
}

impl CloudflareConnectorResolver {
    async fn resolve_connector(
        &self,
        connector_id: &str,
        raw_secret: &str,
    ) -> Result<Option<ResolvedCloudflareConnector>, String> {
        let cache_key = format!("{connector_id}:{raw_secret}");
        if let Some(cached) = self.cache.get(&cache_key).await {
            return Ok(Some(cached));
        }

        let secret_hash = hash_ingest_key(raw_secret, &self.lookup_hmac_key)?;
        let Some(row) = self
            .store
            .fetch_connector(connector_id, &secret_hash)
            .await?
        else {
            return Ok(None);
        };

        let resolved = ResolvedCloudflareConnector {
            connector_id: connector_id.to_string(),
            org_id: row.org_id,
            service_name: row.service_name,
            zone_name: row.zone_name,
            dataset: row.dataset,
            secret_key_id: secret_hash.chars().take(16).collect(),
            self_managed: row.self_managed,
        };

        self.cache.insert(cache_key, resolved.clone()).await;

        Ok(Some(resolved))
    }

    async fn record_success(&self, connector_id: &str) -> Result<(), String> {
        self.store
            .record_connector_success(connector_id, current_time_millis() as i64)
            .await
    }

    async fn record_failure(&self, connector_id: &str, error_message: &str) -> Result<(), String> {
        self.store
            .record_connector_failure(connector_id, error_message, current_time_millis() as i64)
            .await
    }
}

impl SamplingPolicyResolver {
    async fn resolve_policy(&self, org_id: &str) -> SamplingPolicy {
        if let Some(policy) = self.cache.get(org_id).await {
            return policy;
        }

        let policy = match self.store.fetch_sampling_policy(org_id).await {
            Ok(Some(row)) => SamplingPolicy {
                trace_sample_ratio: row.trace_sample_ratio,
                always_keep_error_spans: row.always_keep_error_spans,
                always_keep_slow_spans_ms: row.always_keep_slow_spans_ms,
            },
            Ok(None) => SamplingPolicy::default(),
            Err(error) => {
                warn!(
                    org_id,
                    error = %error,
                    "Sampling policy lookup failed; using unsampled default"
                );
                SamplingPolicy::default()
            }
        };
        self.cache.insert(org_id.to_string(), policy.clone()).await;
        policy
    }
}

/// Cloudflare D1 REST-backed KeyStore. Hits
/// `POST /accounts/{acct}/d1/database/{db}/query` for every cache miss.
/// The HMAC-fingerprint canary, the 60s in-process cache, and SQL strings
/// (which are vanilla SQLite, identical to libsql) all stay the same — only
/// the transport changes.
struct D1KeyStore {
    http: reqwest::Client,
    endpoint: String,
    api_token: String,
}

impl D1KeyStore {
    fn new(http: reqwest::Client, account_id: &str, database_id: &str, api_token: String) -> Self {
        Self {
            http,
            endpoint: format!(
                "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
            ),
            api_token,
        }
    }

    async fn query(
        &self,
        sql: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let body = serde_json::json!({ "sql": sql, "params": params });
        let response = self
            .http
            .post(&self.endpoint)
            .bearer_auth(&self.api_token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("D1 request failed: {error}"))?;

        let status = response.status();
        let payload = response
            .text()
            .await
            .map_err(|error| format!("D1 response read failed: {error}"))?;
        if !status.is_success() {
            return Err(format!("D1 HTTP {status}: {payload}"));
        }

        let parsed: D1Response = serde_json::from_str(&payload)
            .map_err(|error| format!("D1 response parse failed: {error}: {payload}"))?;

        if !parsed.success {
            let messages: Vec<String> = parsed
                .errors
                .into_iter()
                .map(|e| format!("[{}] {}", e.code, e.message))
                .collect();
            return Err(format!("D1 query failed: {}", messages.join("; ")));
        }

        // `result` is one entry per statement; we always submit one SQL string,
        // so take the first. Empty `results` means no rows matched — caller
        // turns that into `Ok(None)`.
        let first = parsed
            .result
            .into_iter()
            .next()
            .ok_or_else(|| "D1 response missing result[0]".to_string())?;
        Ok(first.results)
    }

    async fn execute(&self, sql: &str, params: Vec<serde_json::Value>) -> Result<(), String> {
        let _ = self.query(sql, params).await?;
        Ok(())
    }

    /// Startup sanity check: runs the actual production lookup query with a
    /// stub hash. The row count doesn't matter — we just need CF to accept the
    /// SQL. A 4xx, a `success:false`, a missing table, a missing column, an
    /// auth failure: all surface here as an `Err(...)` that the caller turns
    /// into a hard exit. This is the boot-time gate that prevents shipping a
    /// binary whose D1 access is broken for any reason.
    async fn probe(&self) -> Result<(), String> {
        let sanity_sql = "SELECT k.org_id, \
                                 CASE WHEN s.sync_status = 'connected' THEN 1 ELSE 0 END AS self_managed \
                          FROM org_ingest_keys k \
                          LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
                          WHERE k.private_key_hash = ? LIMIT 1";
        self.query(
            sanity_sql,
            vec![serde_json::Value::String(
                "__ingest_probe_no_match__".to_string(),
            )],
        )
        .await
        .map(|_| ())
    }
}

#[derive(serde::Deserialize)]
struct D1Response {
    success: bool,
    #[serde(default)]
    errors: Vec<D1Error>,
    #[serde(default)]
    result: Vec<D1StatementResult>,
}

#[derive(serde::Deserialize)]
struct D1Error {
    code: i64,
    message: String,
}

#[derive(serde::Deserialize)]
struct D1StatementResult {
    #[serde(default)]
    results: Vec<serde_json::Value>,
}

/// Extract a string field from a D1 row JSON object, returning a descriptive
/// error rather than panicking on a missing/wrong-typed column.
fn d1_str(row: &serde_json::Value, key: &str) -> Result<String, String> {
    row.get(key)
        .and_then(|value| value.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("D1 row missing string field `{key}`: {row}"))
}

/// D1's JSON encoder represents the `CASE WHEN ... THEN 1 ELSE 0 END` as an
/// integer (1/0). Accept either a JSON number or a bool defensively.
fn d1_truthy(row: &serde_json::Value, key: &str) -> bool {
    match row.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(serde_json::Value::Bool(b)) => *b,
        _ => false,
    }
}

#[async_trait::async_trait]
impl KeyStore for D1KeyStore {
    async fn fetch_ingest_key(
        &self,
        key_hash: &str,
        hash_column: &'static str,
    ) -> Result<Option<KeyRow>, String> {
        let sql = format!(
            "SELECT k.org_id, \
                    CASE WHEN s.sync_status = 'connected' THEN 1 ELSE 0 END AS self_managed \
             FROM org_ingest_keys k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             WHERE k.{hash_column} = ? LIMIT 1"
        );
        let rows = self
            .query(&sql, vec![serde_json::Value::String(key_hash.to_string())])
            .await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(KeyRow {
            org_id: d1_str(&row, "org_id")?,
            self_managed: d1_truthy(&row, "self_managed"),
        }))
    }

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        let sql = "SELECT c.org_id, c.service_name, c.zone_name, c.dataset, \
                          CASE WHEN s.sync_status = 'connected' THEN 1 ELSE 0 END AS self_managed \
                   FROM cloudflare_logpush_connectors c \
                   LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
                   WHERE c.id = ? AND c.secret_hash = ? AND c.enabled = 1 LIMIT 1";
        let rows = self
            .query(
                sql,
                vec![
                    serde_json::Value::String(connector_id.to_string()),
                    serde_json::Value::String(secret_hash.to_string()),
                ],
            )
            .await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(ConnectorRow {
            org_id: d1_str(&row, "org_id")?,
            service_name: d1_str(&row, "service_name")?,
            zone_name: d1_str(&row, "zone_name")?,
            dataset: d1_str(&row, "dataset")?,
            self_managed: d1_truthy(&row, "self_managed"),
        }))
    }

    async fn fetch_sampling_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String> {
        let sql = "SELECT trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms \
                   FROM org_ingest_sampling_policies WHERE org_id = ? LIMIT 1";
        let rows = self
            .query(sql, vec![serde_json::Value::String(org_id.to_string())])
            .await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(SamplingPolicyRow {
            trace_sample_ratio: row
                .get("trace_sample_ratio")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(1.0),
            always_keep_error_spans: d1_truthy(&row, "always_keep_error_spans"),
            always_keep_slow_spans_ms: row
                .get("always_keep_slow_spans_ms")
                .and_then(serde_json::Value::as_u64),
        }))
    }

    async fn record_connector_success(
        &self,
        connector_id: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        self.execute(
            "UPDATE cloudflare_logpush_connectors SET last_received_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            vec![
                serde_json::Value::Number(now_ms.into()),
                serde_json::Value::Number(now_ms.into()),
                serde_json::Value::String(connector_id.to_string()),
            ],
        )
        .await
    }

    async fn record_connector_failure(
        &self,
        connector_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        self.execute(
            "UPDATE cloudflare_logpush_connectors SET last_error = ?, updated_at = ? WHERE id = ?",
            vec![
                serde_json::Value::String(error.to_string()),
                serde_json::Value::Number(now_ms.into()),
                serde_json::Value::String(connector_id.to_string()),
            ],
        )
        .await
    }
}

// Local-dev / single-tenant KeyStore: every well-formed ingest key resolves to
// the configured org. No DB, no network. Connector flows are no-ops since
// Cloudflare Logpush is a production-only integration.
struct StaticKeyStore {
    org_id: String,
}

#[async_trait::async_trait]
impl KeyStore for StaticKeyStore {
    async fn fetch_ingest_key(
        &self,
        _key_hash: &str,
        _hash_column: &'static str,
    ) -> Result<Option<KeyRow>, String> {
        Ok(Some(KeyRow {
            org_id: self.org_id.clone(),
            self_managed: false,
        }))
    }

    async fn fetch_connector(
        &self,
        _connector_id: &str,
        _secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        Ok(None)
    }

    async fn fetch_sampling_policy(
        &self,
        _org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String> {
        Ok(None)
    }

    async fn record_connector_success(
        &self,
        _connector_id: &str,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn record_connector_failure(
        &self,
        _connector_id: &str,
        _error: &str,
        _now_ms: i64,
    ) -> Result<(), String> {
        Ok(())
    }
}

fn infer_ingest_key_type(raw_key: &str) -> Option<IngestKeyType> {
    if raw_key.starts_with("maple_pk_") {
        return Some(IngestKeyType::Public);
    }

    if raw_key.starts_with("maple_sk_") {
        return Some(IngestKeyType::Private);
    }

    None
}

fn hash_ingest_key(raw_key: &str, lookup_hmac_key: &str) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(lookup_hmac_key.as_bytes())
        .map_err(|error| format!("Invalid HMAC key: {error}"))?;
    mac.update(raw_key.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn current_time_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// Build the KeyStore for this process. The `Static` variant resolves any
/// well-formed ingest key to a single configured org — used for single-tenant
/// local dev so contributors don't need CF D1 credentials to boot the service.
/// The `D1` variant reads `org_ingest_keys` from Cloudflare D1 via the REST API
/// (the API service writes to the same D1 database); a probe query runs at
/// startup so any auth/schema/network issue surfaces here instead of 503'ing
/// every request.
async fn build_key_store(
    config: &AppConfig,
    http_client: reqwest::Client,
) -> Result<Arc<dyn KeyStore>, String> {
    match &config.key_store_backend {
        KeyStoreBackend::Static { org_id } => {
            info!(
                backend = "static",
                org_id = %org_id,
                "Key store backend selected"
            );
            Ok(Arc::new(StaticKeyStore {
                org_id: org_id.clone(),
            }))
        }
        KeyStoreBackend::D1 {
            cf_account_id,
            d1_database_id,
            d1_api_token,
        } => {
            info!(
                backend = "cloudflare-d1",
                cf_account = %cf_account_id,
                d1_database = %d1_database_id,
                "Key store backend selected"
            );
            let store = D1KeyStore::new(
                http_client,
                cf_account_id,
                d1_database_id,
                d1_api_token.clone(),
            );
            store
                .probe()
                .await
                .map_err(|error| format!("D1 startup probe failed: {error}"))?;
            info!("D1 startup probe succeeded");
            Ok(Arc::new(store))
        }
    }
}

fn parse_bool(name: &str, raw: Option<String>, default: bool) -> Result<bool, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(default);
    }

    match value.as_str() {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => Err(format!("{name} must be true/false or 1/0")),
    }
}

fn parse_u16(name: &str, raw: Option<String>, default: u16) -> Result<u16, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u16>()
        .map_err(|_| format!("{name} must be a valid u16"))
}

fn parse_optional_u16(name: &str, raw: Option<String>) -> Result<Option<u16>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() || value == "0" {
        return Ok(None);
    }
    value
        .parse::<u16>()
        .map(Some)
        .map_err(|_| format!("{name} must be a valid u16"))
}

fn parse_u64(name: &str, raw: Option<String>, default: u64) -> Result<u64, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

fn parse_usize(name: &str, raw: Option<String>, default: usize) -> Result<usize, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic() {
        let hash_a = hash_ingest_key("maple_pk_123", "secret").unwrap();
        let hash_b = hash_ingest_key("maple_pk_123", "secret").unwrap();
        assert_eq!(hash_a, hash_b);
    }

    #[test]
    fn sentinel_token_matches_only_exact_literal() {
        assert!(is_sentinel_token("MAPLE_TEST"));
        assert!(!is_sentinel_token("maple_test"));
        assert!(!is_sentinel_token(" MAPLE_TEST"));
        assert!(!is_sentinel_token("MAPLE_TEST "));
        assert!(!is_sentinel_token("MAPLE_TEST_KEY"));
        assert!(!is_sentinel_token(""));
        assert!(!is_sentinel_token("maple_pk_123"));
    }

    #[test]
    fn extract_ingest_key_returns_sentinel_literal_unchanged() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer MAPLE_TEST".parse().unwrap());
        let token = extract_ingest_key(&headers).expect("token present");
        assert_eq!(token, SENTINEL_TOKEN);
        assert!(is_sentinel_token(&token));
    }

    #[test]
    fn enrichment_overwrites_tenant_fields() {
        let mut attributes = vec![
            KeyValue {
                key: "org_id".to_string(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("spoofed".to_string())),
                }),
            },
            KeyValue {
                key: "maple_org_id".to_string(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::StringValue("spoofed".to_string())),
                }),
            },
        ];

        let resolved = ResolvedIngestKey {
            org_id: "org_real".to_string(),
            key_type: IngestKeyType::Private,
            key_id: "abc".to_string(),
            self_managed: false,
        };

        enrich_resource_attributes(&mut attributes, &resolved);

        let mut values = std::collections::HashMap::new();
        for attribute in &attributes {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                values.insert(attribute.key.clone(), value.clone());
            }
        }

        assert_eq!(values.get("maple_org_id"), Some(&"org_real".to_string()));
        assert_eq!(
            values.get("maple_ingest_key_type"),
            Some(&"private".to_string())
        );
        assert_eq!(
            values.get("maple_ingest_source"),
            Some(&INGEST_SOURCE.to_string())
        );
        assert!(!values.contains_key("org_id"));
    }

    #[test]
    fn cloudflare_validation_payload_is_detected() {
        let parsed = parse_cloudflare_payload(br#"{"content":"tests"}"#).unwrap();
        assert!(matches!(parsed, ParsedCloudflarePayload::Validation));
    }

    #[test]
    fn cloudflare_ndjson_payload_parses_multiple_records() {
        let parsed = parse_cloudflare_payload(
            br#"{"RayID":"a","EdgeResponseStatus":200}
{"RayID":"b","EdgeResponseStatus":503}"#,
        )
        .unwrap();

        match parsed {
            ParsedCloudflarePayload::Validation => panic!("expected records"),
            ParsedCloudflarePayload::Records(records) => {
                assert_eq!(records.len(), 2);
                assert_eq!(
                    records[0].get("RayID").and_then(JsonValue::as_str),
                    Some("a")
                );
                assert_eq!(
                    records[1].get("RayID").and_then(JsonValue::as_str),
                    Some("b")
                );
            }
        }
    }

    #[test]
    fn cloudflare_timestamps_support_rfc3339_unix_and_unix_nano() {
        let rfc3339 = JsonValue::String("2025-03-07T12:34:56Z".to_string());
        let unix = JsonValue::Number(serde_json::Number::from(1_741_351_296u64));
        let unix_nano = JsonValue::Number(serde_json::Number::from(1_741_351_296_123_456_789u64));

        assert_eq!(
            parse_cloudflare_timestamp(&rfc3339),
            Some(1_741_350_896_000_000_000)
        );
        assert_eq!(
            parse_cloudflare_timestamp(&unix),
            Some(1_741_351_296_000_000_000)
        );
        assert_eq!(
            parse_cloudflare_timestamp(&unix_nano),
            Some(1_741_351_296_123_456_789)
        );
    }

    #[test]
    fn cloudflare_log_record_maps_body_severity_and_attributes() {
        let resolved = ResolvedCloudflareConnector {
            connector_id: "connector_1".to_string(),
            org_id: "org_1".to_string(),
            service_name: "cloudflare/example.com".to_string(),
            zone_name: "example.com".to_string(),
            dataset: "http_requests".to_string(),
            secret_key_id: "secret".to_string(),
            self_managed: false,
        };
        let record = serde_json::from_str::<JsonMap<String, JsonValue>>(
            r#"{
                "EdgeStartTimestamp": "2025-03-07T12:34:56Z",
                "ClientRequestMethod": "GET",
                "ClientRequestHost": "example.com",
                "ClientRequestURI": "/status",
                "EdgeResponseStatus": 503,
                "RayID": "abc123",
                "ClientCountry": "US",
                "ZoneName": "example.com"
            }"#,
        )
        .unwrap();

        let otlp = build_cloudflare_logs_request(&resolved, vec![record]);
        let resource_log = &otlp.resource_logs[0];
        let log_record = &resource_log.scope_logs[0].log_records[0];

        assert_eq!(log_record.severity_text, "ERROR");
        assert_eq!(log_record.severity_number, 17);
        assert_eq!(
            log_record.body.as_ref().and_then(|body| match &body.value {
                Some(any_value::Value::StringValue(value)) => Some(value.as_str()),
                _ => None,
            }),
            Some("GET example.com/status -> 503")
        );

        let mut resource_values = std::collections::HashMap::new();
        for attribute in resource_log.resource.as_ref().unwrap().attributes.iter() {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                resource_values.insert(attribute.key.as_str(), value.as_str());
            }
        }
        assert_eq!(
            resource_values.get("maple_ingest_source"),
            Some(&CLOUDFLARE_LOGPUSH_SOURCE)
        );
        assert_eq!(
            resource_values.get("service.name"),
            Some(&"cloudflare/example.com")
        );

        let mut log_values = std::collections::HashMap::new();
        for attribute in log_record.attributes.iter() {
            if let Some(AnyValue {
                value: Some(any_value::Value::StringValue(value)),
            }) = &attribute.value
            {
                log_values.insert(attribute.key.as_str(), value.as_str());
            }
        }

        assert_eq!(log_values.get("RayID"), Some(&"abc123"));
        assert_eq!(log_values.get("ClientCountry"), Some(&"US"));
    }

    #[test]
    fn non_self_managed_goes_to_shared_pool() {
        let (endpoint, pool) = select_forward_endpoint(
            "http://shared:4318",
            Some("http://self-managed:4318"),
            false,
        );
        assert_eq!(endpoint, "http://shared:4318");
        assert_eq!(pool, "shared");
    }

    #[test]
    fn self_managed_goes_to_self_managed_pool_when_configured() {
        let (endpoint, pool) =
            select_forward_endpoint("http://shared:4318", Some("http://self-managed:4318"), true);
        assert_eq!(endpoint, "http://self-managed:4318");
        assert_eq!(pool, "self_managed");
    }

    #[test]
    fn self_managed_degrades_to_shared_when_endpoint_unset() {
        // Missing INGEST_FORWARD_SELF_MANAGED_ENDPOINT should never drop traffic
        // — self-managed orgs degrade back to the shared pool until the
        // operator wires the second collector in.
        let (endpoint, pool) = select_forward_endpoint("http://shared:4318", None, true);
        assert_eq!(endpoint, "http://shared:4318");
        assert_eq!(pool, "shared");
    }

    /// In-memory KeyStore used to exercise the resolver's behavior (caching,
    /// key-type inference, ResolvedIngestKey construction) without HTTP. Keyed
    /// on the same `(hash, column)` shape the real D1 store sees.
    #[derive(Default)]
    struct FakeKeyStore {
        keys: std::sync::Mutex<std::collections::HashMap<(String, &'static str), KeyRow>>,
    }

    impl FakeKeyStore {
        fn insert_private(&self, raw_key: &str, row: KeyRow) {
            let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
            self.keys
                .lock()
                .unwrap()
                .insert((hash, "private_key_hash"), row);
        }
    }

    #[async_trait::async_trait]
    impl KeyStore for FakeKeyStore {
        async fn fetch_ingest_key(
            &self,
            key_hash: &str,
            hash_column: &'static str,
        ) -> Result<Option<KeyRow>, String> {
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(&(key_hash.to_string(), hash_column))
                .cloned())
        }
        async fn fetch_connector(
            &self,
            _connector_id: &str,
            _secret_hash: &str,
        ) -> Result<Option<ConnectorRow>, String> {
            Ok(None)
        }
        async fn fetch_sampling_policy(
            &self,
            _org_id: &str,
        ) -> Result<Option<SamplingPolicyRow>, String> {
            Ok(None)
        }
        async fn record_connector_success(
            &self,
            _connector_id: &str,
            _now_ms: i64,
        ) -> Result<(), String> {
            Ok(())
        }
        async fn record_connector_failure(
            &self,
            _connector_id: &str,
            _error: &str,
            _now_ms: i64,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    fn make_resolver(store: Arc<FakeKeyStore>) -> IngestKeyResolver {
        IngestKeyResolver {
            store,
            lookup_hmac_key: "test-hmac-key".to_string(),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        }
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_false_when_no_settings_row() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_shared",
            KeyRow {
                org_id: "org_shared".to_string(),
                self_managed: false,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_shared")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_shared");
        assert!(!resolved.self_managed);
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_true_when_active_settings_row() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_byo",
            KeyRow {
                org_id: "org_byo".to_string(),
                self_managed: true,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_byo")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_byo");
        assert!(resolved.self_managed);
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_none_when_hash_missing() {
        // Unknown key (e.g. before the API has written the row, or after a
        // reroll under a different HMAC) must produce Ok(None) so the caller
        // emits a 401 rather than crashing.
        let store = Arc::new(FakeKeyStore::default());
        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_unknown")
            .await
            .expect("resolve should succeed");
        assert!(resolved.is_none());
    }

    #[test]
    fn d1_response_parses_success_with_rows() {
        // Canonical Cloudflare D1 response — `result` is an array of one
        // statement result; `results` inside it is the row list. We always
        // submit one SQL string so `result[0].results` is the row set.
        let payload = serde_json::json!({
            "success": true,
            "errors": [],
            "messages": [],
            "result": [{
                "results": [
                    {"org_id": "org_test", "self_managed": 1}
                ],
                "success": true,
                "meta": {"duration": 4.2}
            }]
        })
        .to_string();
        let parsed: D1Response = serde_json::from_str(&payload).expect("parses");
        assert!(parsed.success);
        let first = parsed.result.into_iter().next().expect("has result[0]");
        assert_eq!(first.results.len(), 1);
        let row = &first.results[0];
        assert_eq!(d1_str(row, "org_id").unwrap(), "org_test");
        assert!(d1_truthy(row, "self_managed"));
    }

    #[test]
    fn d1_response_parses_empty_results_as_no_match() {
        // No row → caller turns this into Ok(None) and the gateway 401s.
        let payload = serde_json::json!({
            "success": true,
            "errors": [],
            "messages": [],
            "result": [{"results": [], "success": true}]
        })
        .to_string();
        let parsed: D1Response = serde_json::from_str(&payload).expect("parses");
        let first = parsed.result.into_iter().next().expect("has result[0]");
        assert!(first.results.is_empty());
    }

    #[test]
    fn d1_response_parses_failure_with_errors() {
        // CF returns success=false plus a list of error objects. We surface
        // these as Err(...) without leaking the API token.
        let payload = serde_json::json!({
            "success": false,
            "errors": [{"code": 7500, "message": "no such table"}],
            "messages": [],
            "result": []
        })
        .to_string();
        let parsed: D1Response = serde_json::from_str(&payload).expect("parses");
        assert!(!parsed.success);
        assert_eq!(parsed.errors.len(), 1);
        assert_eq!(parsed.errors[0].code, 7500);
        assert_eq!(parsed.errors[0].message, "no such table");
    }

    #[test]
    fn d1_truthy_accepts_int_and_bool_self_managed() {
        // The SQL is `CASE WHEN ... THEN 1 ELSE 0 END`; D1 returns it as a JSON
        // number, but accept JSON bool defensively in case the encoding ever
        // changes.
        let int_one = serde_json::json!({"self_managed": 1});
        let int_zero = serde_json::json!({"self_managed": 0});
        let bool_true = serde_json::json!({"self_managed": true});
        let missing = serde_json::json!({});
        assert!(d1_truthy(&int_one, "self_managed"));
        assert!(!d1_truthy(&int_zero, "self_managed"));
        assert!(d1_truthy(&bool_true, "self_managed"));
        assert!(!d1_truthy(&missing, "self_managed"));
    }
}
