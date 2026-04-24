#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod autumn;

use std::io::{Read, Write};
use std::path::PathBuf;
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
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use libsql::{params, Builder, Database};
use metrics::{counter, gauge, histogram};
use moka::future::Cache;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::Sha256;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, error, info, warn, Span};

const INGEST_SOURCE: &str = "maple-ingest-gateway";
const CLOUDFLARE_LOGPUSH_SOURCE: &str = "cloudflare-logpush";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct AppConfig {
    port: u16,
    forward_endpoint: String,
    forward_self_managed_endpoint: Option<String>,
    forward_timeout: Duration,
    max_request_body_bytes: usize,
    require_tls: bool,
    db_url: Option<String>,
    db_auth_token: Option<String>,
    lookup_hmac_key: String,
    autumn_secret_key: Option<String>,
    autumn_api_url: String,
    autumn_flush_interval_secs: u64,
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

        let max_request_body_bytes = parse_usize(
            "INGEST_MAX_REQUEST_BODY_BYTES",
            std::env::var("INGEST_MAX_REQUEST_BODY_BYTES").ok(),
            20 * 1024 * 1024,
        )?;

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

        let db_url = std::env::var("MAPLE_DB_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let db_auth_token = std::env::var("MAPLE_DB_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

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
            forward_endpoint,
            forward_self_managed_endpoint,
            forward_timeout: Duration::from_millis(forward_timeout_ms),
            max_request_body_bytes,
            require_tls,
            db_url,
            db_auth_token,
            lookup_hmac_key,
            autumn_secret_key,
            autumn_api_url,
            autumn_flush_interval_secs,
        })
    }
}

struct IngestKeyResolver {
    db: Arc<Database>,
    lookup_hmac_key: String,
    cache: Cache<String, ResolvedIngestKey>,
}

struct CloudflareConnectorResolver {
    db: Arc<Database>,
    lookup_hmac_key: String,
    cache: Cache<String, ResolvedCloudflareConnector>,
}

struct AppState {
    config: AppConfig,
    http_client: Client,
    resolver: IngestKeyResolver,
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
    // shared pool. Computed from a LEFT JOIN with `org_tinybird_settings` at
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

struct EnrichResult {
    payload: Vec<u8>,
    item_count: usize,
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        gauge!("ingest_requests_in_flight").decrement(1.0);
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

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "maple_ingest=info,tower_http=info".into()),
        )
        .with_target(false)
        .compact()
        .init();

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

    let database = match open_database(&config).await {
        Ok(database) => database,
        Err(error) => {
            eprintln!("Database init error: {error}");
            std::process::exit(1);
        }
    };

    let http_client = match Client::builder()
        .timeout(config.forward_timeout)
        .pool_max_idle_per_host(5)
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("HTTP client init error: {error}");
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

    let shared_db = Arc::new(database);

    let state = Arc::new(AppState {
        resolver: IngestKeyResolver {
            db: Arc::clone(&shared_db),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: ingest_key_cache,
        },
        cloudflare_resolver: CloudflareConnectorResolver {
            db: Arc::clone(&shared_db),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
            cache: cloudflare_connector_cache,
        },
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

    info!(
        port = config.port,
        forward_endpoint = %config.forward_endpoint,
        forward_self_managed_endpoint = %config
            .forward_self_managed_endpoint
            .as_deref()
            .unwrap_or("<unset>"),
        require_tls = config.require_tls,
        max_body_bytes = config.max_request_body_bytes,
        "Maple ingest server listening"
    );

    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("Ingest server failed: {error}");
        std::process::exit(1);
    }
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

    let span = tracing::info_span!(
        "ingest",
        signal = signal.path(),
        body_bytes,
        org_id = tracing::field::Empty,
        key_type = tracing::field::Empty,
    );
    let _enter = span.enter();

    let result = handle_signal_inner(&state, &headers, body, signal).await;
    let duration = start.elapsed();
    let duration_ms = duration.as_millis() as u64;

    match result {
        Ok((response, item_count, org_id, decoded_bytes)) => {
            let status_code = response.status().as_u16();
            histogram!("ingest_request_duration_seconds", "signal" => signal.path(), "status" => "ok")
                .record(duration.as_secs_f64());
            counter!("ingest_requests_total", "signal" => signal.path(), "status" => "ok", "error_kind" => "none")
                .increment(1);
            if let Some(tracker) = &state.autumn_tracker {
                let feature_id = signal.path();
                let value_gb = decoded_bytes as f64 / 1_000_000_000.0;
                tracker.track(&org_id, feature_id, value_gb);
            }
            info!(
                status = status_code,
                duration_ms, item_count, "Request processed"
            );
            response
        }
        Err((error, error_kind)) => {
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

    let span = tracing::info_span!(
        "cloudflare_logpush",
        signal = "logs",
        dataset = "http_requests",
        body_bytes,
        org_id = tracing::field::Empty,
        connector_id = %connector_id,
    );
    let _enter = span.enter();

    let result = handle_cloudflare_logpush_inner(&state, &connector_id, secret.as_deref(), &headers, body).await;
    let duration = start.elapsed();

    match result {
        Ok((response, item_count, org_id, is_validation)) => {
            let status_code = response.status().as_u16();
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

    Span::current().record("org_id", &resolved_key.org_id.as_str());
    Span::current().record("key_type", resolved_key.key_type.as_str());
    debug!(
        resolve_ms = key_resolve_start.elapsed().as_millis() as u64,
        "Authenticated"
    );

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

    let content_encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity");

    histogram!("ingest_request_body_bytes", "signal" => signal.path()).record(body.len() as f64);

    // --- Decode ---
    let decoded_payload = decode_payload(&body, content_encoding.as_deref()).map_err(|e| {
        warn!(body_bytes = body.len(), "Failed to decode payload");
        (e, "decode")
    })?;

    let encoding_label = content_encoding.as_deref().unwrap_or("identity");
    debug!(
        decoded_bytes = decoded_payload.len(),
        encoding = encoding_label,
        "Payload decoded"
    );
    histogram!("ingest_decoded_body_bytes", "signal" => signal.path())
        .record(decoded_payload.len() as f64);

    // --- Enrich ---
    let enrich_result = enrich_payload(signal, payload_format, &decoded_payload, &resolved_key)
        .map_err(|e| {
            warn!(format = payload_format.label(), "Invalid OTLP payload");
            (e, "enrich")
        })?;

    debug!(item_count = enrich_result.item_count, "Payload enriched");
    counter!(
        "ingest_items_total",
        "signal" => signal.path(),
        "org_id" => resolved_key.org_id.clone()
    )
    .increment(enrich_result.item_count as u64);

    let decoded_bytes = decoded_payload.len();

    // --- Encode & Forward ---
    let outbound_body = encode_payload(&enrich_result.payload, content_encoding.as_deref())
        .map_err(|e| (e, "encode"))?;

    let response = forward_to_collector(
        state,
        signal,
        payload_format.content_type(),
        content_encoding.as_deref(),
        outbound_body,
        &resolved_key,
    )
    .await
    .map_err(|e| (e, "forward"))?;

    Ok((
        response,
        enrich_result.item_count,
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

    Span::current().record("org_id", &resolved.org_id.as_str());
    debug!(
        connector_id = %resolved.connector_id,
        org_id = %resolved.org_id,
        key_id = %resolved.secret_key_id,
        "Authenticated Cloudflare Logpush connector"
    );

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
                "dataset" => resolved.dataset.clone(),
                "org_id" => resolved.org_id.clone()
            )
            .increment(item_count as u64);

            let response = match forward_to_collector(
                state,
                Signal::Logs,
                "application/x-protobuf",
                None,
                request.encode_to_vec(),
                &ResolvedIngestKey {
                    org_id: resolved.org_id.clone(),
                    key_type: IngestKeyType::Connector,
                    key_id: resolved.secret_key_id.clone(),
                    self_managed: resolved.self_managed,
                },
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

fn enrich_payload(
    signal: Signal,
    payload_format: PayloadFormat,
    payload: &[u8],
    resolved_key: &ResolvedIngestKey,
) -> Result<EnrichResult, ApiError> {
    match (signal, payload_format) {
        (Signal::Traces, PayloadFormat::Protobuf) => {
            let mut request = ExportTraceServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP traces protobuf payload"))?;
            enrich_trace_request(&mut request, resolved_key);
            let item_count = count_trace_items(&request);
            Ok(EnrichResult {
                payload: request.encode_to_vec(),
                item_count,
            })
        }
        (Signal::Logs, PayloadFormat::Protobuf) => {
            let mut request = ExportLogsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs protobuf payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            let item_count = count_log_items(&request);
            Ok(EnrichResult {
                payload: request.encode_to_vec(),
                item_count,
            })
        }
        (Signal::Metrics, PayloadFormat::Protobuf) => {
            let mut request = ExportMetricsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics protobuf payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            let item_count = count_metric_items(&request);
            Ok(EnrichResult {
                payload: request.encode_to_vec(),
                item_count,
            })
        }
        (Signal::Traces, PayloadFormat::Json) => {
            let mut request: ExportTraceServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP traces JSON payload"))?;
            enrich_trace_request(&mut request, resolved_key);
            let item_count = count_trace_items(&request);
            let payload = serde_json::to_vec(&request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize traces payload"))?;
            Ok(EnrichResult {
                payload,
                item_count,
            })
        }
        (Signal::Logs, PayloadFormat::Json) => {
            let mut request: ExportLogsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs JSON payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            let item_count = count_log_items(&request);
            let payload = serde_json::to_vec(&request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize logs payload"))?;
            Ok(EnrichResult {
                payload,
                item_count,
            })
        }
        (Signal::Metrics, PayloadFormat::Json) => {
            let mut request: ExportMetricsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics JSON payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            let item_count = count_metric_items(&request);
            let payload = serde_json::to_vec(&request).map_err(|_| {
                ApiError::service_unavailable("Failed to serialize metrics payload")
            })?;
            Ok(EnrichResult {
                payload,
                item_count,
            })
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

        // LEFT JOIN against org_tinybird_settings so the "self-managed?" flag is
        // resolved in the same roundtrip as org_id. This hits the DB only on cache
        // miss; warm cache hits (>99% of traffic) skip this entirely.
        let query = format!(
            "SELECT k.org_id, \
                    CASE WHEN s.sync_status = 'active' THEN 1 ELSE 0 END AS self_managed \
             FROM org_ingest_keys k \
             LEFT JOIN org_tinybird_settings s ON s.org_id = k.org_id \
             WHERE k.{hash_column} = ? LIMIT 1"
        );

        let conn = self.db.connect().map_err(|error| error.to_string())?;
        let mut rows = conn
            .query(&query, params![key_hash.clone()])
            .await
            .map_err(|error| error.to_string())?;

        let Some(row) = rows.next().await.map_err(|error| error.to_string())? else {
            return Ok(None);
        };

        let org_id: String = row.get(0).map_err(|error| error.to_string())?;
        let self_managed_flag: i64 = row.get(1).map_err(|error| error.to_string())?;

        let resolved = ResolvedIngestKey {
            org_id,
            key_type,
            key_id: key_hash.chars().take(16).collect(),
            self_managed: self_managed_flag != 0,
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
        let conn = self.db.connect().map_err(|error| error.to_string())?;
        let mut rows = conn
            .query(
                "SELECT c.org_id, c.service_name, c.zone_name, c.dataset, \
                        CASE WHEN s.sync_status = 'active' THEN 1 ELSE 0 END AS self_managed \
                 FROM cloudflare_logpush_connectors c \
                 LEFT JOIN org_tinybird_settings s ON s.org_id = c.org_id \
                 WHERE c.id = ? AND c.secret_hash = ? AND c.enabled = 1 LIMIT 1",
                params![connector_id.to_string(), secret_hash.clone()],
            )
            .await
            .map_err(|error| error.to_string())?;

        let Some(row) = rows.next().await.map_err(|error| error.to_string())? else {
            return Ok(None);
        };

        let self_managed_flag: i64 = row.get(4).map_err(|error| error.to_string())?;

        let resolved = ResolvedCloudflareConnector {
            connector_id: connector_id.to_string(),
            org_id: row.get(0).map_err(|error| error.to_string())?,
            service_name: row.get(1).map_err(|error| error.to_string())?,
            zone_name: row.get(2).map_err(|error| error.to_string())?,
            dataset: row.get(3).map_err(|error| error.to_string())?,
            secret_key_id: secret_hash.chars().take(16).collect(),
            self_managed: self_managed_flag != 0,
        };

        self.cache.insert(cache_key, resolved.clone()).await;

        Ok(Some(resolved))
    }

    async fn record_success(&self, connector_id: &str) -> Result<(), String> {
        let conn = self.db.connect().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE cloudflare_logpush_connectors SET last_received_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            params![
                current_time_millis() as i64,
                current_time_millis() as i64,
                connector_id.to_string()
            ],
        )
        .await
        .map_err(|error| error.to_string())?;

        Ok(())
    }

    async fn record_failure(&self, connector_id: &str, error_message: &str) -> Result<(), String> {
        let conn = self.db.connect().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE cloudflare_logpush_connectors SET last_error = ?, updated_at = ? WHERE id = ?",
            params![
                error_message.to_string(),
                current_time_millis() as i64,
                connector_id.to_string()
            ],
        )
        .await
        .map_err(|error| error.to_string())?;

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

async fn open_database(config: &AppConfig) -> Result<Database, String> {
    let db_url = config
        .db_url
        .clone()
        .unwrap_or_else(|| "file:../api/.data/maple.db".to_string());

    if is_remote_db_url(&db_url) {
        let auth_token = config
            .db_auth_token
            .clone()
            .ok_or_else(|| "MAPLE_DB_AUTH_TOKEN is required for remote MAPLE_DB_URL".to_string())?;

        return Builder::new_remote(db_url, auth_token)
            .build()
            .await
            .map_err(|error| error.to_string());
    }

    let local_path = resolve_local_db_path(&db_url)?;
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create DB directory: {error}"))?;
    }

    Builder::new_local(local_path)
        .build()
        .await
        .map_err(|error| error.to_string())
}

fn is_remote_db_url(db_url: &str) -> bool {
    db_url.starts_with("libsql://")
        || db_url.starts_with("https://")
        || db_url.starts_with("http://")
}

fn resolve_local_db_path(db_url: &str) -> Result<PathBuf, String> {
    if db_url.starts_with("file://") {
        return file_url_to_path(db_url);
    }

    if let Some(raw_path) = db_url.strip_prefix("file:") {
        let path = raw_path.trim();
        if path.is_empty() {
            return Err("Invalid MAPLE_DB_URL file path".to_string());
        }
        return Ok(PathBuf::from(path));
    }

    Ok(PathBuf::from(db_url))
}

fn file_url_to_path(file_url: &str) -> Result<PathBuf, String> {
    let parsed = url::Url::parse(file_url).map_err(|error| format!("Invalid file URL: {error}"))?;
    parsed
        .to_file_path()
        .map_err(|_| "Invalid MAPLE_DB_URL file path".to_string())
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
    fn relative_file_url_resolves_for_local_db_default() {
        let path = resolve_local_db_path("file:../api/.data/maple.db")
            .expect("relative file URL should resolve");
        assert_eq!(path, PathBuf::from("../api/.data/maple.db"));
    }

    #[test]
    fn remote_db_urls_are_detected() {
        assert!(is_remote_db_url("libsql://example.turso.io"));
        assert!(is_remote_db_url("https://example.com"));
        assert!(!is_remote_db_url("file:../api/.data/maple.db"));
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
        let (endpoint, pool) = select_forward_endpoint(
            "http://shared:4318",
            Some("http://self-managed:4318"),
            true,
        );
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

    async fn in_memory_db() -> Arc<Database> {
        // libsql's local builder doesn't expose an in-memory mode directly, so
        // use a uniquely-named temp file. The file is removed by the OS on
        // process exit (tests use nextest/cargo test's sandbox by default).
        let path = std::env::temp_dir().join(format!(
            "maple-ingest-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Builder::new_local(&path)
            .build()
            .await
            .expect("libsql builder should open temp db");
        let conn = db.connect().expect("db should connect");
        conn.execute_batch(
            r#"
            CREATE TABLE org_ingest_keys (
                org_id TEXT NOT NULL,
                public_key_hash TEXT,
                private_key_hash TEXT
            );
            CREATE TABLE org_tinybird_settings (
                org_id TEXT PRIMARY KEY,
                sync_status TEXT NOT NULL
            );
            "#,
        )
        .await
        .expect("schema should apply");
        Arc::new(db)
    }

    fn make_resolver(db: Arc<Database>) -> IngestKeyResolver {
        IngestKeyResolver {
            db,
            lookup_hmac_key: "test-hmac-key".to_string(),
            cache: Cache::builder()
                .time_to_live(Duration::from_secs(60))
                .max_capacity(16)
                .build(),
        }
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_false_when_no_settings_row() {
        let db = in_memory_db().await;
        let resolver = make_resolver(Arc::clone(&db));

        let raw_key = "maple_sk_test_shared";
        let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO org_ingest_keys (org_id, private_key_hash) VALUES (?, ?)",
                params!["org_shared".to_string(), hash.clone()],
            )
            .await
            .unwrap();

        let resolved = resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_shared");
        assert!(!resolved.self_managed);
    }

    #[tokio::test]
    async fn resolve_ingest_key_returns_self_managed_true_when_active_settings_row() {
        let db = in_memory_db().await;
        let resolver = make_resolver(Arc::clone(&db));

        let raw_key = "maple_sk_test_byo";
        let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO org_ingest_keys (org_id, private_key_hash) VALUES (?, ?)",
            params!["org_byo".to_string(), hash.clone()],
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO org_tinybird_settings (org_id, sync_status) VALUES (?, 'active')",
            params!["org_byo".to_string()],
        )
        .await
        .unwrap();

        let resolved = resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert_eq!(resolved.org_id, "org_byo");
        assert!(resolved.self_managed);
    }

    #[tokio::test]
    async fn resolve_ingest_key_treats_non_active_settings_as_not_self_managed() {
        // Rows in 'error' / 'out_of_sync' must not route — the customer
        // Tinybird may be broken, so stay on the shared pool until sync
        // recovers.
        let db = in_memory_db().await;
        let resolver = make_resolver(Arc::clone(&db));

        let raw_key = "maple_sk_test_broken";
        let hash = hash_ingest_key(raw_key, "test-hmac-key").unwrap();
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO org_ingest_keys (org_id, private_key_hash) VALUES (?, ?)",
            params!["org_broken".to_string(), hash.clone()],
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO org_tinybird_settings (org_id, sync_status) VALUES (?, 'error')",
            params!["org_broken".to_string()],
        )
        .await
        .unwrap();

        let resolved = resolver
            .resolve_ingest_key(raw_key)
            .await
            .expect("resolve should succeed")
            .expect("key should be found");

        assert!(!resolved.self_managed);
    }
}
