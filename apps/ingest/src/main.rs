mod autumn;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use autumn::AutumnTracker;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::header::{HeaderName, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use libsql::{params, Builder, Database};
use metrics::{counter, gauge, histogram};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message;
use reqwest::Client;
use serde::Serialize;
use sha2::Sha256;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, error, info, warn, Span};

const INGEST_SOURCE: &str = "maple-ingest-gateway";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct AppConfig {
    port: u16,
    forward_endpoint: String,
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

#[derive(Clone)]
struct IngestKeyResolver {
    db: Arc<Database>,
    lookup_hmac_key: String,
}

struct AppState {
    config: AppConfig,
    http_client: Client,
    resolver: IngestKeyResolver,
    metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    autumn_tracker: Option<AutumnTracker>,
}

#[derive(Clone)]
struct ResolvedIngestKey {
    org_id: String,
    key_type: IngestKeyType,
    key_id: String,
}

#[derive(Clone, Copy)]
enum IngestKeyType {
    Public,
    Private,
}

impl IngestKeyType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
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

    let http_client = match Client::builder().timeout(config.forward_timeout).build() {
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

    let state = Arc::new(AppState {
        resolver: IngestKeyResolver {
            db: Arc::new(database),
            lookup_hmac_key: config.lookup_hmac_key.clone(),
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
                duration_ms,
                item_count,
                "Request processed"
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

    histogram!("ingest_request_body_bytes", "signal" => signal.path())
        .record(body.len() as f64);

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
    let enrich_result =
        enrich_payload(signal, payload_format, &decoded_payload, &resolved_key).map_err(|e| {
            warn!(
                format = payload_format.label(),
                "Invalid OTLP payload"
            );
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
    let outbound_body =
        encode_payload(&enrich_result.payload, content_encoding.as_deref()).map_err(|e| {
            (e, "encode")
        })?;

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

    Ok((response, enrich_result.item_count, resolved_key.org_id.clone(), decoded_bytes))
}

fn extract_ingest_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()) {
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
            Ok(EnrichResult { payload: request.encode_to_vec(), item_count })
        }
        (Signal::Logs, PayloadFormat::Protobuf) => {
            let mut request = ExportLogsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs protobuf payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            let item_count = count_log_items(&request);
            Ok(EnrichResult { payload: request.encode_to_vec(), item_count })
        }
        (Signal::Metrics, PayloadFormat::Protobuf) => {
            let mut request = ExportMetricsServiceRequest::decode(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics protobuf payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            let item_count = count_metric_items(&request);
            Ok(EnrichResult { payload: request.encode_to_vec(), item_count })
        }
        (Signal::Traces, PayloadFormat::Json) => {
            let mut request: ExportTraceServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP traces JSON payload"))?;
            enrich_trace_request(&mut request, resolved_key);
            let item_count = count_trace_items(&request);
            let payload = serde_json::to_vec(&request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize traces payload"))?;
            Ok(EnrichResult { payload, item_count })
        }
        (Signal::Logs, PayloadFormat::Json) => {
            let mut request: ExportLogsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP logs JSON payload"))?;
            enrich_logs_request(&mut request, resolved_key);
            let item_count = count_log_items(&request);
            let payload = serde_json::to_vec(&request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize logs payload"))?;
            Ok(EnrichResult { payload, item_count })
        }
        (Signal::Metrics, PayloadFormat::Json) => {
            let mut request: ExportMetricsServiceRequest = serde_json::from_slice(payload)
                .map_err(|_| ApiError::bad_request("Invalid OTLP metrics JSON payload"))?;
            enrich_metrics_request(&mut request, resolved_key);
            let item_count = count_metric_items(&request);
            let payload = serde_json::to_vec(&request)
                .map_err(|_| ApiError::service_unavailable("Failed to serialize metrics payload"))?;
            Ok(EnrichResult { payload, item_count })
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
        let resource = resource_metric.resource.get_or_insert_with(Resource::default);
        enrich_resource_attributes(&mut resource.attributes, resolved_key);
    }
}

fn enrich_resource_attributes(attributes: &mut Vec<KeyValue>, resolved_key: &ResolvedIngestKey) {
    attributes.retain(|attribute| {
        let key = attribute.key.as_str();
        key != "org_id" && key != "maple_org_id"
    });

    upsert_string_attribute(attributes, "maple_org_id", &resolved_key.org_id);
    upsert_string_attribute(attributes, "maple_ingest_key_type", resolved_key.key_type.as_str());
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

async fn forward_to_collector(
    state: &AppState,
    signal: Signal,
    content_type: &str,
    content_encoding: Option<&str>,
    body: Vec<u8>,
    resolved_key: &ResolvedIngestKey,
) -> Result<Response, ApiError> {
    let url = format!("{}/v1/{}", state.config.forward_endpoint, signal.path());
    let outbound_bytes = body.len();

    debug!(url = %url, outbound_bytes, "Forwarding to collector");

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
        histogram!("ingest_forward_duration_seconds", "signal" => signal.path())
            .record(forward_duration.as_secs_f64());
        counter!("ingest_forward_responses_total", "signal" => signal.path(), "upstream_status" => "error")
            .increment(1);
        error!(
            error = %error,
            signal = signal.path(),
            org_id = %resolved_key.org_id,
            key_id = %resolved_key.key_id,
            url = %url,
            "Collector forwarding failed"
        );
        ApiError::service_unavailable("Telemetry backend unavailable")
    })?;

    let forward_duration = forward_start.elapsed();
    histogram!("ingest_forward_duration_seconds", "signal" => signal.path())
        .record(forward_duration.as_secs_f64());

    let upstream_status_code = response.status().as_u16();
    let status_bucket = match upstream_status_code {
        200..=299 => "2xx",
        400..=499 => "4xx",
        500..=599 => "5xx",
        _ => "other",
    };
    counter!("ingest_forward_responses_total", "signal" => signal.path(), "upstream_status" => status_bucket)
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
        return Err(ApiError::service_unavailable("Telemetry backend unavailable"));
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
        let key_type = infer_ingest_key_type(raw_key);
        let Some(key_type) = key_type else {
            return Ok(None);
        };

        let key_hash = hash_ingest_key(raw_key, &self.lookup_hmac_key)?;
        let hash_column = match key_type {
            IngestKeyType::Public => "public_key_hash",
            IngestKeyType::Private => "private_key_hash",
        };

        let query = format!(
            "SELECT org_id FROM org_ingest_keys WHERE {hash_column} = ? LIMIT 1"
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

        Ok(Some(ResolvedIngestKey {
            org_id,
            key_type,
            key_id: key_hash.chars().take(16).collect(),
        }))
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
}
