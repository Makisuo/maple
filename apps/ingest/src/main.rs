#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod autumn;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use autumn::{AutumnEntitlements, AutumnTracker};
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
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::DateTime;
use dashmap::DashMap;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use maple_ingest::clickhouse_insert_mappings::SCHEMA_VERSION as CLICKHOUSE_SCHEMA_VERSION;
use maple_ingest::metrics;
use maple_ingest::otel::{build_resource, forward_client_span, ResourceConfig};
use maple_ingest::telemetry::{
    AttributeMappingRule, ClickHouseBreakerConfig, ClickHouseTarget, ClickHouseTargetProvider,
    DatasourceNames, ExportDestination, MappingOperation, MappingSourceContext, PipelineError,
    SamplingPolicy, TelemetryPipeline, TelemetrySignal, TinybirdConfig,
};
use moka::future::Cache;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_sdk::metrics::periodic_reader_with_async_runtime::PeriodicReader;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::runtime::Tokio as OtelTokio;
use opentelemetry_sdk::trace::span_processor_with_async_runtime::BatchSpanProcessor;
use opentelemetry_sdk::trace::{BatchConfigBuilder, SdkTracerProvider};
use prost::Message;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::Sha256;
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
    forward_timeout: Duration,
    write_mode: WriteMode,
    tinybird: TinybirdConfig,
    max_request_body_bytes: usize,
    org_max_in_flight: u64,
    require_tls: bool,
    key_store_backend: KeyStoreBackend,
    clickhouse_encryption_key: Option<[u8; 32]>,
    lookup_hmac_key: String,
    autumn_secret_key: Option<String>,
    autumn_api_url: String,
    autumn_flush_interval_secs: u64,
    autumn_enforce_limits: bool,
    autumn_check_cache_ttl_secs: u64,
    ingest_key_cache_ttl_secs: u64,
    org_routing_cache_ttl_secs: u64,
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

fn uses_native_pipeline_for(write_mode: WriteMode, destination: ExportDestination) -> bool {
    write_mode.uses_tinybird() || destination == ExportDestination::ClickHouse
}

fn uses_forward_path_for(write_mode: WriteMode, destination: ExportDestination) -> bool {
    write_mode.uses_forward() && destination != ExportDestination::ClickHouse
}

#[derive(Clone)]
enum KeyStoreBackend {
    // No-DB local backend: every well-formed ingest key resolves to a single
    // override org. Selected for single-tenant local dev so contributors don't
    // need database credentials to boot the service.
    Static {
        org_id: String,
    },
    // PlanetScale Postgres backend used in multi-tenant / production deploys.
    // `url` is the standard pg connection string (PSBouncer port 6432, sslmode
    // require); the API service writes ingest-key rows to the same database.
    Postgres {
        url: String,
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
            export_max_attempts: parse_u32(
                "INGEST_EXPORT_MAX_ATTEMPTS",
                std::env::var("INGEST_EXPORT_MAX_ATTEMPTS").ok(),
                20,
            )?,
            clickhouse_export_timeout: Duration::from_millis(parse_u64(
                "INGEST_CLICKHOUSE_EXPORT_TIMEOUT_MS",
                std::env::var("INGEST_CLICKHOUSE_EXPORT_TIMEOUT_MS").ok(),
                3_000,
            )?),
            clickhouse_breaker: ClickHouseBreakerConfig {
                // 0 disables the breaker (full retry budget on every batch).
                failure_threshold: parse_u32(
                    "INGEST_CLICKHOUSE_BREAKER_FAILURE_THRESHOLD",
                    std::env::var("INGEST_CLICKHOUSE_BREAKER_FAILURE_THRESHOLD").ok(),
                    ClickHouseBreakerConfig::default().failure_threshold,
                )?,
                cooldown: Duration::from_millis(parse_u64(
                    "INGEST_CLICKHOUSE_BREAKER_COOLDOWN_MS",
                    std::env::var("INGEST_CLICKHOUSE_BREAKER_COOLDOWN_MS").ok(),
                    ClickHouseBreakerConfig::default().cooldown.as_millis() as u64,
                )?),
            },
            datasources: DatasourceNames::from_env(),
            datasource_session_replays: std::env::var("INGEST_TINYBIRD_DATASOURCE_SESSION_REPLAYS")
                .unwrap_or_else(|_| "session_replays".to_string()),
            datasource_session_replay_events: std::env::var(
                "INGEST_TINYBIRD_DATASOURCE_SESSION_REPLAY_EVENTS",
            )
            .unwrap_or_else(|_| "session_replay_events".to_string()),
            datasource_session_events: std::env::var("INGEST_TINYBIRD_DATASOURCE_SESSION_EVENTS")
                .unwrap_or_else(|_| "session_events".to_string()),
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

        let key_store_backend = resolve_key_store_backend()?;
        let clickhouse_encryption_key = match &key_store_backend {
            // The Postgres key store decrypts BYO-ClickHouse credentials from
            // org_clickhouse_settings, so it needs the encryption key.
            KeyStoreBackend::Postgres { .. } => {
                let raw = std::env::var("MAPLE_INGEST_KEY_ENCRYPTION_KEY")
                    .map_err(|_| "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required".to_string())?;
                Some(parse_base64_aes256_gcm_key(&raw)?)
            }
            KeyStoreBackend::Static { .. } => None,
        };

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

        // Billing enforcement: when enabled, the gateway rejects ingestion for
        // orgs that are over their hard-capped base-plan allotment or have no
        // active subscription (see AutumnEntitlements). Off by default so it can
        // be deployed dark and flipped on per-environment after verification.
        let autumn_enforce_limits = parse_bool(
            "AUTUMN_ENFORCE_LIMITS",
            std::env::var("AUTUMN_ENFORCE_LIMITS").ok(),
            false,
        )?;

        let autumn_check_cache_ttl_secs = parse_u64(
            "AUTUMN_CHECK_CACHE_TTL_SECS",
            std::env::var("AUTUMN_CHECK_CACHE_TTL_SECS").ok(),
            60,
        )?;

        let ingest_key_cache_ttl_secs = parse_u64(
            "INGEST_KEY_CACHE_TTL_SECS",
            std::env::var("INGEST_KEY_CACHE_TTL_SECS").ok(),
            60,
        )?;

        let org_routing_cache_ttl_secs = parse_u64(
            "INGEST_ORG_ROUTING_CACHE_TTL_SECS",
            std::env::var("INGEST_ORG_ROUTING_CACHE_TTL_SECS").ok(),
            1,
        )?;

        Ok(Self {
            port,
            otlp_grpc_port,
            forward_endpoint,
            forward_timeout: Duration::from_millis(forward_timeout_ms),
            write_mode,
            tinybird,
            max_request_body_bytes,
            org_max_in_flight,
            require_tls,
            key_store_backend,
            clickhouse_encryption_key,
            lookup_hmac_key,
            autumn_secret_key,
            autumn_api_url,
            autumn_flush_interval_secs,
            autumn_enforce_limits,
            autumn_check_cache_ttl_secs,
            ingest_key_cache_ttl_secs,
            org_routing_cache_ttl_secs,
        })
    }
}

// Pick a KeyStore backend from env. `INGEST_KEY_STORE_BACKEND`
// (static|postgres) wins when set; otherwise `MAPLE_SELF_HOSTED_MODE=
// single_tenant` implies static; in all other cases we use Postgres (the
// production backend).
fn resolve_key_store_backend() -> Result<KeyStoreBackend, String> {
    let backend_override = std::env::var("INGEST_KEY_STORE_BACKEND")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    let self_hosted_mode = std::env::var("MAPLE_SELF_HOSTED_MODE")
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    #[derive(PartialEq)]
    enum Want {
        Static,
        Postgres,
    }

    let want = match backend_override.as_deref() {
        Some("static") => Want::Static,
        Some("postgres") | Some("pg") => Want::Postgres,
        Some(other) => {
            return Err(format!(
                "INGEST_KEY_STORE_BACKEND must be `static` or `postgres`, got `{other}`"
            ));
        }
        None => {
            if self_hosted_mode.as_deref() == Some("single_tenant") {
                Want::Static
            } else {
                Want::Postgres
            }
        }
    };

    if want == Want::Static {
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

    let url = std::env::var("MAPLE_PG_URL")
        .map_err(|_| "MAPLE_PG_URL is required for the postgres key store backend".to_string())?
        .trim()
        .to_string();
    if url.is_empty() {
        return Err("MAPLE_PG_URL is required for the postgres key store backend".to_string());
    }

    Ok(KeyStoreBackend::Postgres {
        url,
    })
}

struct IngestKeyResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, IngestKeyIdentity>,
    routing: Arc<OrgRoutingResolver>,
}

struct CloudflareConnectorResolver {
    store: Arc<dyn KeyStore>,
    lookup_hmac_key: String,
    cache: Cache<String, CloudflareConnectorIdentity>,
    routing: Arc<OrgRoutingResolver>,
}

struct OrgRoutingResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, OrgRouting>,
    last_known: DashMap<String, OrgRouting>,
}

struct SamplingPolicyResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, SamplingPolicy>,
}

struct AttributeMappingResolver {
    store: Arc<dyn KeyStore>,
    cache: Cache<String, Arc<Vec<AttributeMappingRule>>>,
}

struct ClickHouseTargetResolver {
    store: Arc<dyn KeyStore>,
    encryption_key: Option<[u8; 32]>,
    cache: Cache<String, ClickHouseTarget>,
}

/// Database-agnostic surface used by the resolvers. Implementations:
/// `StaticKeyStore` (local dev / single-tenant) and `PostgresKeyStore`
/// (PlanetScale Postgres in production, where the API service writes ingest-key
/// rows). Both back the same operations.
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

    async fn fetch_attribute_mappings(
        &self,
        org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String>;

    async fn fetch_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String>;

    async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String>;

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
    clickhouse_ready: bool,
}

#[derive(Clone, Debug)]
struct ConnectorRow {
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    self_managed: bool,
    clickhouse_ready: bool,
}

#[derive(Clone, Debug)]
struct SamplingPolicyRow {
    trace_sample_ratio: f64,
    always_keep_error_spans: bool,
    always_keep_slow_spans_ms: Option<u64>,
}

#[derive(Clone, Debug)]
struct AttributeMappingRow {
    source_context: String,
    source_key: String,
    target_key: String,
    operation: String,
}

#[derive(Clone)]
struct IngestKeyIdentity {
    org_id: String,
    key_type: IngestKeyType,
    key_id: String,
}

impl IngestKeyIdentity {
    fn into_resolved(self, routing: OrgRouting) -> ResolvedIngestKey {
        ResolvedIngestKey {
            org_id: self.org_id,
            key_type: self.key_type,
            key_id: self.key_id,
            self_managed: routing.self_managed,
            clickhouse_ready: routing.clickhouse_ready,
        }
    }
}

#[derive(Clone)]
struct CloudflareConnectorIdentity {
    connector_id: String,
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    secret_key_id: String,
}

impl CloudflareConnectorIdentity {
    fn into_resolved(self, routing: OrgRouting) -> ResolvedCloudflareConnector {
        ResolvedCloudflareConnector {
            connector_id: self.connector_id,
            org_id: self.org_id,
            service_name: self.service_name,
            zone_name: self.zone_name,
            dataset: self.dataset,
            secret_key_id: self.secret_key_id,
            self_managed: routing.self_managed,
            clickhouse_ready: routing.clickhouse_ready,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct OrgRouting {
    self_managed: bool,
    clickhouse_ready: bool,
}

impl OrgRouting {
    fn from_key_row(row: &KeyRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        }
    }

    fn from_connector_row(row: &ConnectorRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
        }
    }
}

#[derive(Clone, Debug)]
struct ClickHouseTargetRow {
    ch_url: String,
    ch_user: String,
    ch_password_ciphertext: Option<String>,
    ch_password_iv: Option<String>,
    ch_password_tag: Option<String>,
    ch_database: String,
    schema_version: String,
}

struct AppState {
    config: AppConfig,
    http_client: Client,
    telemetry_pipeline: Option<TelemetryPipeline>,
    resolver: IngestKeyResolver,
    org_inflight_limiter: OrgInFlightLimiter,
    sampling_resolver: SamplingPolicyResolver,
    attribute_mapping_resolver: AttributeMappingResolver,
    cloudflare_resolver: CloudflareConnectorResolver,
    autumn_tracker: Option<AutumnTracker>,
    autumn_entitlements: Option<AutumnEntitlements>,
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
    // Native direct ClickHouse ingest is stricter: the connection is healthy
    // and the applied schema version equals this binary's ClickHouse migration
    // version (SCHEMA_VERSION) — NOT the Tinybird-coupled PROJECT_REVISION, so a
    // Tinybird-only schema change can't silently un-ready a BYO-CH org.
    clickhouse_ready: bool,
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
    clickhouse_ready: bool,
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
        metrics::request_finished();
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
                metrics::org_throttled(org_id, "in_flight");
                return None;
            }
            if counter
                .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                metrics::org_requests_in_flight(org_id, current + 1);
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
        metrics::org_requests_in_flight(&self.org_id, next);
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

    /// Stable `error.type` label for this error, by HTTP status. Reuses the same
    /// vocabulary as `handle_signal_inner` so the native replay/session handlers
    /// produce categorizable spans instead of "Unknown Error".
    fn error_kind(&self) -> &'static str {
        match self.status {
            StatusCode::UNAUTHORIZED => "auth",
            StatusCode::BAD_REQUEST => "bad_request",
            StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media",
            StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
            StatusCode::TOO_MANY_REQUESTS => "throttle",
            StatusCode::SERVICE_UNAVAILABLE => "unavailable",
            _ => "error",
        }
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

/// OTEL span status (`otel.status_code`) for a rejected request, by HTTP status.
///
/// Per the OpenTelemetry HTTP semantic conventions, a SERVER span is only an
/// `Error` for 5xx responses; 4xx client rejections (missing/invalid ingest key,
/// billing limit, throttle, oversized/undecodable payload) are the caller's fault
/// and must NOT mark the span `Error` — otherwise they flood the error dashboards
/// (which count `StatusCode='Error'`). The genuine server-side auth failure
/// (resolver unavailable → 503) is 5xx and stays `Error`. `http.response.status_code`,
/// `error.type`, and the `request_completed(… "error" …)` metric are recorded
/// regardless, so 4xx rejections remain fully observable.
fn otel_status_for_rejection(status: u16) -> &'static str {
    if status >= 500 {
        "Error"
    } else {
        "Ok"
    }
}

/// Map a telemetry pipeline rejection to the client-facing HTTP error.
///
/// Transient queue conditions (`Throttled` = per-org byte cap, `Backpressure` =
/// lane channel full) are retryable and surface as **429** — via
/// `otel_status_for_rejection` these become `Ok` spans, so a customer's slow
/// BYO-ClickHouse target (which backs the lane up) does not flood our error
/// dashboards as "Unknown Error" 503s. Genuine backend failures
/// (`QueueUnavailable` = WAL I/O, `Encode`) stay **503** and are labeled via
/// `otel.status_description` on the handler span.
///
/// Single source of truth for both the OTLP signal path and the session-replay
/// handlers, which previously diverged (the replay paths blanket-mapped every
/// variant to 503).
fn api_error_from_pipeline(error: &PipelineError) -> ApiError {
    match error {
        PipelineError::Throttled(_) => {
            ApiError::too_many_requests("Ingest queue full for org, retry shortly")
        }
        PipelineError::Backpressure(_) => {
            ApiError::too_many_requests("Ingest export lane full, retry shortly")
        }
        PipelineError::QueueUnavailable(_) | PipelineError::Encode(_) => {
            ApiError::service_unavailable("Telemetry backend unavailable")
        }
    }
}

/// Resolve the deployment environment in maple's canonical priority order.
/// MAPLE_ENVIRONMENT is what apps/api/alchemy.run.ts and friends set via
/// resolveDeploymentEnvironment(stage); RAILWAY_ENVIRONMENT_NAME is Railway's
/// free runtime label; DEPLOYMENT_ENV is a manual override of last resort.
fn resolve_deployment_env() -> String {
    std::env::var("MAPLE_ENVIRONMENT")
        .or_else(|_| std::env::var("RAILWAY_ENVIRONMENT_NAME"))
        .or_else(|_| std::env::var("DEPLOYMENT_ENV"))
        .unwrap_or_else(|_| "development".to_string())
}

fn init_tracing(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
) -> Option<SdkTracerProvider> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "maple_ingest=info,tower_http=info".into());

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .compact();

    let deployment_env = resolve_deployment_env();
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

    let resource = build_resource(ResourceConfig {
        service_name: "ingest",
        service_namespace: "ingest",
        service_version: env!("CARGO_PKG_VERSION"),
        service_instance_id: service_instance_id.to_string(),
        deployment_env,
        internal_org_id,
    });

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

/// Wire up OTLP metric export, mirroring `init_tracing`. The gateway's own
/// operational metrics are pushed to `{forward_endpoint}/v1/metrics` on a
/// periodic interval — the same downstream collector → Tinybird pipeline that
/// carries its traces. Returns `None` (metrics become no-ops) when export is
/// skipped in local dev or would loop back onto this server.
fn init_metrics(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
) -> Option<SdkMeterProvider> {
    let deployment_env = resolve_deployment_env();
    let internal_org_id =
        std::env::var("MAPLE_INTERNAL_ORG_ID").unwrap_or_else(|_| "internal".to_string());

    let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
    let skip_dev = deployment_env == "development" && !forward_explicit;
    if skip_dev || endpoint_loopback_to_self(forward_endpoint, bind_port) {
        return None;
    }

    let resource = build_resource(ResourceConfig {
        service_name: "ingest",
        service_namespace: "ingest",
        service_version: env!("CARGO_PKG_VERSION"),
        service_instance_id: service_instance_id.to_string(),
        deployment_env,
        internal_org_id,
    });

    let exporter = match MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/metrics"))
        .with_protocol(Protocol::HttpBinary)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!("Failed to build OTLP metric exporter: {error}; metrics disabled");
            return None;
        }
    };

    let reader = PeriodicReader::builder(exporter, OtelTokio)
        .with_interval(Duration::from_secs(30))
        .build();

    let provider = SdkMeterProvider::builder()
        .with_resource(resource)
        .with_reader(reader)
        .build();

    opentelemetry::global::set_meter_provider(provider.clone());

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

    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Configuration error: {error}");
            std::process::exit(1);
        }
    };

    // One UUID per process, shared by the trace and metric resources so both
    // signals attribute to the same `service.instance.id`.
    let service_instance_id = uuid::Uuid::new_v4().to_string();
    let tracer_provider = init_tracing(&config.forward_endpoint, config.port, &service_instance_id);
    let meter_provider = init_metrics(&config.forward_endpoint, config.port, &service_instance_id);

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

    // The API service writes ingest-key rows to PlanetScale Postgres, so ingest
    // reads them from the same place. We run a probe query before accepting
    // traffic; if anything is wrong (auth, schema, network) the deploy fails
    // here rather than 503'ing forever.
    let store: Arc<dyn KeyStore> = match build_key_store(&config).await {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Key store init error: {error}");
            std::process::exit(1);
        }
    };

    // The Postgres key store resolves BYO-ClickHouse export targets from
    // org_clickhouse_settings (the Static backend has no DB to resolve from).
    // This must stay in lockstep with routing: `fetch_org_routing` marks orgs
    // clickhouse_ready and sends frames down the ClickHouse path, so the export
    // worker needs a target provider for the same backend or it would drop every
    // batch with "no ready target resolved".
    let direct_clickhouse_possible =
        matches!(config.key_store_backend, KeyStoreBackend::Postgres { .. });
    let clickhouse_target_provider: Option<Arc<dyn ClickHouseTargetProvider>> =
        if direct_clickhouse_possible {
            Some(Arc::new(ClickHouseTargetResolver {
                store: Arc::clone(&store),
                encryption_key: config.clickhouse_encryption_key,
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(60))
                    .max_capacity(10_000)
                    .build(),
            }) as Arc<dyn ClickHouseTargetProvider>)
        } else {
            None
        };

    let telemetry_pipeline = if config.write_mode.uses_tinybird() || direct_clickhouse_possible {
        match TelemetryPipeline::new_with_clickhouse_validation(
            config.tinybird.clone(),
            http_client.clone(),
            clickhouse_target_provider,
            config.write_mode.uses_tinybird(),
        )
        .await
        {
            Ok(pipeline) => Some(pipeline),
            Err(error) => {
                eprintln!("Telemetry pipeline init error: {error}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    let autumn_tracker = config.autumn_secret_key.as_ref().map(|key| {
        AutumnTracker::spawn(
            key.clone(),
            &config.autumn_api_url,
            config.autumn_flush_interval_secs,
        )
    });

    // Entitlement enforcement is opt-in: requires both a secret key and the
    // AUTUMN_ENFORCE_LIMITS flag. When absent, ingestion is never billing-gated.
    let autumn_entitlements = match (&config.autumn_secret_key, config.autumn_enforce_limits) {
        (Some(key), true) => Some(AutumnEntitlements::new(
            http_client.clone(),
            key.clone(),
            &config.autumn_api_url,
            config.autumn_check_cache_ttl_secs,
        )),
        _ => None,
    };

    let ingest_key_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.ingest_key_cache_ttl_secs))
        .max_capacity(1_000)
        .build();

    let cloudflare_connector_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.ingest_key_cache_ttl_secs))
        .max_capacity(1_000)
        .build();
    let org_routing_cache = Cache::builder()
        .time_to_live(Duration::from_secs(config.org_routing_cache_ttl_secs))
        .max_capacity(10_000)
        .build();
    let sampling_policy_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();
    let attribute_mapping_cache = Cache::builder()
        .time_to_live(Duration::from_secs(30))
        .max_capacity(10_000)
        .build();

    let org_routing_resolver = Arc::new(OrgRoutingResolver {
        store: Arc::clone(&store),
        cache: org_routing_cache,
        last_known: DashMap::new(),
    });

    let state = Arc::new(AppState {
        resolver: IngestKeyResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: ingest_key_cache,
            routing: Arc::clone(&org_routing_resolver),
        },
        org_inflight_limiter: OrgInFlightLimiter::new(config.org_max_in_flight),
        sampling_resolver: SamplingPolicyResolver {
            store: Arc::clone(&store),
            cache: sampling_policy_cache,
        },
        attribute_mapping_resolver: AttributeMappingResolver {
            store: Arc::clone(&store),
            cache: attribute_mapping_cache,
        },
        cloudflare_resolver: CloudflareConnectorResolver {
            store: Arc::clone(&store),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: cloudflare_connector_cache,
            routing: org_routing_resolver,
        },
        telemetry_pipeline,
        http_client,
        config: config.clone(),
        autumn_tracker,
        autumn_entitlements,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            CONTENT_ENCODING,
            HeaderName::from_static("x-maple-ingest-key"),
            // Session-replay chunk metadata headers (POST /v1/sessionReplays/blob).
            // Without these the browser preflight blocks the cross-origin blob upload.
            HeaderName::from_static("x-maple-session-id"),
            HeaderName::from_static("x-maple-chunk-seq"),
            HeaderName::from_static("x-maple-is-checkpoint"),
            HeaderName::from_static("x-maple-event-count"),
            HeaderName::from_static("x-maple-duration-ms"),
        ]);

    let grpc_state = Arc::clone(&state);
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/traces", post(handle_traces))
        .route("/v1/logs", post(handle_logs))
        .route("/v1/metrics", post(handle_metrics))
        .route("/v1/sessionReplays/meta", post(handle_replay_meta))
        .route("/v1/sessionReplays/blob", post(handle_replay_blob))
        .route("/v1/sessionEvents", post(handle_session_events))
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

    if let Some(provider) = meter_provider {
        // Flush the final metric export on graceful exit.
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
            clickhouse_ready: false,
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

// --- Session replay ingest -------------------------------------------------

fn replay_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Storage-key-safe session id: bounded length, alphanumeric + `-`/`_` only, so
/// a malicious value can't poison the `{org_id}/{session_id}` keying in ClickHouse.
fn is_safe_replay_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Auth shared by both replay endpoints. `Ok(None)` is the sentinel token —
/// silently dropped like the OTLP path.
async fn resolve_replay_key(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<ResolvedIngestKey>, ApiError> {
    let ingest_key =
        extract_ingest_key(headers).ok_or_else(|| ApiError::unauthorized("Missing ingest key"))?;
    if is_sentinel_token(&ingest_key) {
        return Ok(None);
    }
    let resolved = state
        .resolver
        .resolve_ingest_key(&ingest_key)
        .await
        .map_err(|_| ApiError::service_unavailable("Ingest authentication unavailable"))?
        .ok_or_else(|| ApiError::unauthorized("Invalid ingest key"))?;
    Ok(Some(resolved))
}

async fn handle_replay_meta(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_replay_meta",
        otel.name = "POST /v1/sessionReplays/meta",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionReplays/meta",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_replays",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
    );
    let span_handle = span.clone();
    match handle_replay_meta_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            span_handle.record("otel.status_code", otel_status_for_rejection(status));
            span_handle.record("otel.status_description", error.message.as_str());
            error.into_response()
        }
    }
}

async fn handle_replay_meta_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<usize, ApiError> {
    let resolved_key = match resolve_replay_key(state, headers).await? {
        Some(resolved_key) => resolved_key,
        None => return Ok(0),
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session replay storage is not configured",
    )?;

    // NDJSON: one session-metadata object per line. The org_id is always taken
    // from the authenticated key, never from the client-supplied body.
    //
    // Count session-start rows so we can meter one browser session per session to
    // Autumn. The browser SDK posts a start row (`version: 1` / `status: "active"`)
    // at session start and an end row (`version: 2`) at unload; counting only starts
    // avoids double-counting. Caveat: an in-tab reload recreates the SDK session sink
    // and re-posts a start row for the same SessionId, so reloads can slightly
    // over-count — consistent with the at-least-once metering used for the
    // logs/traces/metrics signals.
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut session_starts: u64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid session metadata JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("session metadata must be a JSON object"))?;
        obj.insert(
            "org_id".to_string(),
            serde_json::Value::String(org_id.clone()),
        );
        if obj.get("version").and_then(|v| v.as_u64()) == Some(1) {
            session_starts += 1;
        }
        rows.push(
            serde_json::to_vec(&value).map_err(|e| {
                ApiError::bad_request(format!("failed to re-serialize metadata: {e}"))
            })?,
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    let count = rows.len();
    pipeline
        .accept_rows_to(
            &org_id,
            state.config.tinybird.datasource_session_replays.clone(),
            rows,
            TelemetrySignal::SessionReplays,
            destination,
        )
        .await
        .map_err(|e| {
            warn!(org_id = %org_id, error = %e, "session metadata enqueue rejected");
            api_error_from_pipeline(&e)
        })?;

    // Meter browser sessions to Autumn after the rows are safely enqueued, mirroring
    // the logs/traces/metrics path (which only tracks on success). Skip the internal
    // sentinel org so self-observability traffic is not billed.
    if let Some(tracker) = &state.autumn_tracker {
        if org_id != SENTINEL_ORG_ID && session_starts > 0 {
            tracker.track(&org_id, "browser_sessions", session_starts as f64);
        }
    }

    Ok(count)
}

async fn handle_session_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_session_events",
        otel.name = "POST /v1/sessionEvents",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionEvents",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_events",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
    );
    let span_handle = span.clone();
    match handle_session_events_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(count) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            (StatusCode::OK, axum::Json(AcceptedBody { accepted: count })).into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            span_handle.record("otel.status_code", otel_status_for_rejection(status));
            span_handle.record("otel.status_description", error.message.as_str());
            error.into_response()
        }
    }
}

async fn handle_session_events_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<usize, ApiError> {
    let resolved_key = match resolve_replay_key(state, headers).await? {
        Some(resolved_key) => resolved_key,
        None => return Ok(0),
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session event storage is not configured",
    )?;

    // NDJSON: one distilled session-event object per line. As with replay
    // metadata, org_id is taken from the authenticated key, never the body.
    let mut rows: Vec<Vec<u8>> = Vec::new();
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid session event JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("session event must be a JSON object"))?;
        obj.insert(
            "org_id".to_string(),
            serde_json::Value::String(org_id.clone()),
        );
        rows.push(
            serde_json::to_vec(&value)
                .map_err(|e| ApiError::bad_request(format!("failed to re-serialize event: {e}")))?,
        );
    }

    if rows.is_empty() {
        return Ok(0);
    }
    let count = rows.len();
    pipeline
        .accept_rows_to(
            &org_id,
            state.config.tinybird.datasource_session_events.clone(),
            rows,
            TelemetrySignal::SessionEvents,
            destination,
        )
        .await
        .map_err(|e| {
            warn!(org_id = %org_id, error = %e, "session events enqueue rejected");
            api_error_from_pipeline(&e)
        })?;
    Ok(count)
}

async fn handle_replay_blob(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    metrics::request_started();
    let _guard = InFlightGuard;
    let span = tracing::info_span!(
        "ingest_replay_blob",
        otel.name = "POST /v1/sessionReplays/blob",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionReplays/blob",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_replays",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
    );
    let span_handle = span.clone();
    match handle_replay_blob_inner(&state, &headers, body)
        .instrument(span)
        .await
    {
        Ok(()) => {
            span_handle.record("http.response.status_code", 200u16);
            span_handle.record("otel.status_code", "Ok");
            StatusCode::OK.into_response()
        }
        Err(error) => {
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error.error_kind());
            span_handle.record("otel.status_code", otel_status_for_rejection(status));
            span_handle.record("otel.status_description", error.message.as_str());
            error.into_response()
        }
    }
}

async fn handle_replay_blob_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<(), ApiError> {
    let resolved_key = match resolve_replay_key(state, headers).await? {
        Some(resolved_key) => resolved_key,
        None => return Ok(()),
    };
    let org_id = resolved_key.org_id.clone();
    Span::current().record("maple.org_id", org_id.as_str());
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    let destination = native_destination_for(&resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session replay storage is not configured",
    )?;

    let session_id = replay_header(headers, "x-maple-session-id")
        .ok_or_else(|| ApiError::bad_request("missing x-maple-session-id header"))?;
    if !is_safe_replay_id(&session_id) {
        return Err(ApiError::bad_request("invalid x-maple-session-id"));
    }
    let chunk_seq: u32 = replay_header(headers, "x-maple-chunk-seq")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ApiError::bad_request("missing or invalid x-maple-chunk-seq header"))?;
    let is_checkpoint: u8 = replay_header(headers, "x-maple-is-checkpoint")
        .map(|v| u8::from(v == "1" || v.eq_ignore_ascii_case("true")))
        .unwrap_or(0);
    let event_count: u32 = replay_header(headers, "x-maple-event-count")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let duration_ms: u32 = replay_header(headers, "x-maple-duration-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // The SDK gzips the rrweb event array (native CompressionStream). Decompress
    // here so the events land in ClickHouse as queryable JSON text (the column is
    // ZSTD-compressed by the warehouse) — no R2 blob store on the replay path.
    use std::io::Read as _;
    let mut decoder = flate2::read::GzDecoder::new(&body[..]);
    let mut events_json = String::new();
    decoder
        .read_to_string(&mut events_json)
        .map_err(|e| ApiError::bad_request(format!("failed to gunzip replay chunk: {e}")))?;
    let byte_size = events_json.len() as u64;

    // Row → session_replay_events. Tinybird parses the space-separated datetime
    // into DateTime64(9); `events` is stored verbatim as a String column.
    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.9f")
        .to_string();
    let row = serde_json::json!({
        "org_id": org_id,
        "session_id": session_id,
        "chunk_seq": chunk_seq,
        "timestamp": timestamp,
        "duration_ms": duration_ms,
        "event_count": event_count,
        "byte_size": byte_size,
        "events": events_json,
        "is_checkpoint": is_checkpoint,
    });
    let serialized = serde_json::to_vec(&row).map_err(|e| {
        ApiError::service_unavailable(format!("failed to serialize replay events: {e}"))
    })?;
    pipeline
        .accept_rows_to(
            &org_id,
            state
                .config
                .tinybird
                .datasource_session_replay_events
                .clone(),
            vec![serialized],
            TelemetrySignal::SessionReplays,
            destination,
        )
        .await
        .map_err(|e| {
            warn!(org_id = %org_id, error = %e, "session replay blob enqueue rejected");
            api_error_from_pipeline(&e)
        })?;
    Ok(())
}

#[derive(Serialize)]
struct AcceptedBody {
    accepted: usize,
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

    metrics::request_started();
    let _guard = InFlightGuard;

    let route = format!("/v1/{}", signal.path());
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "ingest",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = %route,
        "http.request.body.size" = body_bytes,
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = signal.path(),
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.key_type" = tracing::field::Empty,
        "maple.ingest.self_managed" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
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
            metrics::request_completed(signal.path(), "ok", "none", duration.as_secs_f64());
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
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            span_handle.record("otel.status_code", otel_status_for_rejection(status));
            span_handle.record("otel.status_description", error.message.as_str());
            metrics::request_completed(signal.path(), "error", error_kind, duration.as_secs_f64());
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

    metrics::request_started();
    let _guard = InFlightGuard;

    let route = format!("/v1/logpush/cloudflare/http_requests/{connector_id}");
    let otel_name = format!("POST {route}");
    let span = tracing::info_span!(
        "cloudflare_logpush",
        otel.name = %otel_name,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        otel.status_description = tracing::field::Empty,
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
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
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
            metrics::request_completed("logs", "ok", "none", duration.as_secs_f64());
            metrics::cloudflare_batch("http_requests", is_validation);
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
            let status = error.status.as_u16();
            span_handle.record("http.response.status_code", status);
            span_handle.record("error.type", error_kind);
            span_handle.record("otel.status_code", otel_status_for_rejection(status));
            span_handle.record("otel.status_description", error.message.as_str());
            metrics::request_completed("logs", "error", error_kind, duration.as_secs_f64());
            if error_kind == "auth" {
                metrics::cloudflare_auth_failure("http_requests");
            }
            if error_kind == "parse" {
                metrics::cloudflare_parse_failure("http_requests");
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
        metrics::sentinel(signal.path());
        Span::current().record("maple.org_id", SENTINEL_ORG_ID);
        Span::current().record("maple.ingest.key_type", "sentinel");
        Span::current().record("maple.ingest.self_managed", false);
        Span::current().record("maple.ingest.clickhouse_ready", false);
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
    metrics::key_resolution_duration(key_resolve_start.elapsed().as_secs_f64());

    Span::current().record("maple.org_id", &resolved_key.org_id.as_str());
    Span::current().record("maple.ingest.key_type", resolved_key.key_type.as_str());
    Span::current().record("maple.ingest.self_managed", resolved_key.self_managed);
    Span::current().record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );
    debug!(
        resolve_ms = key_resolve_start.elapsed().as_millis() as u64,
        "Authenticated"
    );

    // --- Billing entitlement (per-signal) ---
    // Reject ingestion when the org has no active subscription or has exhausted
    // its hard-capped base-plan allotment for this signal. Fails open on any
    // Autumn error (see AutumnEntitlements::is_allowed). Inert unless
    // AUTUMN_ENFORCE_LIMITS=true and AUTUMN_SECRET_KEY is set.
    if let Some(entitlements) = &state.autumn_entitlements {
        let feature_id = signal.path();
        if !entitlements
            .is_allowed(&resolved_key.org_id, feature_id)
            .await
        {
            warn!(
                org_id = %resolved_key.org_id,
                feature_id,
                "Ingestion blocked: plan limit reached or no active subscription"
            );
            return Err((
                ApiError::new(
                    StatusCode::PAYMENT_REQUIRED,
                    "Plan limit reached or no active subscription",
                ),
                "billing_limit",
            ));
        }
    }

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

    metrics::request_body_bytes(signal.path(), body.len() as u64);

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
    metrics::decoded_body_bytes(signal.path(), decoded_payload.len() as u64);

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
    metrics::items_accepted(signal.path(), item_count as u64);

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
    Span::current().record("maple.ingest.clickhouse_ready", resolved.clickhouse_ready);

    // Logpush bills the `logs` feature — gate it the same way as OTLP logs.
    if let Some(entitlements) = &state.autumn_entitlements {
        if !entitlements.is_allowed(&resolved.org_id, "logs").await {
            warn!(
                org_id = %resolved.org_id,
                connector_id,
                "Cloudflare logpush blocked: plan limit reached or no active subscription"
            );
            return Err((
                ApiError::new(
                    StatusCode::PAYMENT_REQUIRED,
                    "Plan limit reached or no active subscription",
                ),
                "billing_limit",
            ));
        }
    }
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
            metrics::cloudflare_records(&resolved.dataset, item_count as u64);

            let resolved_key = ResolvedIngestKey {
                org_id: resolved.org_id.clone(),
                key_type: IngestKeyType::Connector,
                key_id: resolved.secret_key_id.clone(),
                self_managed: resolved.self_managed,
                clickhouse_ready: resolved.clickhouse_ready,
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

fn native_destination_for(resolved_key: &ResolvedIngestKey) -> ExportDestination {
    if resolved_key.clickhouse_ready {
        ExportDestination::ClickHouse
    } else {
        ExportDestination::Tinybird
    }
}

fn native_rows_pipeline_for<'a>(
    state: &'a AppState,
    destination: ExportDestination,
    unavailable_message: &'static str,
) -> Result<&'a TelemetryPipeline, ApiError> {
    if destination == ExportDestination::Tinybird && !state.config.write_mode.uses_tinybird() {
        return Err(ApiError::service_unavailable(unavailable_message));
    }
    state
        .telemetry_pipeline
        .as_ref()
        .ok_or_else(|| ApiError::service_unavailable(unavailable_message))
}

async fn forward_to_collector(
    state: &AppState,
    signal: Signal,
    content_type: &str,
    content_encoding: Option<&str>,
    body: Vec<u8>,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    let endpoint = state.config.forward_endpoint.as_str();
    let upstream_pool = "shared";

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
        metrics::forward_duration(signal.path(), upstream_pool, forward_duration.as_secs_f64());
        metrics::forward_response(signal.path(), "error", upstream_pool);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            upstream_pool,
            url = %url,
            "Collector forwarding failed"
        );
        ApiError::service_unavailable("Collector forwarding failed: transport error")
    })?;

    let forward_duration = forward_start.elapsed();
    metrics::forward_duration(signal.path(), upstream_pool, forward_duration.as_secs_f64());

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
    metrics::forward_response(signal.path(), status_bucket, upstream_pool);

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
            "Collector returned server error",
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
    let destination = native_destination_for(resolved_key);
    Span::current().record("maple.ingest.destination", destination.as_str());

    if uses_native_pipeline_for(state.config.write_mode, destination) {
        accept_native_decoded_payload(state, signal, decoded, resolved_key, destination).await?;
        if destination == ExportDestination::ClickHouse {
            return Ok(StatusCode::OK.into_response());
        }
    }

    if uses_forward_path_for(state.config.write_mode, destination) {
        let outbound_payload = decoded.encode(payload_format)?;
        let outbound_body = encode_payload(&outbound_payload, content_encoding)?;
        let outbound_bytes = outbound_body.len();
        let forward_span = forward_client_span("collector", outbound_bytes, signal.path());
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

async fn accept_native_decoded_payload(
    state: &AppState,
    signal: Signal,
    decoded: &DecodedPayload,
    resolved_key: &ResolvedIngestKey,
    destination: ExportDestination,
) -> Result<(), ApiError> {
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
            let attribute_mappings = state
                .attribute_mapping_resolver
                .resolve_mappings(&resolved_key.org_id)
                .await;
            pipeline
                .accept_traces_to(
                    &resolved_key.org_id,
                    request,
                    &policy,
                    attribute_mappings.as_slice(),
                    destination,
                )
                .await
        }
        DecodedPayload::Logs(request) => {
            pipeline
                .accept_logs_to(&resolved_key.org_id, request, destination)
                .await
        }
        DecodedPayload::Metrics(request) => {
            pipeline
                .accept_metrics_to(&resolved_key.org_id, request, destination)
                .await
        }
    }
    .map_err(|error| {
        let api_error = api_error_from_pipeline(&error);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            "Native telemetry pipeline rejected payload"
        );
        api_error
    })?;
    metrics::native_accept_duration(signal.path(), native_start.elapsed().as_secs_f64());
    metrics::native_rows(signal.path(), stats.rows as u64);
    if stats.dropped > 0 {
        metrics::native_sampled_dropped(signal.path(), stats.dropped as u64);
    }
    Span::current().record("maple.ingest.native_rows", stats.rows as u64);
    Span::current().record("maple.ingest.sampled_dropped", stats.dropped as u64);
    Ok(())
}

impl OrgRoutingResolver {
    async fn resolve_org_routing(&self, org_id: &str) -> Result<OrgRouting, String> {
        if let Some(cached) = self.cache.get(org_id).await {
            return Ok(cached);
        }

        match self.store.fetch_org_routing(org_id).await {
            Ok(row) => {
                let routing = row.unwrap_or_default();
                self.remember_org_routing(org_id, routing.clone()).await;
                Ok(routing)
            }
            Err(error) => {
                if let Some(stale) = self.last_known.get(org_id) {
                    warn!(
                        org_id,
                        error = %error,
                        "Org routing refresh failed; serving last-known routing"
                    );
                    Ok(stale.clone())
                } else {
                    warn!(
                        org_id,
                        error = %error,
                        "Org routing refresh failed with no last-known routing; using managed Tinybird path"
                    );
                    Ok(OrgRouting::default())
                }
            }
        }
    }

    async fn remember_org_routing(&self, org_id: &str, routing: OrgRouting) {
        self.last_known.insert(org_id.to_string(), routing.clone());
        self.cache.insert(org_id.to_string(), routing).await;
    }
}

impl IngestKeyResolver {
    async fn resolve_ingest_key(&self, raw_key: &str) -> Result<Option<ResolvedIngestKey>, String> {
        if let Some(identity) = self.cache.get(raw_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(routing)));
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

        // LEFT JOIN against org_clickhouse_settings so the initial routing state
        // is resolved in the same roundtrip as org_id. Warm auth-cache hits keep
        // the key identity cached while the separate org-routing cache refreshes
        // ClickHouse readiness on its shorter TTL.
        let Some(row) = self.store.fetch_ingest_key(&key_hash, hash_column).await? else {
            return Ok(None);
        };

        let routing = OrgRouting::from_key_row(&row);
        let identity = IngestKeyIdentity {
            org_id: row.org_id.clone(),
            key_type,
            key_id: key_hash.chars().take(16).collect(),
        };

        self.cache
            .insert(raw_key.to_string(), identity.clone())
            .await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(routing)))
    }
}

impl CloudflareConnectorResolver {
    async fn resolve_connector(
        &self,
        connector_id: &str,
        raw_secret: &str,
    ) -> Result<Option<ResolvedCloudflareConnector>, String> {
        let cache_key = format!("{connector_id}:{raw_secret}");
        if let Some(identity) = self.cache.get(&cache_key).await {
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(routing)));
        }

        let secret_hash = hash_ingest_key(raw_secret, &self.lookup_hmac_key)?;
        let Some(row) = self
            .store
            .fetch_connector(connector_id, &secret_hash)
            .await?
        else {
            return Ok(None);
        };

        let routing = OrgRouting::from_connector_row(&row);
        let identity = CloudflareConnectorIdentity {
            connector_id: connector_id.to_string(),
            org_id: row.org_id.clone(),
            service_name: row.service_name,
            zone_name: row.zone_name,
            dataset: row.dataset,
            secret_key_id: secret_hash.chars().take(16).collect(),
        };

        self.cache.insert(cache_key, identity.clone()).await;
        self.routing
            .remember_org_routing(&identity.org_id, routing.clone())
            .await;

        Ok(Some(identity.into_resolved(routing)))
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

/// Translates a stored mapping row into a usable rule, dropping rows whose
/// `source_context` / `operation` strings fall outside the known enums.
fn parse_attribute_mapping_row(row: AttributeMappingRow) -> Option<AttributeMappingRule> {
    let source_context = match row.source_context.as_str() {
        "span" => MappingSourceContext::Span,
        "resource" => MappingSourceContext::Resource,
        other => {
            warn!(
                source_context = other,
                "Skipping attribute mapping with unknown source context"
            );
            return None;
        }
    };
    let operation = match row.operation.as_str() {
        "move" => MappingOperation::Move,
        "copy" => MappingOperation::Copy,
        other => {
            warn!(
                operation = other,
                "Skipping attribute mapping with unknown operation"
            );
            return None;
        }
    };
    Some(AttributeMappingRule {
        source_context,
        source_key: row.source_key,
        target_key: row.target_key,
        operation,
    })
}

impl AttributeMappingResolver {
    async fn resolve_mappings(&self, org_id: &str) -> Arc<Vec<AttributeMappingRule>> {
        if let Some(rules) = self.cache.get(org_id).await {
            return rules;
        }

        let rules = match self.store.fetch_attribute_mappings(org_id).await {
            Ok(rows) => Arc::new(
                rows.into_iter()
                    .filter_map(parse_attribute_mapping_row)
                    .collect::<Vec<_>>(),
            ),
            Err(error) => {
                warn!(
                    org_id,
                    error = %error,
                    "Attribute mapping lookup failed; ingesting without remapping"
                );
                Arc::new(Vec::new())
            }
        };
        self.cache
            .insert(org_id.to_string(), Arc::clone(&rules))
            .await;
        rules
    }
}

#[async_trait::async_trait]
impl ClickHouseTargetProvider for ClickHouseTargetResolver {
    async fn resolve_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTarget>, String> {
        if let Some(target) = self.cache.get(org_id).await {
            return Ok(Some(target));
        }

        let Some(row) = self.store.fetch_clickhouse_target(org_id).await? else {
            return Ok(None);
        };
        if row.schema_version != CLICKHOUSE_SCHEMA_VERSION {
            return Ok(None);
        }

        let password = match (
            row.ch_password_ciphertext.as_deref(),
            row.ch_password_iv.as_deref(),
            row.ch_password_tag.as_deref(),
        ) {
            (Some(ciphertext), Some(iv), Some(tag)) => {
                let key = self.encryption_key.as_ref().ok_or_else(|| {
                    "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required to decrypt ClickHouse credentials"
                        .to_string()
                })?;
                decrypt_aes256_gcm(ciphertext, iv, tag, key)?
            }
            (None, None, None) => String::new(),
            _ => {
                return Err(
                    "ClickHouse password encryption fields must be all present or all null"
                        .to_string(),
                )
            }
        };

        let target = ClickHouseTarget {
            endpoint: row.ch_url.trim().trim_end_matches('/').to_string(),
            user: row.ch_user,
            password,
            database: row.ch_database,
        };
        if target.endpoint.is_empty() || target.user.is_empty() || target.database.is_empty() {
            return Err("ClickHouse target is missing url, user, or database".to_string());
        }
        let endpoint_url = url::Url::parse(&target.endpoint)
            .map_err(|error| format!("ClickHouse target endpoint URL is invalid: {error}"))?;
        if !target.password.is_empty() && endpoint_url.scheme() != "https" {
            return Err(
                "ClickHouse target endpoint must use https when a password is configured"
                    .to_string(),
            );
        }
        self.cache.insert(org_id.to_string(), target.clone()).await;
        Ok(Some(target))
    }
}

/// PlanetScale Postgres-backed KeyStore. A pooled direct connection (PSBouncer
/// 6432, no Hyperdrive — Railway dials PlanetScale). Uses `$N` placeholders,
/// native booleans, and `to_timestamp()` for the epoch-ms connector timestamps
/// (those columns are `timestamptz`). A 60s in-process cache and HMAC
/// fingerprinting sit upstream.
struct PostgresKeyStore {
    pool: deadpool_postgres::Pool,
}

impl PostgresKeyStore {
    fn new(url: &str) -> Result<Self, String> {
        let pg_config = url
            .parse::<tokio_postgres::Config>()
            .map_err(|error| format!("invalid MAPLE_PG_URL: {error}"))?;

        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let tls_config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| format!("rustls config failed: {error}"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config);

        let mgr = deadpool_postgres::Manager::from_config(
            pg_config,
            tls,
            deadpool_postgres::ManagerConfig {
                recycling_method: deadpool_postgres::RecyclingMethod::Fast,
            },
        );
        let pool = deadpool_postgres::Pool::builder(mgr)
            .max_size(8)
            .build()
            .map_err(|error| format!("postgres pool build failed: {error}"))?;

        Ok(Self { pool })
    }

    async fn client(&self) -> Result<deadpool_postgres::Object, String> {
        self.pool
            .get()
            .await
            .map_err(|error| format!("postgres pool checkout failed: {error}"))
    }

    /// Startup gate — runs the production lookup query with a stub hash so any
    /// auth/schema/network/TLS issue exits the process instead of 503'ing every
    /// request.
    async fn probe(&self) -> Result<(), String> {
        let client = self.client().await?;
        client
            .query(
                "SELECT k.org_id, \
                        COALESCE(s.sync_status = 'connected', false) AS self_managed \
                 FROM org_ingest_keys k \
                 LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
                 WHERE k.private_key_hash = $1 LIMIT 1",
                &[&"__ingest_probe_no_match__"],
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres probe query failed: {error}"))
    }
}

#[async_trait::async_trait]
impl KeyStore for PostgresKeyStore {
    async fn fetch_ingest_key(
        &self,
        key_hash: &str,
        hash_column: &'static str,
    ) -> Result<Option<KeyRow>, String> {
        // hash_column is a compile-time constant chosen by the resolver, never
        // user input — safe to interpolate.
        let revision = CLICKHOUSE_SCHEMA_VERSION;
        let sql = format!(
            "SELECT k.org_id, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND s.schema_version = $1, false) AS clickhouse_ready \
             FROM org_ingest_keys k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             WHERE k.{hash_column} = $2 LIMIT 1"
        );
        let client = self.client().await?;
        let rows = client
            .query(&sql, &[&revision, &key_hash])
            .await
            .map_err(|error| format!("postgres fetch_ingest_key failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(KeyRow {
            org_id: row.get("org_id"),
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
        }))
    }

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        let revision = CLICKHOUSE_SCHEMA_VERSION;
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT c.org_id, c.service_name, c.zone_name, c.dataset, \
                        COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                        COALESCE(s.sync_status = 'connected' AND s.schema_version = $1, false) AS clickhouse_ready \
                 FROM cloudflare_logpush_connectors c \
                 LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
                 WHERE c.id = $2 AND c.secret_hash = $3 AND c.enabled = true LIMIT 1",
                &[&revision, &connector_id, &secret_hash],
            )
            .await
            .map_err(|error| format!("postgres fetch_connector failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(ConnectorRow {
            org_id: row.get("org_id"),
            service_name: row.get("service_name"),
            zone_name: row.get("zone_name"),
            dataset: row.get("dataset"),
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
        }))
    }

    async fn fetch_sampling_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<SamplingPolicyRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms \
                 FROM org_ingest_sampling_policies WHERE org_id = $1 LIMIT 1",
                &[&org_id],
            )
            .await
            .map_err(|error| format!("postgres fetch_sampling_policy failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        let slow_ms: Option<i32> = row.get("always_keep_slow_spans_ms");
        Ok(Some(SamplingPolicyRow {
            trace_sample_ratio: row.get("trace_sample_ratio"),
            always_keep_error_spans: row.get("always_keep_error_spans"),
            always_keep_slow_spans_ms: slow_ms.and_then(|v| u64::try_from(v).ok()),
        }))
    }

    async fn fetch_attribute_mappings(
        &self,
        org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT source_context, source_key, target_key, operation \
                 FROM org_ingest_attribute_mappings WHERE org_id = $1 AND enabled = true",
                &[&org_id],
            )
            .await
            .map_err(|error| format!("postgres fetch_attribute_mappings failed: {error}"))?;
        Ok(rows
            .into_iter()
            .map(|row| AttributeMappingRow {
                source_context: row.get("source_context"),
                source_key: row.get("source_key"),
                target_key: row.get("target_key"),
                operation: row.get("operation"),
            })
            .collect())
    }

    async fn fetch_clickhouse_target(
        &self,
        org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String> {
        let revision = CLICKHOUSE_SCHEMA_VERSION;
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT ch_url, ch_user, ch_password_ciphertext, ch_password_iv, ch_password_tag, \
                        ch_database, schema_version \
                 FROM org_clickhouse_settings \
                 WHERE org_id = $1 AND sync_status = 'connected' AND schema_version = $2 LIMIT 1",
                &[&org_id, &revision],
            )
            .await
            .map_err(|error| format!("postgres fetch_clickhouse_target failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(ClickHouseTargetRow {
            ch_url: row.get("ch_url"),
            ch_user: row.get("ch_user"),
            ch_password_ciphertext: row.get("ch_password_ciphertext"),
            ch_password_iv: row.get("ch_password_iv"),
            ch_password_tag: row.get("ch_password_tag"),
            ch_database: row.get("ch_database"),
            schema_version: row.get("schema_version"),
        }))
    }

    async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String> {
        let revision = CLICKHOUSE_SCHEMA_VERSION;
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT COALESCE(sync_status = 'connected', false) AS self_managed, \
                        COALESCE(sync_status = 'connected' AND schema_version = $1, false) AS clickhouse_ready \
                 FROM org_clickhouse_settings WHERE org_id = $2 LIMIT 1",
                &[&revision, &org_id],
            )
            .await
            .map_err(|error| format!("postgres fetch_org_routing failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(OrgRouting {
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
        }))
    }

    async fn record_connector_success(
        &self,
        connector_id: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE cloudflare_logpush_connectors \
                 SET last_received_at = to_timestamp($1::bigint / 1000.0), \
                     last_error = NULL, \
                     updated_at = to_timestamp($1::bigint / 1000.0) \
                 WHERE id = $2",
                &[&now_ms, &connector_id],
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres record_connector_success failed: {error}"))
    }

    async fn record_connector_failure(
        &self,
        connector_id: &str,
        error: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE cloudflare_logpush_connectors \
                 SET last_error = $1, updated_at = to_timestamp($2::bigint / 1000.0) \
                 WHERE id = $3",
                &[&error, &now_ms, &connector_id],
            )
            .await
            .map(|_| ())
            .map_err(|err| format!("postgres record_connector_failure failed: {err}"))
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
            clickhouse_ready: false,
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

    async fn fetch_attribute_mappings(
        &self,
        _org_id: &str,
    ) -> Result<Vec<AttributeMappingRow>, String> {
        Ok(Vec::new())
    }

    async fn fetch_clickhouse_target(
        &self,
        _org_id: &str,
    ) -> Result<Option<ClickHouseTargetRow>, String> {
        Ok(None)
    }

    async fn fetch_org_routing(&self, _org_id: &str) -> Result<Option<OrgRouting>, String> {
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
    let mut mac = <HmacSha256 as Mac>::new_from_slice(lookup_hmac_key.as_bytes())
        .map_err(|error| format!("Invalid HMAC key: {error}"))?;
    mac.update(raw_key.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn parse_base64_aes256_gcm_key(raw: &str) -> Result<[u8; 32], String> {
    let decoded = STANDARD
        .decode(raw.trim())
        .map_err(|_| "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64".to_string())?;
    decoded.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes, got {} bytes",
            bytes.len()
        )
    })
}

fn decrypt_aes256_gcm(
    ciphertext: &str,
    iv: &str,
    tag: &str,
    key: &[u8; 32],
) -> Result<String, String> {
    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|_| "ClickHouse password ciphertext is not base64".to_string())?;
    let iv = STANDARD
        .decode(iv)
        .map_err(|_| "ClickHouse password iv is not base64".to_string())?;
    let tag = STANDARD
        .decode(tag)
        .map_err(|_| "ClickHouse password tag is not base64".to_string())?;
    if iv.len() != 12 {
        return Err(format!(
            "ClickHouse password iv must be 12 bytes for AES-GCM, got {} bytes",
            iv.len()
        ));
    }
    if tag.len() != 16 {
        return Err(format!(
            "ClickHouse password tag must be 16 bytes for AES-GCM, got {} bytes",
            tag.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Invalid AES-256-GCM key: {error}"))?;
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), sealed.as_ref())
        .map_err(|_| "Decryption failed".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Decrypted password was not UTF-8".to_string())
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
async fn build_key_store(config: &AppConfig) -> Result<Arc<dyn KeyStore>, String> {
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
        KeyStoreBackend::Postgres { url } => {
            info!(backend = "planetscale-postgres", "Key store backend selected");
            let store = PostgresKeyStore::new(url)?;
            store
                .probe()
                .await
                .map_err(|error| format!("Postgres startup probe failed: {error}"))?;
            info!("Postgres startup probe succeeded");
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

fn parse_u32(name: &str, raw: Option<String>, default: u32) -> Result<u32, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };

    let value = raw.trim();
    if value.is_empty() {
        return Ok(default);
    }

    value
        .parse::<u32>()
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
    // `AtomicBool` is only used by the test fakes below; keeping it out of the
    // top-level import avoids an unused-import warning in non-test bin builds.
    use std::sync::atomic::AtomicBool;

    #[test]
    fn hash_is_deterministic() {
        let hash_a = hash_ingest_key("maple_pk_123", "secret").unwrap();
        let hash_b = hash_ingest_key("maple_pk_123", "secret").unwrap();
        assert_eq!(hash_a, hash_b);
    }

    #[test]
    fn rejection_span_status_is_error_only_for_5xx() {
        // 4xx client rejections must not mark the SERVER span Error.
        assert_eq!(otel_status_for_rejection(401), "Ok"); // missing/invalid ingest key
        assert_eq!(otel_status_for_rejection(402), "Ok"); // billing limit
        assert_eq!(otel_status_for_rejection(413), "Ok"); // payload too large
        assert_eq!(otel_status_for_rejection(415), "Ok"); // unsupported media type
        assert_eq!(otel_status_for_rejection(429), "Ok"); // throttle
                                                          // 5xx server faults stay Error (e.g. auth resolver unavailable → 503).
        assert_eq!(otel_status_for_rejection(500), "Error");
        assert_eq!(otel_status_for_rejection(503), "Error");
    }

    #[test]
    fn api_error_kind_maps_status_to_stable_label() {
        // The native replay/session handlers derive `error.type` from this so
        // their spans are categorizable instead of "Unknown Error".
        assert_eq!(ApiError::unauthorized("x").error_kind(), "auth");
        assert_eq!(ApiError::bad_request("x").error_kind(), "bad_request");
        assert_eq!(
            ApiError::unsupported_media_type("x").error_kind(),
            "unsupported_media"
        );
        assert_eq!(
            ApiError::payload_too_large("x").error_kind(),
            "payload_too_large"
        );
        assert_eq!(ApiError::too_many_requests("x").error_kind(), "throttle");
        assert_eq!(ApiError::service_unavailable("x").error_kind(), "unavailable");
        assert_eq!(
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "x").error_kind(),
            "error"
        );
    }

    #[test]
    fn api_error_from_pipeline_maps_variants_to_status() {
        // Transient queue conditions are retryable → 429 (classified Ok via
        // otel_status_for_rejection, so a stalled BYO-ClickHouse target backing
        // the lane up does not flood the error dashboards as "Unknown Error").
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Throttled("x")).status,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Backpressure("x")).status,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Genuine backend failures stay 503 (Error), now labeled via the span's
        // otel.status_description rather than surfacing as "Unknown Error".
        assert_eq!(
            api_error_from_pipeline(&PipelineError::QueueUnavailable("x".into())).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            api_error_from_pipeline(&PipelineError::Encode("x".into())).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(otel_status_for_rejection(429), "Ok");
        assert_eq!(otel_status_for_rejection(503), "Error");
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
            clickhouse_ready: false,
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
            clickhouse_ready: false,
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
    fn clickhouse_destination_uses_native_pipeline_even_in_forward_mode() {
        assert!(uses_native_pipeline_for(
            WriteMode::Forward,
            ExportDestination::ClickHouse
        ));
        assert!(!uses_forward_path_for(
            WriteMode::Forward,
            ExportDestination::ClickHouse
        ));
    }

    #[test]
    fn tinybird_destination_keeps_forward_mode_on_forward_path() {
        assert!(!uses_native_pipeline_for(
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
        assert!(uses_forward_path_for(
            WriteMode::Forward,
            ExportDestination::Tinybird
        ));
    }

    #[test]
    fn clickhouse_destination_is_terminal_in_dual_mode() {
        assert!(uses_native_pipeline_for(
            WriteMode::Dual,
            ExportDestination::ClickHouse
        ));
        assert!(!uses_forward_path_for(
            WriteMode::Dual,
            ExportDestination::ClickHouse
        ));
    }

    /// In-memory KeyStore used to exercise the resolver's behavior (caching,
    /// key-type inference, ResolvedIngestKey construction) without a database.
    /// Keyed on the same `(hash, column)` shape the real key store sees.
    #[derive(Default)]
    struct FakeKeyStore {
        keys: std::sync::Mutex<std::collections::HashMap<(String, &'static str), KeyRow>>,
        connectors: std::sync::Mutex<std::collections::HashMap<(String, String), ConnectorRow>>,
        routings: std::sync::Mutex<std::collections::HashMap<String, OrgRouting>>,
        targets: std::sync::Mutex<std::collections::HashMap<String, ClickHouseTargetRow>>,
        ingest_key_fetches: AtomicU64,
        connector_fetches: AtomicU64,
        routing_fetches: AtomicU64,
        routing_errors: AtomicBool,
    }

    impl FakeKeyStore {
        fn insert_private(&self, raw_key: &str, row: KeyRow) {
            let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.keys
                .lock()
                .unwrap()
                .insert((hash, "private_key_hash"), row);
        }

        fn insert_connector(&self, connector_id: &str, raw_secret: &str, row: ConnectorRow) {
            let hash = hash_ingest_key(raw_secret, "test-hmac-key").unwrap();
            self.set_org_routing(
                &row.org_id,
                OrgRouting {
                    self_managed: row.self_managed,
                    clickhouse_ready: row.clickhouse_ready,
                },
            );
            self.connectors
                .lock()
                .unwrap()
                .insert((connector_id.to_string(), hash), row);
        }

        fn set_org_routing(&self, org_id: &str, routing: OrgRouting) {
            self.routings
                .lock()
                .unwrap()
                .insert(org_id.to_string(), routing);
        }

        fn insert_clickhouse_target(&self, org_id: &str, row: ClickHouseTargetRow) {
            self.targets.lock().unwrap().insert(org_id.to_string(), row);
        }
    }

    #[async_trait::async_trait]
    impl KeyStore for FakeKeyStore {
        async fn fetch_ingest_key(
            &self,
            key_hash: &str,
            hash_column: &'static str,
        ) -> Result<Option<KeyRow>, String> {
            self.ingest_key_fetches.fetch_add(1, Ordering::Relaxed);
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(&(key_hash.to_string(), hash_column))
                .cloned())
        }
        async fn fetch_connector(
            &self,
            connector_id: &str,
            secret_hash: &str,
        ) -> Result<Option<ConnectorRow>, String> {
            self.connector_fetches.fetch_add(1, Ordering::Relaxed);
            Ok(self
                .connectors
                .lock()
                .unwrap()
                .get(&(connector_id.to_string(), secret_hash.to_string()))
                .cloned())
        }
        async fn fetch_sampling_policy(
            &self,
            _org_id: &str,
        ) -> Result<Option<SamplingPolicyRow>, String> {
            Ok(None)
        }
        async fn fetch_attribute_mappings(
            &self,
            _org_id: &str,
        ) -> Result<Vec<AttributeMappingRow>, String> {
            Ok(Vec::new())
        }
        async fn fetch_clickhouse_target(
            &self,
            org_id: &str,
        ) -> Result<Option<ClickHouseTargetRow>, String> {
            Ok(self.targets.lock().unwrap().get(org_id).cloned())
        }
        async fn fetch_org_routing(&self, org_id: &str) -> Result<Option<OrgRouting>, String> {
            self.routing_fetches.fetch_add(1, Ordering::Relaxed);
            if self.routing_errors.load(Ordering::Relaxed) {
                return Err("simulated routing store outage".to_string());
            }
            Ok(self.routings.lock().unwrap().get(org_id).cloned())
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

    fn make_routing_resolver(store: Arc<FakeKeyStore>, ttl: Duration) -> Arc<OrgRoutingResolver> {
        let store: Arc<dyn KeyStore> = store;
        Arc::new(OrgRoutingResolver {
            store,
            cache: Cache::builder().time_to_live(ttl).max_capacity(16).build(),
            last_known: DashMap::new(),
        })
    }

    fn make_resolver(store: Arc<FakeKeyStore>) -> IngestKeyResolver {
        make_resolver_with_routing_ttl(store, Duration::from_secs(60))
    }

    fn make_resolver_with_routing_ttl(
        store: Arc<FakeKeyStore>,
        routing_ttl: Duration,
    ) -> IngestKeyResolver {
        let routing = make_routing_resolver(Arc::clone(&store), routing_ttl);
        let store: Arc<dyn KeyStore> = store;
        IngestKeyResolver {
            store,
            lookup_hmac_key: "test-hmac-key".to_string(),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
            routing,
        }
    }

    #[derive(Debug)]
    struct FakeClickHouseImport {
        query: String,
        database: String,
        user: String,
        content_encoding: String,
        body: String,
    }

    #[derive(Debug)]
    struct FakeForwardImport {
        content_type: String,
        content_encoding: String,
        body_len: usize,
    }

    async fn fake_clickhouse_import(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<FakeClickHouseImport>>,
        Query(query): Query<std::collections::HashMap<String, String>>,
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
            content_encoding: headers
                .get(CONTENT_ENCODING)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
            body: decoded,
        });

        StatusCode::OK
    }

    async fn fake_forward_collector(
        State(tx): State<tokio::sync::mpsc::UnboundedSender<FakeForwardImport>>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let _ = tx.send(FakeForwardImport {
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
            body_len: body.len(),
        });
        StatusCode::OK
    }

    fn unique_main_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "maple-ingest-main-{name}-{}-{}",
            std::process::id(),
            current_time_millis()
        ))
    }

    fn test_tinybird_config(queue_dir: PathBuf) -> TinybirdConfig {
        TinybirdConfig {
            endpoint: String::new(),
            token: String::new(),
            queue_dir,
            queue_max_bytes: 1024 * 1024,
            org_queue_max_bytes: 1024 * 1024,
            queue_channel_capacity: 10,
            wal_shards: 1,
            batch_max_rows: 100,
            batch_max_bytes: 1024 * 1024,
            batch_max_wait: Duration::from_millis(1),
            export_concurrency_per_shard: 1,
            export_max_attempts: 1,
            clickhouse_export_timeout: Duration::from_secs(5),
            clickhouse_breaker: ClickHouseBreakerConfig::default(),
            datasources: DatasourceNames::defaults(),
            datasource_session_replays: "session_replays".to_string(),
            datasource_session_replay_events: "session_replay_events".to_string(),
            datasource_session_events: "session_events".to_string(),
        }
    }

    fn test_log_request(message: &str) -> ExportLogsServiceRequest {
        ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![KeyValue {
                        key: "service.name".to_string(),
                        value: Some(AnyValue {
                            value: Some(any_value::Value::StringValue("routing-test".to_string())),
                        }),
                    }],
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_logs: vec![ScopeLogs {
                    scope: Some(InstrumentationScope {
                        name: "routing-logger".to_string(),
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
                            value: Some(any_value::Value::StringValue(message.to_string())),
                        }),
                        ..Default::default()
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    fn test_headers(raw_key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            format!("Bearer {raw_key}")
                .parse()
                .expect("valid auth header"),
        );
        headers.insert(CONTENT_TYPE, "application/x-protobuf".parse().unwrap());
        headers
    }

    async fn test_app_state(
        store: Arc<FakeKeyStore>,
        queue_dir: PathBuf,
        forward_endpoint: String,
        routing_ttl: Duration,
    ) -> AppState {
        let tinybird = test_tinybird_config(queue_dir);
        let key_store: Arc<dyn KeyStore> = store.clone();
        let routing = make_routing_resolver(Arc::clone(&store), routing_ttl);
        let clickhouse_targets = Arc::new(ClickHouseTargetResolver {
            store: Arc::clone(&key_store),
            encryption_key: None,
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        });
        let http_client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let telemetry_pipeline = TelemetryPipeline::new_with_clickhouse_validation(
            tinybird.clone(),
            http_client.clone(),
            Some(clickhouse_targets),
            false,
        )
        .await
        .expect("test pipeline should start without Tinybird credentials");

        AppState {
            config: AppConfig {
                port: 0,
                otlp_grpc_port: None,
                forward_endpoint,
                forward_timeout: Duration::from_secs(5),
                write_mode: WriteMode::Forward,
                tinybird,
                max_request_body_bytes: 1024 * 1024,
                org_max_in_flight: 100,
                require_tls: false,
                key_store_backend: KeyStoreBackend::Static {
                    org_id: "org_test".to_string(),
                },
                clickhouse_encryption_key: None,
                lookup_hmac_key: "test-hmac-key".to_string(),
                autumn_secret_key: None,
                autumn_api_url: "https://api.useautumn.com".to_string(),
                autumn_flush_interval_secs: 1,
                autumn_enforce_limits: false,
                autumn_check_cache_ttl_secs: 60,
                ingest_key_cache_ttl_secs: 60,
                org_routing_cache_ttl_secs: 5,
            },
            http_client,
            telemetry_pipeline: Some(telemetry_pipeline),
            resolver: IngestKeyResolver {
                store: Arc::clone(&key_store),
                lookup_hmac_key: "test-hmac-key".to_string(),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(60))
                    .max_capacity(16)
                    .build(),
                routing: Arc::clone(&routing),
            },
            org_inflight_limiter: OrgInFlightLimiter::new(100),
            sampling_resolver: SamplingPolicyResolver {
                store: Arc::clone(&key_store),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(30))
                    .max_capacity(16)
                    .build(),
            },
            attribute_mapping_resolver: AttributeMappingResolver {
                store: Arc::clone(&key_store),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(30))
                    .max_capacity(16)
                    .build(),
            },
            cloudflare_resolver: CloudflareConnectorResolver {
                store: key_store,
                lookup_hmac_key: "test-hmac-key".to_string(),
                cache: Cache::builder()
                    .time_to_live(Duration::from_secs(60))
                    .max_capacity(16)
                    .build(),
                routing,
            },
            autumn_tracker: None,
            autumn_entitlements: None,
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
                clickhouse_ready: false,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_shared")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_shared");
        assert!(!resolved.self_managed);
        assert!(!resolved.clickhouse_ready);
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_true_when_active_settings_row() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_byo",
            KeyRow {
                org_id: "org_byo".to_string(),
                self_managed: true,
                clickhouse_ready: true,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_byo")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_byo");
        assert!(resolved.self_managed);
        assert!(resolved.clickhouse_ready);
    }

    #[tokio::test]
    async fn resolve_ingest_key_keeps_stale_schema_on_managed_native_path() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_stale_schema",
            KeyRow {
                org_id: "org_stale".to_string(),
                self_managed: true,
                clickhouse_ready: false,
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_stale_schema")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert!(resolved.self_managed);
        assert!(!resolved.clickhouse_ready);
        assert_eq!(
            native_destination_for(&resolved),
            ExportDestination::Tinybird
        );
    }

    #[tokio::test]
    async fn resolve_ingest_key_refreshes_routing_before_auth_cache_expires() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_becomes_ready",
            KeyRow {
                org_id: "org_transition".to_string(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );

        let resolver = make_resolver_with_routing_ttl(Arc::clone(&store), Duration::from_millis(5));
        let first = resolver
            .resolve_ingest_key("maple_sk_test_becomes_ready")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");
        assert!(!first.clickhouse_ready);
        assert_eq!(store.ingest_key_fetches.load(Ordering::Relaxed), 1);

        store.set_org_routing(
            "org_transition",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second = resolver
            .resolve_ingest_key("maple_sk_test_becomes_ready")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");
        assert!(second.self_managed);
        assert!(second.clickhouse_ready);
        assert_eq!(
            native_destination_for(&second),
            ExportDestination::ClickHouse
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "auth identity should stay cached while routing refreshes"
        );
        assert_eq!(store.routing_fetches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn resolve_ingest_key_serves_last_known_routing_when_refresh_fails() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_d1_blip",
            KeyRow {
                org_id: "org_d1_blip".to_string(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );

        let resolver = make_resolver_with_routing_ttl(Arc::clone(&store), Duration::from_millis(5));
        let first = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("initial resolve should succeed")
            .expect("key should be found");
        assert!(!first.clickhouse_ready);

        store.set_org_routing(
            "org_d1_blip",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let ready = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("routing refresh should succeed")
            .expect("key should be found");
        assert!(ready.clickhouse_ready);

        store.routing_errors.store(true, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(10)).await;

        let stale = resolver
            .resolve_ingest_key("maple_sk_test_d1_blip")
            .await
            .expect("warm key should not 503 when routing refresh fails")
            .expect("key should be found");
        assert!(
            stale.clickhouse_ready,
            "last-known ready routing should be served during a routing-store outage"
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "auth identity should stay cached through the routing-store outage"
        );
        assert!(
            store.routing_fetches.load(Ordering::Relaxed) >= 2,
            "routing refresh should have been attempted before falling back to stale"
        );
    }

    #[tokio::test]
    async fn resolve_connector_refreshes_routing_before_auth_cache_expires() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_connector(
            "connector_ready_later",
            "secret-before-ready",
            ConnectorRow {
                org_id: "org_logpush_transition".to_string(),
                service_name: "cloudflare/example.com".to_string(),
                zone_name: "example.com".to_string(),
                dataset: "http_requests".to_string(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let routing = make_routing_resolver(Arc::clone(&store), Duration::from_millis(5));
        let key_store: Arc<dyn KeyStore> = store.clone();
        let resolver = CloudflareConnectorResolver {
            store: key_store,
            lookup_hmac_key: "test-hmac-key".to_string(),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
            routing,
        };

        let first = resolver
            .resolve_connector("connector_ready_later", "secret-before-ready")
            .await
            .expect("resolve should succeed")
            .expect("connector should be found");
        assert!(!first.clickhouse_ready);
        assert_eq!(store.connector_fetches.load(Ordering::Relaxed), 1);

        store.set_org_routing(
            "org_logpush_transition",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second = resolver
            .resolve_connector("connector_ready_later", "secret-before-ready")
            .await
            .expect("resolve should succeed")
            .expect("connector should be found");
        assert!(second.self_managed);
        assert!(second.clickhouse_ready);
        assert_eq!(
            store.connector_fetches.load(Ordering::Relaxed),
            1,
            "connector identity should stay cached while routing refreshes"
        );
        assert_eq!(store.routing_fetches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn forward_mode_switches_ready_org_to_clickhouse_without_forwarding_again() {
        let (ch_tx, mut ch_rx) = tokio::sync::mpsc::unbounded_channel();
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

        let (forward_tx, mut forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let forward_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let forward_addr = forward_listener.local_addr().unwrap();
        let forward_app = Router::new()
            .route("/v1/logs", post(fake_forward_collector))
            .with_state(forward_tx);
        tokio::spawn(async move {
            axum::serve(forward_listener, forward_app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("forward-ready-clickhouse");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_forward_ready";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_forward_ready".to_string(),
                self_managed: false,
                clickhouse_ready: false,
            },
        );
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            format!("http://{forward_addr}"),
            Duration::from_millis(5),
        )
        .await;

        let first_payload = test_log_request("before setup").encode_to_vec();
        let (first_response, first_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(first_payload),
            Signal::Logs,
        )
        .await
        .expect("non-ready request should be accepted through forward path");
        assert_eq!(first_response.status(), StatusCode::OK);
        assert_eq!(first_count, 1);
        let first_forward = tokio::time::timeout(Duration::from_secs(2), forward_rx.recv())
            .await
            .expect("non-ready org should forward")
            .expect("forward channel should stay open");
        assert_eq!(first_forward.content_type, "application/x-protobuf");
        assert_eq!(first_forward.content_encoding, "");
        assert!(first_forward.body_len > 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), ch_rx.recv())
                .await
                .is_err(),
            "non-ready org must not write to ClickHouse"
        );

        store.set_org_routing(
            "org_forward_ready",
            OrgRouting {
                self_managed: true,
                clickhouse_ready: true,
            },
        );
        store.insert_clickhouse_target(
            "org_forward_ready",
            ClickHouseTargetRow {
                ch_url: format!("http://{ch_addr}"),
                ch_user: "ingest".to_string(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_string(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_string(),
            },
        );
        tokio::time::sleep(Duration::from_millis(10)).await;

        let second_payload = test_log_request("after setup").encode_to_vec();
        let (second_response, second_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(second_payload),
            Signal::Logs,
        )
        .await
        .expect("ready request should be accepted through ClickHouse path");
        assert_eq!(second_response.status(), StatusCode::OK);
        assert_eq!(second_count, 1);

        let clickhouse = tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("ready org should write to ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert!(clickhouse.query.starts_with("INSERT INTO logs"));
        assert!(clickhouse.query.contains(" FROM input('"));
        assert!(clickhouse.query.ends_with(" FORMAT JSONEachRow"));
        assert_eq!(clickhouse.database, "maple");
        assert_eq!(clickhouse.user, "ingest");
        assert_eq!(clickhouse.content_encoding, "gzip");
        assert!(clickhouse.body.contains("after setup"));
        assert!(
            !clickhouse.body.contains("before setup"),
            "the earlier Tinybird-routed request must not be replayed into ClickHouse"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), forward_rx.recv())
                .await
                .is_err(),
            "ready org must not forward to the Tinybird collector path"
        );
        assert_eq!(
            store.ingest_key_fetches.load(Ordering::Relaxed),
            1,
            "same key should stay auth-cached across setup transition"
        );
        assert!(
            store.routing_fetches.load(Ordering::Relaxed) >= 1,
            "routing cache should refresh independently from auth cache"
        );

        let _ = std::fs::remove_dir_all(queue_dir);
    }

    #[test]
    fn decrypt_aes256_gcm_matches_node_crypto_fixture() {
        // Generated with Node's createCipheriv("aes-256-gcm", Buffer.alloc(32, 5), iv).
        let key = parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
            .expect("base64 key parses");
        let plaintext = decrypt_aes256_gcm(
            "vDjK0A+Vv5bHlJ2a3A==",
            "AQIDBAUGBwgJCgsM",
            "b7D1umrvI8557NFvR9nJ/A==",
            &key,
        )
        .expect("fixture decrypts");
        assert_eq!(plaintext, "ch-secret-123");
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_requires_current_schema() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_old",
            ClickHouseTargetRow {
                ch_url: "https://clickhouse.example".to_string(),
                ch_user: "ingest".to_string(),
                ch_password_ciphertext: None,
                ch_password_iv: None,
                ch_password_tag: None,
                ch_database: "maple".to_string(),
                schema_version: "old-revision".to_string(),
            },
        );

        let resolver = ClickHouseTargetResolver {
            store,
            encryption_key: None,
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        };

        let target = resolver
            .resolve_clickhouse_target("org_old")
            .await
            .expect("target lookup should not fail");
        assert!(target.is_none());
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_decrypts_current_schema_password() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_ready",
            ClickHouseTargetRow {
                ch_url: "https://clickhouse.example/".to_string(),
                ch_user: "ingest".to_string(),
                ch_password_ciphertext: Some("vDjK0A+Vv5bHlJ2a3A==".to_string()),
                ch_password_iv: Some("AQIDBAUGBwgJCgsM".to_string()),
                ch_password_tag: Some("b7D1umrvI8557NFvR9nJ/A==".to_string()),
                ch_database: "maple".to_string(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_string(),
            },
        );

        let resolver = ClickHouseTargetResolver {
            store,
            encryption_key: Some(
                parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
                    .unwrap(),
            ),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        };

        let target = resolver
            .resolve_clickhouse_target("org_ready")
            .await
            .expect("target lookup should not fail")
            .expect("target should resolve");
        assert_eq!(target.endpoint, "https://clickhouse.example");
        assert_eq!(target.user, "ingest");
        assert_eq!(target.password, "ch-secret-123");
        assert_eq!(target.database, "maple");
    }

    #[tokio::test]
    async fn clickhouse_target_resolver_rejects_password_over_http() {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_clickhouse_target(
            "org_insecure",
            ClickHouseTargetRow {
                ch_url: "http://clickhouse.example/".to_string(),
                ch_user: "ingest".to_string(),
                ch_password_ciphertext: Some("vDjK0A+Vv5bHlJ2a3A==".to_string()),
                ch_password_iv: Some("AQIDBAUGBwgJCgsM".to_string()),
                ch_password_tag: Some("b7D1umrvI8557NFvR9nJ/A==".to_string()),
                ch_database: "maple".to_string(),
                schema_version: CLICKHOUSE_SCHEMA_VERSION.to_string(),
            },
        );

        let resolver = ClickHouseTargetResolver {
            store,
            encryption_key: Some(
                parse_base64_aes256_gcm_key("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=")
                    .unwrap(),
            ),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        };

        let error = resolver
            .resolve_clickhouse_target("org_insecure")
            .await
            .expect_err("password-authenticated http endpoint should be rejected");
        assert!(error.contains("https"));
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

}
