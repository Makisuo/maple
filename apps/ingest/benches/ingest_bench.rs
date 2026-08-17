use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use flate2::read::GzDecoder;
use maple_ingest::ai_classifier::ResourceContext;
use maple_ingest::ai_registry::registry;
use maple_ingest::telemetry::{
    AiClassificationSettings, ClickHouseBreakerConfig, DatasourceNames, SamplingPolicy,
    TelemetryPipeline, TinybirdConfig,
};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::{
    collector::trace::v1::ExportTraceServiceRequest,
    trace::v1::{span, ResourceSpans, ScopeSpans, Span},
};
use reqwest::Client;
use tokio::runtime::Runtime;

#[derive(Clone, Default)]
struct FakeTinybirdState {
    rows: Arc<AtomicU64>,
}

struct BenchFixture {
    pipeline: TelemetryPipeline,
    logs: ExportLogsServiceRequest,
    traces: ExportTraceServiceRequest,
    queue_dir: PathBuf,
}

fn bench_ingest_accept(c: &mut Criterion) {
    let runtime = Runtime::new().expect("tokio runtime");
    let fixture = runtime.block_on(BenchFixture::new());
    let mut group = c.benchmark_group("ingest_accept");
    group.sample_size(10);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(2));

    group.bench_function("logs_10_rows_wal_ack", |b| {
        b.to_async(&runtime).iter(|| async {
            black_box(
                fixture
                    .pipeline
                    .accept_logs("org_bench", black_box(&fixture.logs))
                    .await
                    .expect("accept logs"),
            );
        });
    });

    group.bench_function("traces_10_spans_wal_ack", |b| {
        b.to_async(&runtime).iter(|| async {
            black_box(
                fixture
                    .pipeline
                    .accept_traces(
                        "org_bench",
                        black_box(&fixture.traces),
                        &SamplingPolicy::default(),
                        &[],
                        // This group measures WAL ack; classification cost is
                        // the `ai_classifier` group's job.
                        &AiClassificationSettings::disabled(),
                    )
                    .await
                    .expect("accept traces"),
            );
        });
    });

    group.finish();
    let _ = std::fs::remove_dir_all(&fixture.queue_dir);
}

/// Classifier cost in isolation. Budget: ~50 ns/span mean, ~300 ns worst case on a
/// 60-attribute AI span, out of ~500 ns total per span. Pure CPU — no pipeline, no
/// I/O.
fn bench_ai_classifier(c: &mut Criterion) {
    let registry = registry();
    let mut group = c.benchmark_group("ai_classifier");

    // Typical non-AI server span: nothing survives the prefilter.
    let http_resource = vec![
        string_kv("service.name", "checkout-api"),
        string_kv("telemetry.sdk.name", "opentelemetry"),
        string_kv("telemetry.sdk.language", "nodejs"),
        string_kv("deployment.environment.name", "production"),
    ];
    let http_scope = InstrumentationScope {
        name: "@opentelemetry/instrumentation-http".to_string(),
        version: "0.57.0".to_string(),
        ..Default::default()
    };
    let http_attributes: Vec<KeyValue> = [
        ("http.request.method", "POST"),
        ("url.path", "/v2/checkout"),
        ("url.scheme", "https"),
        ("server.address", "api.example.com"),
        ("http.response.status_code", "200"),
    ]
    .iter()
    .map(|(k, v)| string_kv(k, v))
    .collect();
    let http_attributes_15: Vec<KeyValue> = http_attributes
        .iter()
        .cloned()
        .chain((0..10).map(|i| string_kv(&format!("net.peer.detail_{i}"), "value")))
        .collect();

    // A fat AI span: 60 attributes, most of them registry-referenced.
    let ai_resource = vec![
        string_kv("service.name", "spring-ai-trace-capture"),
        string_kv("telemetry.sdk.name", "opentelemetry"),
    ];
    let ai_scope = InstrumentationScope {
        name: "org.springframework.boot".to_string(),
        version: "4.1.0".to_string(),
        ..Default::default()
    };
    let mut ai_attributes = vec![
        string_kv("spring.ai.kind", "chat_client"),
        string_kv("gen_ai.system", "spring_ai"),
        string_kv("gen_ai.operation.name", "chat"),
        string_kv("gen_ai.request.model", "gpt-4o-mini"),
        string_kv("gen_ai.response.model", "gpt-4o-mini-2024-07-18"),
        string_kv("session.id", "sess-4f9c1b2e-77aa-4c31-9d0e-3b8f1a6d2c55"),
    ];
    ai_attributes.extend((0..54).map(|i| {
        string_kv(
            &format!("gen_ai.request.parameter_{i}"),
            "a moderately long attribute value, as vendors emit",
        )
    }));

    group.bench_function("non_ai_span_5_attrs", |b| {
        let resource = ResourceContext::new(registry, &http_resource);
        let scope = resource.scope(Some(&http_scope), "");
        b.iter(|| black_box(scope.classify_span("POST /v2/checkout", black_box(&http_attributes))));
    });

    group.bench_function("non_ai_span_15_attrs", |b| {
        let resource = ResourceContext::new(registry, &http_resource);
        let scope = resource.scope(Some(&http_scope), "");
        b.iter(|| {
            black_box(scope.classify_span("POST /v2/checkout", black_box(&http_attributes_15)))
        });
    });

    group.bench_function("ai_span_60_attrs", |b| {
        let resource = ResourceContext::new(registry, &ai_resource);
        let scope = resource.scope(Some(&ai_scope), "");
        b.iter(|| black_box(scope.classify_span("chat_client", black_box(&ai_attributes))));
    });

    // Per-batch hoisting: one ResourceSpans + one ScopeSpans. Amortized over the
    // spans of that scope, so it is charged once per scope, not per span.
    // Same span shape, but the 54 filler keys start with a byte no registry key or
    // prefix begins with, so the prefilter rejects them on the byte screen alone.
    // The delta against `ai_span_60_attrs` is the cost of hashing keys that survive
    // the screen and miss the exact-key map — the classifier's main hotspot today.
    let mut ai_attributes_screened = ai_attributes[..6].to_vec();
    ai_attributes_screened.extend((0..54).map(|i| {
        string_kv(
            &format!("zzz.request.parameter_{i}"),
            "a moderately long attribute value, as vendors emit",
        )
    }));
    group.bench_function("ai_span_60_attrs_screened_out", |b| {
        let resource = ResourceContext::new(registry, &ai_resource);
        let scope = resource.scope(Some(&ai_scope), "");
        b.iter(|| {
            black_box(scope.classify_span("chat_client", black_box(&ai_attributes_screened)))
        });
    });

    group.bench_function("hoist_resource_and_scope", |b| {
        b.iter(|| {
            let resource = ResourceContext::new(registry, black_box(&ai_resource));
            black_box(resource.scope(Some(&ai_scope), ""));
        });
    });

    // The realistic unit: hoist once, then classify a trace's worth of spans.
    // Divide by 20 for the effective per-span cost including hoisting.
    group.bench_function("hoisted_scope_20_ai_spans", |b| {
        b.iter(|| {
            let resource = ResourceContext::new(registry, black_box(&ai_resource));
            let scope = resource.scope(Some(&ai_scope), "");
            for _ in 0..20 {
                black_box(scope.classify_span("chat_client", black_box(&ai_attributes)));
            }
        });
    });

    group.finish();
}

impl BenchFixture {
    async fn new() -> Self {
        let fake_state = FakeTinybirdState::default();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("fake Tinybird listener");
        let addr = listener.local_addr().expect("fake Tinybird addr");
        let app = Router::new()
            .route("/v0/events", post(fake_tinybird_import))
            .with_state(fake_state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let queue_dir = unique_temp_dir("maple-ingest-bench-wal");
        let pipeline = TelemetryPipeline::new(
            TinybirdConfig {
                endpoint: format!("http://{addr}"),
                token: "bench-token".to_string(),
                queue_dir: queue_dir.clone(),
                // Effectively uncapped: this benchmark measures accept latency
                // (encode + WAL append + ack), not back-pressure. A single org
                // hashes to a single shard, so every frame lands in one lane and
                // the lane only truncates when the exporter's cursor fully catches
                // up with the appender — which it never does under sustained
                // bench load. With a finite cap, a fast runner simply writes more
                // bytes than a slow one and the run fails with "WAL lane is full".
                queue_max_bytes: u64::MAX,
                org_queue_max_bytes: u64::MAX,
                queue_channel_capacity: 100_000,
                wal_shards: 4,
                batch_max_rows: 5_000,
                batch_max_bytes: 4 * 1024 * 1024,
                batch_max_wait: Duration::from_millis(10),
                export_concurrency_per_shard: 1,
                export_max_attempts: 20,
                clickhouse_export_timeout: Duration::from_secs(5),
                clickhouse_breaker: ClickHouseBreakerConfig::default(),
                datasources: DatasourceNames::defaults(),
                datasource_session_replays: "session_replays".to_string(),
                datasource_session_replay_events: "session_replay_events".to_string(),
                datasource_session_events: "session_events".to_string(),
            },
            Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("http client"),
        )
        .await
        .expect("pipeline");

        Self {
            pipeline,
            logs: build_logs(10),
            traces: build_traces(10),
            queue_dir,
        }
    }
}

async fn fake_tinybird_import(
    State(state): State<FakeTinybirdState>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> StatusCode {
    if !query.contains_key("name") {
        return StatusCode::BAD_REQUEST;
    }
    let mut decoded = String::new();
    if GzDecoder::new(&body[..])
        .read_to_string(&mut decoded)
        .is_err()
    {
        return StatusCode::BAD_REQUEST;
    }
    state.rows.fetch_add(
        decoded.lines().filter(|line| !line.is_empty()).count() as u64,
        Ordering::Relaxed,
    );
    StatusCode::OK
}

fn build_logs(count: usize) -> ExportLogsServiceRequest {
    let records = (0..count)
        .map(|index| LogRecord {
            time_unix_nano: 1_700_000_000_000_000_000 + index as u64,
            observed_time_unix_nano: 1_700_000_000_000_000_000 + index as u64,
            severity_number: 9,
            severity_text: "INFO".to_string(),
            body: Some(AnyValue {
                value: Some(any_value::Value::StringValue(format!(
                    "benchmark log {index}"
                ))),
            }),
            attributes: vec![string_kv("benchmark", "true")],
            ..Default::default()
        })
        .collect();

    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: vec![string_kv("service.name", "ingest-bench")],
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: "criterion".to_string(),
                    version: "1".to_string(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                log_records: records,
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn build_traces(count: usize) -> ExportTraceServiceRequest {
    let spans = (0..count)
        .map(|index| Span {
            trace_id: vec![index as u8 + 1; 16],
            span_id: vec![index as u8 + 1; 8],
            name: format!("benchmark span {index}"),
            kind: span::SpanKind::Server as i32,
            start_time_unix_nano: 1_700_000_000_000_000_000 + index as u64,
            end_time_unix_nano: 1_700_000_000_010_000_000 + index as u64,
            attributes: vec![string_kv("benchmark", "true")],
            ..Default::default()
        })
        .collect();

    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![string_kv("service.name", "ingest-bench")],
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            scope_spans: vec![ScopeSpans {
                scope: Some(InstrumentationScope {
                    name: "criterion".to_string(),
                    version: "1".to_string(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                spans,
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn string_kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    }
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}

criterion_group!(benches, bench_ingest_accept, bench_ai_classifier);
criterion_main!(benches);
