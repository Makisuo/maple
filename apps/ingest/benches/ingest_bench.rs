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
use maple_ingest::telemetry::{SamplingPolicy, TelemetryPipeline, TinybirdConfig};
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
                    )
                    .await
                    .expect("accept traces"),
            );
        });
    });

    group.finish();
    let _ = std::fs::remove_dir_all(&fixture.queue_dir);
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
                queue_max_bytes: 1024 * 1024 * 1024,
                org_queue_max_bytes: 1024 * 1024 * 1024,
                queue_channel_capacity: 100_000,
                wal_shards: 4,
                batch_max_rows: 5_000,
                batch_max_bytes: 4 * 1024 * 1024,
                batch_max_wait: Duration::from_millis(10),
                export_concurrency_per_shard: 1,
                export_max_attempts: 20,
                datasource_traces: "traces".to_string(),
                datasource_logs: "logs".to_string(),
                datasource_metrics_sum: "metrics_sum".to_string(),
                datasource_metrics_gauge: "metrics_gauge".to_string(),
                datasource_metrics_histogram: "metrics_histogram".to_string(),
                datasource_metrics_exponential_histogram: "metrics_exponential_histogram"
                    .to_string(),
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

criterion_group!(benches, bench_ingest_accept);
criterion_main!(benches);
