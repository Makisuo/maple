use std::time::Duration;

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use maple_ingest::ai_session::{classify_span, stamp_trace_request, SpanView};
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::{
    collector::trace::v1::ExportTraceServiceRequest,
    trace::v1::{ResourceSpans, ScopeSpans, Span},
};

fn kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    }
}

fn attrs(pairs: &[(&str, &str)]) -> Vec<KeyValue> {
    pairs.iter().map(|(k, v)| kv(k, v)).collect()
}

fn http_span_attrs() -> Vec<KeyValue> {
    attrs(&[
        ("http.request.method", "POST"),
        ("http.route", "/api/checkout"),
        ("url.path", "/api/checkout"),
        ("url.scheme", "https"),
        ("server.address", "api.example.com"),
        ("server.port", "443"),
        ("network.protocol.version", "1.1"),
        ("user_agent.original", "Mozilla/5.0"),
        ("http.response.status_code", "200"),
        ("http.request.body.size", "1042"),
        ("http.response.body.size", "2318"),
        ("client.address", "203.0.113.7"),
    ])
}

fn db_span_attrs() -> Vec<KeyValue> {
    attrs(&[
        ("db.system", "postgresql"),
        ("db.namespace", "maple"),
        ("db.operation.name", "SELECT"),
        ("db.query.text", "SELECT * FROM orders WHERE org_id = $1"),
        ("server.address", "db.internal"),
        ("server.port", "5432"),
        ("db.response.returned_rows", "42"),
        ("network.peer.address", "10.0.0.12"),
    ])
}

fn wide_span_attrs() -> Vec<KeyValue> {
    let mut out = http_span_attrs();
    for i in 0..18 {
        out.push(kv(&format!("app.custom.dimension_{i}"), "value"));
    }
    out
}

fn mastra_span_attrs() -> Vec<KeyValue> {
    attrs(&[
        ("mastra.span.type", "agent_run"),
        ("mastra.agent.id", "support-agent"),
        ("gen_ai.conversation.id", "conv-8f14e45f"),
        ("gen_ai.request.model", "claude-opus-5"),
        ("gen_ai.usage.input_tokens", "1042"),
        ("gen_ai.usage.output_tokens", "231"),
        ("mastra.metadata.runId", "run-77"),
        ("mastra.metadata.resourceId", "user-9"),
    ])
}

fn vercel_span_attrs() -> Vec<KeyValue> {
    attrs(&[
        ("operation.name", "ai.generateText"),
        ("ai.operationId", "ai.generateText"),
        ("ai.model.id", "gpt-5"),
        ("ai.model.provider", "openai"),
        ("ai.prompt.messages", "[{\"role\":\"user\"}]"),
        ("ai.response.text", "hello"),
        ("ai.response.finishReason", "stop"),
        ("ai.settings.maxRetries", "2"),
        ("ai.settings.context.eve.session.id", "sess-42"),
        ("ai.usage.promptTokens", "812"),
        ("ai.usage.completionTokens", "96"),
        ("ai.response.id", "resp-1"),
        ("ai.response.model", "gpt-5"),
        ("ai.response.timestamp", "2026-08-18T12:00:00Z"),
        ("gen_ai.system", "openai"),
        ("gen_ai.request.model", "gpt-5"),
        ("gen_ai.response.model", "gpt-5"),
        ("gen_ai.usage.input_tokens", "812"),
        ("gen_ai.usage.output_tokens", "96"),
        ("ai.telemetry.functionId", "chat"),
    ])
}

fn claude_span_attrs() -> Vec<KeyValue> {
    attrs(&[
        ("span.type", "llm_request"),
        ("session.id", "sess-cc-1"),
        ("model", "claude-opus-5"),
        ("input_tokens", "1200"),
        ("output_tokens", "300"),
    ])
}

fn service_resource(name: &str) -> Vec<KeyValue> {
    attrs(&[
        ("service.name", name),
        ("service.version", "1.4.2"),
        ("telemetry.sdk.name", "opentelemetry"),
        ("telemetry.sdk.language", "nodejs"),
        ("telemetry.sdk.version", "1.30.0"),
        ("deployment.environment.name", "production"),
        ("maple_org_id", "org_bench"),
    ])
}

fn bench_classify(c: &mut Criterion) {
    let mut group = c.benchmark_group("ai_classify");
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(2));

    let resource = service_resource("checkout");
    let cases: Vec<(&str, &str, &str, Vec<KeyValue>)> = vec![
        (
            "non_ai_http_12_attrs",
            "@opentelemetry/instrumentation-http",
            "POST /api/checkout",
            http_span_attrs(),
        ),
        (
            "non_ai_db_8_attrs",
            "@opentelemetry/instrumentation-pg",
            "SELECT maple.orders",
            db_span_attrs(),
        ),
        (
            "non_ai_wide_30_attrs",
            "@opentelemetry/instrumentation-http",
            "POST /api/checkout",
            wide_span_attrs(),
        ),
        ("mastra_ai_span", "@mastra/otel-exporter", "agent.generate", mastra_span_attrs()),
        ("vercel_ai_span_20_attrs", "ai", "ai.generateText", vercel_span_attrs()),
        (
            "claude_ai_span",
            "com.anthropic.claude_code",
            "claude_code.llm_request",
            claude_span_attrs(),
        ),
    ];

    for (name, scope_name, span_name, span_attrs) in &cases {
        group.bench_function(*name, |b| {
            b.iter(|| {
                black_box(classify_span(&SpanView {
                    scope_name: black_box(scope_name),
                    span_name: black_box(span_name),
                    span_attrs: black_box(span_attrs),
                    resource_attrs: black_box(&resource),
                    events: &[],
                }))
            })
        });
    }
    group.finish();
}

/// The number that has to stay under 50ns/span: a realistic batch (95% non-AI
/// HTTP/DB spans, 5% AI spans) through the full decode-time stamping path,
/// measured per span.
fn bench_stamp_request(c: &mut Criterion) {
    let mut group = c.benchmark_group("ai_stamp");
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(3));

    let scope = |name: &str| {
        Some(InstrumentationScope {
            name: name.to_string(),
            ..Default::default()
        })
    };
    let span = |name: &str, attributes: Vec<KeyValue>| Span {
        name: name.to_string(),
        attributes,
        ..Default::default()
    };

    let mut scope_spans = vec![
        ScopeSpans {
            scope: scope("@opentelemetry/instrumentation-http"),
            spans: (0..60).map(|_| span("POST /api/checkout", http_span_attrs())).collect(),
            ..Default::default()
        },
        ScopeSpans {
            scope: scope("@opentelemetry/instrumentation-pg"),
            spans: (0..35).map(|_| span("SELECT maple.orders", db_span_attrs())).collect(),
            ..Default::default()
        },
        ScopeSpans {
            scope: scope("ai"),
            spans: (0..3).map(|_| span("ai.generateText", vercel_span_attrs())).collect(),
            ..Default::default()
        },
        ScopeSpans {
            scope: scope("@mastra/otel-exporter"),
            spans: (0..2).map(|_| span("agent.generate", mastra_span_attrs())).collect(),
            ..Default::default()
        },
    ];
    let span_count: usize = scope_spans.iter().map(|ss| ss.spans.len()).sum();
    let request = ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: service_resource("checkout"),
                ..Default::default()
            }),
            scope_spans: std::mem::take(&mut scope_spans),
            ..Default::default()
        }],
    };

    group.throughput(Throughput::Elements(span_count as u64));
    group.bench_function("mixed_100_spans_95pct_non_ai", |b| {
        b.iter_batched(
            || request.clone(),
            |mut request| {
                stamp_trace_request(&mut request);
                black_box(request)
            },
            criterion::BatchSize::LargeInput,
        )
    });
    group.finish();
}

criterion_group!(benches, bench_classify, bench_stamp_request);
criterion_main!(benches);
