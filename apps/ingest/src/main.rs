#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod autumn;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use maple_ingest::otel::{
    accept_internal_span, auth_internal_span, build_resource, decode_internal_span,
    entitlement_internal_span, forward_client_span, grpc_server_span, parse_internal_span,
    record_stage_error, rejection_loses_data, resolve_config_internal_span, ResourceConfig,
};
use maple_ingest::otlp_json;
use maple_ingest::r2::{replay_object_key, ReplayBlobStore};
use maple_ingest::session_analytics::{
    derive_referrer_host, sanitize_session_event, sanitize_session_meta,
};
use maple_ingest::telemetry::{
    AttributeMappingRule, ClickHouseBreakerConfig, ClickHouseTarget, ClickHouseTargetProvider,
    DatasourceNames, ExportDestination, MappingOperation, MappingSourceContext, PipelineError,
    SamplingPolicy, TelemetryPipeline, TelemetrySignal, TinybirdConfig,
};
use maple_ingest::usage_metrics::{billable_gb, usage_cardinality_view, UsageMetrics};
use moka::future::Cache;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_sdk::logs::{BatchLogProcessor, SdkLoggerProvider};
use opentelemetry_sdk::metrics::periodic_reader_with_async_runtime::PeriodicReader;
use opentelemetry_sdk::metrics::{SdkMeterProvider, Temporality};
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

/// Credentials for the S3-compatible endpoint that holds replay chunk payloads.
#[derive(Clone)]
struct ReplayBlobStoreConfig {
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    region: String,
    timeout: Duration,
}

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
    /// Ceiling on the total decompressed rrweb payload a single replay session
    /// may accumulate. 0 disables the cap. See `ReplaySessionBudget`.
    replay_max_session_bytes: u64,
    /// Where replay chunk payloads are stored. `None` — the default, and the
    /// only option for self-hosted and BYO-ClickHouse deployments — keeps the
    /// rrweb JSON inline in the `session_replay_events` row. `Some` diverts the
    /// payload to R2 and writes a thin index row with an empty `events`.
    replay_blob_store: Option<ReplayBlobStoreConfig>,
    /// Whether `Cf-IPCountry` on an inbound request can be believed.
    ///
    /// Off by default, and that default is the safe one: this gateway is a
    /// Railway container, so it is reachable directly on its
    /// `*.up.railway.app` origin and any client can set the header itself.
    /// Enable it only on deployments where every path to the process is
    /// terminated by Cloudflare. Off simply writes `''`, which is what the
    /// column held before this existed — it cannot regress anything.
    trust_proxy_geo: bool,
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
    Static { org_id: String },
    // PlanetScale Postgres backend used in multi-tenant / production deploys.
    // `url` is the standard pg connection string (PSBouncer port 6432, sslmode
    // require); the API service writes ingest-key rows to the same database.
    Postgres { url: String },
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

        // Routing (self-managed + ClickHouse-readiness flags) is re-read per
        // ingest request on a cache miss. A 1s TTL made that ~11 QPS against
        // org_clickhouse_settings — 961k statements a day, a quarter of ALL
        // traffic on the application database — to observe a value that changes
        // when an operator finishes a schema apply. 30s matches the sampling and
        // attribute-mapping caches; the only cost is that an org flipping to
        // ClickHouse-ready keeps routing to Tinybird for up to another 30s.
        let org_routing_cache_ttl_secs = parse_u64(
            "INGEST_ORG_ROUTING_CACHE_TTL_SECS",
            std::env::var("INGEST_ORG_ROUTING_CACHE_TTL_SECS").ok(),
            30,
        )?;

        // 1 GiB of decompressed rrweb per session. Sized as an absurdity guard,
        // not a product tier: the observed p99 session is ~594 MB, so this only
        // trips on runaway recordings (canvas capture, unmasked media, a page
        // that never stops mutating) while leaving genuinely heavy sessions
        // untouched.
        let replay_max_session_bytes = parse_u64(
            "INGEST_REPLAY_MAX_SESSION_BYTES",
            std::env::var("INGEST_REPLAY_MAX_SESSION_BYTES").ok(),
            1024 * 1024 * 1024,
        )?;

        // Replay payload storage. An unset endpoint is the signal for "keep the
        // rrweb JSON inline in ClickHouse" — that is what self-hosted and
        // BYO-ClickHouse deployments run, and it is also how this ships dark on
        // the managed path until the credentials are set. Anything half-set is a
        // misconfiguration we refuse to boot on rather than silently falling
        // back to inline, which would look identical in metrics until someone
        // noticed the warehouse bill hadn't moved.
        let replay_blob_store = {
            let endpoint = std::env::var("INGEST_REPLAY_R2_ENDPOINT")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            match endpoint {
                None => None,
                Some(endpoint) => {
                    let required = |name: &str| -> Result<String, String> {
                        std::env::var(name)
                            .ok()
                            .map(|v| v.trim().to_string())
                            .filter(|v| !v.is_empty())
                            .ok_or_else(|| {
                                format!("{name} is required when INGEST_REPLAY_R2_ENDPOINT is set")
                            })
                    };
                    let timeout_ms = parse_u64(
                        "INGEST_REPLAY_R2_TIMEOUT_MS",
                        std::env::var("INGEST_REPLAY_R2_TIMEOUT_MS").ok(),
                        5_000,
                    )?;
                    Some(ReplayBlobStoreConfig {
                        endpoint,
                        bucket: required("INGEST_REPLAY_R2_BUCKET")?,
                        access_key_id: required("INGEST_REPLAY_R2_ACCESS_KEY_ID")?,
                        secret_access_key: required("INGEST_REPLAY_R2_SECRET_ACCESS_KEY")?,
                        region: std::env::var("INGEST_REPLAY_R2_REGION")
                            .ok()
                            .map(|v| v.trim().to_string())
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| "auto".to_string()),
                        timeout: Duration::from_millis(timeout_ms),
                    })
                }
            }
        };

        // Default off — see the field doc. Set it on services that are only
        // reachable through Cloudflare.
        let trust_proxy_geo = parse_bool(
            "MAPLE_INGEST_TRUST_PROXY_GEO",
            std::env::var("MAPLE_INGEST_TRUST_PROXY_GEO").ok(),
            false,
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
            replay_max_session_bytes,
            replay_blob_store,
            trust_proxy_geo,
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

    Ok(KeyStoreBackend::Postgres { url })
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
    spend_paused: bool,
    paused_features: Vec<String>,
}

#[derive(Clone, Debug)]
struct ConnectorRow {
    org_id: String,
    service_name: String,
    zone_name: String,
    dataset: String,
    self_managed: bool,
    clickhouse_ready: bool,
    spend_paused: bool,
    paused_features: Vec<String>,
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
            spend_paused: routing.spend_paused,
            paused_features: routing.paused_features,
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
            spend_paused: routing.spend_paused,
            paused_features: routing.paused_features,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct OrgRouting {
    self_managed: bool,
    clickhouse_ready: bool,
    /// The org is over its configured monthly spend ceiling AND chose to pause
    /// ingest on breach. Stamped on `org_spend_limits` by the API's hourly
    /// spend-limit cron — the gateway never prices a cycle itself. Defaults to
    /// false, so an org with no row (the common case) is never paused.
    spend_paused: bool,
    /// Autumn featureIds whose per-cycle cap is exceeded. Per signal on purpose:
    /// blowing the logs cap must not stop traces.
    paused_features: Vec<String>,
}

impl OrgRouting {
    fn from_key_row(row: &KeyRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
            spend_paused: row.spend_paused,
            paused_features: row.paused_features.clone(),
        }
    }

    fn from_connector_row(row: &ConnectorRow) -> Self {
        Self {
            self_managed: row.self_managed,
            clickhouse_ready: row.clickhouse_ready,
            spend_paused: row.spend_paused,
            paused_features: row.paused_features.clone(),
        }
    }
}

/// The Autumn featureId session replay meters as. A `&'static str` for the same
/// reason `Signal::path()` is: it is simultaneously the billing feature, the
/// spend-cap key, and the usage metric's `signal` dimension, and those three must
/// never drift apart.
const BROWSER_SESSIONS_FEATURE_ID: &str = "browser_sessions";

/// Is this signal blocked by the org's own spend guardrails?
///
/// `feature_id` is the Autumn featureId the signal meters as (`logs` / `traces` /
/// `metrics` / `browser_sessions`). A whole-org pause blocks everything; a cap
/// blocks only its own signal. Shared by the OTLP, session-replay and Cloudflare
/// Logpush paths so they can't diverge on what "paused" means.
fn spend_blocks_signal(spend_paused: bool, paused_features: &[String], feature_id: &str) -> bool {
    spend_paused || paused_features.iter().any(|id| id == feature_id)
}

/// The 402 the org's own spend guardrails produce for `feature_id`, or `None`
/// when it is clear to ingest.
///
/// The org's OWN ceiling, not the plan's: `paused_at` / `paused_features` are
/// stamped on `org_spend_limits` by the API's hourly spend-limit cron, and are
/// only ever set when the customer chose "pause ingest at limit". Checked before
/// the Autumn entitlement because it needs no network call — the state arrived
/// with the resolved key — and because a customer who asked us to stop spending
/// their money should not wait on a billing-provider round-trip.
///
/// Never fails open into a pause: the cron leaves the previous state untouched
/// when it can't price a cycle, and an org with no row is never paused.
fn spend_limit_rejection(
    org_id: &str,
    spend_paused: bool,
    paused_features: &[String],
    feature_id: &str,
) -> Option<ApiError> {
    if !spend_blocks_signal(spend_paused, paused_features, feature_id) {
        return None;
    }
    let by_cap = !spend_paused;
    warn!(
        org_id,
        feature_id, by_cap, "Ingestion blocked: customer spend limit reached"
    );
    Some(ApiError::new(
        StatusCode::PAYMENT_REQUIRED,
        if by_cap {
            "Per-feature volume cap reached for this billing cycle"
        } else {
            "Monthly spend limit reached; ingest paused by your organization's settings"
        },
    ))
}

/// The 402 Autumn's entitlement check produces for `feature_id`, or `None` when
/// the org may ingest it.
///
/// Rejects when the org has no active subscription or has exhausted a hard-capped
/// allotment. Fails open on any Autumn error (see `AutumnEntitlements::is_allowed`).
/// Inert unless `AUTUMN_ENFORCE_LIMITS=true` and `AUTUMN_SECRET_KEY` is set.
async fn entitlement_rejection(
    state: &AppState,
    org_id: &str,
    // `&'static str` because `entitlement_internal_span` records it as a span
    // field; every caller already has one (`Signal::path()`, the feature consts).
    feature_id: &'static str,
) -> Option<ApiError> {
    let entitlements = state.autumn_entitlements.as_ref()?;
    // Parent for the existing `autumn.check` client span, so a cache miss that
    // blocks on Autumn is visible even when the HTTP call itself is fast.
    let entitlement_span = entitlement_internal_span(feature_id);
    let entitlement_span_handle = entitlement_span.clone();
    let allowed = entitlements
        .is_allowed(org_id, feature_id)
        .instrument(entitlement_span)
        .await;
    entitlement_span_handle.record("maple.billing.allowed", allowed);
    if allowed {
        return None;
    }
    warn!(
        org_id,
        feature_id, "Ingestion blocked: plan limit reached or no active subscription"
    );
    Some(ApiError::new(
        StatusCode::PAYMENT_REQUIRED,
        "Plan limit reached or no active subscription",
    ))
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
    /// Set once the key store has answered a probe. Drives `/ready`; never
    /// `/health` — see the comment on `health()`.
    key_store_ready: Arc<AtomicBool>,
    resolver: IngestKeyResolver,
    org_inflight_limiter: OrgInFlightLimiter,
    sampling_resolver: SamplingPolicyResolver,
    attribute_mapping_resolver: AttributeMappingResolver,
    cloudflare_resolver: CloudflareConnectorResolver,
    autumn_tracker: Option<AutumnTracker>,
    autumn_entitlements: Option<AutumnEntitlements>,
    /// Per-org ingest volume, on its own delta-temporality provider. Recorded
    /// beside `autumn_tracker` from the same value so the warehouse is ground
    /// truth for what the gateway metered. `None` when metric export is skipped
    /// (local dev, or a loopback endpoint).
    usage_metrics: Option<Arc<UsageMetrics>>,
    replay_session_budget: ReplaySessionBudget,
    /// `Some` when replay payloads go to R2; `None` keeps them inline in the
    /// `session_replay_events` row. See `AppConfig::replay_blob_store`.
    replay_blob_store: Option<ReplayBlobStore>,
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
    // Spend guardrails, resolved with routing: whole-org pause (spend ceiling
    // breached in "pause ingest" mode) and per-signal cap pauses.
    spend_paused: bool,
    paused_features: Vec<String>,
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
    spend_paused: bool,
    paused_features: Vec<String>,
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

/// OTEL span status (`otel.status_code`) for a rejected request.
///
/// 5xx is always `Error` (server fault). Below that, see `rejection_loses_data`:
/// a rejection that drops the caller's telemetry is an `Error`, a rejection of
/// the caller itself is not.
fn otel_status_for_rejection(status: u16, error_kind: &str) -> &'static str {
    if status >= 500 || rejection_loses_data(error_kind) {
        "Error"
    } else {
        "Ok"
    }
}

/// Record why a request was rejected, on the server span.
///
/// `otel.status_description` cannot be the sole carrier: it resolves to
/// `Status::error(reason)`, and the SDK keeps only the winner of `Ok > Error >
/// Unset` — so on a rejection left deliberately `Ok`, the description is dropped
/// and the span records *that* a request was refused but never *why*. The reason
/// therefore always gets its own attribute, and the description is additionally
/// written where an `Error` status will keep it. Counterpart of
/// `record_stage_error` for the stage spans.
fn record_rejection_reason(span: &Span, status: u16, error_kind: &str, reason: &str) {
    span.record("maple.ingest.reject_reason", reason);
    if otel_status_for_rejection(status, error_kind) == "Error" {
        span.record("otel.status_description", reason);
    } else {
        span.record("otel.status_code", "Ok");
    }
}

/// gRPC counterpart of `otel_status_for_rejection`, applying the same rule: a
/// caller-caused rejection leaves the SERVER span `Ok`, only a server-side
/// failure is `Error`. `accept_grpc_decoded` maps the pipeline's 429 to
/// `ResourceExhausted` and everything else to `Unavailable`, so the split here
/// mirrors the 4xx/5xx split on the HTTP path.
fn grpc_otel_status_for_rejection(code: tonic::Code) -> &'static str {
    match code {
        tonic::Code::Unauthenticated
        | tonic::Code::PermissionDenied
        | tonic::Code::ResourceExhausted
        | tonic::Code::InvalidArgument
        | tonic::Code::NotFound
        | tonic::Code::FailedPrecondition
        | tonic::Code::OutOfRange
        | tonic::Code::Cancelled => "Ok",
        _ => "Error",
    }
}

/// Fully-qualified `rpc.service` names, per the OTel semantic conventions.
const GRPC_TRACE_SERVICE: &str = "opentelemetry.proto.collector.trace.v1.TraceService";
const GRPC_LOGS_SERVICE: &str = "opentelemetry.proto.collector.logs.v1.LogsService";
const GRPC_METRICS_SERVICE: &str = "opentelemetry.proto.collector.metrics.v1.MetricsService";

/// Record the resolved caller on the current gRPC server span, mirroring what
/// `handle_signal_inner` records on the HTTP one.
fn record_grpc_identity(resolved: &ResolvedIngestKey) {
    let span = Span::current();
    span.record("maple.org_id", resolved.org_id.as_str());
    span.record("maple.ingest.key_type", resolved.key_type.as_str());
}

/// Fill in the deferred outcome fields on a gRPC server span. Generic over the
/// response body so the three OTLP services share one implementation.
fn record_grpc_outcome<T>(span: &Span, result: &Result<tonic::Response<T>, tonic::Status>) {
    match result {
        Ok(_) => {
            span.record("rpc.grpc.status_code", tonic::Code::Ok as i32);
            span.record("otel.status_code", "Ok");
        }
        Err(status) => {
            let code = status.code();
            span.record("rpc.grpc.status_code", code as i32);
            span.record("error.type", code.description());
            span.record("maple.ingest.reject_reason", status.message());
            if grpc_otel_status_for_rejection(code) == "Error" {
                // See `record_rejection_reason`: the description is only kept
                // on a span whose status stays `Error`.
                span.record("otel.status_description", status.message());
            } else {
                span.record("otel.status_code", "Ok");
            }
        }
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

struct TelemetryProviders {
    tracer: SdkTracerProvider,
    logger: SdkLoggerProvider,
}

fn init_tracing(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
) -> Option<TelemetryProviders> {
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
    let log_exporter = match LogExporter::builder()
        .with_http()
        .with_endpoint(format!("{forward_endpoint}/v1/logs"))
        .with_protocol(Protocol::HttpBinary)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP log exporter: {error}; falling back to stdout-only tracing"
            );
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .init();
            return None;
        }
    };

    // Sized for the per-request child spans (ingest.authenticate / .decode /
    // .parse / .accept / .encode_rows / .wal_commit): a request emits ~7 spans,
    // not 1. At 2048 the queue held only a few seconds of that volume, so a
    // brief export stall silently dropped spans — parents and children alike.
    // Head volume is controlled by OTEL_TRACES_SAMPLER / _ARG, which the SDK
    // reads via TracerProviderBuilder's derived Default.
    let batch_config = BatchConfigBuilder::default()
        .with_max_queue_size(8192)
        .with_max_export_batch_size(1024)
        .with_scheduled_delay(Duration::from_secs(5))
        .build();

    let processor = BatchSpanProcessor::builder(exporter, OtelTokio)
        .with_batch_config(batch_config)
        .build();

    let provider = SdkTracerProvider::builder()
        .with_resource(resource.clone())
        .with_span_processor(processor)
        .build();
    let log_processor = BatchLogProcessor::builder(log_exporter)
        .with_batch_config(
            opentelemetry_sdk::logs::BatchConfigBuilder::default()
                .with_max_queue_size(2048)
                .with_max_export_batch_size(512)
                .with_scheduled_delay(Duration::from_secs(5))
                .build(),
        )
        .build();
    let logger_provider = SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_log_processor(log_processor)
        .build();

    let tracer = provider.tracer("maple-ingest");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let log_layer = OpenTelemetryTracingBridge::new(&logger_provider);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(log_layer)
        .with(otel_layer)
        .init();

    opentelemetry::global::set_tracer_provider(provider.clone());

    Some(TelemetryProviders {
        tracer: provider,
        logger: logger_provider,
    })
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

/// Wire up the per-org ingest volume pipeline. Deliberately a *second* meter
/// provider rather than more instruments on the global one, for three reasons:
///
/// - Temporality is an exporter setting in opentelemetry 0.31, and these metrics
///   need [`Temporality::Delta`] to be exact (see `usage_metrics` module docs).
///   Flipping the shared exporter would silently change every operational metric.
/// - It is never installed with `set_meter_provider`, so nothing can accidentally
///   bind a cumulative operational instrument to the delta exporter.
/// - A 60s interval halves the row count versus the operational provider's 30s,
///   which under delta costs nothing but chart granularity below a minute.
///
/// Shares `service_instance_id` with `init_metrics` so both providers describe
/// one process. Skipped under exactly the same conditions as `init_metrics`.
fn init_usage_metrics(
    forward_endpoint: &str,
    bind_port: u16,
    service_instance_id: &str,
) -> Option<UsageMetrics> {
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
        .with_temporality(Temporality::Delta)
        .build()
    {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!(
                "Failed to build OTLP usage metric exporter: {error}; usage metrics disabled"
            );
            return None;
        }
    };

    let reader = PeriodicReader::builder(exporter, OtelTokio)
        .with_interval(Duration::from_secs(60))
        .build();

    let provider = SdkMeterProvider::builder()
        .with_resource(resource)
        .with_reader(reader)
        .with_view(usage_cardinality_view)
        .build();

    Some(UsageMetrics::new(provider))
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
    let telemetry_providers =
        init_tracing(&config.forward_endpoint, config.port, &service_instance_id);
    let meter_provider = init_metrics(&config.forward_endpoint, config.port, &service_instance_id);
    let usage_metrics =
        init_usage_metrics(&config.forward_endpoint, config.port, &service_instance_id)
            .map(Arc::new);

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
    // reads them from the same place. We probe at boot, but only config errors
    // (a malformed URL) are fatal — an unreachable database boots DEGRADED and
    // retries in the background. Deploy-time validation lives on `/ready`, not on
    // process exit, so a bad deploy never goes ready while a transient database
    // fault can no longer kill a healthy running fleet.
    let key_store_ready = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn KeyStore> = match build_key_store(&config, Arc::clone(&key_store_ready)).await
    {
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

    // Same pooled client as every other outbound call; `http_client` itself is
    // moved into the state below.
    let http_client_for_blobs = http_client.clone();

    let state = Arc::new(AppState {
        key_store_ready: Arc::clone(&key_store_ready),
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
        usage_metrics: usage_metrics.clone(),
        replay_session_budget: ReplaySessionBudget::new(config.replay_max_session_bytes),
        replay_blob_store: config.replay_blob_store.as_ref().map(|blob| {
            ReplayBlobStore::new(
                http_client_for_blobs,
                blob.endpoint.clone(),
                blob.bucket.clone(),
                blob.access_key_id.clone(),
                blob.secret_access_key.clone(),
                blob.region.clone(),
                blob.timeout,
            )
        }),
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
        .route("/ready", get(ready))
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

    if let Some(providers) = telemetry_providers {
        // Flush buffered spans on graceful exit. Errors here are non-fatal —
        // the process is shutting down anyway.
        let _ = providers.tracer.shutdown();
        let _ = providers.logger.shutdown();
    }

    if let Some(provider) = meter_provider {
        // Flush the final metric export on graceful exit.
        let _ = provider.shutdown();
    }

    if let Some(usage) = usage_metrics {
        // Load-bearing, unlike the cumulative provider above: a delta interval
        // that is never collected is lost outright rather than folded into the
        // next export, so skipping this silently under-reports billable volume.
        usage.shutdown();
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
        let span = grpc_server_span(GRPC_TRACE_SERVICE, "traces");
        let span_handle = span.clone();
        let result = async {
            let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
            let mut inner = request.into_inner();
            // Sized before enrichment injects resource attributes, so this is
            // the client's own payload size — the same basis as the HTTP path's
            // `decoded_payload.len()`.
            let decoded_bytes = inner.encoded_len();
            enrich_trace_request(&mut inner, &resolved);
            record_grpc_identity(&resolved);
            accept_grpc_decoded(
                &self.state,
                Signal::Traces,
                DecodedPayload::Traces(inner),
                &resolved,
                decoded_bytes,
            )
            .await?;
            Ok(tonic::Response::new(
                opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse {
                    partial_success: None,
                },
            ))
        }
        .instrument(span)
        .await;
        record_grpc_outcome(&span_handle, &result);
        result
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
        let span = grpc_server_span(GRPC_LOGS_SERVICE, "logs");
        let span_handle = span.clone();
        let result = async {
            let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
            let mut inner = request.into_inner();
            let decoded_bytes = inner.encoded_len();
            enrich_logs_request(&mut inner, &resolved);
            record_grpc_identity(&resolved);
            accept_grpc_decoded(
                &self.state,
                Signal::Logs,
                DecodedPayload::Logs(inner),
                &resolved,
                decoded_bytes,
            )
            .await?;
            Ok(tonic::Response::new(
                opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse {
                    partial_success: None,
                },
            ))
        }
        .instrument(span)
        .await;
        record_grpc_outcome(&span_handle, &result);
        result
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
        let span = grpc_server_span(GRPC_METRICS_SERVICE, "metrics");
        let span_handle = span.clone();
        let result = async {
            let resolved = resolve_grpc_ingest_key(&self.state, request.metadata()).await?;
            let mut inner = request.into_inner();
            let decoded_bytes = inner.encoded_len();
            enrich_metrics_request(&mut inner, &resolved);
            record_grpc_identity(&resolved);
            accept_grpc_decoded(
                &self.state,
                Signal::Metrics,
                DecodedPayload::Metrics(inner),
                &resolved,
                decoded_bytes,
            )
            .await?;
            Ok(tonic::Response::new(
                opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse {
                    partial_success: None,
                },
            ))
        }
        .instrument(span)
        .await;
        record_grpc_outcome(&span_handle, &result);
        result
    }
}

async fn accept_grpc_decoded(
    state: &AppState,
    signal: Signal,
    decoded: DecodedPayload,
    resolved: &ResolvedIngestKey,
    decoded_bytes: usize,
) -> Result<(), tonic::Status> {
    // The customer's own pause applies here even though this path is unbilled:
    // "pause my ingest" has to mean every door, or an org that set a ceiling
    // keeps ingesting over gRPC and never understands why. No entitlement check
    // — gating an unbilled path on a balance it never decrements would be
    // incoherent; see the note in the metering block below.
    if resolved.org_id != SENTINEL_ORG_ID {
        if let Some(error) = spend_limit_rejection(
            &resolved.org_id,
            resolved.spend_paused,
            &resolved.paused_features,
            signal.path(),
        ) {
            return Err(tonic::Status::resource_exhausted(error.message));
        }
    }

    let _org_inflight_permit = state
        .org_inflight_limiter
        .try_acquire(&resolved.org_id)
        .ok_or_else(|| tonic::Status::resource_exhausted("Per-org ingest limit exceeded"))?;
    let item_count = decoded.item_count();
    process_decoded_payload(
        state,
        signal,
        PayloadFormat::Protobuf,
        None,
        &decoded,
        resolved,
    )
    .await
    .map(|_| {
        // gRPC volume is recorded but deliberately NOT metered to Autumn here:
        // this path has never been billed, and switching that on is a
        // customer-facing pricing change that needs its own review. Recording it
        // makes the internal dashboard honest about total ingest, and the
        // warehouse-vs-Autumn gap then quantifies exactly what is unbilled.
        if resolved.org_id != SENTINEL_ORG_ID {
            if let Some(usage) = &state.usage_metrics {
                usage.record(
                    &resolved.org_id,
                    signal.path(),
                    decoded_bytes as u64,
                    item_count as u64,
                );
            }
        }
    })
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
            // The sentinel is a synthetic health probe, not a billable org.
            spend_paused: false,
            paused_features: Vec::new(),
        });
    }

    state
        .resolver
        .resolve_ingest_key(&token)
        .await
        .map_err(|_| tonic::Status::unavailable("Ingest authentication unavailable"))?
        .ok_or_else(|| tonic::Status::unauthenticated("Invalid ingest key"))
}

/// Liveness only — deliberately independent of Postgres.
///
/// If this ever starts reporting database health, a database outage becomes a
/// platform-driven restart loop, which is the exact failure this endpoint's
/// separation from `/ready` exists to prevent.
async fn health() -> &'static str {
    "OK"
}

/// Readiness — false until the key store has answered at least once.
///
/// This is the deploy gate that `std::process::exit(1)` used to be: a genuinely
/// broken deploy (bad credentials, missing schema) never goes ready and the
/// platform can roll it back, without a transient fault killing live tasks.
async fn ready(State(state): State<Arc<AppState>>) -> Response {
    if state.key_store_ready.load(Ordering::Relaxed) {
        (StatusCode::OK, "READY").into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "DEGRADED: key store unavailable").into_response()
    }
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

/// Running total of decompressed rrweb bytes per in-flight replay session, used
/// to stop a runaway recording from writing an unbounded amount into
/// `session_replay_events`.
///
/// Deliberately best-effort and process-local. Sessions are short-lived and a
/// browser holds one origin connection for their duration, so a single replica
/// normally sees every chunk of a session; across N replicas the effective
/// ceiling degrades to roughly N x the configured limit. That is fine for an
/// absurdity guard — it still turns "unbounded" into "bounded" — but it is why
/// this must not be relied on as a billing-accurate quota.
///
/// Entries expire on idle rather than at a fixed age so a genuinely long session
/// keeps its accumulated total, while abandoned ones fall out of the map.
struct ReplaySessionBudget {
    totals: Cache<String, Arc<AtomicU64>>,
    limit: u64,
}

impl ReplaySessionBudget {
    fn new(limit: u64) -> Self {
        Self {
            totals: Cache::builder()
                .time_to_idle(Duration::from_secs(2 * 60 * 60))
                .max_capacity(100_000)
                .build(),
            limit,
        }
    }

    fn key(org_id: &str, session_id: &str) -> String {
        format!("{org_id}:{session_id}")
    }

    /// True once the session has already exceeded its ceiling. Checked before
    /// gunzipping so rejected chunks cost no decompression CPU.
    async fn is_exhausted(&self, org_id: &str, session_id: &str) -> bool {
        if self.limit == 0 {
            return false;
        }
        match self.totals.get(&Self::key(org_id, session_id)).await {
            Some(total) => total.load(Ordering::Relaxed) >= self.limit,
            None => false,
        }
    }

    /// Add a chunk's decompressed size and return the session's new total. The
    /// chunk that crosses the limit is still accepted, so playback truncates at
    /// a chunk boundary instead of on a partial payload; every chunk after it is
    /// rejected by `is_exhausted`.
    async fn add(&self, org_id: &str, session_id: &str, bytes: u64) -> u64 {
        if self.limit == 0 {
            return 0;
        }
        let counter = self
            .totals
            .get_with(Self::key(org_id, session_id), async {
                Arc::new(AtomicU64::new(0))
            })
            .await;
        counter.fetch_add(bytes, Ordering::Relaxed) + bytes
    }
}

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

/// Two-letter ISO country for a session, derived from `Cf-IPCountry`.
///
/// Server-derived on purpose: the client never gets a say, so `Country` cannot
/// be spoofed into a competitor's dashboard. The strict shape check also bounds
/// the `LowCardinality(String)` dictionary to ~250 values no matter what
/// arrives — an unbounded dictionary on that column would degrade every query
/// on the table for that org.
///
/// Returns `""` (the column default) when geo is untrusted, absent, or
/// unrecognized. Cloudflare's `XX` (unknown) and `T1` (Tor exit) are mapped to
/// `""` as well: they are not countries, and leaving them in makes every
/// breakdown carry two junk buckets.
///
/// The client IP is deliberately never read or stored — country is all we take.
fn derive_country(headers: &HeaderMap, trust_proxy_geo: bool) -> String {
    if !trust_proxy_geo {
        return String::new();
    }
    let Some(raw) = replay_header(headers, "cf-ipcountry") else {
        return String::new();
    };
    if raw.len() != 2 || !raw.bytes().all(|b| b.is_ascii_alphabetic()) {
        return String::new();
    }
    let code = raw.to_ascii_uppercase();
    if code == "XX" || code == "T1" {
        return String::new();
    }
    code
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
        "maple.ingest.reject_reason" = tracing::field::Empty,
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
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.message.as_str(),
            );
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

    // Replay is metered to Autumn at the end of this function, so it has to be
    // gated like every other billable signal: a `browser_sessions` cap that
    // keeps billing is the worst way for a spend limit to fail. Same two gates,
    // in the same order, as handle_signal_inner. The sentinel org is a synthetic
    // probe, never billed and never blocked.
    if org_id != SENTINEL_ORG_ID {
        if let Some(error) = spend_limit_rejection(
            &org_id,
            resolved_key.spend_paused,
            &resolved_key.paused_features,
            BROWSER_SESSIONS_FEATURE_ID,
        ) {
            return Err(error);
        }
        if let Some(error) =
            entitlement_rejection(state, &org_id, BROWSER_SESSIONS_FEATURE_ID).await
        {
            return Err(error);
        }
    }

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
    let country = derive_country(headers, state.config.trust_proxy_geo);
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
        // Server-derived fields, forced alongside org_id so the three stay
        // visibly paired: whatever the client sent is overwritten, including
        // with an empty string. Both the active and ended rows get them, which
        // matters because ReplacingMergeTree replaces the whole row — a country
        // present only on v1 would be erased by the v2 merge.
        obj.insert(
            "country".to_string(),
            serde_json::Value::String(country.clone()),
        );
        let referrer = obj
            .get("referrer")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let current_host = obj
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let referrer_host = derive_referrer_host(&referrer, &current_host);
        obj.insert(
            "referrer_host".to_string(),
            serde_json::Value::String(referrer_host),
        );
        // Everything else on this row is client-supplied, including six
        // LowCardinality columns. Clamp before it reaches the warehouse — the
        // SDK's own trimming ships in customer JavaScript.
        sanitize_session_meta(obj);
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
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionEvents",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_events",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.session_events.dropped" = tracing::field::Empty,
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
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.message.as_str(),
            );
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

    // Same two gates as the metadata endpoint, in the same order. Session events
    // are not separately metered — `browser_sessions` remains the billed unit,
    // and introducing a `browser_events` meter is a pricing decision, not a
    // schema one — but they must still be entitlement-gated: an out-of-quota org
    // whose metadata rows are rejected while its event stream keeps writing is
    // the incoherent half of the old design, and it only widens now that custom
    // events are a promoted feature.
    if org_id != SENTINEL_ORG_ID {
        if let Some(error) = spend_limit_rejection(
            &org_id,
            resolved_key.spend_paused,
            &resolved_key.paused_features,
            BROWSER_SESSIONS_FEATURE_ID,
        ) {
            return Err(error);
        }
        if let Some(error) =
            entitlement_rejection(state, &org_id, BROWSER_SESSIONS_FEATURE_ID).await
        {
            return Err(error);
        }
    }

    let pipeline = native_rows_pipeline_for(
        state,
        destination,
        "Session event storage is not configured",
    )?;

    // NDJSON: one distilled session-event object per line. As with replay
    // metadata, org_id is taken from the authenticated key, never the body.
    let mut rows: Vec<Vec<u8>> = Vec::new();
    let mut dropped: u64 = 0;
    for line in body.split(|&b| b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|e| ApiError::bad_request(format!("invalid session event JSON: {e}")))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| ApiError::bad_request("session event must be a JSON object"))?;
        // Unknown `Type` values and oversized message/attribute payloads would
        // bloat this table's LowCardinality dictionaries, which degrades every
        // query on it for that org. Drop or clamp the row rather than failing
        // the batch — see `sanitize_session_event`.
        if !sanitize_session_event(obj) {
            dropped += 1;
            continue;
        }
        obj.insert(
            "org_id".to_string(),
            serde_json::Value::String(org_id.clone()),
        );
        rows.push(
            serde_json::to_vec(&value)
                .map_err(|e| ApiError::bad_request(format!("failed to re-serialize event: {e}")))?,
        );
    }

    if dropped > 0 {
        Span::current().record("maple.session_events.dropped", dropped);
        warn!(
            org_id = %org_id,
            dropped,
            "dropped session events with an unrecognized type"
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

/// Decompressed length of a gzip payload, without materializing it.
///
/// Same number `read_to_string(...).len()` would produce, and the same
/// rejection of malformed gzip — it just doesn't keep the bytes. Used on the
/// blob-store path, where the decompressed text is never needed but `ByteSize`
/// and the per-session budget are still denominated in decompressed bytes.
fn decompressed_len(body: &[u8]) -> Result<u64, ApiError> {
    use std::io::Read as _;
    let mut decoder = flate2::read::GzDecoder::new(body);
    let mut buffer = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        match decoder.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(n) => total += n as u64,
            Err(e) => {
                return Err(ApiError::bad_request(format!(
                    "failed to gunzip replay chunk: {e}"
                )))
            }
        }
    }
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
        "maple.ingest.reject_reason" = tracing::field::Empty,
        "http.request.method" = "POST",
        "http.route" = "/v1/sessionReplays/blob",
        "http.request.body.size" = body.len(),
        "http.response.status_code" = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "maple.signal" = "session_replays",
        "maple.org_id" = tracing::field::Empty,
        "maple.ingest.clickhouse_ready" = tracing::field::Empty,
        "maple.ingest.destination" = tracing::field::Empty,
        "maple.replay.truncated" = tracing::field::Empty,
        "maple.replay.storage" = tracing::field::Empty,
        "maple.replay.object_key" = tracing::field::Empty,
        "maple.replay.blob_put_ms" = tracing::field::Empty,
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
            record_rejection_reason(
                &span_handle,
                status,
                error.error_kind(),
                error.message.as_str(),
            );
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

    // Spend pause only — see handle_session_events_inner: rrweb chunks are not
    // metered, but they are the bulk of a session's bytes, so a pause that
    // didn't cover them would barely be a pause.
    if org_id != SENTINEL_ORG_ID {
        if let Some(error) = spend_limit_rejection(
            &org_id,
            resolved_key.spend_paused,
            &resolved_key.paused_features,
            BROWSER_SESSIONS_FEATURE_ID,
        ) {
            return Err(error);
        }
    }

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
    // The org id comes from the resolved key rather than the request, so this is
    // a guard against a malformed key row, not against the caller. It matters
    // because the id is now a path segment in a signed URL, not just a quoted
    // SQL param.
    if state.replay_blob_store.is_some() && !is_safe_replay_id(&org_id) {
        return Err(ApiError::service_unavailable(
            "organization id is not storage-key safe",
        ));
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

    // Drop chunks for a session that already blew its byte ceiling before paying
    // to decompress them. The SDK treats a non-2xx as a dropped chunk and does
    // not retry, so this ends the recording cleanly rather than looping.
    if state
        .replay_session_budget
        .is_exhausted(&org_id, &session_id)
        .await
    {
        metrics::replay_session_chunk_dropped(&org_id);
        return Err(ApiError::payload_too_large(
            "session replay exceeded its maximum recorded size",
        ));
    }

    // The SDK gzips the rrweb event array (native CompressionStream).
    //
    // With a blob store configured we never need the decompressed text — the
    // gzip is stored verbatim — but we still decode it, for two reasons: this is
    // what rejects malformed gzip from a hostile client, and `byte_size` is a
    // published API field and the input to `ReplaySessionBudget`, whose ceiling
    // is denominated in *decompressed* bytes. So decode and discard, counting.
    // What that avoids is the part that actually cost: materializing a
    // multi-megabyte String, JSON-escaping it, and pushing it through the WAL.
    let (events_json, byte_size) = if state.replay_blob_store.is_some() {
        (None, decompressed_len(&body)?)
    } else {
        use std::io::Read as _;
        let mut decoder = flate2::read::GzDecoder::new(&body[..]);
        let mut events_json = String::new();
        decoder
            .read_to_string(&mut events_json)
            .map_err(|e| ApiError::bad_request(format!("failed to gunzip replay chunk: {e}")))?;
        let byte_size = events_json.len() as u64;
        (Some(events_json), byte_size)
    };

    // Accept the chunk that crosses the ceiling so the recording truncates on a
    // chunk boundary; `is_exhausted` rejects everything after it.
    let session_bytes = state
        .replay_session_budget
        .add(&org_id, &session_id, byte_size)
        .await;
    let limit = state.config.replay_max_session_bytes;
    if limit > 0 && session_bytes >= limit {
        warn!(
            org_id = %org_id,
            session_id = %session_id,
            session_bytes,
            limit,
            "session replay hit its byte ceiling; truncating recording"
        );
        Span::current().record("maple.replay.truncated", true);
        metrics::replay_session_truncated(&org_id);
    }

    // Store the payload before the row that indexes it. The ordering is the
    // invariant: a row must never point at an object that isn't there, and a
    // failed PUT returns non-2xx so the SDK drops the chunk (it already does not
    // retry) rather than leaving an unplayable gap in a listed session. The
    // reverse — an object with no row — is harmless and gets swept by the
    // bucket's lifecycle rule.
    let events_json = match (&state.replay_blob_store, events_json) {
        (Some(store), _) => {
            let key = replay_object_key(&org_id, &session_id, chunk_seq);
            Span::current().record("maple.replay.storage", "r2");
            Span::current().record("maple.replay.object_key", key.as_str());
            let started = Instant::now();
            // Verbatim gzip: ~10x smaller at rest than the JSON text, no
            // recompression, and the Content-Encoding lets a reader hand the
            // bytes to a browser to inflate.
            store
                .put_object(&key, body.to_vec(), "application/json", Some("gzip"))
                .await
                .map_err(|e| {
                    warn!(
                        org_id = %org_id,
                        session_id = %session_id,
                        chunk_seq,
                        error = %e,
                        "replay chunk blob upload failed"
                    );
                    metrics::replay_blob_put_failed(&org_id);
                    ApiError::service_unavailable("failed to store replay chunk")
                })?;
            Span::current().record(
                "maple.replay.blob_put_ms",
                started.elapsed().as_millis() as i64,
            );
            // The index row carries the chunk's metadata; the payload lives in
            // R2 under a key derived from (OrgId, SessionId, ChunkSeq). An empty
            // `events` is what marks the row as blob-backed on read — the SDK
            // never posts an empty chunk, so it cannot occur otherwise.
            String::new()
        }
        (None, Some(events_json)) => {
            Span::current().record("maple.replay.storage", "inline");
            events_json
        }
        // Unreachable: `events_json` is only `None` when a store is configured.
        (None, None) => {
            return Err(ApiError::service_unavailable(
                "replay chunk was neither stored nor decoded",
            ))
        }
    };

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
        "maple.ingest.reject_reason" = tracing::field::Empty,
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
            // Usage and billing are emitted together, from one value, behind one
            // guard — they must never drift. `signal.path()` is both the Autumn
            // feature id and the metric's `signal` dimension.
            if org_id != SENTINEL_ORG_ID {
                let feature_id = signal.path();
                if let Some(usage) = &state.usage_metrics {
                    usage.record(&org_id, feature_id, decoded_bytes as u64, item_count as u64);
                }
                if let Some(tracker) = &state.autumn_tracker {
                    tracker.track(&org_id, feature_id, billable_gb(decoded_bytes as u64));
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
            record_rejection_reason(&span_handle, status, error_kind, error.message.as_str());
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
        "maple.ingest.reject_reason" = tracing::field::Empty,
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
            record_rejection_reason(&span_handle, status, error_kind, error.message.as_str());
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
    // Own span so a cache miss that falls through to PSBouncer is attributable
    // per-request, not just visible in the key_resolution_duration histogram.
    // `postgres.query` (see `postgres_client_span`) nests under this on a miss.
    let auth_span = auth_internal_span();
    let auth_span_handle = auth_span.clone();
    let resolved_key = state
        .resolver
        .resolve_ingest_key(&ingest_key)
        .instrument(auth_span)
        .await
        .map_err(|error| {
            error!(error = %error, "Ingest key resolution failed");
            // The resolver being down is our fault (503), unlike a bad key.
            record_stage_error(&auth_span_handle, "auth_unavailable", &error, true);
            (
                ApiError::service_unavailable("Ingest authentication unavailable"),
                "auth",
            )
        })?
        .ok_or_else(|| {
            warn!("Unknown ingest key");
            record_stage_error(&auth_span_handle, "auth", "Unknown ingest key", false);
            (ApiError::unauthorized("Invalid ingest key"), "auth")
        })?;
    metrics::key_resolution_duration(key_resolve_start.elapsed().as_secs_f64());
    auth_span_handle.record("maple.ingest.key_type", resolved_key.key_type.as_str());
    // Truncated HMAC, not the key itself — enough to find the row in Postgres.
    auth_span_handle.record("maple.ingest.key_id", resolved_key.key_id.as_str());
    auth_span_handle.record("maple.org_id", resolved_key.org_id.as_str());
    auth_span_handle.record("maple.ingest.self_managed", resolved_key.self_managed);
    auth_span_handle.record(
        "maple.ingest.clickhouse_ready",
        resolved_key.clickhouse_ready,
    );

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

    // --- Billing gates (per-signal) ---
    // Customer's own spend guardrails first (no network), then the plan
    // entitlement. Same pair, in the same order, as the session-replay path.
    if let Some(error) = spend_limit_rejection(
        &resolved_key.org_id,
        resolved_key.spend_paused,
        &resolved_key.paused_features,
        signal.path(),
    ) {
        return Err((error, "spend_limit"));
    }

    if let Some(error) = entitlement_rejection(state, &resolved_key.org_id, signal.path()).await {
        return Err((error, "billing_limit"));
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
    let encoding_label = content_encoding.as_deref().unwrap_or("identity");
    // Synchronous, so the span is entered rather than instrumented. Scoped so the
    // span closes on the decompress itself and not on the rest of the handler.
    let decoded_payload = {
        let decode_span = decode_internal_span(encoding_label, body.len());
        let _guard = decode_span.enter();
        let decoded_payload = decode_payload(&body, content_encoding.as_deref()).map_err(|e| {
            warn!(body_bytes = body.len(), "Failed to decode payload");
            record_stage_error(&decode_span, "decode", &e.message, false);
            metrics::org_data_loss(&resolved_key.org_id, signal.path(), "decode");
            (e, "decode")
        })?;
        decode_span.record("maple.ingest.decoded_bytes", decoded_payload.len());
        decoded_payload
    };

    Span::current().record("maple.ingest.decoded_bytes", decoded_payload.len());
    debug!(
        decoded_bytes = decoded_payload.len(),
        encoding = encoding_label,
        "Payload decoded"
    );
    metrics::decoded_body_bytes(signal.path(), decoded_payload.len() as u64);

    // --- Enrich ---
    let decoded = {
        let parse_span = parse_internal_span(payload_format.label(), signal.path());
        let _guard = parse_span.enter();
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
                    // The reason previously only reached the log; on the span it
                    // is what tells you *why* a customer's SDK is being rejected.
                    record_stage_error(&parse_span, "enrich", &e.message, false);
                    metrics::org_data_loss(&resolved_key.org_id, signal.path(), "enrich");
                    (e, "enrich")
                })?;
        parse_span.record("maple.ingest.item_count", decoded.item_count());
        decoded
    };
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

    // Logpush bills the `logs` feature — so the customer's own spend guardrails
    // gate it exactly like OTLP logs do.
    if spend_blocks_signal(resolved.spend_paused, &resolved.paused_features, "logs") {
        warn!(
            org_id = %resolved.org_id,
            connector_id,
            by_cap = !resolved.spend_paused,
            "Cloudflare logpush blocked: customer spend limit reached"
        );
        return Err((
            ApiError::new(
                StatusCode::PAYMENT_REQUIRED,
                "Spend limit reached; ingest paused by your organization's settings",
            ),
            "spend_limit",
        ));
    }

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
                spend_paused: resolved.spend_paused,
                paused_features: resolved.paused_features.clone(),
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

            // Logpush already *checks* the `logs` entitlement above but has never
            // reported usage against it, so this org consumes quota without ever
            // metering. Record the volume here (same `decoded_payload.len()` basis
            // as the OTLP path); switching on the Autumn `track` is a separate,
            // customer-facing decision.
            if resolved.org_id != SENTINEL_ORG_ID {
                if let Some(usage) = &state.usage_metrics {
                    usage.record(
                        &resolved.org_id,
                        Signal::Logs.path(),
                        decoded_payload.len() as u64,
                        item_count as u64,
                    );
                }
            }

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
                .map_err(|e| invalid_payload("traces", "protobuf", e))?;
            enrich_trace_request(&mut request, resolved_key);
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Protobuf) => {
            let mut request = ExportLogsServiceRequest::decode(payload)
                .map_err(|e| invalid_payload("logs", "protobuf", e))?;
            enrich_logs_request(&mut request, resolved_key);
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Protobuf) => {
            let mut request = ExportMetricsServiceRequest::decode(payload)
                .map_err(|e| invalid_payload("metrics", "protobuf", e))?;
            enrich_metrics_request(&mut request, resolved_key);
            Ok(DecodedPayload::Metrics(request))
        }
        (Signal::Traces, PayloadFormat::Json) => {
            let mut request: ExportTraceServiceRequest =
                decode_otlp_json(payload, "traces", "resourceSpans")?;
            enrich_trace_request(&mut request, resolved_key);
            Ok(DecodedPayload::Traces(request))
        }
        (Signal::Logs, PayloadFormat::Json) => {
            let mut request: ExportLogsServiceRequest =
                decode_otlp_json(payload, "logs", "resourceLogs")?;
            enrich_logs_request(&mut request, resolved_key);
            Ok(DecodedPayload::Logs(request))
        }
        (Signal::Metrics, PayloadFormat::Json) => {
            let mut request: ExportMetricsServiceRequest =
                decode_otlp_json(payload, "metrics", "resourceMetrics")?;
            enrich_metrics_request(&mut request, resolved_key);
            Ok(DecodedPayload::Metrics(request))
        }
    }
}

/// OTLP/JSON decode, via the leniency pass in `otlp_json`.
///
/// Deserializing straight into the generated types rejects encodings the spec
/// says a receiver must accept (a `time_unix_nano` sent as a JSON number) and,
/// for metrics, silently discards the data points instead of failing. So the
/// payload goes through `serde_json::Value` first and is normalized onto the
/// encoding the derives handle. See `otlp_json` for the full list.
fn decode_otlp_json<T: serde::de::DeserializeOwned>(
    payload: &[u8],
    signal: &str,
    root_field: &str,
) -> Result<T, ApiError> {
    let mut json: serde_json::Value =
        serde_json::from_slice(payload).map_err(|e| invalid_payload(signal, "JSON", e))?;
    otlp_json::normalize(&mut json, root_field);
    serde_json::from_value(json).map_err(|e| invalid_payload(signal, "JSON", e))
}

/// The parser's own complaint is the only thing that says *which* field a
/// customer's SDK got wrong, so it goes in the response body (and from there
/// onto the span) rather than being flattened into "Invalid OTLP payload".
/// Bounded because it is attacker-influenced and lands on a span attribute.
fn invalid_payload(signal: &str, format: &str, error: impl std::fmt::Display) -> ApiError {
    let mut detail = error.to_string();
    if detail.len() > MAX_PAYLOAD_ERROR_DETAIL {
        detail.truncate(
            (0..=MAX_PAYLOAD_ERROR_DETAIL)
                .rev()
                .find(|i| detail.is_char_boundary(*i))
                .unwrap_or(0),
        );
        detail.push('…');
    }
    ApiError::bad_request(format!("Invalid OTLP {signal} {format} payload: {detail}"))
}

const MAX_PAYLOAD_ERROR_DETAIL: usize = 200;

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
        accept_native_decoded_payload(state, signal, decoded, resolved_key, destination)
            .instrument(accept_internal_span(signal.path(), destination.as_str()))
            .await?;
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
            // Both lookups are 30s-TTL cached; the span exists so a TTL miss that
            // stalls on PSBouncer is attributable instead of vanishing into
            // native_accept_duration.
            let config_span = resolve_config_internal_span();
            let config_span_handle = config_span.clone();
            let (policy, attribute_mappings) = async {
                let policy = state
                    .sampling_resolver
                    .resolve_policy(&resolved_key.org_id)
                    .await;
                let attribute_mappings = state
                    .attribute_mapping_resolver
                    .resolve_mappings(&resolved_key.org_id)
                    .await;
                (policy, attribute_mappings)
            }
            .instrument(config_span)
            .await;
            config_span_handle.record("maple.ingest.sampling_ratio", policy.trace_sample_ratio);
            config_span_handle.record(
                "maple.ingest.attribute_mapping_count",
                attribute_mappings.len(),
            );
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
        record_stage_error(
            &Span::current(),
            error.kind(),
            &error.to_string(),
            error.is_server_fault(),
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
        // Recorded on `ingest.authenticate` when this runs under the HTTP path;
        // a no-op elsewhere (the field is only declared on that span).
        if let Some(identity) = self.cache.get(raw_key).await {
            Span::current().record("maple.ingest.cache_hit", true);
            let routing = self.routing.resolve_org_routing(&identity.org_id).await?;
            return Ok(Some(identity.into_resolved(routing)));
        }
        Span::current().record("maple.ingest.cache_hit", false);

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
        // ClickHouse readiness on its own TTL.
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

/// The schema revision this binary needs an org's ClickHouse to be at, as a
/// number. Non-numeric (legacy hash) revisions parse to 0, which is older than
/// every real migration — the same "not ready" answer they get today.
fn required_schema_revision() -> i32 {
    CLICKHOUSE_SCHEMA_VERSION.parse().unwrap_or(0)
}

/// Is an org's stamped schema revision new enough for this binary to write to?
///
/// Deliberately `>=` rather than `==`. Migrations only ever add columns or widen
/// types, and every INSERT names its columns explicitly, so an older binary
/// writing into a newer schema is safe — the columns it doesn't know about take
/// their DEFAULT. Equality instead made *any* skew a routing change: between
/// stamping an org at the new revision and rolling out the matching binary, the
/// org fell back to Tinybird and its own ClickHouse silently missed that window.
/// With `>=` the org keeps writing to its own cluster throughout the rollout.
///
/// The comparison is numeric on purpose: these are stored as text, and as text
/// "12" sorts before "9", so a string `>=` would strand every org.
fn schema_revision_is_compatible(stamped: &str) -> bool {
    schema_revision_at_least(stamped, required_schema_revision())
}

/// The comparison itself, with `needed` passed in so it is testable without
/// depending on whatever revision this binary happens to be pinned to.
fn schema_revision_at_least(stamped: &str, needed: i32) -> bool {
    stamped.parse::<i32>().unwrap_or(-1) >= needed
}

/// SQL predicate matching `schema_revision_is_compatible`, for the routing
/// queries. Kept next to it so the two can never drift — if they disagree,
/// routing sends frames down the ClickHouse path that the target resolver then
/// refuses, and the export worker drops the batch.
///
/// `CASE` rather than `regex AND cast`: legacy revisions were content hashes,
/// and `'2967fa9b'::int` raises rather than returning false. Postgres does not
/// promise to evaluate `AND` left-to-right — it may reorder on cost, and a
/// regex match costs more than a cast — so the guard has to be `CASE`, which
/// *is* defined to short-circuit. Getting this wrong fails the whole query,
/// which would take down every ingest-key lookup, not just one org's routing.
const SCHEMA_REVISION_COMPATIBLE_SQL: &str =
    "(CASE WHEN s.schema_version ~ '^[0-9]+$' THEN s.schema_version::int ELSE -1 END >= $1)";

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
        if !schema_revision_is_compatible(&row.schema_version) {
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
    /// Target identity for the DB client spans, read off the parsed connection
    /// string once at startup. Without a `db.namespace` these spans collapse
    /// into the per-system generic node on the service map instead of naming
    /// the database they actually hit.
    target: PostgresTarget,
}

/// The `db.namespace` / `server.address` / `server.port` of the configured
/// origin. Derived from `MAPLE_PG_URL` rather than hardcoded so self-hosted and
/// local deployments report the database they really talk to.
#[derive(Clone, Debug, Default)]
struct PostgresTarget {
    namespace: String,
    address: String,
    port: u16,
}

impl PostgresTarget {
    fn from_config(config: &tokio_postgres::Config) -> Self {
        let address = match config.get_hosts().first() {
            Some(tokio_postgres::config::Host::Tcp(host)) => host.clone(),
            Some(tokio_postgres::config::Host::Unix(path)) => path.to_string_lossy().into_owned(),
            None => String::new(),
        };
        Self {
            namespace: config.get_dbname().unwrap_or_default().to_string(),
            address,
            port: config.get_ports().first().copied().unwrap_or_default(),
        }
    }
}

/// One Postgres client span.
///
/// `operation`/`collection` are the SQL verb and primary table, NOT the Rust
/// method name: `db.operation.name` composes with `db.collection.name` into the
/// query-shape label the warehouse groups on, so a method name there produces a
/// label like "fetch_ingest_key" that no SQL-shaped view can line up with the
/// same table hit from the API. The method name rides on `code.function.name`,
/// which keeps existing log/dashboard filters working.
fn postgres_client_span(
    method: &'static str,
    operation: &'static str,
    collection: &'static str,
    target: &PostgresTarget,
) -> Span {
    tracing::info_span!(
        "postgres.query",
        otel.kind = "client",
        "db.system.name" = "postgresql",
        "db.operation.name" = operation,
        "db.collection.name" = collection,
        "db.namespace" = %target.namespace,
        "server.address" = %target.address,
        "server.port" = target.port,
        "code.function.name" = method,
        "peer.service" = "planetscale-postgres",
    )
}

/// Flatten an error's source chain into one line.
///
/// `tokio_postgres::Error`'s `Display` is the bare string "db error" — the
/// SQLSTATE, the pooler's rejection reason, the TLS failure all live in
/// `source()`. During the 2026-08-09 outage every log line read
/// `fetch_ingest_key failed: db error`, which could not distinguish a refused
/// connection from exhausted pooler slots from rejected credentials.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.join(": ")
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

        // Read the target identity before the config is moved into the manager.
        let target = PostgresTarget::from_config(&pg_config);

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

        Ok(Self { pool, target })
    }

    async fn client(&self) -> Result<deadpool_postgres::Object, String> {
        self.pool
            .get()
            .await
            .map_err(|error| format!("postgres pool checkout failed: {}", error_chain(&error)))
    }

    /// Startup gate — runs the production lookup query with a stub hash so any
    /// auth/schema/network/TLS issue exits the process instead of 503'ing every
    /// request.
    async fn probe(&self) -> Result<(), String> {
        let client = self.client().await?;
        client
            .query(
                // Exercises every join the production lookup uses, so a missing
                // table or column exits at startup instead of 503'ing requests.
                "SELECT k.org_id, \
                        COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                        COALESCE(l.paused_at IS NOT NULL, false) AS spend_paused, \
                        COALESCE(ARRAY(SELECT jsonb_array_elements_text(l.paused_features)), '{}')::text[] AS paused_features \
                 FROM org_ingest_keys k \
                 LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
                 LEFT JOIN org_spend_limits l ON l.org_id = k.org_id \
                 WHERE k.private_key_hash = $1 LIMIT 1",
                &[&"__ingest_probe_no_match__"],
            )
            .instrument(postgres_client_span("probe", "SELECT", "org_ingest_keys", &self.target))
            .await
            .map(|_| ())
            .map_err(|error| format!("postgres probe query failed: {}", error_chain(&error)))
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
        let revision = required_schema_revision();
        let sql = format!(
            "SELECT k.org_id, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                    COALESCE(l.paused_at IS NOT NULL, false) AS spend_paused, \
                    COALESCE(ARRAY(SELECT jsonb_array_elements_text(l.paused_features)), '{{}}')::text[] AS paused_features \
             FROM org_ingest_keys k \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id \
             LEFT JOIN org_spend_limits l ON l.org_id = k.org_id \
             WHERE k.{hash_column} = $2 LIMIT 1"
        );
        let client = self.client().await?;
        let rows = client
            .query(&sql, &[&revision, &key_hash])
            .instrument(postgres_client_span(
                "fetch_ingest_key",
                "SELECT",
                "org_ingest_keys",
                &self.target,
            ))
            .await
            .map_err(|error| format!("postgres fetch_ingest_key failed: {}", error_chain(&error)))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(KeyRow {
            org_id: row.get("org_id"),
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
            spend_paused: row.get("spend_paused"),
            paused_features: row.get("paused_features"),
        }))
    }

    async fn fetch_connector(
        &self,
        connector_id: &str,
        secret_hash: &str,
    ) -> Result<Option<ConnectorRow>, String> {
        let revision = required_schema_revision();
        let client = self.client().await?;
        let sql = format!(
            "SELECT c.org_id, c.service_name, c.zone_name, c.dataset, \
                    COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                    COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                    COALESCE(l.paused_at IS NOT NULL, false) AS spend_paused, \
                    COALESCE(ARRAY(SELECT jsonb_array_elements_text(l.paused_features)), '{{}}')::text[] AS paused_features \
             FROM cloudflare_logpush_connectors c \
             LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id \
             LEFT JOIN org_spend_limits l ON l.org_id = c.org_id \
             WHERE c.id = $2 AND c.secret_hash = $3 AND c.enabled = true LIMIT 1"
        );
        let rows = client
            .query(&sql, &[&revision, &connector_id, &secret_hash])
            .instrument(postgres_client_span(
                "fetch_connector",
                "SELECT",
                "cloudflare_logpush_connectors",
                &self.target,
            ))
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
            spend_paused: row.get("spend_paused"),
            paused_features: row.get("paused_features"),
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
            .instrument(postgres_client_span(
                "fetch_sampling_policy",
                "SELECT",
                "org_ingest_sampling_policies",
                &self.target,
            ))
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
            .instrument(postgres_client_span(
                "fetch_attribute_mappings",
                "SELECT",
                "org_ingest_attribute_mappings",
                &self.target,
            ))
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
        let revision = required_schema_revision();
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT ch_url, ch_user, ch_password_ciphertext, ch_password_iv, ch_password_tag, \
                        ch_database, schema_version \
                 FROM org_clickhouse_settings \
                 WHERE org_id = $1 AND sync_status = 'connected' \
                   AND CASE WHEN schema_version ~ '^[0-9]+$' \
                            THEN schema_version::int ELSE -1 END >= $2 LIMIT 1",
                &[&org_id, &revision],
            )
            .instrument(postgres_client_span(
                "fetch_clickhouse_target",
                "SELECT",
                "org_clickhouse_settings",
                &self.target,
            ))
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
        let revision = required_schema_revision();
        let client = self.client().await?;
        let rows = client
            .query(
                // Anchored on a one-row scalar subquery, not on
                // org_clickhouse_settings: an org can have spend limits and no
                // BYO-ClickHouse config, and the old FROM would return no row at
                // all for it — reading as "never paused".
                &format!(
                    "SELECT COALESCE(s.sync_status = 'connected', false) AS self_managed, \
                            COALESCE(s.sync_status = 'connected' AND {SCHEMA_REVISION_COMPATIBLE_SQL}, false) AS clickhouse_ready, \
                            COALESCE(l.paused_at IS NOT NULL, false) AS spend_paused, \
                            COALESCE(ARRAY(SELECT jsonb_array_elements_text(l.paused_features)), '{{}}')::text[] AS paused_features \
                     FROM (SELECT $2::text AS org_id) o \
                     LEFT JOIN org_clickhouse_settings s ON s.org_id = o.org_id \
                     LEFT JOIN org_spend_limits l ON l.org_id = o.org_id LIMIT 1"
                ),
                &[&revision, &org_id],
            )
            .instrument(postgres_client_span("fetch_org_routing", "SELECT", "org_clickhouse_settings", &self.target))
            .await
            .map_err(|error| format!("postgres fetch_org_routing failed: {error}"))?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(OrgRouting {
            self_managed: row.get("self_managed"),
            clickhouse_ready: row.get("clickhouse_ready"),
            spend_paused: row.get("spend_paused"),
            paused_features: row.get("paused_features"),
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
            .instrument(postgres_client_span(
                "record_connector_success",
                "UPDATE",
                "cloudflare_logpush_connectors",
                &self.target,
            ))
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
            .instrument(postgres_client_span(
                "record_connector_failure",
                "UPDATE",
                "cloudflare_logpush_connectors",
                &self.target,
            ))
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
            // Self-hosted / local: no billing provider, so nothing can be paused.
            spend_paused: false,
            paused_features: Vec::new(),
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
async fn build_key_store(
    config: &AppConfig,
    ready: Arc<AtomicBool>,
) -> Result<Arc<dyn KeyStore>, String> {
    match &config.key_store_backend {
        KeyStoreBackend::Static { org_id } => {
            info!(
                backend = "static",
                org_id = %org_id,
                "Key store backend selected"
            );
            ready.store(true, Ordering::Relaxed);
            Ok(Arc::new(StaticKeyStore {
                org_id: org_id.clone(),
            }))
        }
        KeyStoreBackend::Postgres { url } => {
            info!(
                backend = "planetscale-postgres",
                "Key store backend selected"
            );
            // A malformed MAPLE_PG_URL is operator error, fixable in seconds, and
            // can never resolve on its own — that stays fatal.
            let store = Arc::new(PostgresKeyStore::new(url)?);

            // A failing probe is NOT fatal. It used to `exit(1)`, which turned any
            // transient Postgres/PSBouncer fault into a restart loop: every boot
            // reopened pool connections against the very component that was
            // struggling, and each restart wiped the in-memory key + routing
            // caches, so nothing could serve stale and nothing could recover
            // without an operator. Boot degraded and re-probe in the background
            // instead — auth 503s until Postgres returns, then heals by itself.
            match store.probe().await {
                Ok(()) => {
                    info!("Postgres startup probe succeeded");
                    ready.store(true, Ordering::Relaxed);
                }
                Err(error) => {
                    error!(
                        %error,
                        "Postgres startup probe failed; booting DEGRADED (ingest auth will 503 until Postgres recovers). /ready stays false; /health stays OK so the platform does not restart-loop this task."
                    );
                    spawn_key_store_reprobe(Arc::clone(&store), ready);
                }
            }

            Ok(store)
        }
    }
}

/// Re-probe Postgres until it answers, then flip the readiness flag.
///
/// Backoff is capped and jittered: an un-jittered fleet retrying in lockstep is
/// how a recovering pooler gets knocked straight back over.
fn spawn_key_store_reprobe(store: Arc<PostgresKeyStore>, ready: Arc<AtomicBool>) {
    tokio::spawn(async move {
        let mut delay_ms: u64 = 1_000;
        loop {
            // Cheap per-iteration jitter without pulling in `rand`; recomputed
            // each pass so replicas that booted together drift apart.
            let jitter_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| u64::from(elapsed.subsec_nanos()) % 1_000)
                .unwrap_or(0);
            tokio::time::sleep(Duration::from_millis(delay_ms + jitter_ms)).await;

            match store.probe().await {
                Ok(()) => {
                    info!("Postgres reachable again; key store READY");
                    ready.store(true, Ordering::Relaxed);
                    return;
                }
                Err(error) => {
                    warn!(%error, delay_ms, "Postgres re-probe failed; still degraded");
                    delay_ms = (delay_ms * 2).min(30_000);
                }
            }
        }
    });
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
    use opentelemetry_proto::tonic::metrics::v1::metric;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn postgres_target_is_derived_from_the_connection_string() {
        let config = "postgres://user:pw@psbouncer.example.com:6432/maple_prod"
            .parse::<tokio_postgres::Config>()
            .unwrap();
        let target = PostgresTarget::from_config(&config);
        assert_eq!(target.namespace, "maple_prod");
        assert_eq!(target.address, "psbouncer.example.com");
        assert_eq!(target.port, 6432);
    }

    #[test]
    fn postgres_client_span_declares_db_identity() {
        // A field that isn't declared here can't be filtered or grouped on, and
        // an absent `db.namespace` drops the span into the generic per-system
        // node on the service map instead of naming the database.
        let target = PostgresTarget {
            namespace: "maple_prod".to_string(),
            address: "psbouncer.example.com".to_string(),
            port: 6432,
        };
        let span = postgres_client_span("fetch_ingest_key", "SELECT", "org_ingest_keys", &target);
        for field in [
            "db.system.name",
            "db.operation.name",
            "db.collection.name",
            "db.namespace",
            "server.address",
            "server.port",
            "peer.service",
            "code.function.name",
        ] {
            assert!(span.has_field(field), "span is missing field `{field}`");
        }
    }

    #[test]
    fn hash_is_deterministic() {
        let hash_a = hash_ingest_key("maple_pk_123", "secret").unwrap();
        let hash_b = hash_ingest_key("maple_pk_123", "secret").unwrap();
        assert_eq!(hash_a, hash_b);
    }

    /// Rejections of the *caller* stay `Ok` — a rotated key or a 429 storm is
    /// high-volume and expected, and must not page anyone.
    #[test]
    fn caller_fault_rejections_do_not_mark_the_span_error() {
        assert_eq!(otel_status_for_rejection(401, "auth"), "Ok"); // missing/invalid ingest key
        assert_eq!(otel_status_for_rejection(402, "error"), "Ok"); // billing limit
        assert_eq!(otel_status_for_rejection(413, "payload_too_large"), "Ok");
        assert_eq!(otel_status_for_rejection(415, "unsupported_media"), "Ok");
        assert_eq!(otel_status_for_rejection(429, "throttle"), "Ok");
        assert_eq!(otel_status_for_rejection(429, "forward"), "Ok"); // pipeline shed
    }

    /// Rejections that destroy the sender's telemetry are `Error` regardless of
    /// status class. This is the regression that let a bug drop 99.2% of one
    /// org's logs for over a day while every dashboard read 0%.
    #[test]
    fn data_loss_rejections_mark_the_span_error_even_at_4xx() {
        assert_eq!(otel_status_for_rejection(400, "enrich"), "Error");
        assert_eq!(otel_status_for_rejection(400, "decode"), "Error");
        assert_eq!(otel_status_for_rejection(400, "bad_request"), "Error");

        assert!(rejection_loses_data("enrich"));
        assert!(rejection_loses_data("decode"));
        assert!(rejection_loses_data("bad_request"));
        assert!(!rejection_loses_data("auth"));
        assert!(!rejection_loses_data("throttle"));
        assert!(!rejection_loses_data("payload_too_large"));
        assert!(!rejection_loses_data("forward"));
    }

    #[test]
    fn server_faults_stay_error() {
        // e.g. auth resolver unavailable → 503.
        assert_eq!(otel_status_for_rejection(500, "error"), "Error");
        assert_eq!(otel_status_for_rejection(503, "unavailable"), "Error");
        assert_eq!(otel_status_for_rejection(503, "forward"), "Error");
    }

    /// Every label `rejection_loses_data` claims must actually be producible, or
    /// the rule silently covers nothing — the failure mode it exists to prevent.
    #[test]
    fn data_loss_labels_match_the_kinds_the_gateway_emits() {
        assert_eq!(ApiError::bad_request("x").error_kind(), "bad_request");
        // `decode` and `enrich` are the stage labels attached in
        // `handle_signal_inner`; they reach the span via the Err tuple.
        for stage in ["decode", "enrich"] {
            assert!(
                rejection_loses_data(stage),
                "{stage} is emitted as an error.type but is not classified"
            );
        }
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
        assert_eq!(
            ApiError::service_unavailable("x").error_kind(),
            "unavailable"
        );
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
        assert_eq!(otel_status_for_rejection(429, "forward"), "Ok");
        assert_eq!(otel_status_for_rejection(503, "forward"), "Error");
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
            spend_paused: false,
            paused_features: Vec::new(),
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

    fn test_key() -> ResolvedIngestKey {
        ResolvedIngestKey {
            org_id: "org_real".to_string(),
            key_type: IngestKeyType::Private,
            key_id: "abc".to_string(),
            self_managed: false,
            clickhouse_ready: false,
            spend_paused: false,
            paused_features: Vec::new(),
        }
    }

    fn decode_json(signal: Signal, payload: &str) -> Result<DecodedPayload, ApiError> {
        decode_and_enrich_payload(signal, PayloadFormat::Json, payload.as_bytes(), &test_key())
    }

    /// Spec-legal encodings the generated types refuse: nanosecond timestamps as
    /// JSON numbers, `{}` for a log with no body or an attribute with no value,
    /// and `null` for an absent id. Rejecting these 400'd effectively all of one
    /// org's logs.
    #[test]
    fn lenient_log_payload_is_accepted() {
        let decoded = decode_json(
            Signal::Logs,
            r#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeLogs":[{"scope":{"name":"app"},"logRecords":[{"timeUnixNano":1753660000000000000,"observedTimeUnixNano":1753660000000000000,"severityNumber":9,"severityText":"INFO","body":{},"attributes":[{"key":"empty","value":{}},{"key":"kept","value":{"stringValue":"v"}}],"traceId":null}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Logs(request) = decoded else {
            panic!("expected logs");
        };
        assert_eq!(count_log_items(&request), 1);
        let record = &request.resource_logs[0].scope_logs[0].log_records[0];
        assert_eq!(record.time_unix_nano, 1753660000000000000);
        assert_eq!(record.severity_number, 9);
        assert!(record.body.is_none());
        // The empty attribute survives as a key with no value; the real one is intact.
        assert_eq!(record.attributes.len(), 2);
        assert!(record.attributes[0].value.is_none());
        assert!(record.attributes[1].value.is_some());
    }

    /// Metrics fail differently and worse: `Metric.data` is a flattened oneof, so
    /// the same encoding deserializes to `None` — a 200 with the data points
    /// thrown away, billed and never stored.
    #[test]
    fn numeric_nanos_no_longer_silently_empty_a_metric() {
        let decoded = decode_json(
            Signal::Metrics,
            r#"{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":1753660000000000000,"asDouble":1.5}]}}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Metrics(request) = decoded else {
            panic!("expected metrics");
        };
        let metric = &request.resource_metrics[0].scope_metrics[0].metrics[0];
        let Some(metric::Data::Gauge(gauge)) = &metric.data else {
            panic!("gauge data dropped");
        };
        assert_eq!(gauge.data_points.len(), 1);
    }

    #[test]
    fn spec_compliant_payloads_still_decode() {
        let decoded = decode_json(
            Signal::Traces,
            r#"{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET /","kind":2,"startTimeUnixNano":"1753660000000000000","endTimeUnixNano":"1753660000000000001","status":{"code":1}}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Traces(request) = decoded else {
            panic!("expected traces");
        };
        let span = &request.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.name, "GET /");
        assert_eq!(span.kind, 2);
        assert_eq!(span.end_time_unix_nano, 1753660000000000001);
    }

    /// Enrichment still has to reach a request whose resource we normalized away.
    #[test]
    fn enrichment_applies_to_a_payload_with_no_resource() {
        let decoded = decode_json(
            Signal::Logs,
            r#"{"resourceLogs":[{"resource":{},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1"}]}]}]}"#,
        )
        .expect("payload accepted");

        let DecodedPayload::Logs(request) = decoded else {
            panic!("expected logs");
        };
        let attributes = &request.resource_logs[0]
            .resource
            .as_ref()
            .expect("resource re-inserted")
            .attributes;
        assert!(attributes.iter().any(|a| a.key == "maple_org_id"
            && matches!(
                &a.value,
                Some(AnyValue { value: Some(any_value::Value::StringValue(v)) }) if v == "org_real"
            )));
    }

    /// An export request with nothing to export is a no-op, not a rejection.
    #[test]
    fn empty_export_request_is_accepted() {
        let decoded = decode_json(Signal::Logs, r#"{}"#).expect("payload accepted");
        assert_eq!(decoded.item_count(), 0);
    }

    /// Genuinely malformed input is still refused — and now says why, which is
    /// the whole point: the previous message named neither the field nor the
    /// offset, so a customer had no way to find the bug in their exporter.
    #[test]
    fn malformed_payload_is_rejected_with_the_parser_reason() {
        let Err(error) = decode_json(Signal::Logs, r#"{"resourceLogs":"nope"}"#) else {
            panic!("expected rejection");
        };
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(
            error
                .message
                .starts_with("Invalid OTLP logs JSON payload: "),
            "unexpected message: {}",
            error.message
        );
        assert!(
            error.message.contains("invalid type"),
            "reason not preserved: {}",
            error.message
        );
    }

    #[test]
    fn rejection_reason_is_bounded() {
        let error = invalid_payload("logs", "JSON", "x".repeat(10_000));
        assert!(error.message.len() < MAX_PAYLOAD_ERROR_DETAIL + 64);
        assert!(error.message.ends_with('…'));
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
            spend_paused: false,
            paused_features: Vec::new(),
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

    fn geo_headers(country: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cf-ipcountry", country.parse().unwrap());
        headers
    }

    #[test]
    fn country_is_empty_unless_the_proxy_is_trusted() {
        // The gateway is reachable directly on its Railway origin, so an
        // untrusted deployment must ignore the header entirely rather than let
        // a client label its own traffic.
        assert_eq!(derive_country(&geo_headers("DE"), false), "");
        assert_eq!(derive_country(&HeaderMap::new(), true), "");
    }

    #[test]
    fn country_normalizes_and_rejects_non_countries() {
        assert_eq!(derive_country(&geo_headers("de"), true), "DE");
        assert_eq!(derive_country(&geo_headers(" us "), true), "US");
        // Cloudflare's unknown/Tor sentinels are not countries — keeping them
        // would put two junk buckets in every breakdown.
        assert_eq!(derive_country(&geo_headers("XX"), true), "");
        assert_eq!(derive_country(&geo_headers("T1"), true), "");
        // Anything off-shape is dropped, which is what bounds the LowCardinality
        // dictionary to ~250 values.
        assert_eq!(derive_country(&geo_headers("DE; DROP"), true), "");
        assert_eq!(derive_country(&geo_headers("DEU"), true), "");
        assert_eq!(derive_country(&geo_headers("1"), true), "");
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
                    spend_paused: false,
                    paused_features: Vec::new(),
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
                    spend_paused: false,
                    paused_features: Vec::new(),
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
            key_store_ready: Arc::new(AtomicBool::new(true)),
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
                replay_max_session_bytes: 1024 * 1024 * 1024,
                replay_blob_store: None,
                trust_proxy_geo: false,
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
            usage_metrics: None,
            replay_session_budget: ReplaySessionBudget::new(1024 * 1024 * 1024),
            replay_blob_store: None,
        }
    }

    /// Point a state's replay payloads at a fake S3 endpoint. Mirrors what
    /// `INGEST_REPLAY_R2_*` does in `Config::from_env`.
    fn with_replay_blob_store(mut state: AppState, endpoint: String) -> AppState {
        let config = ReplayBlobStoreConfig {
            endpoint,
            bucket: "replays".to_string(),
            access_key_id: "test-access-key".to_string(),
            secret_access_key: "test-secret-key".to_string(),
            region: "auto".to_string(),
            timeout: Duration::from_secs(5),
        };
        state.replay_blob_store = Some(ReplayBlobStore::new(
            state.http_client.clone(),
            config.endpoint.clone(),
            config.bucket.clone(),
            config.access_key_id.clone(),
            config.secret_access_key.clone(),
            config.region.clone(),
            config.timeout,
        ));
        state.config.replay_blob_store = Some(config);
        state
    }

    #[tokio::test]
    async fn replay_budget_truncates_session_at_its_ceiling() {
        let budget = ReplaySessionBudget::new(1_000);

        // Under the ceiling: the session keeps accepting chunks.
        assert_eq!(budget.add("org_a", "s1", 400).await, 400);
        assert!(!budget.is_exhausted("org_a", "s1").await);
        assert_eq!(budget.add("org_a", "s1", 400).await, 800);
        assert!(!budget.is_exhausted("org_a", "s1").await);

        // The chunk that crosses is still accepted, so the recording truncates on
        // a chunk boundary rather than mid-payload.
        assert_eq!(budget.add("org_a", "s1", 400).await, 1_200);
        assert!(budget.is_exhausted("org_a", "s1").await);
    }

    #[tokio::test]
    async fn replay_budget_scopes_totals_per_session_and_org() {
        let budget = ReplaySessionBudget::new(1_000);
        budget.add("org_a", "s1", 1_200).await;

        // A different session in the same org is unaffected...
        assert!(!budget.is_exhausted("org_a", "s2").await);
        // ...as is the same session id belonging to a different org, so one
        // tenant cannot exhaust another's budget by guessing session ids.
        assert!(!budget.is_exhausted("org_b", "s1").await);
        assert!(budget.is_exhausted("org_a", "s1").await);
    }

    #[tokio::test]
    async fn replay_budget_disabled_when_limit_is_zero() {
        let budget = ReplaySessionBudget::new(0);
        budget.add("org_a", "s1", u64::MAX / 2).await;
        assert!(!budget.is_exhausted("org_a", "s1").await);
    }

    #[test]
    fn spend_blocks_signal_pauses_the_whole_org_or_just_the_capped_signal() {
        // Whole-org pause: the spend ceiling was breached in "pause ingest" mode.
        assert!(spend_blocks_signal(true, &[], "logs"));
        assert!(spend_blocks_signal(true, &[], "traces"));

        // A per-feature cap blocks only its own signal — blowing the logs cap
        // must not stop traces, which is the whole point of a per-feature cap.
        let caps = vec!["logs".to_string()];
        assert!(spend_blocks_signal(false, &caps, "logs"));
        assert!(!spend_blocks_signal(false, &caps, "traces"));
        assert!(!spend_blocks_signal(false, &caps, "metrics"));

        // The default state — no row in org_spend_limits — never blocks.
        assert!(!spend_blocks_signal(false, &[], "logs"));
    }

    #[tokio::test]
    async fn resolve_ingest_key_carries_spend_pause_state_from_the_key_lookup() {
        // The cold path builds routing from the key row, so a paused org must be
        // paused on the very first request after a key-cache miss — not only once
        // the separate routing cache refreshes.
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_paused",
            KeyRow {
                org_id: "org_paused".to_string(),
                self_managed: false,
                clickhouse_ready: false,
                spend_paused: true,
                paused_features: vec!["logs".to_string()],
            },
        );

        let resolved = make_resolver(store)
            .resolve_ingest_key("maple_sk_test_paused")
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert!(resolved.spend_paused);
        assert_eq!(resolved.paused_features, vec!["logs".to_string()]);
        assert!(spend_blocks_signal(
            resolved.spend_paused,
            &resolved.paused_features,
            "traces"
        ));
    }

    #[test]
    fn a_browser_sessions_cap_blocks_replay_without_touching_other_signals() {
        // Replay is metered as `browser_sessions`, so the cap has to reach it —
        // a cap that keeps billing is the worst way for a spend limit to fail.
        let caps = vec![BROWSER_SESSIONS_FEATURE_ID.to_string()];

        let rejection = spend_limit_rejection("org_1", false, &caps, BROWSER_SESSIONS_FEATURE_ID)
            .expect("a browser_sessions cap must block replay");
        assert_eq!(rejection.status, StatusCode::PAYMENT_REQUIRED);
        assert!(rejection.message.contains("Per-feature volume cap"));

        // And only replay: capping sessions must not stop trace ingestion.
        assert!(spend_limit_rejection("org_1", false, &caps, "traces").is_none());

        // A whole-org pause blocks replay too, with the ceiling's message.
        let paused = spend_limit_rejection("org_1", true, &[], BROWSER_SESSIONS_FEATURE_ID)
            .expect("a whole-org pause must block replay");
        assert!(paused.message.contains("Monthly spend limit reached"));

        // No guardrails configured — never blocked.
        assert!(spend_limit_rejection("org_1", false, &[], BROWSER_SESSIONS_FEATURE_ID).is_none());
    }

    #[tokio::test]
    async fn replay_metadata_is_rejected_and_unmetered_when_sessions_are_capped() {
        // End-to-end on the handler: the 402 must land before the pipeline write
        // and before the Autumn `track`, or we bill for data we refused.
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            "maple_sk_test_replay_capped",
            KeyRow {
                org_id: "org_replay_capped".to_string(),
                self_managed: false,
                clickhouse_ready: false,
                spend_paused: false,
                paused_features: vec![BROWSER_SESSIONS_FEATURE_ID.to_string()],
            },
        );

        let queue_dir = unique_main_test_dir("replay-capped");
        let state = test_app_state(
            store,
            queue_dir.clone(),
            "http://127.0.0.1:1".to_string(),
            Duration::from_secs(30),
        )
        .await;

        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "Bearer maple_sk_test_replay_capped".parse().unwrap(),
        );
        let body = Bytes::from(r#"{"session_id":"s1","version":1,"status":"active"}"#.to_string());

        let error = handle_replay_meta_inner(&state, &headers, body)
            .await
            .expect_err("a browser_sessions cap must reject replay metadata");
        assert_eq!(error.status, StatusCode::PAYMENT_REQUIRED);

        // `state.autumn_tracker` is None in tests, so the assertion that matters
        // is structural: the gate returns before the metering block is reached.
        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    /// What a fake R2 recorded for one PUT.
    #[derive(Debug)]
    struct CapturedPut {
        path: String,
        authorization: String,
        content_type: String,
        content_encoding: String,
        body: Vec<u8>,
    }

    async fn fake_r2_put(
        axum::extract::State(tx): axum::extract::State<
            tokio::sync::mpsc::UnboundedSender<CapturedPut>,
        >,
        Path(path): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string()
        };
        let _ = tx.send(CapturedPut {
            path,
            authorization: header("authorization"),
            content_type: header("content-type"),
            content_encoding: header("content-encoding"),
            body: body.to_vec(),
        });
        StatusCode::OK
    }

    async fn always_500() -> StatusCode {
        StatusCode::INTERNAL_SERVER_ERROR
    }

    fn gzip_bytes(plain: &str) -> Bytes {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(plain.as_bytes()).unwrap();
        Bytes::from(encoder.finish().unwrap())
    }

    fn replay_blob_headers(raw_key: &str, session_id: &str, chunk_seq: u32) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {raw_key}").parse().unwrap(),
        );
        headers.insert("x-maple-session-id", session_id.parse().unwrap());
        headers.insert("x-maple-chunk-seq", chunk_seq.to_string().parse().unwrap());
        headers.insert("x-maple-event-count", "3".parse().unwrap());
        headers.insert("x-maple-duration-ms", "1200".parse().unwrap());
        headers
    }

    /// Total bytes the pipeline has committed to disk. The WAL is appended
    /// before a frame reaches the export channel, so this growing is the
    /// observable "a row was enqueued".
    fn queue_dir_bytes(dir: &PathBuf) -> u64 {
        fn walk(dir: &std::path::Path) -> u64 {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            entries
                .flatten()
                .map(|entry| match entry.metadata() {
                    Ok(meta) if meta.is_dir() => walk(&entry.path()),
                    Ok(meta) => meta.len(),
                    Err(_) => 0,
                })
                .sum()
        }
        walk(dir)
    }

    async fn replay_blob_test_state(
        raw_key: &str,
        org_id: &str,
        queue_dir: PathBuf,
    ) -> AppState {
        let store = Arc::new(FakeKeyStore::default());
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: org_id.to_string(),
                // Routes to ClickHouse. The fixture's `WriteMode::Forward` has no
                // Tinybird pipeline, so a Tinybird-destined chunk would 503 in
                // `native_rows_pipeline_for` before reaching the blob path.
                self_managed: true,
                clickhouse_ready: true,
                spend_paused: false,
                paused_features: Vec::new(),
            },
        );
        test_app_state(
            store,
            queue_dir,
            "http://127.0.0.1:1".to_string(),
            Duration::from_secs(30),
        )
        .await
    }

    #[tokio::test]
    async fn replay_chunk_payload_goes_to_the_blob_store_verbatim() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/{*path}", axum::routing::put(fake_r2_put))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("replay-blob-put");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_blob",
            "org_replay_blob",
            queue_dir.clone(),
        )
        .await;
        let state = with_replay_blob_store(state, format!("http://{addr}"));

        let events = r#"[{"type":2,"timestamp":1}]"#;
        let gzipped = gzip_bytes(events);
        handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_blob", "sess_42", 7),
            gzipped.clone(),
        )
        .await
        .expect("blob upload should succeed");

        let captured = rx.recv().await.expect("the blob store should see a PUT");

        // Key scheme: bucket first, then the v1/{org}/{session}/{seq}.json.gz
        // that the API side reconstructs from the ClickHouse row.
        assert_eq!(
            captured.path,
            "replays/v1/org_replay_blob/sess_42/00000007.json.gz"
        );
        // Stored verbatim — not re-gzipped, not the decompressed text. A
        // recompression here would silently double ingest CPU and break the
        // Content-Encoding contract the reader depends on.
        assert_eq!(captured.body, gzipped.to_vec());
        assert_eq!(captured.content_type, "application/json");
        assert_eq!(captured.content_encoding, "gzip");
        assert!(
            captured.authorization.starts_with(
                "AWS4-HMAC-SHA256 Credential=test-access-key/"
            ),
            "expected a SigV4 authorization header, got {:?}",
            captured.authorization
        );
        assert!(captured.authorization.contains("/auto/s3/aws4_request"));

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[tokio::test]
    async fn a_failed_blob_upload_rejects_the_chunk_and_enqueues_no_row() {
        // The orphan-prevention invariant. A row whose payload never landed is
        // an unplayable gap in a session that still lists as recorded; the SDK
        // does not retry, so the only safe failure is to drop the chunk whole.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/{*path}", axum::routing::put(always_500));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let queue_dir = unique_main_test_dir("replay-blob-fail");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_fail",
            "org_replay_fail",
            queue_dir.clone(),
        )
        .await;
        let state = with_replay_blob_store(state, format!("http://{addr}"));

        let before = queue_dir_bytes(&queue_dir);
        let error = handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_fail", "sess_fail", 1),
            gzip_bytes(r#"[{"type":2,"timestamp":1}]"#),
        )
        .await
        .expect_err("a blob store 500 must reject the chunk");

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            queue_dir_bytes(&queue_dir),
            before,
            "no index row may be committed when the payload was not stored"
        );

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[tokio::test]
    async fn replay_chunks_stay_inline_when_no_blob_store_is_configured() {
        // The self-hosted / BYO-ClickHouse path, and the pre-cutover managed
        // path: unset credentials must behave exactly as before.
        let queue_dir = unique_main_test_dir("replay-blob-inline");
        let state = replay_blob_test_state(
            "maple_sk_test_replay_inline",
            "org_replay_inline",
            queue_dir.clone(),
        )
        .await;
        assert!(state.replay_blob_store.is_none());

        let before = queue_dir_bytes(&queue_dir);
        handle_replay_blob_inner(
            &state,
            &replay_blob_headers("maple_sk_test_replay_inline", "sess_inline", 0),
            gzip_bytes(r#"[{"type":2,"timestamp":1}]"#),
        )
        .await
        .expect("the inline path should accept the chunk");

        assert!(
            queue_dir_bytes(&queue_dir) > before,
            "the inline path must still enqueue a row carrying the payload"
        );

        let _ = std::fs::remove_dir_all(&queue_dir);
    }

    #[test]
    fn decompressed_len_matches_read_to_string_and_rejects_garbage() {
        // `byte_size` is a published API field and the input to the per-session
        // budget, both denominated in decompressed bytes — the streaming counter
        // must not quietly redefine it as compressed bytes.
        for payload in [
            "[]",
            r#"[{"type":2,"timestamp":1}]"#,
            &"x".repeat(256 * 1024),
        ] {
            let gzipped = gzip_bytes(payload);
            assert_eq!(
                decompressed_len(&gzipped).expect("valid gzip should decode"),
                payload.len() as u64,
                "byte count drifted for a {}-byte payload",
                payload.len()
            );
        }

        let error = decompressed_len(b"not gzip at all")
            .expect_err("malformed gzip must still be rejected");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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

    /// Records `(thread, span name, parent span name)` for every span opened
    /// while it is installed, so a test can assert the shape of the trace rather
    /// than just that individual spans exist.
    ///
    /// Installed as the *global* default rather than a thread-local one: callsite
    /// interest is cached process-wide, so with a thread-local subscriber a
    /// sibling test reaching a span macro first caches `Interest::never` and the
    /// span silently never gets created for us. `set_global_default` rebuilds
    /// that cache. The cost is that concurrently-running tests land in the same
    /// capture, which is why every record is tagged with its thread.
    /// One opened span: the thread that opened it, its name, and its parent's
    /// name (`None` for a root).
    type CapturedSpan = (std::thread::ThreadId, String, Option<String>);

    #[derive(Clone, Default)]
    struct SpanTreeCapture {
        spans: Arc<std::sync::Mutex<Vec<CapturedSpan>>>,
    }

    static SPAN_TREE_CAPTURE: std::sync::OnceLock<SpanTreeCapture> = std::sync::OnceLock::new();

    /// Install the capture globally, once per test process.
    fn install_span_capture() -> &'static SpanTreeCapture {
        SPAN_TREE_CAPTURE.get_or_init(|| {
            let capture = SpanTreeCapture::default();
            tracing::subscriber::set_global_default(
                tracing_subscriber::registry().with(capture.clone()),
            )
            .expect("no other test may install a global subscriber");
            capture
        })
    }

    impl SpanTreeCapture {
        /// Scoped to the calling thread. `#[tokio::test]` uses a current-thread
        /// runtime, so the handler and the export worker it spawns both run here,
        /// while other tests' spans are filtered out.
        fn parent_of(&self, name: &str) -> Option<Option<String>> {
            let this_thread = std::thread::current().id();
            self.spans
                .lock()
                .unwrap()
                .iter()
                .find(|(thread, span, _)| *thread == this_thread && span == name)
                .map(|(_, _, parent)| parent.clone())
        }

        fn assert_child_of(&self, child: &str, parent: &str) {
            let observed = self
                .parent_of(child)
                .unwrap_or_else(|| panic!("span `{child}` was never created"));
            assert_eq!(
                observed.as_deref(),
                Some(parent),
                "span `{child}` should be a child of `{parent}`"
            );
        }
    }

    impl<S> tracing_subscriber::Layer<S> for SpanTreeCapture
    where
        S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    {
        fn on_new_span(
            &self,
            _attrs: &tracing::span::Attributes<'_>,
            id: &tracing::Id,
            ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let Some(span) = ctx.span(id) else {
                return;
            };
            let parent = span.parent().map(|parent| parent.name().to_string());
            self.spans.lock().unwrap().push((
                std::thread::current().id(),
                span.name().to_string(),
                parent,
            ));
        }
    }

    /// The whole point of the child spans: a single slow request must show *which*
    /// stage was slow. Without this the trace collapses to one server span and the
    /// per-stage histograms are the only signal, which cannot attribute an
    /// individual request.
    /// `PipelineError::is_server_fault` decides the span status and
    /// `api_error_from_pipeline` decides the HTTP status. They encode the same
    /// judgement in two places, so a new variant that gets one right and the
    /// other wrong would mislabel error dashboards.
    #[test]
    fn pipeline_error_fault_split_matches_http_status() {
        for error in [
            PipelineError::Backpressure("lane full"),
            PipelineError::Throttled("org cap"),
            PipelineError::QueueUnavailable("wal io".to_string()),
            PipelineError::Encode("bad row".to_string()),
        ] {
            let status = api_error_from_pipeline(&error).status.as_u16();
            assert_eq!(
                error.is_server_fault(),
                status >= 500,
                "{} maps to HTTP {status} but reports is_server_fault()={}",
                error.kind(),
                error.is_server_fault()
            );
            assert_eq!(
                otel_status_for_rejection(status, "forward"),
                if error.is_server_fault() {
                    "Error"
                } else {
                    "Ok"
                },
                "span status for {} disagrees with the HTTP rule",
                error.kind()
            );
        }
    }

    #[tokio::test]
    async fn native_request_emits_a_span_per_pipeline_stage() {
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

        let queue_dir = unique_main_test_dir("span-tree");
        let store = Arc::new(FakeKeyStore::default());
        let raw_key = "maple_sk_test_span_tree";
        store.insert_private(
            raw_key,
            KeyRow {
                org_id: "org_span_tree".to_string(),
                self_managed: true,
                clickhouse_ready: true,
                spend_paused: false,
                paused_features: Vec::new(),
            },
        );
        store.insert_clickhouse_target(
            "org_span_tree",
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
        let state = test_app_state(
            Arc::clone(&store),
            queue_dir.clone(),
            "http://127.0.0.1:1".to_string(),
            Duration::from_millis(5),
        )
        .await;

        let capture = install_span_capture();

        // Stands in for the `ingest` server span that handle_signal creates.
        let server_span = tracing::info_span!("ingest");
        let (response, item_count, _, _) = handle_signal_inner(
            &state,
            &test_headers(raw_key),
            Bytes::from(test_log_request("span tree").encode_to_vec()),
            Signal::Logs,
        )
        .instrument(server_span)
        .await
        .expect("request should be accepted through the native ClickHouse path");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(item_count, 1);

        capture.assert_child_of("ingest.authenticate", "ingest");
        capture.assert_child_of("ingest.decode", "ingest");
        capture.assert_child_of("ingest.parse", "ingest");
        capture.assert_child_of("ingest.accept", "ingest");
        capture.assert_child_of("ingest.encode_rows", "ingest.accept");
        capture.assert_child_of("ingest.wal_commit", "ingest.accept");

        // The export lane drains asynchronously, so its batch is deliberately a
        // root: one batch aggregates frames from many requests and cannot be
        // parented under any single one.
        tokio::time::timeout(Duration::from_secs(2), ch_rx.recv())
            .await
            .expect("ready org should write to ClickHouse")
            .expect("ClickHouse channel should stay open");
        assert_eq!(
            capture.parent_of("ingest.export_batch"),
            Some(None),
            "export batches must stay root spans and link back instead"
        );
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
                spend_paused: false,
                paused_features: Vec::new(),
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
                spend_paused: false,
                paused_features: Vec::new(),
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

    #[test]
    fn schema_revision_accepts_newer_schemas_and_rejects_older_ones() {
        let needed = required_schema_revision();
        assert!(needed > 0, "generated SCHEMA_VERSION should be numeric");

        // Exactly current, and ahead of this binary: both writable. The second
        // is the rollout window — an org stamped at the new revision before the
        // matching binary ships keeps writing to its own ClickHouse instead of
        // silently falling back to Tinybird.
        assert!(schema_revision_is_compatible(&needed.to_string()));
        assert!(schema_revision_is_compatible(&(needed + 1).to_string()));

        // Behind this binary: the columns genuinely are not there yet.
        assert!(!schema_revision_is_compatible(&(needed - 1).to_string()));

        // Legacy content-hash revisions are not comparable — treated as older.
        assert!(!schema_revision_is_compatible("old-revision"));
        assert!(!schema_revision_is_compatible(""));
    }

    #[test]
    fn schema_revision_compares_numerically_not_lexicographically() {
        // Revisions are stored as text, where "12" sorts *before* "9". A string
        // comparison would call an org at revision 12 "behind" revision 9 and
        // strand every org the moment the count reached double digits.
        assert!(schema_revision_at_least("12", 9), "12 is ahead of 9");
        assert!(!schema_revision_at_least("9", 12), "9 is behind 12");
        assert!(schema_revision_at_least("100", 99), "100 is ahead of 99");
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
