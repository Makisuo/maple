use opentelemetry::KeyValue;
use opentelemetry_sdk::Resource;
use std::env;
use tracing::field::Empty;
use tracing::{info_span, Span};

pub struct ResourceConfig {
    pub service_name: &'static str,
    pub service_namespace: &'static str,
    pub service_version: &'static str,
    pub service_instance_id: String,
    pub deployment_env: String,
    pub internal_org_id: String,
}

pub fn build_resource(cfg: ResourceConfig) -> Resource {
    let mut attrs = vec![
        KeyValue::new("service.name", cfg.service_name),
        KeyValue::new("service.namespace", cfg.service_namespace),
        KeyValue::new("service.version", cfg.service_version),
        KeyValue::new("service.instance.id", cfg.service_instance_id),
        KeyValue::new("deployment.environment.name", cfg.deployment_env.clone()),
        // Dual-emit the legacy `deployment.environment` key — every Tinybird MV
        // (service_overview_spans_mv, service_map_*_mv, error_*_mv,
        // logs_aggregates_hourly_mv, service_platforms_hourly_mv) still pre-extracts
        // ResourceAttributes['deployment.environment'] at write time. Drop only
        // after those MVs migrate to coalesce() both keys.
        KeyValue::new("deployment.environment", cfg.deployment_env),
        KeyValue::new("process.runtime.name", "rust"),
        KeyValue::new("process.runtime.version", rustc_version()),
        KeyValue::new("os.type", os_type()),
        KeyValue::new("host.arch", host_arch()),
        KeyValue::new("maple.sdk.type", "server"),
        KeyValue::new("maple_org_id", cfg.internal_org_id),
    ];
    // vcs.* semconv: link telemetry back to source. URL is overridable for
    // forks; revision is best-effort from the deploy platform's env (never
    // shells out to git at runtime).
    attrs.push(KeyValue::new(
        "vcs.repository.url.full",
        env::var("VCS_REPOSITORY_URL")
            .unwrap_or_else(|_| "https://github.com/Makisuo/maple".to_string()),
    ));
    if let Some(revision) = detect_head_revision() {
        attrs.push(KeyValue::new("vcs.ref.head.revision", revision));
    }
    attrs.extend(detect_platform());
    Resource::builder().with_attributes(attrs).build()
}

/// Commit SHA of the running build, from the deploy platform's env vars —
/// mirrors lib/effect-sdk/src/server/resource.ts (`COMMIT_SHA` chain).
fn detect_head_revision() -> Option<String> {
    [
        "COMMIT_SHA",
        "RAILWAY_GIT_COMMIT_SHA",
        "RENDER_GIT_COMMIT",
        "GITHUB_SHA",
    ]
    .iter()
    .find_map(|key| env::var(key).ok().filter(|v| !v.is_empty()))
}

/// Mirrors lib/effect-sdk/src/server/platform.ts platform detection — first
/// match wins. Returns the cloud.{provider,platform,region} (and faas.* / k8s.*
/// where applicable) attribute set for the runtime environment.
fn detect_platform() -> Vec<KeyValue> {
    if env::var("CF_VERSION_METADATA").is_ok() || env::var("WORKERS_CI").is_ok() {
        return vec![
            KeyValue::new("cloud.provider", "cloudflare"),
            KeyValue::new("cloud.platform", "cloudflare.workers"),
        ];
    }
    if let Ok(fn_name) = env::var("AWS_LAMBDA_FUNCTION_NAME") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "aws"),
            KeyValue::new("cloud.platform", "aws_lambda"),
            KeyValue::new("faas.name", fn_name),
        ];
        if let Ok(region) = env::var("AWS_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(version) = env::var("AWS_LAMBDA_FUNCTION_VERSION") {
            attrs.push(KeyValue::new("faas.version", version));
        }
        if let Ok(instance) = env::var("AWS_LAMBDA_LOG_STREAM_NAME") {
            attrs.push(KeyValue::new("faas.instance", instance));
        }
        return attrs;
    }
    if env::var("RAILWAY_ENVIRONMENT_NAME").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "railway"),
            KeyValue::new("cloud.platform", "railway"),
        ];
        if let Ok(replica) = env::var("RAILWAY_REPLICA_ID") {
            attrs.push(KeyValue::new("faas.instance", replica));
        }
        if let Ok(region) = env::var("RAILWAY_REPLICA_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        return attrs;
    }
    if env::var("VERCEL").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "vercel"),
            KeyValue::new("cloud.platform", "vercel"),
        ];
        if let Ok(region) = env::var("VERCEL_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(deployment) = env::var("VERCEL_DEPLOYMENT_ID") {
            attrs.push(KeyValue::new("faas.instance", deployment));
        }
        return attrs;
    }
    if let Ok(service) = env::var("K_SERVICE") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "gcp"),
            KeyValue::new("cloud.platform", "gcp_cloud_run"),
            KeyValue::new("faas.name", service),
        ];
        if let Ok(revision) = env::var("K_REVISION") {
            attrs.push(KeyValue::new("faas.version", revision));
        }
        if let Ok(region) = env::var("CLOUD_RUN_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        return attrs;
    }
    if env::var("RENDER").is_ok() {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "render"),
            KeyValue::new("cloud.platform", "render"),
        ];
        if let Ok(instance) = env::var("RENDER_INSTANCE_ID") {
            attrs.push(KeyValue::new("faas.instance", instance));
        }
        return attrs;
    }
    if let Ok(app) = env::var("FLY_APP_NAME") {
        let mut attrs = vec![
            KeyValue::new("cloud.provider", "fly"),
            KeyValue::new("cloud.platform", "fly"),
            KeyValue::new("faas.name", app),
        ];
        if let Ok(region) = env::var("FLY_REGION") {
            attrs.push(KeyValue::new("cloud.region", region));
        }
        if let Ok(machine) = env::var("FLY_MACHINE_ID") {
            attrs.push(KeyValue::new("faas.instance", machine));
        }
        return attrs;
    }
    if env::var("KUBERNETES_SERVICE_HOST").is_ok() {
        let mut attrs = vec![KeyValue::new("cloud.platform", "k8s")];
        if let Ok(cluster) = env::var("K8S_CLUSTER_NAME") {
            attrs.push(KeyValue::new("k8s.cluster.name", cluster));
        }
        if let Ok(pod) = env::var("K8S_POD_NAME") {
            attrs.push(KeyValue::new("k8s.pod.name", pod));
        }
        if let Ok(deployment) = env::var("K8S_DEPLOYMENT_NAME") {
            attrs.push(KeyValue::new("k8s.deployment.name", deployment));
        }
        return attrs;
    }
    Vec::new()
}

fn os_type() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "x86" => "x86",
        "aarch64" => "arm64",
        other => other,
    }
}

fn rustc_version() -> &'static str {
    option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("unknown")
}

/// Does this rejection mean the caller lost telemetry it believed it had sent?
///
/// This is the distinction that matters operationally, and it is *not* the same
/// as the 4xx/5xx split:
///
/// * **Caller-fault** (`auth`, `payload_too_large`, `throttle`, `unsupported_media`)
///   — the sender is misconfigured, over quota, or being shed. Expected, usually
///   self-inflicted, and high-volume: a rotated key or a 429 storm must not page
///   anyone. These stay `Ok`.
/// * **Data loss** (`decode`, `enrich`, `bad_request`) — an undecodable body or
///   an invalid OTLP payload. The sender is healthy, believes it is shipping
///   telemetry, and is silently getting none of it stored. That is an outage for
///   that customer, and it is the gateway's problem whether the cause is our
///   strictness or their encoder.
///
/// Classifying the second group as `Ok` is how a bug that rejected 99.2% of one
/// org's logs for over 24h sat behind a 0% error rate: every dashboard counts
/// `StatusCode='Error'`, and by the old rule there was nothing to count. Payload
/// rejections are `Error` now. A healthy exporter produces none, so this reports
/// real breakage rather than re-flooding the dashboards that the 4xx/5xx rule was
/// written to protect.
///
/// Accepts both `error.type` vocabularies, since both reach the spans: the
/// per-stage labels from `handle_signal_inner` (`decode`, `enrich`) and the
/// status-derived kinds from `ApiError::error_kind` (`bad_request`, used by the
/// replay/session handlers).
///
/// `payload_too_large` is deliberately *not* here. It also drops data, but it is
/// a bounded, self-announcing config problem — the sender is told exactly what
/// happened and can batch smaller — rather than a healthy exporter shipping into
/// a void.
pub fn rejection_loses_data(error_type: &str) -> bool {
    matches!(error_type, "bad_request" | "decode" | "enrich")
}

/// Record a failed stage on `span`.
///
/// `error.type` and `maple.ingest.reject_reason` are recorded unconditionally so
/// the failure is always searchable and always carries its reason. The span
/// status follows the same rule the server span uses (`otel_status_for_rejection`
/// in main.rs): `Error` for a server fault or a rejection that loses the caller's
/// data (see `rejection_loses_data`), `Ok` for a rejection of the caller itself —
/// a bad key or a per-org throttle — because error dashboards count
/// `StatusCode='Error'` and would otherwise be flooded by things working exactly
/// as designed.
///
/// The reason is its own attribute rather than `otel.status_description` because
/// the two cannot coexist: tracing-opentelemetry turns a description into
/// `Status::error(detail)`, and an `Ok` written next replaces it wholesale — so
/// on a rejection left `Ok`, the reason exported as an empty `StatusMessage` and
/// the span said only *that* a payload was refused, never *why*.
pub fn record_stage_error(span: &Span, error_type: &str, detail: &str, server_fault: bool) {
    span.record("error.type", error_type);
    span.record("maple.ingest.reject_reason", detail);
    if server_fault || rejection_loses_data(error_type) {
        // One write, not two: `otel.status_description` already resolves to
        // `Status::error(detail)`. Also writing `otel.status_code = "Error"`
        // would contend for the same slot, and which of the two survives
        // depends on write order and on the SDK's `Ok > Error > Unset`
        // comparison — for two `Error`s, on how their descriptions sort.
        span.record("otel.status_description", detail);
    } else {
        span.record("otel.status_code", "Ok");
    }
}

/// Downstream-forward client-kind span. `peer_service` is the canonical name of
/// the destination service as it appears in the service map (see
/// `.agents/skills/maple-telemetry-conventions/rules/service-map-attribution.md`
/// for the registry). `url.full` and `server.address` are recorded later inside
/// `forward_to_collector` because the URL is computed there.
pub fn forward_client_span(
    peer_service: &'static str,
    body_size: usize,
    signal_path: &'static str,
) -> Span {
    info_span!(
        "forward",
        otel.name = "POST",
        otel.kind = "client",
        otel.status_code = Empty,
        "peer.service" = peer_service,
        "http.request.method" = "POST",
        "http.request.body.size" = body_size,
        "http.response.status_code" = Empty,
        "url.full" = Empty,
        "server.address" = Empty,
        "error.type" = Empty,
        "maple.signal" = signal_path,
        "maple.ingest.upstream_pool" = Empty,
    )
}

/// OTLP-over-gRPC server span. The tonic server has no tracing layer, so without
/// this the gRPC path's `postgres.query` / `forward` / `ingest.*` spans become
/// disconnected roots. Mirrors the HTTP `ingest` span, with rpc semconv in place
/// of http.
pub fn grpc_server_span(rpc_service: &'static str, signal_path: &'static str) -> Span {
    info_span!(
        "ingest.grpc",
        otel.name = %format_args!("{rpc_service}/Export"),
        otel.kind = "server",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "rpc.system" = "grpc",
        "rpc.service" = rpc_service,
        "rpc.method" = "Export",
        "rpc.grpc.status_code" = Empty,
        "error.type" = Empty,
        "maple.signal" = signal_path,
        "maple.org_id" = Empty,
        "maple.ingest.key_type" = Empty,
        "maple.ingest.destination" = Empty,
    )
}

/// Ingest-key resolution. Wraps the moka lookup and, on a miss, the HMAC hash
/// plus the PSBouncer roundtrip — so `postgres.query` nests under this rather
/// than hanging directly off the server span.
pub fn auth_internal_span() -> Span {
    info_span!(
        "ingest.authenticate",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.ingest.cache_hit" = Empty,
        "maple.ingest.key_type" = Empty,
        "maple.ingest.key_id" = Empty,
        "maple.org_id" = Empty,
        "maple.ingest.self_managed" = Empty,
        "maple.ingest.clickhouse_ready" = Empty,
    )
}

/// Autumn entitlement gate. Parent of the `autumn.check` client span, which only
/// fires on an entitlement-cache miss.
pub fn entitlement_internal_span(signal_path: &'static str) -> Span {
    info_span!(
        "ingest.entitlement_check",
        otel.kind = "internal",
        "maple.signal" = signal_path,
        "maple.ingest.cache_hit" = Empty,
        "maple.billing.allowed" = Empty,
    )
}

/// Request-body decompression (gzip/deflate).
pub fn decode_internal_span(content_encoding: &str, body_size: usize) -> Span {
    info_span!(
        "ingest.decode",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.ingest.content_encoding" = content_encoding,
        "http.request.body.size" = body_size,
        "maple.ingest.decoded_bytes" = Empty,
    )
}

/// Protobuf/JSON decode plus resource-attribute enrichment.
pub fn parse_internal_span(payload_format: &'static str, signal_path: &'static str) -> Span {
    info_span!(
        "ingest.parse",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.ingest.payload_format" = payload_format,
        "maple.signal" = signal_path,
        "maple.ingest.item_count" = Empty,
    )
}

/// Native pipeline accept — row encoding, backpressure, quota and WAL commit.
/// Mirrors the `ingest_native_accept_duration_seconds` histogram boundary.
pub fn accept_internal_span(signal_path: &'static str, destination: &'static str) -> Span {
    info_span!(
        "ingest.accept",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.signal" = signal_path,
        "maple.ingest.destination" = destination,
        "maple.ingest.native_rows" = Empty,
        "maple.ingest.sampled_dropped" = Empty,
    )
}

/// OTLP → NDJSON row encoding, including trace sampling and attribute mapping.
/// Synchronous CPU work, so callers enter this rather than instrumenting.
pub fn encode_rows_internal_span(signal_path: &'static str) -> Span {
    info_span!(
        "ingest.encode_rows",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.signal" = signal_path,
        "maple.ingest.row_count" = Empty,
        "maple.ingest.frame_count" = Empty,
        "maple.ingest.sampled_dropped" = Empty,
        // Encoded NDJSON size. Compare against `ingest.decode`'s
        // `maple.ingest.decoded_bytes` to spot encode amplification.
        "maple.ingest.payload_bytes" = Empty,
    )
}

/// Backpressure reservation, per-org queue quota, and the durable WAL append
/// (the `fsync` runs on a blocking thread, but the span wraps the await so its
/// wall time is still captured). No single shard attribute: one commit can fan
/// out across shards, so `maple.ingest.shard`/`lane` are only recorded for the
/// frame that failed, which is the one you need when debugging.
pub fn wal_commit_internal_span(destination: &'static str) -> Span {
    info_span!(
        "ingest.wal_commit",
        otel.kind = "internal",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "maple.ingest.destination" = destination,
        "maple.ingest.frame_count" = Empty,
        // How many frames were durably committed before a mid-loop rejection.
        // A commit is not atomic, so on a 429 this is the difference between
        // "nothing landed" and "half the payload landed".
        "maple.ingest.frames_committed" = Empty,
        "maple.ingest.queued_bytes" = Empty,
        // Only set on the failing frame.
        "maple.ingest.shard" = Empty,
        "maple.ingest.lane" = Empty,
        "maple.ingest.datasource" = Empty,
        // Only set on a quota rejection, so you can see how far over the cap
        // the org was rather than just that it was over.
        "maple.ingest.org_queue_bytes" = Empty,
        "maple.ingest.org_queue_limit_bytes" = Empty,
    )
}

/// One export attempt against Tinybird or ClickHouse.
///
/// One span per *attempt*, not per batch, so a retry storm is visible as a
/// sequence rather than one long opaque span. `maple.ingest.outcome` is the
/// field to filter on: `delivered` | `retry` | `dropped` | `shed_circuit_open`.
/// Only a terminal `dropped` sets `Error` — a retry that later succeeds is not
/// a failure of the batch, and marking every attempt `Error` would turn a
/// self-healing blip into an error-rate spike.
pub fn export_client_span(
    span_name: &'static str,
    peer_service: &'static str,
    datasource: &str,
    attempt: u32,
    rows: usize,
    body_size: usize,
) -> Span {
    info_span!(
        "export",
        otel.name = span_name,
        otel.kind = "client",
        otel.status_code = Empty,
        otel.status_description = Empty,
        "maple.ingest.reject_reason" = Empty,
        "error.type" = Empty,
        "http.request.method" = "POST",
        "http.request.body.size" = body_size,
        "http.response.status_code" = Empty,
        "peer.service" = peer_service,
        // Recorded by the caller: for ClickHouse it is only known after the
        // per-org target resolves.
        "server.address" = Empty,
        "db.system.name" = Empty,
        "db.operation.name" = Empty,
        "db.namespace" = Empty,
        "maple.ingest.datasource" = datasource,
        "maple.ingest.attempt" = attempt,
        "maple.ingest.row_count" = rows,
        "maple.ingest.outcome" = Empty,
        "maple.org_id" = Empty,
    )
}

/// Per-org sampling-policy and attribute-mapping cache lookups. Parent of
/// `postgres.query` when either 30s TTL expires.
pub fn resolve_config_internal_span() -> Span {
    info_span!(
        "ingest.resolve_config",
        otel.kind = "internal",
        "maple.ingest.sampling_ratio" = Empty,
        "maple.ingest.attribute_mapping_count" = Empty,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_attr<'a>(resource: &'a Resource, key: &str) -> Option<String> {
        resource
            .iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, v)| v.to_string())
    }

    /// The stage spans classify identically to the server span, so a payload
    /// rejection is `Error` at every level rather than only on the outermost one.
    #[test]
    fn stage_spans_treat_payload_rejections_as_data_loss() {
        assert!(rejection_loses_data("decode"));
        assert!(rejection_loses_data("enrich"));
        assert!(rejection_loses_data("bad_request"));

        // Caller-fault stages stay Ok so they cannot flood the error dashboards.
        assert!(!rejection_loses_data("auth"));
        assert!(!rejection_loses_data("forward"));
        // A genuine server fault is Error via the `server_fault` flag instead,
        // which is how `auth_unavailable` (503) is reported.
        assert!(!rejection_loses_data("auth_unavailable"));
    }

    /// `tracing` only accepts `record()` for fields declared when the span was
    /// constructed; recording anything else is a silent no-op. That is not a
    /// compile error and produces no warning, so every deferred field has to be
    /// asserted here against the site that fills it in.
    fn assert_declares(span: &Span, fields: &[&str]) {
        for field in fields {
            assert!(
                span.has_field(*field),
                "span is missing field `{field}`; Span::record for it would silently no-op"
            );
        }
    }

    #[test]
    fn accept_span_declares_fields_recorded_by_the_native_path() {
        // Filled in by accept_native_decoded_payload (main.rs). These two were
        // previously recorded on the server span, which never declared them —
        // the attributes silently never appeared on any span.
        assert_declares(
            &accept_internal_span("traces", "clickhouse"),
            &[
                "maple.ingest.native_rows",
                "maple.ingest.sampled_dropped",
                "maple.ingest.destination",
                "maple.signal",
            ],
        );
    }

    #[test]
    fn auth_span_declares_fields_recorded_by_the_resolver() {
        // `maple.ingest.cache_hit` is recorded from inside
        // IngestKeyResolver::resolve_ingest_key; the rest by handle_signal_inner.
        assert_declares(
            &auth_internal_span(),
            &[
                "maple.ingest.cache_hit",
                "maple.ingest.key_type",
                "maple.ingest.key_id",
                "maple.org_id",
                "maple.ingest.self_managed",
                "maple.ingest.clickhouse_ready",
            ],
        );
    }

    /// Every span that `record_stage_error` can be called on must declare its
    /// fields, or a failure records nothing at all — the worst case, since that
    /// is exactly when the span is being read.
    #[test]
    fn every_fallible_span_declares_the_stage_error_fields() {
        let fields = [
            "error.type",
            "otel.status_code",
            "otel.status_description",
            "maple.ingest.reject_reason",
        ];
        for span in [
            auth_internal_span(),
            decode_internal_span("gzip", 1),
            parse_internal_span("protobuf", "traces"),
            accept_internal_span("traces", "clickhouse"),
            encode_rows_internal_span("traces"),
            wal_commit_internal_span("tinybird"),
            export_client_span("tinybird.export", "tinybird", "spans", 0, 1, 1),
            grpc_server_span("svc", "traces"),
        ] {
            assert_declares(&span, &fields);
        }
    }

    #[test]
    fn wal_commit_span_declares_its_rejection_diagnostics() {
        // Recorded by commit_frames / record_failing_frame / reserve_org_queue_bytes.
        assert_declares(
            &wal_commit_internal_span("clickhouse"),
            &[
                "maple.ingest.frames_committed",
                "maple.ingest.shard",
                "maple.ingest.lane",
                "maple.ingest.datasource",
                "maple.ingest.org_queue_bytes",
                "maple.ingest.org_queue_limit_bytes",
            ],
        );
    }

    #[test]
    fn export_span_declares_fields_recorded_by_both_destinations() {
        // post_tinybird records the http/outcome fields; post_clickhouse also
        // records the db.* and org fields via clickhouse_export_span.
        assert_declares(
            &export_client_span("clickhouse.export", "clickhouse", "spans", 2, 10, 100),
            &[
                "http.response.status_code",
                "server.address",
                "maple.ingest.outcome",
                "maple.org_id",
                "db.system.name",
                "db.operation.name",
                "db.namespace",
            ],
        );
    }

    #[test]
    fn entitlement_span_declares_fields_recorded_by_the_billing_gate() {
        // `maple.ingest.cache_hit` is recorded from inside
        // AutumnEntitlements::is_allowed.
        assert_declares(
            &entitlement_internal_span("traces"),
            &["maple.ingest.cache_hit", "maple.billing.allowed"],
        );
    }

    #[test]
    fn payload_spans_declare_their_deferred_fields() {
        assert_declares(
            &decode_internal_span("gzip", 1024),
            &["maple.ingest.decoded_bytes"],
        );
        assert_declares(
            &parse_internal_span("protobuf", "traces"),
            &["maple.ingest.item_count"],
        );
        assert_declares(
            &resolve_config_internal_span(),
            &[
                "maple.ingest.sampling_ratio",
                "maple.ingest.attribute_mapping_count",
            ],
        );
    }

    #[test]
    fn pipeline_spans_declare_fields_recorded_by_telemetry() {
        // record_encode_stats and commit_frames (telemetry.rs).
        assert_declares(
            &encode_rows_internal_span("traces"),
            &[
                "maple.ingest.row_count",
                "maple.ingest.frame_count",
                "maple.ingest.sampled_dropped",
            ],
        );
        assert_declares(
            &wal_commit_internal_span("tinybird"),
            &["maple.ingest.frame_count", "maple.ingest.queued_bytes"],
        );
    }

    #[test]
    fn grpc_span_declares_fields_recorded_by_the_tonic_services() {
        // record_grpc_identity and record_grpc_outcome (main.rs).
        assert_declares(
            &grpc_server_span(
                "opentelemetry.proto.collector.trace.v1.TraceService",
                "traces",
            ),
            &[
                "maple.org_id",
                "maple.ingest.key_type",
                "maple.ingest.destination",
                "rpc.grpc.status_code",
                "error.type",
                "otel.status_code",
                "otel.status_description",
            ],
        );
    }

    #[test]
    fn build_resource_sets_runtime_and_sdk_type() {
        let resource = build_resource(ResourceConfig {
            service_name: "ingest",
            service_namespace: "ingest",
            service_version: "0.0.0",
            service_instance_id: "test-instance".to_string(),
            deployment_env: "test".to_string(),
            internal_org_id: "internal".to_string(),
        });
        assert_eq!(
            find_attr(&resource, "process.runtime.name").as_deref(),
            Some("rust")
        );
        assert_eq!(
            find_attr(&resource, "maple.sdk.type").as_deref(),
            Some("server")
        );
        assert_eq!(
            find_attr(&resource, "service.name").as_deref(),
            Some("ingest")
        );
        assert_eq!(
            find_attr(&resource, "service.namespace").as_deref(),
            Some("ingest")
        );
        // Dual-emit deployment env
        assert_eq!(
            find_attr(&resource, "deployment.environment.name").as_deref(),
            Some("test")
        );
        assert_eq!(
            find_attr(&resource, "deployment.environment").as_deref(),
            Some("test")
        );
    }
}
