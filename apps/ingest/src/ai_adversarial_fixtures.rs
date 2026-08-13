//! Adversarial classification fixtures: hand-built hostile spans, driven through
//! the **real** row writer.
//!
//! # What this is
//!
//! `fixtures/classification/` is real wire data — what the vendors actually emit.
//! This module is the opposite corner: a deterministic corpus of spans nobody
//! sent, constructed to sit on the classifier's edges. Typed and valueless
//! `AnyValue`s, present-but-empty values, duplicate keys, near-miss key spellings,
//! astral-plane and NUL-bearing UTF-8, 64 KiB values that spill out of the inline
//! attribute path, one span carrying six vendors' evidence at once, and the full
//! session-state ladder per vendor.
//!
//! Every case runs through [`super::encode_traces`] — the same function the ingest
//! request path calls, with the classification flag on — so the fixture is a golden
//! for the classifier **as the write path invokes it**, not for the classifier
//! called in isolation. The generator additionally asserts, per span, that the
//! `ai_vendor` / `ai_session_key_state` / `ai_session_key_hash` / `ai_rules_version`
//! the row writer emitted equal what a direct [`ResourceContext`] call produces, and
//! that the hash equals `cityhash102::city_hash64` over the winning key — so the row
//! writer and the classifier cannot drift apart silently.
//!
//! The checked-in artifact (`fixtures/adversarial/adversarial-spans.jsonl`) carries
//! the verdict per case, plus the hex of the raw winning session-key value, which is
//! never stored on a row. That hex is what
//! `packages/domain/src/ai/hash-alignment.clickhouse.e2e.test.ts` feeds to a real
//! ClickHouse to prove `cityHash64` there equals `city_hash64` here — the hash
//! contract the read path's "recompute the column in SQL" claim rests on.
//!
//! # What this does not prove
//!
//! Nothing about the trace-capture reference evaluator (`scripts/verify-seed.ts`),
//! which is a third implementation: it renders kvlist values in insertion order and
//! `JSON.stringify`s bytes, where `any_value_string` sorts kvlist keys (the row Map
//! is a `serde_json::Map`) and hex-encodes bytes. "The fixture agrees with the seed
//! verifier" is not a claim made here.
//!
//! # Determinism
//!
//! No clock, no RNG, no environment. Receive time, span start times, trace/span ids
//! and every attribute value are constants or derived from a fixed counter, so
//! regenerating the artifact is byte-stable; [`fixture_is_reproducible`] pins that,
//! which is what turns it into a golden: any rule change that moves a verdict fails
//! `cargo test` with the moved line.
//!
//! # Regeneration
//!
//! ```sh
//! ADVERSARIAL_FIXTURE_OUT=apps/ingest/fixtures/adversarial/adversarial-spans.jsonl \
//!   cargo test -p maple-ingest --lib write_adversarial_fixture -- --ignored --nocapture
//! ```

use std::collections::BTreeSet;

use opentelemetry_proto::tonic::common::v1::{ArrayValue, InstrumentationScope, KeyValueList};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans};

use super::*;
use crate::ai_classifier::ResourceContext;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/// Batch receive time, epoch seconds — 2023-11-14 22:13:20 UTC. Fixed so
/// `ai_rollup_hour` never depends on when the fixture was generated.
const RECEIVE_SECS: i64 = 1_700_000_000;
/// Every span starts at the receive second, inside the rollup clamp window.
const START_NANOS: u64 = RECEIVE_SECS as u64 * 1_000_000_000;

const ORG_ID: &str = "org_adversarial";

// ---------------------------------------------------------------------------
// attribute helpers
// ---------------------------------------------------------------------------

fn any(value: any_value::Value) -> Option<AnyValue> {
    Some(AnyValue { value: Some(value) })
}

/// String-valued attribute.
fn s(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::StringValue(value.to_string())),
    }
}

fn int(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::IntValue(value)),
    }
}

fn double(key: &str, value: f64) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::DoubleValue(value)),
    }
}

fn boolean(key: &str, value: bool) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::BoolValue(value)),
    }
}

fn bytes(key: &str, value: &[u8]) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::BytesValue(value.to_vec())),
    }
}

fn array(key: &str, values: Vec<KeyValue>) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::ArrayValue(ArrayValue {
            values: values.into_iter().filter_map(|kv| kv.value).collect(),
        })),
    }
}

fn kvlist(key: &str, values: Vec<KeyValue>) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: any(any_value::Value::KvlistValue(KeyValueList { values })),
    }
}

/// `AnyValue { value: None }` — a wire-legal "typed nothing".
fn untyped(key: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue { value: None }),
    }
}

/// `KeyValue { value: None }` — the attribute exists, the value field does not.
fn valueless(key: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: None,
    }
}

fn scope(name: &str) -> InstrumentationScope {
    InstrumentationScope {
        name: name.to_string(),
        version: "1.2.3".to_string(),
        attributes: Vec::new(),
        dropped_attributes_count: 0,
    }
}

// ---------------------------------------------------------------------------
// spec model
// ---------------------------------------------------------------------------

/// One span to classify.
struct Case {
    id: String,
    category: &'static str,
    note: String,
    span_name: String,
    attributes: Vec<KeyValue>,
}

fn case(
    category: &'static str,
    id: &str,
    note: &str,
    span_name: &str,
    attributes: Vec<KeyValue>,
) -> Case {
    Case {
        id: id.to_string(),
        category,
        note: note.to_string(),
        span_name: span_name.to_string(),
        attributes,
    }
}

/// A `ResourceSpans`/`ScopeSpans` pair and the spans under it. Groups with more than
/// one case exercise the hoisting path — resource and scope evidence resolved once and
/// shared — which a corpus of singletons would never reach.
struct Group {
    resource: Vec<KeyValue>,
    scope: Option<InstrumentationScope>,
    schema_url: String,
    cases: Vec<Case>,
}

impl Group {
    fn new(scope_name: &str, cases: Vec<Case>) -> Self {
        Self {
            resource: vec![s("service.name", "adversarial-fixture")],
            scope: Some(scope(scope_name)),
            schema_url: String::new(),
            cases,
        }
    }

    fn resource(mut self, attributes: Vec<KeyValue>) -> Self {
        self.resource = attributes;
        self
    }

    fn scope_attrs(mut self, attributes: Vec<KeyValue>) -> Self {
        if let Some(scope) = self.scope.as_mut() {
            scope.attributes = attributes;
        }
        self
    }

    fn scope_version(mut self, version: &str) -> Self {
        if let Some(scope) = self.scope.as_mut() {
            scope.version = version.to_string();
        }
        self
    }

    fn no_scope(mut self) -> Self {
        self.scope = None;
        self
    }

    fn schema_url(mut self, url: &str) -> Self {
        self.schema_url = url.to_string();
        self
    }

}

/// A single-span group — the common shape.
fn one(scope_name: &str, case: Case) -> Group {
    Group::new(scope_name, vec![case])
}

// ---------------------------------------------------------------------------
// the corpus
// ---------------------------------------------------------------------------

/// Neutral scope for spans whose classification must come from attributes alone.
const NEUTRAL_SCOPE: &str = "com.example.app";

fn groups() -> Vec<Group> {
    let mut out = Vec::new();
    out.extend(sufficient_scope_groups());
    out.extend(resource_and_promotion_groups());
    out.extend(attr_only_groups());
    out.extend(cross_vendor_groups());
    out.extend(unknown_tier_groups());
    out.extend(non_ai_groups());
    out.extend(session_state_groups());
    out.extend(typed_value_groups());
    out.extend(present_but_empty_groups());
    out.extend(duplicate_key_groups());
    out.extend(near_miss_groups());
    out.extend(unicode_groups());
    out.extend(oversized_groups());
    out.extend(pseudo_key_groups());
    out.extend(cross_class_groups());
    out
}

/// Every vendor whose scope matcher is `sufficient` — the branch where resource/scope
/// evidence classifies on its own, with no span attribute involved.
fn sufficient_scope_groups() -> Vec<Group> {
    const SCOPES: &[(&str, &str)] = &[
        ("openinference.instrumentation.agno", "agno"),
        ("com.anthropic.claude_code.tracing", "claude_agent_sdk"),
        ("com.anthropic.claude_code.events", "claude_agent_sdk"),
        ("com.anthropic.claude_code", "claude_agent_sdk"),
        ("openinference.instrumentation.crewai", "crewai"),
        ("crewai.telemetry", "crewai"),
        ("openinference.instrumentation.dspy", "dspy"),
        ("@flue/opentelemetry", "flue"),
        ("gcp.vertex.agent", "google_adk"),
        ("haystack", "haystack"),
        ("langsmith", "langchain"),
        ("litellm", "litellm"),
        ("llamaindex.opentelemetry.tracer", "llamaindex"),
        ("@mastra/otel-exporter", "mastra"),
        ("agent_framework", "microsoft_agent_framework"),
        (
            "openinference.instrumentation.openai_agents",
            "openai_agents_sdk",
        ),
        (
            "openinference.instrumentation.openai",
            "openinference-openai",
        ),
        ("pydantic-ai", "pydantic_ai"),
        (
            "semantic_kernel.utils.telemetry.agent_diagnostics.decorators",
            "semantic_kernel",
        ),
        (
            "semantic_kernel.utils.telemetry.model_diagnostics.decorators",
            "semantic_kernel",
        ),
        (
            "semantic_kernel.functions.kernel_function",
            "semantic_kernel",
        ),
        (
            "semantic_kernel.connectors.ai.chat_completion_client_base",
            "semantic_kernel",
        ),
        ("agent_runtime InProcessRuntime", "semantic_kernel"),
        ("openinference.instrumentation.smolagents", "smolagents"),
        ("strands.telemetry.tracer", "strands"),
        // Phase-2 SK1/SK2: the module-path enumeration and the pinned
        // `agent_runtime InProcessRuntime` value became prefix families, so a
        // utils/telemetry refactor and a non-InProcess CoreRuntime still classify.
        (
            "semantic_kernel.utils.telemetry.some_future_module",
            "semantic_kernel",
        ),
        ("agent_runtime SomeOtherRuntime", "semantic_kernel"),
    ];
    SCOPES
        .iter()
        .enumerate()
        .map(|(index, (scope_name, vendor))| {
            Group::new(
                scope_name,
                vec![
                    case(
                        "resolution/sufficient_scope",
                        &format!("sufficient_scope/{vendor}/{index}"),
                        &format!("sufficient scope matcher for {vendor}, no AI attribute at all"),
                        "operation",
                        vec![s("http.route", "/x")],
                    ),
                    case(
                        "resolution/sufficient_scope",
                        &format!("sufficient_scope_hoisted/{vendor}/{index}"),
                        "second span under the same hoisted scope",
                        "operation.two",
                        vec![],
                    ),
                ],
            )
        })
        .collect()
}

/// Insufficient resource/scope matchers: promoted by a same-vendor attr hit, and the
/// same evidence without one (the negative the plan names explicitly).
fn resource_and_promotion_groups() -> Vec<Group> {
    // (label, resource attrs, scope name, promoting attrs)
    let cases: Vec<(&str, Vec<KeyValue>, &str, Vec<KeyValue>)> = vec![
        (
            "spring_ai_scope",
            vec![s("service.name", "spring-app")],
            "org.springframework.boot",
            vec![s("spring.ai.kind", "chat_client")],
        ),
        (
            "vercel_scope_ai",
            vec![s("service.name", "next-app")],
            "ai",
            vec![s("ai.operationId", "ai.generateText")],
        ),
        (
            "vercel_scope_gen_ai",
            vec![s("service.name", "next-app")],
            "gen_ai",
            vec![s("gen_ai.operation.name", "agent_step")],
        ),
        (
            "claude_resource",
            vec![s("service.name", "claude-code")],
            NEUTRAL_SCOPE,
            vec![s("span.type", "interaction")],
        ),
        (
            "litellm_resource",
            vec![s("service.name", "gateway"), s("model_id", "gpt-4o-mini")],
            NEUTRAL_SCOPE,
            vec![s("litellm.call_id", "call-1")],
        ),
        (
            "llamaindex_resource",
            vec![s("service.name", "llamaindex.opentelemetry")],
            NEUTRAL_SCOPE,
            vec![s("llamaindex.run_id", "run-1")],
        ),
        (
            "langchain_resource",
            vec![
                s("service.name", "langgraph-app"),
                s("langsmith.internal_provider", "true"),
            ],
            NEUTRAL_SCOPE,
            vec![s("langsmith.trace.name", "chain")],
        ),
        (
            "effect_ai_resource",
            vec![
                s("service.name", "effect-app"),
                s("telemetry.sdk.name", "@effect/opentelemetry"),
            ],
            NEUTRAL_SCOPE,
            vec![],
        ),
    ];

    let mut out = Vec::new();
    for (label, resource, scope_name, promoting) in cases {
        // effect_ai promotes on span *name*, not an attribute.
        let span_name = if label == "effect_ai_resource" {
            "LanguageModel.generateText"
        } else {
            "op"
        };
        let mut promoted = promoting.clone();
        promoted.push(s("http.route", "/api"));
        out.push(
            Group::new(
                scope_name,
                vec![case(
                    "resolution/insufficient_promoted",
                    &format!("promoted/{label}"),
                    "insufficient resource/scope candidate promoted by a same-vendor hit",
                    span_name,
                    promoted,
                )],
            )
            .resource(resource.clone()),
        );
        out.push(
            Group::new(
                scope_name,
                vec![case(
                    "resolution/insufficient_not_promoted",
                    &format!("not_promoted/{label}"),
                    "same insufficient evidence with nothing to promote it",
                    "POST",
                    vec![s("http.request.method", "POST"), s("http.route", "/api")],
                )],
            )
            .resource(resource),
        );
    }
    out
}

/// Attr-class matchers on their own, under a scope no rule claims.
fn attr_only_groups() -> Vec<Group> {
    let attrs: Vec<(&str, Vec<KeyValue>)> = vec![
        ("agno", vec![s("agno.run.id", "r-1")]),
        ("claude_agent_sdk", vec![s("span.type", "tool.execution")]),
        ("crewai", vec![s("crew_key", "k")]),
        ("crewai_task_key", vec![s("task_key", "research")]),
        (
            "crewai_tool_result",
            vec![s("tool.result_as_answer", "false")],
        ),
        ("crewai_flow", vec![s("flow_name", "f")]),
        ("crewai_flow_node", vec![s("flow.node.id", "n")]),
        ("flue", vec![s("flue.operation.kind", "tool")]),
        (
            "google_adk_prefix",
            vec![s("gcp.vertex.agent.invocation_id", "i-1")],
        ),
        (
            "google_adk_system",
            vec![s("gen_ai.system", "gcp.vertex.agent")],
        ),
        ("haystack", vec![s("haystack.component.name", "retriever")]),
        (
            "langchain_prefix",
            vec![s("langsmith.metadata.thread_id", "t-1")],
        ),
        ("langchain_system", vec![s("gen_ai.system", "langchain")]),
        ("litellm", vec![s("litellm.call_id", "c-1")]),
        ("llamaindex", vec![s("llamaindex.span.kind", "query")]),
        ("mastra", vec![s("mastra.span.type", "agent_run")]),
        (
            "microsoft_provider",
            vec![s("gen_ai.provider.name", "microsoft.agent_framework")],
        ),
        ("microsoft_prefix", vec![s("agent_framework.run.id", "r")]),
        // Phase-2 MS1: the provider fingerprint is a value PREFIX, so the harness
        // subclass's `microsoft.agent_framework.harness` is covered too.
        (
            "microsoft_provider_subclass",
            vec![s("gen_ai.provider.name", "microsoft.agent_framework.harness")],
        ),
        // Phase-2 X4 sweep: `executor.` / `edge_group.` are generic scheduler
        // vocabulary (the class that already burned `workflow.` on 2,037 eve_slack
        // spans), so they classify only alongside the co-emitted `message.*` keys.
        ("microsoft_executor", vec![s("executor.id", "e")]),
        (
            "microsoft_executor_with_message",
            vec![
                s("executor.id", "e"),
                s("executor.type", "AgentExecutor"),
                s("message.type", "ConcurrentRequestMessage"),
            ],
        ),
        (
            "microsoft_edge_group",
            vec![s("edge_group.type", "fan_out")],
        ),
        (
            "microsoft_edge_group_with_message",
            vec![
                s("edge_group.type", "fan_out"),
                s("message.source_id", "dispatcher"),
            ],
        ),
        (
            "microsoft_message_only",
            vec![s("message.type", "ConcurrentResponseMessage")],
        ),
        ("pydantic_ai", vec![s("pydantic_ai.all_messages", "[]")]),
        (
            "pydantic_ai_usage",
            vec![s("gen_ai.aggregated_usage.input_tokens", "12")],
        ),
        // Phase-2 P2: the hardened logfire fallback tier — the 3-way conjunction
        // fires; the queue's 2-conjunct form must NOT (logfire.* is a cross-vendor
        // dialect; without pydantic-unique co-evidence the span stays unknown:genai).
        (
            "pydantic_ai_logfire_conjunction",
            vec![
                s("logfire.json_schema", "{\"type\":\"object\"}"),
                s("gen_ai.operation.name", "chat"),
                s("operation.cost", "0.00013"),
            ],
        ),
        (
            "pydantic_ai_logfire_two_conjuncts_insufficient",
            vec![
                s("logfire.json_schema", "{\"type\":\"object\"}"),
                s("gen_ai.operation.name", "chat"),
            ],
        ),
        // Phase-2 X4: the two-letter `sk.` prefix is gone — only the exact
        // `sk.available_functions` key classifies on scope loss, so a generic
        // `sk.*` app key (Sidekiq, an `sdk` typo) no longer claims the vendor.
        ("semantic_kernel_prefix", vec![s("sk.function.name", "f")]),
        (
            "semantic_kernel_available_functions",
            vec![s("sk.available_functions", "[]")],
        ),
        // Phase-2 clause 5: the non-streaming chat fallback is conjunctive on SK's
        // Python-enum-repr finish_reason; the operation value alone must not fire.
        (
            "semantic_kernel_chat_completions_alone",
            vec![s("gen_ai.operation.name", "chat.completions")],
        ),
        (
            "semantic_kernel_chat_completions_enum_repr",
            vec![
                s("gen_ai.operation.name", "chat.completions"),
                s("gen_ai.response.finish_reason", "FinishReason.TOOL_CALLS"),
            ],
        ),
        (
            "semantic_kernel_chat_completions_semconv_value",
            vec![
                s("gen_ai.operation.name", "chat.completions"),
                s("gen_ai.response.finish_reason", "tool_calls"),
            ],
        ),
        (
            "semantic_kernel_streaming",
            vec![s("gen_ai.operation.name", "chat.streaming_completions")],
        ),
        ("smolagents", vec![s("smolagents.max_steps", "10")]),
        ("spring_ai_prefix", vec![s("spring.ai.kind", "chat_client")]),
        ("spring_ai_system", vec![s("gen_ai.system", "spring_ai")]),
        ("strands_system", vec![s("gen_ai.system", "strands-agents")]),
        (
            "strands_provider",
            vec![s("gen_ai.provider.name", "strands-agents")],
        ),
        // Phase-2 X4 sweep: `event_loop.` is generic async-runtime vocabulary, not a
        // vendor namespace, so it needs generic-AI co-evidence (a vendor-owned guard
        // would collapse the clause into the gen_ai.system one). All 19 corpus carriers
        // have gen_ai.operation.name; an asyncio monitor has none.
        ("strands_event_loop", vec![s("event_loop.cycle_id", "c")]),
        (
            "strands_event_loop_with_operation",
            vec![
                s("event_loop.cycle_id", "c"),
                s("gen_ai.operation.name", "execute_event_loop_cycle"),
            ],
        ),
        (
            "vercel_prefix",
            vec![s("ai.operationId", "ai.generateText")],
        ),
        (
            "vercel_execute_tool",
            vec![s("gen_ai.execute_tool.duration", "1")],
        ),
        (
            "vercel_agent_step",
            vec![s("gen_ai.operation.name", "agent_step")],
        ),
    ];
    let mut out: Vec<Group> = attrs
        .into_iter()
        .map(|(label, attributes)| {
            one(
                NEUTRAL_SCOPE,
                case(
                    "resolution/attr_only",
                    &format!("attr_only/{label}"),
                    "attr-class matcher alone under an unclaimed scope",
                    "op",
                    attributes,
                ),
            )
        })
        .collect();
    // Phase-2 C2 witnesses for claude_agent_sdk's scope-rewritten path: the
    // `claude_code.` span-name fingerprint is conjunctive with span.type
    // co-evidence — with it the span classifies; without it (span names are
    // customer data in other dialects: a crewai crew named "claude_code" yields
    // a span literally named "claude_code.kickoff") the span stays unclaimed.
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/claude_span_name_with_span_type",
            "scope-rewritten claude dialect: claude_code.* name + span.type classifies",
            "claude_code.llm_request",
            vec![s("span.type", "llm_request")],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/claude_span_name_without_span_type",
            "the crewai customer-data hazard: claude_code.-named span without span.type",
            "claude_code.kickoff",
            vec![s("http.route", "/x")],
        ),
    ));
    // Phase-2 effect_ai (queue E1–E3): the 6 ordinary-English Class.method names
    // classify only alongside Effect-ecosystem evidence, the 7 module-path names
    // stay standalone, and the bare-word pair is the guarded rename-proof tier.
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/effect_ai_guarded_name_without_evidence",
            "an ordinary-English Class.method name with no Effect evidence stays unclaimed",
            "Chat.export",
            vec![s("http.route", "/x")],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/effect_ai_strong_name_without_evidence",
            "a module-path name classifies without any Effect evidence (tier 1 unguarded)",
            "EmbeddingModel.embed",
            vec![s("http.route", "/x")],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/effect_ai_bare_words_without_evidence",
            "toolChoice + concurrency alone (renamed spans, no Effect evidence) stay unclaimed",
            "op",
            vec![s("toolChoice", "undefined"), s("concurrency", "undefined")],
        ),
    ));
    out.push(
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "resolution/attr_only",
                "attr_only/effect_ai_bare_words_with_evidence",
                "the E3 rename-proof tier: bare-word pair + the @effect/opentelemetry resource",
                "op",
                vec![s("toolChoice", "undefined"), s("concurrency", "undefined")],
            )],
        )
        .resource(vec![s("telemetry.sdk.name", "@effect/opentelemetry")]),
    );
    // The tier-2 hazard, constructed rather than described: `scope_name ==
    // service.name` is the plain `getTracer(serviceName)` idiom — 100% of the
    // openrouter capture satisfies it — so it must NOT carry an ordinary-English
    // guarded name. The scope here is deliberately NOT Effect-branded; using
    // "effect-ai-user" (as this case did) documents the clause without ever
    // building the false positive it risks.
    out.push(
        Group::new(
            "openrouter",
            vec![case(
                "resolution/attr_only",
                "attr_only/effect_ai_guarded_name_via_scope_is_service",
                "scope.name == service.name is the getTracer idiom, not Effect evidence: unclaimed",
                "Toolkit.handle",
                vec![s("tool", "get_weather")],
            )],
        )
        .resource(vec![s("service.name", "openrouter")]),
    );
    out.push(
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "resolution/attr_only",
                "attr_only/effect_ai_guarded_name_with_effect_resource",
                "the tier-2 guard that survives: a guarded name under the @effect/opentelemetry resource",
                "Toolkit.handle",
                vec![s("tool", "get_weather")],
            )],
        )
        .resource(vec![s("telemetry.sdk.name", "@effect/opentelemetry")]),
    );
    // Phase-2 spring_ai (fix-queue SP1): the tool-less ChatModel fallback is the
    // POSITIVE conjunct `boot scope && gen_ai.system == "openai"`. Naive negation
    // is banned — openrouter carries 1,477 gen_ai.system="openai" spans under its
    // own scope and its FP ceiling is zero vendor claims.
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "resolution/attr_only",
            "attr_only/spring_ai_openai_without_boot_scope",
            "the openrouter trap: gen_ai.system=openai outside the Boot scope is not spring_ai",
            "chat openai/gpt-4o-mini",
            vec![s("gen_ai.system", "openai")],
        ),
    ));
    out.push(one(
        "org.springframework.boot",
        case(
            "resolution/attr_only",
            "attr_only/spring_ai_openai_under_boot_scope",
            "SP1: a tool-less ChatModel span (no spring.ai.* key) under the Boot scope",
            "chat openai/gpt-4o-mini",
            vec![s("gen_ai.system", "openai")],
        ),
    ));
    out.push(one(
        "org.springframework.boot",
        case(
            "resolution/attr_only",
            "attr_only/spring_ai_boot_scope_http_span",
            "the reason the Boot scope is conjunct-only: a plain Micrometer HTTP span",
            "POST",
            vec![s("http.request.method", "POST"), s("uri", "/v1/chat")],
        ),
    ));
    out
}

/// Spans carrying two vendors' evidence at once: the global priority ordering, not a
/// per-candidate probe, decides.
fn cross_vendor_groups() -> Vec<Group> {
    vec![
        Group::new(
            "openinference.instrumentation.openai",
            vec![case(
                "resolution/cross_vendor",
                "cross_vendor/openai_scope_vs_crewai_attr",
                "sufficient scope (band 3xxxx) outranks another vendor's attr hit (2xxxx)",
                "ChatCompletion",
                vec![
                    s("openinference.span.kind", "LLM"),
                    s("task_key", "research"),
                ],
            )],
        ),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "resolution/cross_vendor",
                "cross_vendor/mastra_resource_vs_agno_attr",
                "sufficient *resource* matcher outranks an attr hit",
                "agent.generate",
                vec![s("agno.run.id", "r-1")],
            )],
        )
        .resource(vec![
            s("service.name", "mastra-app"),
            s("telemetry.sdk.name", "@mastra/otel-exporter"),
        ]),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/cross_vendor",
                "cross_vendor/two_attr_bands",
                "two vendors' attr matchers on one span: highest priority wins",
                "op",
                vec![
                    s("spring.ai.kind", "chat_client"),
                    s("mastra.span.type", "llm"),
                ],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/cross_vendor",
                "cross_vendor/vendor_beats_unknown",
                "phase 2 flipped this: vercel's ai. evidence is scope-gated, so under an \
                 unclaimed scope the unknown tier wins (gen_ai.operation.name → unknown:genai)",
                "ai.generateText",
                vec![
                    s("ai.operationId", "ai.generateText"),
                    s("gen_ai.operation.name", "chat"),
                ],
            ),
        ),
        one(
            "org.springframework.boot",
            case(
                "resolution/cross_vendor",
                "cross_vendor/unpromoted_candidate_loses_to_unknown",
                "an unpromoted candidate does not suppress the unknown tier",
                "POST",
                vec![s("gen_ai.operation.name", "chat")],
            ),
        ),
        one(
            "gcp.vertex.agent",
            case(
                "resolution/cross_vendor",
                "cross_vendor/sufficient_scope_with_foreign_system",
                "sufficient scope wins over a conflicting gen_ai.system attr matcher",
                "invocation",
                vec![s("gen_ai.system", "langchain")],
            ),
        ),
    ]
}

fn unknown_tier_groups() -> Vec<Group> {
    vec![
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/genai",
                "present(gen_ai.operation.name)",
                "chat",
                vec![s("gen_ai.operation.name", "chat")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/openinference",
                "present(openinference.span.kind)",
                "call",
                vec![s("openinference.span.kind", "LLM")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/llm_prefix",
                "key_prefix(llm.)",
                "call",
                vec![s("llm.model_name", "gpt-4o")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/traceloop_prefix",
                "key_prefix(traceloop.)",
                "workflow",
                vec![s("traceloop.workflow.name", "w")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/ai_prefix",
                "key_prefix(ai.) outside the AI SDK's ai/gen_ai scopes — reachable since \
                 phase 2 scope-gated vercel's prefix evidence (fix-queue X3)",
                "call",
                vec![s("ai.telemetry.functionId", "f")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/co_occurrence_gate_off",
                "input.value/output.value alone are deliberately not fingerprints",
                "handler",
                vec![s("input.value", "{}"), s("output.value", "{}")],
            ),
        ),
        // S11 (owner decision 2026-08-13): the witness for the clause vercel LOST.
        // Removing a rule leaves nothing behind to fail if it comes back, so the
        // negative is written down: the AI SDK's own hardcoded tracer scope, holding
        // a span with the GenAI-semconv key OTel requires on every such span and no
        // `ai.*` at all, must NOT resolve to `vercel_ai_sdk`. That is exactly eve's
        // default-config `chat` population — 53 corpus spans given up by choice. Its
        // positive twin is `pseudo/scope_name_eq_is_case_sensitive`, the same scope
        // WITH an `ai.*` key, which still classifies.
        one(
            "gen_ai",
            case(
                "resolution/unknown_tier",
                "unknown/genai_in_the_ai_sdk_scope",
                "S11: scope `gen_ai` + gen_ai.operation.name is not vendor evidence — \
                 the conjunct is semconv-required, so the clause reduced to \"a tracer \
                 named gen_ai claims everything inside it\" over customer data",
                "chat openai/gpt-4o-mini",
                vec![s("gen_ai.operation.name", "chat")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/co_occurrence_gate_on",
                "the same generic values with an OpenInference attribute present",
                "handler",
                vec![
                    s("input.value", "{}"),
                    s("openinference.span.kind", "CHAIN"),
                ],
            ),
        ),
        // Phase-2 X1/D-4: the other OpenInference spelling as co-evidence. The
        // ordering inside the tier is what makes this unknown:openinference
        // rather than the unknown:other the bare `llm.` rule would give it.
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/co_occurrence_gate_llm_namespace",
                "generic output.value with the OpenInference llm.* namespace as co-evidence",
                "handler",
                vec![s("output.value", "{}"), s("llm.model_name", "gpt-4o")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/unknown_tier",
                "unknown/priority_between_buckets",
                "genai outranks openinference outranks llm.",
                "call",
                vec![
                    s("gen_ai.operation.name", "chat"),
                    s("openinference.span.kind", "LLM"),
                    s("llm.model_name", "gpt-4o"),
                ],
            ),
        ),
    ]
}

fn non_ai_groups() -> Vec<Group> {
    vec![
        one(
            "@opentelemetry/instrumentation-http",
            case(
                "resolution/non_ai",
                "non_ai/http_server",
                "ordinary HTTP server span",
                "GET /health",
                vec![
                    s("http.request.method", "GET"),
                    s("url.path", "/health"),
                    int("http.response.status_code", 200),
                ],
            ),
        ),
        one(
            "@opentelemetry/instrumentation-pg",
            case(
                "resolution/non_ai",
                "non_ai/db_client",
                "ordinary DB client span",
                "SELECT maple.traces",
                vec![
                    s("db.system.name", "postgresql"),
                    s("db.namespace", "maple"),
                ],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "resolution/non_ai",
                "non_ai/no_attributes",
                "no attributes at all",
                "work",
                vec![],
            ),
        ),
        Group::new(
            "",
            vec![case(
                "resolution/non_ai",
                "non_ai/empty_scope_name",
                "empty scope name",
                "work",
                vec![s("http.route", "/")],
            )],
        ),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "resolution/non_ai",
                "non_ai/no_scope",
                "ScopeSpans with no InstrumentationScope at all",
                "work",
                vec![s("http.route", "/")],
            )],
        )
        .no_scope(),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "resolution/non_ai",
                "non_ai/no_resource",
                "ResourceSpans with no resource attributes",
                "work",
                vec![s("http.route", "/")],
            )],
        )
        .resource(vec![]),
    ]
}

/// The session-state ladder (1..6), per vendor, one span per rung it can reach.
// One `push` per vendor keeps each vendor's ladder a self-contained block with its own
// comment; a single `vec![]` literal would bury the boundaries.
#[allow(clippy::vec_init_then_push)]
fn session_state_groups() -> Vec<Group> {
    let mut out = Vec::new();

    // -- agno: two candidates, authority = AGENT kind or an agno.workflow. key ----
    out.push(Group::new(
        "openinference.instrumentation.agno",
        vec![
            case(
                "session/agno",
                "session/agno/presence_gated_session_id",
                "no AGENT kind, but session.id present — the phase-2 A3 presence branch \
                 makes the session.id candidate authoritative (run.id's stays state 2)",
                "Model.invoke",
                vec![s("agno.run.id", "r-1"), s("session.id", "s-1")],
            ),
            case(
                "session/agno",
                "session/agno/state2_not_authoritative",
                "no AGENT kind, no agno.workflow. key, no session.id — both candidates \
                 report not-authoritative",
                "Model.invoke",
                vec![s("agno.run.id", "r-1")],
            ),
            case(
                "session/agno",
                "session/agno/state3_key_absent",
                "authoritative, neither candidate key present",
                "Agent.run",
                vec![s("openinference.span.kind", "AGENT")],
            ),
            case(
                "session/agno",
                "session/agno/state4_empty",
                "authoritative, session.id present but empty; agno.run.id also empty",
                "Agent.run",
                vec![
                    s("openinference.span.kind", "AGENT"),
                    s("session.id", ""),
                    s("agno.run.id", ""),
                ],
            ),
            case(
                "session/agno",
                "session/agno/state5_run_only",
                "run-granularity candidate only",
                "Agent.run",
                vec![
                    s("openinference.span.kind", "AGENT"),
                    s("agno.run.id", "r-9"),
                ],
            ),
            case(
                "session/agno",
                "session/agno/state6_session",
                "session-granularity candidate resolves; max over candidates",
                "Agent.run",
                vec![
                    s("openinference.span.kind", "AGENT"),
                    s("session.id", "sess-agno"),
                    s("agno.run.id", "r-9"),
                ],
            ),
            case(
                "session/agno",
                "session/agno/state6_via_workflow_prefix",
                "authority via key_prefix(agno.workflow.)",
                "Workflow.run",
                vec![
                    s("agno.workflow.name", "research"),
                    s("session.id", "sess-agno-2"),
                ],
            ),
            case(
                "session/agno",
                "session/agno/state4_empty_wins_over_absent",
                "empty session.id (4) beats absent agno.run.id (3) under max",
                "Agent.run",
                vec![s("openinference.span.kind", "AGENT"), s("session.id", "")],
            ),
        ],
    ));

    // -- claude_agent_sdk: authority = present(span.type) -------------------------
    out.push(Group::new(
        "com.anthropic.claude_code",
        vec![
            case(
                "session/claude_agent_sdk",
                "session/claude/state2",
                "no span.type ⇒ neither candidate is authoritative",
                "claude_code.other",
                vec![s("session.id", "sess-1")],
            ),
            case(
                "session/claude_agent_sdk",
                "session/claude/state3",
                "authoritative, no key",
                "claude_code.interaction",
                vec![s("span.type", "interaction")],
            ),
            case(
                "session/claude_agent_sdk",
                "session/claude/state4",
                "present-but-empty session.id",
                "claude_code.interaction",
                vec![s("span.type", "interaction"), s("session.id", "")],
            ),
            case(
                "session/claude_agent_sdk",
                "session/claude/state5_user_only",
                "user granularity only",
                "claude_code.interaction",
                vec![s("span.type", "interaction"), s("user.id", "u-7")],
            ),
            case(
                "session/claude_agent_sdk",
                "session/claude/state6",
                "session id present and valid",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    s("session.id", "sess-claude"),
                    s("user.id", "u-7"),
                ],
            ),
        ],
    ));

    // -- flue: one ALWAYS candidate, one gated; decoy value 'default' -------------
    out.push(Group::new(
        "@flue/opentelemetry",
        vec![
            case(
                "session/flue",
                "session/flue/state3_always_candidate_absent",
                "the ALWAYS candidate is authoritative but its key is absent",
                "flue.tool",
                vec![s("flue.operation.kind", "tool")],
            ),
            case(
                "session/flue",
                "session/flue/state5_instance",
                "instance granularity resolves at 5",
                "flue.tool",
                vec![
                    s("flue.operation.kind", "tool"),
                    s("flue.instance.id", "inst-7"),
                ],
            ),
            case(
                "session/flue",
                "session/flue/state6_conversation",
                "prompt span with a conversation id",
                "flue.prompt",
                vec![
                    s("flue.operation.kind", "prompt"),
                    s("gen_ai.conversation.id", "conv-3"),
                    s("flue.instance.id", "inst-7"),
                ],
            ),
            case(
                "session/flue",
                "session/flue/state5_decoy_conversation",
                "decoy value 'default' invalidates candidate 1 (4) but instance still resolves (5)",
                "flue.prompt",
                vec![
                    s("flue.operation.kind", "prompt"),
                    s("gen_ai.conversation.id", "default"),
                    s("flue.instance.id", "inst-7"),
                ],
            ),
            case(
                "session/flue",
                "session/flue/state4_decoy_only",
                "decoy conversation id, no instance id ⇒ 4",
                "flue.prompt",
                vec![
                    s("flue.operation.kind", "prompt"),
                    s("gen_ai.conversation.id", "default"),
                ],
            ),
            // Phase-2 F1: a delegate whose operation_start dedup guard missed —
            // kind=prompt AND flue.task.id AND its own SUB-conversation id. The
            // authority rejects it, so it resolves at instance granularity (5)
            // instead of minting a sub-conversation session (6).
            case(
                "session/flue",
                "session/flue/state5_delegate_prompt_rejected",
                "F1: a kind=prompt span carrying flue.task.id is not session-authoritative",
                "flue.prompt",
                vec![
                    s("flue.operation.kind", "prompt"),
                    s("flue.task.id", "task_01KZ"),
                    s("gen_ai.conversation.id", "conv-delegate-9"),
                    s("flue.instance.id", "inst-7"),
                ],
            ),
        ],
    ));

    // -- google_adk: three candidates, disjoint authority populations -------------
    out.push(Group::new(
        "gcp.vertex.agent",
        vec![
            case(
                "session/google_adk",
                "session/adk/state2",
                "none of the three authority predicates hold",
                "internal",
                vec![s("gcp.vertex.agent.session_id", "s-1")],
            ),
            case(
                "session/google_adk",
                "session/adk/state3",
                "authoritative via gen_ai.system, key absent",
                "invocation",
                vec![s("gen_ai.system", "gcp.vertex.agent")],
            ),
            case(
                "session/google_adk",
                "session/adk/state6_via_system",
                "candidate 2 resolves at session granularity",
                "invocation",
                vec![
                    s("gen_ai.system", "gcp.vertex.agent"),
                    s("gcp.vertex.agent.session_id", "s-1"),
                ],
            ),
            case(
                "session/google_adk",
                "session/adk/state6_via_conversation",
                "candidate 1's population: invoke_agent",
                "invoke_agent weather",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s("gen_ai.conversation.id", "c-9"),
                ],
            ),
            case(
                "session/google_adk",
                "session/adk/state6_via_invoke_workflow",
                "phase-2 G2: the adk-schema-v2 root (source-cited, zero corpus spans) \
                 is authoritative for candidate 1",
                "invoke_workflow entrypoint",
                vec![
                    s("gen_ai.operation.name", "invoke_workflow"),
                    s("gen_ai.conversation.id", "c-10"),
                ],
            ),
            case(
                "session/google_adk",
                "session/adk/state5_invocation_run",
                "run-granularity candidate 3 (authority = present(gen_ai.request.model))",
                "generate_content",
                vec![
                    s("gen_ai.request.model", "gemini-2.0-flash"),
                    s("gcp.vertex.agent.invocation_id", "inv-1"),
                ],
            ),
            case(
                "session/google_adk",
                "session/adk/state6_max_unions_disjoint",
                "one candidate at 2, one at 6 — max unions instead of cancelling",
                "generate_content",
                vec![
                    s("gen_ai.operation.name", "generate_content"),
                    s("gen_ai.conversation.id", "c-11"),
                    s("gcp.vertex.agent.invocation_id", "inv-2"),
                ],
            ),
        ],
    ));

    // -- spring_ai: promoted candidate + decoy 'default' --------------------------
    out.push(
        Group::new(
            "org.springframework.boot",
            vec![
                case(
                    "session/spring_ai",
                    "session/spring/state2",
                    "not a chat_client span ⇒ not authoritative",
                    "chat",
                    vec![
                        s("spring.ai.kind", "chat_model"),
                        s("spring.ai.chat.client.conversation.id", "c-1"),
                    ],
                ),
                case(
                    "session/spring_ai",
                    "session/spring/state3",
                    "authoritative, key absent",
                    "chat_client",
                    vec![s("spring.ai.kind", "chat_client")],
                ),
                case(
                    "session/spring_ai",
                    "session/spring/state4_decoy",
                    "the 'default' decoy value",
                    "chat_client",
                    vec![
                        s("spring.ai.kind", "chat_client"),
                        s("spring.ai.chat.client.conversation.id", "default"),
                    ],
                ),
                case(
                    "session/spring_ai",
                    "session/spring/state4_empty",
                    "present-but-empty",
                    "chat_client",
                    vec![
                        s("spring.ai.kind", "chat_client"),
                        s("spring.ai.chat.client.conversation.id", ""),
                    ],
                ),
                case(
                    "session/spring_ai",
                    "session/spring/state6",
                    "resolved",
                    "chat_client",
                    vec![
                        s("spring.ai.kind", "chat_client"),
                        s("spring.ai.chat.client.conversation.id", "conv-42"),
                    ],
                ),
            ],
        )
        .resource(vec![s("service.name", "spring-ai-app")]),
    );

    // -- litellm: two user-granularity candidates, decoys incl. the empty string --
    out.push(Group::new(
        "litellm",
        vec![
            case(
                "session/litellm",
                "session/litellm/state2",
                "no litellm.call_id ⇒ not authoritative",
                "litellm_request",
                vec![s("metadata.user_api_key_user_id", "u-1")],
            ),
            case(
                "session/litellm",
                "session/litellm/state3",
                "authoritative, no key",
                "litellm_request",
                vec![s("litellm.call_id", "c-1")],
            ),
            case(
                "session/litellm",
                "session/litellm/state4_decoy_default_user",
                "'default_user_id' is a decoy value",
                "litellm_request",
                vec![
                    s("litellm.call_id", "c-1"),
                    s("metadata.user_api_key_end_user_id", "default_user_id"),
                ],
            ),
            case(
                "session/litellm",
                "session/litellm/state4_decoy_empty",
                "the empty string is BOTH a non_empty failure and a declared decoy",
                "litellm_request",
                vec![
                    s("litellm.call_id", "c-1"),
                    s("metadata.user_api_key_end_user_id", ""),
                ],
            ),
            case(
                "session/litellm",
                "session/litellm/state5",
                "user granularity resolves at 5, never 6",
                "litellm_request",
                vec![
                    s("litellm.call_id", "c-1"),
                    s("metadata.user_api_key_user_id", "user-77"),
                ],
            ),
        ],
    ));

    // -- langchain: ALWAYS candidate + decoy --------------------------------------
    out.push(Group::new(
        "langsmith",
        vec![
            case(
                "session/langchain",
                "session/langchain/state3",
                "ALWAYS-authoritative candidate with no key",
                "chain",
                vec![s("langsmith.trace.name", "chain")],
            ),
            case(
                "session/langchain",
                "session/langchain/state4_decoy",
                "'default' decoy",
                "chain",
                vec![s("langsmith.metadata.thread_id", "default")],
            ),
            case(
                "session/langchain",
                "session/langchain/state6",
                "resolved thread id",
                "chain",
                vec![s("langsmith.metadata.thread_id", "thread-9")],
            ),
        ],
    ));

    // -- mastra: three candidates at three granularities --------------------------
    out.push(Group::new(
        "@mastra/otel-exporter",
        vec![
            case(
                "session/mastra",
                "session/mastra/state2",
                "no mastra.span.type ⇒ not authoritative",
                "agent.generate",
                vec![s("gen_ai.conversation.id", "c-1")],
            ),
            case(
                "session/mastra",
                "session/mastra/state3",
                "authoritative, no candidate key",
                "agent.generate",
                vec![s("mastra.span.type", "agent_run")],
            ),
            case(
                "session/mastra",
                "session/mastra/state5_run",
                "run granularity",
                "agent.generate",
                vec![
                    s("mastra.span.type", "agent_run"),
                    s("mastra.metadata.runId", "run-1"),
                ],
            ),
            case(
                "session/mastra",
                "session/mastra/state5_user",
                "user granularity",
                "agent.generate",
                vec![
                    s("mastra.span.type", "agent_run"),
                    s("mastra.metadata.resourceId", "res-1"),
                ],
            ),
            case(
                "session/mastra",
                "session/mastra/state6_max",
                "all three candidates resolve; max picks session and the hash follows it",
                "agent.generate",
                vec![
                    s("mastra.span.type", "agent_run"),
                    s("gen_ai.conversation.id", "conv-mastra"),
                    s("mastra.metadata.runId", "run-1"),
                    s("mastra.metadata.resourceId", "res-1"),
                ],
            ),
        ],
    ));

    // -- pydantic_ai --------------------------------------------------------------
    out.push(Group::new(
        "pydantic-ai",
        vec![
            case(
                "session/pydantic_ai",
                "session/pydantic/state2",
                "no gen_ai.operation.name ⇒ not authoritative",
                "agent run",
                vec![s("gen_ai.conversation.id", "c-1")],
            ),
            case(
                "session/pydantic_ai",
                "session/pydantic/state5_call_id",
                "run granularity only",
                "agent run",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s("gen_ai.agent.call.id", "call-1"),
                ],
            ),
            case(
                "session/pydantic_ai",
                "session/pydantic/state6",
                "conversation id at session granularity",
                "agent run",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s("gen_ai.conversation.id", "run-1"),
                    s("pydantic_ai.all_messages", "[]"),
                ],
            ),
            case(
                "session/pydantic_ai",
                "session/pydantic/state5_uuid7_demotion",
                "phase-2 P1: a strict-UUIDv7 conversation id is pydantic's auto-minted \
                 per-run default — value-conditional granularity demotes it to run (5); \
                 the hash still comes from the conversation id (candidate-order tie)",
                "agent run",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s(
                        "gen_ai.conversation.id",
                        "01890a5d-ac96-774b-bcce-b302099a8057",
                    ),
                    s("gen_ai.agent.call.id", "0195e2f1-7d13-7cc0-a583-53c804a45f92"),
                ],
            ),
        ],
    ));

    // -- microsoft_agent_framework: two decoy values ------------------------------
    out.push(Group::new(
        "agent_framework",
        vec![
            case(
                "session/microsoft_agent_framework",
                "session/maf/state2",
                "operation is not invoke_agent",
                "chat",
                vec![s("gen_ai.conversation.id", "c-1")],
            ),
            case(
                "session/microsoft_agent_framework",
                "session/maf/state4_decoy_local_history",
                "'agent_framework_local_history_persistence' decoy",
                "invoke_agent",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s(
                        "gen_ai.conversation.id",
                        "agent_framework_local_history_persistence",
                    ),
                ],
            ),
            case(
                "session/microsoft_agent_framework",
                "session/maf/state4_decoy_unknown",
                "'unknown' decoy",
                "invoke_agent",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s("gen_ai.conversation.id", "unknown"),
                ],
            ),
            case(
                "session/microsoft_agent_framework",
                "session/maf/state6",
                "resolved",
                "invoke_agent",
                vec![
                    s("gen_ai.operation.name", "invoke_agent"),
                    s("gen_ai.conversation.id", "thread_abc"),
                ],
            ),
        ],
    ));

    // -- strands / openai_agents_sdk / smolagents / crewai / dspy / llamaindex ----
    out.push(Group::new(
        "strands.telemetry.tracer",
        vec![
            case(
                "session/strands",
                "session/strands/state2",
                "no gen_ai.system / provider ⇒ not authoritative",
                "Model invoke",
                vec![s("session.id", "s-1")],
            ),
            case(
                "session/strands",
                "session/strands/state6",
                "authoritative via gen_ai.system",
                "Cycle",
                vec![s("gen_ai.system", "strands-agents"), s("session.id", "s-2")],
            ),
            case(
                "session/strands",
                "session/strands/state6_via_provider",
                "authoritative via gen_ai.provider.name",
                "Cycle",
                vec![
                    s("gen_ai.provider.name", "strands-agents"),
                    s("session.id", "s-3"),
                ],
            ),
        ],
    ));
    out.push(Group::new(
        "openinference.instrumentation.openai_agents",
        vec![
            case(
                "session/openai_agents_sdk",
                "session/openai_agents/state2",
                "no openinference.span.kind ⇒ not authoritative",
                "Response",
                vec![s("session.id", "s-1")],
            ),
            case(
                "session/openai_agents_sdk",
                "session/openai_agents/state6_session_id",
                "session.id wins; gen_ai.conversation.id ties at 6 and loses on order",
                "Agent workflow",
                vec![
                    s("openinference.span.kind", "AGENT"),
                    s("session.id", "sess-a"),
                    s("gen_ai.conversation.id", "conv-b"),
                ],
            ),
            case(
                "session/openai_agents_sdk",
                "session/openai_agents/state6_conversation_only",
                "second candidate alone",
                "Agent workflow",
                vec![
                    s("openinference.span.kind", "AGENT"),
                    s("gen_ai.conversation.id", "conv-b"),
                ],
            ),
        ],
    ));
    out.push(Group::new(
        "openinference.instrumentation.smolagents",
        vec![
            case(
                "session/smolagents",
                "session/smolagents/state3",
                "authoritative, no key",
                "CodeAgent.run",
                vec![s("openinference.span.kind", "AGENT")],
            ),
            case(
                "session/smolagents",
                "session/smolagents/state5_user",
                "user granularity only",
                "CodeAgent.run",
                vec![s("openinference.span.kind", "AGENT"), s("user.id", "u-1")],
            ),
        ],
    ));
    out.push(Group::new(
        "openinference.instrumentation.crewai",
        vec![
            case(
                "session/crewai",
                "session/crewai/state3",
                "authority is the scope itself; key absent",
                "Crew.kickoff",
                vec![s("crew_key", "k")],
            ),
            case(
                "session/crewai",
                "session/crewai/state6",
                "resolved",
                "Crew.kickoff",
                vec![s("crew_key", "k"), s("session.id", "sess-crew")],
            ),
        ],
    ));
    out.push(Group::new(
        "openinference.instrumentation.dspy",
        vec![case(
            "session/dspy",
            "session/dspy/state6",
            "scope-gated authority, session granularity",
            "Predict.forward",
            vec![s("session.id", "sess-dspy"), s("user.id", "u-dspy")],
        )],
    ));
    out.push(Group::new(
        "llamaindex.opentelemetry.tracer",
        vec![
            case(
                "session/llamaindex",
                "session/llamaindex/state3",
                "ALWAYS candidate, key absent",
                "query",
                vec![s("llamaindex.span.kind", "query")],
            ),
            case(
                "session/llamaindex",
                "session/llamaindex/state5",
                "run granularity",
                "query",
                vec![s("llamaindex.run_id", "run-3")],
            ),
        ],
    ));

    // -- vendors with no session rules at all ⇒ state 1 ---------------------------
    for (scope_name, label) in [
        ("haystack", "haystack"),
        (
            "semantic_kernel.functions.kernel_function",
            "semantic_kernel",
        ),
        ("ai", "vercel_ai_sdk"),
    ] {
        out.push(one(
            scope_name,
            case(
                "session/no_rules",
                &format!("session/no_rules/{label}"),
                "vendor with zero session candidates ⇒ state 1",
                "op",
                vec![s("ai.operationId", "ai.generateText")],
            ),
        ));
    }
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "session/no_rules",
            "session/no_rules/unknown_bucket",
            "unknown-tier buckets carry no session rules ⇒ state 1",
            "call",
            vec![s("gen_ai.operation.name", "chat"), s("session.id", "s-1")],
        ),
    ));
    out.push(one(
        "effect_ai_scope_is_not_a_thing",
        case(
            "session/no_rules",
            "session/no_rules/effect_ai",
            "effect_ai classifies on span name and has no candidates",
            "LanguageModel.generateText",
            vec![s("gen_ai.operation.name", "chat")],
        ),
    ));

    out
}

/// Typed `AnyValue`s: the canonicalization the alignment contract rests on. Each case
/// pairs a typed value with a rule that reads it, so a canonicalization difference
/// changes the verdict rather than hiding in an unread column.
fn typed_value_groups() -> Vec<Group> {
    let mut out = vec![
        // bool ⇒ "true"/"false", read by langchain's resource matcher.
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "values/typed",
                "typed/bool_true_resource",
                "BoolValue(true) canonicalizes to 'true' for eq()",
                "chain",
                vec![s("langsmith.trace.name", "x")],
            )],
        )
        .resource(vec![
            s("service.name", "lc"),
            boolean("langsmith.internal_provider", true),
        ]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "values/typed",
                "typed/bool_false_resource",
                "BoolValue(false) must NOT satisfy eq(..., 'true')",
                "chain",
                vec![s("http.route", "/x")],
            )],
        )
        .resource(vec![
            s("service.name", "lc"),
            boolean("langsmith.internal_provider", false),
        ]),
    ];

    // Typed session-key values: the hash is taken over the canonical string.
    let typed_keys: Vec<(&str, KeyValue, &str)> = vec![
        (
            "int",
            int("session.id", 4_294_967_296),
            "IntValue beyond 2^32 as a session key",
        ),
        (
            "int_negative",
            int("session.id", i64::MIN),
            "IntValue::MIN as a session key",
        ),
        (
            "double",
            double("session.id", 1.5),
            "DoubleValue canonicalizes with Rust's float formatting",
        ),
        (
            "double_integral",
            double("session.id", 42.0),
            "42.0 renders as '42', not '42.0'",
        ),
        (
            "bool",
            boolean("session.id", true),
            "BoolValue as a session key",
        ),
        (
            "bytes",
            bytes("session.id", &[0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
            "BytesValue hex-encodes (the row writer's rule, not JSON.stringify)",
        ),
        (
            "array",
            array(
                "session.id",
                vec![s("", "a"), int("", 2), boolean("", false)],
            ),
            "ArrayValue renders as a JSON array of canonical strings",
        ),
        (
            "kvlist",
            kvlist(
                "session.id",
                vec![s("z", "last"), s("a", "first"), int("m", 7)],
            ),
            "KvlistValue renders as a JSON object; the row Map's key order is what SQL sees",
        ),
        (
            "nested",
            array(
                "session.id",
                vec![kvlist("", vec![s("k", "v")]), array("", vec![int("", 1)])],
            ),
            "nested array/kvlist",
        ),
        (
            "untyped",
            untyped("session.id"),
            "AnyValue with no value ⇒ empty string ⇒ state 4",
        ),
        (
            "valueless",
            valueless("session.id"),
            "KeyValue with no AnyValue ⇒ empty string ⇒ state 4",
        ),
    ];
    for (label, key_value, note) in typed_keys {
        out.push(Group::new(
            "com.anthropic.claude_code",
            vec![case(
                "values/typed",
                &format!("typed/session_key_{label}"),
                note,
                "claude_code.interaction",
                vec![s("span.type", "interaction"), key_value],
            )],
        ));
    }

    // Typed values on keys compared by eq(): a canonicalization slip flips the vendor.
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "values/typed",
            "typed/eq_int_vs_string",
            "IntValue on gen_ai.system cannot match any vendor's string literal",
            "op",
            vec![int("gen_ai.system", 42)],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "values/typed",
            "typed/eq_kvlist_on_matched_key",
            "KvlistValue on an eq()-compared key",
            "op",
            vec![kvlist("gen_ai.system", vec![s("spring_ai", "yes")])],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "values/typed",
            "typed/present_only_key_is_type_blind",
            "present() ignores the value's type entirely",
            "op",
            vec![bytes("gen_ai.operation.name", &[0x00, 0xff])],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "values/typed",
            "typed/array_on_prefix_key",
            "key_prefix() ignores values; the key alone decides",
            "op",
            vec![array("llm.token_counts", vec![int("", 1), int("", 2)])],
        ),
    ));
    out
}

/// Present-but-empty: the algebra's load-bearing subtlety. `mapContains` sees it,
/// `!= ''` would not.
fn present_but_empty_groups() -> Vec<Group> {
    vec![
        one(
            NEUTRAL_SCOPE,
            case(
                "values/present_empty",
                "present_empty/unknown_genai",
                "gen_ai.operation.name = '' still fingerprints as unknown:genai",
                "llm",
                vec![s("gen_ai.operation.name", "")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "values/present_empty",
                "present_empty/unknown_openinference",
                "openinference.span.kind = ''",
                "llm",
                vec![s("openinference.span.kind", "")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "values/present_empty",
                "present_empty/eq_matcher_not_satisfied",
                "an empty value cannot satisfy eq() against a non-empty literal",
                "op",
                vec![s("gen_ai.system", "")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "values/present_empty",
                "present_empty/prefix_key_empty_value",
                "key_prefix() reads keys, so an empty value still hits",
                "op",
                vec![s("spring.ai.kind", "")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "values/present_empty",
                "present_empty/empty_key_name",
                "an attribute whose key is the empty string",
                "op",
                vec![s("", ""), s("gen_ai.operation.name", "chat")],
            ),
        ),
        Group::new(
            "com.anthropic.claude_code",
            vec![
                case(
                    "values/present_empty",
                    "present_empty/state4_vs_state3_empty",
                    "present-but-empty ⇒ 4",
                    "claude_code.interaction",
                    vec![s("span.type", "interaction"), s("session.id", "")],
                ),
                case(
                    "values/present_empty",
                    "present_empty/state4_vs_state3_absent",
                    "the same span with the key absent ⇒ 3",
                    "claude_code.interaction",
                    vec![s("span.type", "interaction")],
                ),
                case(
                    "values/present_empty",
                    "present_empty/authority_key_empty",
                    "the authority predicate is present(), so an empty span.type still grants it",
                    "claude_code.interaction",
                    vec![s("span.type", ""), s("session.id", "sess-empty-auth")],
                ),
            ],
        ),
        one(
            "@flue/opentelemetry",
            case(
                "values/present_empty",
                "present_empty/eq_authority_empty",
                "eq()-based authority against an empty value",
                "flue.prompt",
                vec![
                    s("flue.operation.kind", ""),
                    s("gen_ai.conversation.id", "c-1"),
                ],
            ),
        ),
    ]
}

/// Duplicate keys. Rule-referenced keys are first-occurrence-wins inside the
/// classifier; the row Map keeps the last occurrence for every key (the v1
/// row-writer coupling that forced the Map to agree with the matcher is gone).
fn duplicate_key_groups() -> Vec<Group> {
    let mut out = Vec::new();
    let orders: [(&str, [&str; 2]); 2] = [
        ("spring_first", ["spring_ai", "strands-agents"]),
        ("strands_first", ["strands-agents", "spring_ai"]),
    ];
    for (label, [first, second]) in orders {
        out.push(one(
            NEUTRAL_SCOPE,
            case(
                "keys/duplicate",
                &format!("duplicate/gen_ai_system_{label}"),
                "duplicate registry key: the first occurrence decides both the verdict and the row",
                "chat",
                vec![s("gen_ai.system", first), s("gen_ai.system", second)],
            ),
        ));
    }
    out.push(Group::new(
        "com.anthropic.claude_code",
        vec![
            case(
                "keys/duplicate",
                "duplicate/session_id_valid_then_empty",
                "first occurrence valid, second empty ⇒ state 6",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    s("session.id", "sess-dup-1"),
                    s("session.id", ""),
                ],
            ),
            case(
                "keys/duplicate",
                "duplicate/session_id_empty_then_valid",
                "first occurrence empty, second valid ⇒ state 4",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    s("session.id", ""),
                    s("session.id", "sess-dup-2"),
                ],
            ),
            case(
                "keys/duplicate",
                "duplicate/session_id_typed_then_string",
                "typed first occurrence wins over a later string",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    int("session.id", 7),
                    s("session.id", "nine"),
                ],
            ),
            case(
                "keys/duplicate",
                "duplicate/authority_key_duplicated",
                "the authority key duplicated with a contradicting second value",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    s("span.type", "not-a-type"),
                    s("session.id", "sess-dup-3"),
                ],
            ),
            case(
                "keys/duplicate",
                "duplicate/authority_key_contradiction_first",
                "the mirror image: the non-matching value comes first",
                "claude_code.interaction",
                vec![
                    s("span.type", "not-a-type"),
                    s("span.type", "interaction"),
                    s("session.id", "sess-dup-4"),
                ],
            ),
            case(
                "keys/duplicate",
                "duplicate/triplicate",
                "three occurrences of a registry key",
                "claude_code.interaction",
                vec![
                    s("span.type", "interaction"),
                    s("session.id", "first"),
                    s("session.id", "second"),
                    s("session.id", "third"),
                ],
            ),
        ],
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "keys/duplicate",
            "duplicate/non_registry_key_last_wins",
            "a key no rule consults keeps the LAST occurrence in the row Map",
            "op",
            vec![
                s("http.route", "/first"),
                s("http.route", "/second"),
                s("gen_ai.operation.name", "chat"),
            ],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "keys/duplicate",
            "duplicate/prefix_family_duplicated",
            "duplicated keys inside a key_prefix family",
            "op",
            vec![
                s("spring.ai.kind", "chat_client"),
                s("spring.ai.kind", "chat_model"),
                s("spring.ai.other", "x"),
            ],
        ),
    ));
    out.push(
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "keys/duplicate",
                "duplicate/resource_and_scope_same_key",
                "the same registry key on the resource, the scope and the span",
                "op",
                vec![s("gen_ai.system", "spring_ai")],
            )],
        )
        .resource(vec![
            s("service.name", "dup"),
            s("gen_ai.system", "strands-agents"),
        ])
        .scope_attrs(vec![s("gen_ai.system", "langchain")]),
    );
    out.push(
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "keys/duplicate",
                "duplicate/scope_attribute_duplicated",
                "duplicate keys inside the scope attribute list",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .scope_attrs(vec![
            s("gen_ai.system", "spring_ai"),
            s("gen_ai.system", "strands-agents"),
        ]),
    );
    out
}

/// Near misses: keys engineered to share a first byte and length with a registry key,
/// or to sit one character away from a registry prefix. These are what the byte/length
/// screens are for, and a screen that leaks would show up as a spurious vendor.
fn near_miss_groups() -> Vec<Group> {
    let near: Vec<(&str, &str)> = vec![
        ("gen_ai.systen", "same length, last byte differs"),
        ("gen_ai.systemm", "one byte longer"),
        ("gen_ai.syste", "one byte shorter"),
        ("Gen_ai.system", "case-flipped first byte"),
        ("gen_ai.operation.namf", "same length as a fingerprint key"),
        ("session.iD", "case-flipped tail"),
        ("sessionXid", "separator replaced"),
        ("span.typ", "prefix of a registry key"),
        ("span.typee", "registry key plus a byte"),
        ("spring.ai", "the prefix without its trailing dot"),
        ("spring/ai.kind", "separator swapped inside a prefix"),
        ("spring.ao.kind", "one byte inside the prefix differs"),
        ("agno", "prefix minus the dot"),
        ("agnos.run", "prefix plus a byte before the dot"),
        ("ai", "the shortest prefix minus its dot"),
        ("aix.thing", "shares the first byte of the ai. prefix"),
        ("llm", "llm. minus the dot"),
        ("llmx.model", "llm prefix near miss"),
        ("traceloop", "traceloop. minus the dot"),
        ("traceloo.x", "one byte short inside the prefix"),
        ("flue", "flue. minus the dot"),
        ("mastra", "mastra. minus the dot"),
        ("model_i", "resource key minus a byte"),
        ("model_idx", "resource key plus a byte"),
        ("telemetry.sdk.nam", "sufficient-resource key minus a byte"),
        ("openinference.span.kin", "fingerprint key minus a byte"),
        ("crew", "crew_ prefix minus the underscore"),
        ("flow", "flow_ prefix minus the underscore"),
        ("event_loop", "event_loop. minus the dot"),
        ("executor", "executor. minus the dot"),
        ("edge_group", "edge_group. minus the dot"),
        ("sk", "sk. minus the dot"),
        ("smolagents", "smolagents. minus the dot"),
        ("langsmith", "langsmith. minus the dot"),
        ("litellm", "litellm. minus the dot"),
        ("haystack", "haystack. minus the dot"),
        ("llamaindex", "llamaindex. minus the dot"),
        ("pydantic_ai", "pydantic_ai. minus the dot"),
        ("agent_framework", "agent_framework. minus the dot"),
        ("gcp.vertex.agent", "gcp.vertex.agent. minus the dot"),
    ];
    let mut out: Vec<Group> = near
        .into_iter()
        .map(|(key, note)| {
            one(
                NEUTRAL_SCOPE,
                case(
                    "keys/near_miss",
                    &format!("near_miss/{key}"),
                    note,
                    "op",
                    vec![s(key, "value"), s("http.route", "/x")],
                ),
            )
        })
        .collect();

    // Near-miss scope names against `eq(scope.name, …)` matchers.
    for (scope_name, note) in [
        ("openinference.instrumentation.agn", "one byte short"),
        ("openinference.instrumentation.agnoo", "one byte long"),
        ("Openinference.instrumentation.agno", "case-flipped"),
        ("openinference.instrumentation.agno ", "trailing space"),
        (" openinference.instrumentation.agno", "leading space"),
        ("pydantic_ai", "underscore instead of the hyphen"),
        ("langsmit", "one byte short"),
        ("litellmx", "one byte long"),
    ] {
        out.push(one(
            scope_name,
            case(
                "keys/near_miss",
                &format!("near_miss/scope/{scope_name}"),
                note,
                "op",
                vec![s("http.route", "/x")],
            ),
        ));
    }
    out
}

/// Unicode, including multi-byte boundaries — the byte screens index by first *byte*,
/// so a multi-byte lead byte is the interesting case.
fn unicode_groups() -> Vec<Group> {
    let mut out = Vec::new();
    let unicode_values: Vec<(&str, String, &str)> = vec![
        ("emoji", "🙂🧠🚀".to_string(), "astral-plane characters"),
        ("cjk", "会話-識別子-42".to_string(), "3-byte sequences"),
        ("rtl", "מזהה-שיחה".to_string(), "RTL text"),
        (
            "combining",
            "e\u{0301}\u{0327}session".to_string(),
            "combining marks after ASCII",
        ),
        (
            "zero_width",
            "sess\u{200b}\u{200d}ion".to_string(),
            "zero-width joiners inside the value",
        ),
        (
            "bom",
            "\u{feff}session-1".to_string(),
            "a leading byte-order mark",
        ),
        (
            "surrogate_pair_boundary",
            format!("{}{}", "a".repeat(3), '\u{10FFFF}'),
            "the last valid scalar value",
        ),
        (
            "nul_adjacent",
            "before\u{0}after".to_string(),
            "an embedded NUL",
        ),
        ("nul_leading", "\u{0}leading".to_string(), "a leading NUL"),
        (
            "nul_trailing",
            "trailing\u{0}".to_string(),
            "a trailing NUL",
        ),
        (
            "control_chars",
            "a\u{1}\u{2}\u{1f}b".to_string(),
            "C0 control characters",
        ),
        (
            "quotes_and_backslash",
            "it's a \\ \"test\" -- /* */".to_string(),
            "SQL-hostile punctuation in a hashed value",
        ),
        (
            "newlines",
            "line1\nline2\r\nline3\t".to_string(),
            "newlines and tabs (NDJSON is line-delimited)",
        ),
    ];
    for (label, value, note) in unicode_values {
        out.push(Group::new(
            "com.anthropic.claude_code",
            vec![case(
                "unicode",
                &format!("unicode/session_value/{label}"),
                note,
                "claude_code.interaction",
                vec![s("span.type", "interaction"), s("session.id", &value)],
            )],
        ));
    }

    // Unicode in KEYS: near-misses against the byte screen at multi-byte boundaries.
    for (key, note) in [
        ("🌍.emoji.key", "a 4-byte lead byte"),
        ("gen_ai.系统", "multi-byte tail on a registry-ish key"),
        ("ai.🙂", "multi-byte tail inside a registry prefix"),
        ("аi.operationId", "Cyrillic 'а' homoglyph as the first byte"),
        ("gen_ai.system\u{0}", "a trailing NUL in the key"),
        ("\u{feff}gen_ai.system", "a BOM in front of a registry key"),
    ] {
        out.push(one(
            NEUTRAL_SCOPE,
            case(
                "unicode",
                &format!("unicode/key/{key}"),
                note,
                "op",
                vec![s(key, "v"), s("http.route", "/x")],
            ),
        ));
    }

    // Unicode in the scope name and the span name (real columns on both sides).
    out.push(one(
        "openinference.instrumentation.agnő",
        case(
            "unicode",
            "unicode/scope_name",
            "a multi-byte near miss on a sufficient scope matcher",
            "Agent.run",
            vec![s("openinference.span.kind", "AGENT")],
        ),
    ));
    out.push(one(
        NEUTRAL_SCOPE,
        case(
            "unicode",
            "unicode/span_name",
            "a span name that is a unicode near miss of an effect_ai matcher",
            "LanguageModel.generateTéxt",
            vec![s("telemetry.sdk.name", "@effect/opentelemetry")],
        ),
    ));

    // The hash is over bytes, not chars: a non-ASCII session-key value.
    out.push(Group::new(
        "com.anthropic.claude_code",
        vec![case(
            "unicode",
            "unicode/session_value",
            "a non-ASCII session-key value",
            "claude_code.interaction",
            vec![
                s("span.type", "interaction"),
                s("session.id", "セッション-1"),
            ],
        )],
    ));
    out
}

/// Oversized values and attribute lists: the never-truncate list for registry keys,
/// and the spill path out of the classifier's inline attribute view.
fn oversized_groups() -> Vec<Group> {
    let big_value = "x".repeat(64 * 1024);
    let big_unicode = "🙂".repeat(4096);
    let big_key = format!("spring.ai.{}", "k".repeat(4096));
    let mut filler: Vec<KeyValue> = (0..60)
        .map(|index| s(&format!("http.request.header.x_{index:03}"), "v"))
        .collect();
    filler.push(s("span.type", "interaction"));
    filler.push(s("session.id", "sess-wide"));

    // More registry-referenced keys than the classifier's inline view holds.
    let mut spilled: Vec<KeyValue> = vec![
        s("span.type", "interaction"),
        s("session.id", "sess-spill"),
        s("user.id", "u-spill"),
        s("gen_ai.operation.name", "chat"),
        s("gen_ai.system", "spring_ai"),
        s("gen_ai.conversation.id", "conv-spill"),
        s("gen_ai.request.model", "gpt-4o"),
        s("openinference.span.kind", "AGENT"),
        s("agno.run.id", "r-spill"),
        s("mastra.span.type", "agent_run"),
        s("mastra.metadata.runId", "run-spill"),
        s("litellm.call_id", "call-spill"),
    ];
    spilled.push(s("task_key", "research"));

    vec![
        Group::new(
            "com.anthropic.claude_code",
            vec![
                case(
                    "oversized",
                    "oversized/64kib_session_value",
                    "a 64 KiB session key value, hashed in full",
                    "claude_code.interaction",
                    vec![s("span.type", "interaction"), s("session.id", &big_value)],
                ),
                case(
                    "oversized",
                    "oversized/16kib_unicode_session_value",
                    "16 Ki astral characters (64 KiB of UTF-8)",
                    "claude_code.interaction",
                    vec![s("span.type", "interaction"), s("session.id", &big_unicode)],
                ),
                case(
                    "oversized",
                    "oversized/wide_attribute_list",
                    "60 non-registry attributes around the two that matter",
                    "claude_code.interaction",
                    filler,
                ),
                case(
                    "oversized",
                    "oversized/spilled_registry_keys",
                    "more registry keys than the inline attribute view holds",
                    "claude_code.interaction",
                    spilled,
                ),
            ],
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "oversized",
                "oversized/long_key",
                "a 4 KiB key inside a registry prefix family",
                "op",
                vec![s(&big_key, "v")],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "oversized",
                "oversized/deep_array",
                "a deeply nested array value",
                "op",
                vec![array(
                    "llm.messages",
                    vec![array(
                        "",
                        vec![array("", vec![array("", vec![s("", "deep")])])],
                    )],
                )],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "oversized",
                "oversized/long_span_name",
                "a 4 KiB span name",
                &"n".repeat(4096),
                vec![s("gen_ai.operation.name", "chat")],
            ),
        ),
    ]
}

/// Pseudo-keys are real columns on both sides. The interesting cases are span
/// attributes that impersonate one, and the `value_prefix` op (D1), which the current
/// registry never uses — covered here at the canonicalization level so the columns it
/// would read are exercised.
fn pseudo_key_groups() -> Vec<Group> {
    vec![
        one(
            "openinference.instrumentation.agno",
            case(
                "pseudo_keys",
                "pseudo/span_attribute_named_scope_name",
                "a span attribute literally called scope.name must not shadow the column",
                "Agent.run",
                vec![
                    s("scope.name", "litellm"),
                    s("openinference.span.kind", "AGENT"),
                ],
            ),
        ),
        one(
            NEUTRAL_SCOPE,
            case(
                "pseudo_keys",
                "pseudo/span_attribute_named_span_name",
                "a span attribute called span.name against effect_ai's span-name matchers",
                "op",
                vec![
                    s("span.name", "LanguageModel.generateText"),
                    s("telemetry.sdk.name", "@effect/opentelemetry"),
                ],
            ),
        ),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "pseudo_keys",
                "pseudo/effect_ai_span_name_match",
                "the real span-name matcher, promoted by the resource candidate",
                "Chat.generateText",
                vec![s("http.route", "/x")],
            )],
        )
        .resource(vec![
            s("service.name", "effect-app"),
            s("telemetry.sdk.name", "@effect/opentelemetry"),
        ]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "pseudo_keys",
                "pseudo/scope_version_and_schema_url",
                "scope.version / scope.schema_url carry values (no matcher reads them today)",
                "op",
                vec![s("gen_ai.operation.name", "chat")],
            )],
        )
        .scope_version("2.0.0-rc.1+build.7")
        .schema_url("https://opentelemetry.io/schemas/1.34.0"),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "pseudo_keys",
                "pseudo/empty_scope_version",
                "empty scope version and schema url",
                "op",
                vec![s("openinference.span.kind", "LLM")],
            )],
        )
        .scope_version(""),
        one(
            "gen_ai",
            case(
                "pseudo_keys",
                "pseudo/scope_name_eq_is_case_sensitive",
                "vercel's insufficient scope matcher, exact match",
                "ai.generateText",
                vec![s("ai.operationId", "ai.generateText")],
            ),
        ),
    ]
}

/// Cross-class placement probes: registry keys deliberately put where their matcher's
/// declared class does not look.
///
/// Both engines are class-directed: a matcher's keys resolve in the one attribute list
/// its class names, and the class-less predicates (unknown-tier fingerprints, session
/// candidates, authority predicates) are span-local. So every span here must classify
/// as if the misplaced key were not there at all.
///
/// These are the spans that caught the divergence when the Rust side still fell back
/// span → scope → resource for every key: ten of them, plus
/// `not_promoted/langchain_resource` and `typed/bool_false_resource`, were pinned
/// mismatches until 2026-08. They stay in the fixture as the regression surface.
fn cross_class_groups() -> Vec<Group> {
    vec![
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/resource_key_on_span",
                "a resource-class matcher's key carried as a span attribute",
                "agent.generate",
                vec![s("telemetry.sdk.name", "@mastra/otel-exporter")],
            )],
        )
        .resource(vec![s("service.name", "app")]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/resource_key_shadowed_by_span",
                "the resource carries the matching value; a span attribute of the same name disagrees",
                "agent.generate",
                vec![s("telemetry.sdk.name", "@opentelemetry/sdk-node")],
            )],
        )
        .resource(vec![
            s("service.name", "app"),
            s("telemetry.sdk.name", "@mastra/otel-exporter"),
        ]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/attr_prefix_on_resource",
                "an attr-class key_prefix family carried on the resource",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .resource(vec![s("service.name", "app"), s("agno.run.id", "r-1")]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/attr_key_on_scope",
                "an attr-class eq() key carried on the scope",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .scope_attrs(vec![s("gen_ai.system", "spring_ai")]),
        Group::new(
            "com.anthropic.claude_code",
            vec![case(
                "cross_class",
                "cross_class/session_key_on_resource",
                "the session-candidate key carried on the resource instead of the span",
                "claude_code.interaction",
                vec![s("span.type", "interaction")],
            )],
        )
        .resource(vec![s("service.name", "app"), s("session.id", "sess-res")]),
        Group::new(
            "com.anthropic.claude_code",
            vec![case(
                "cross_class",
                "cross_class/session_key_on_scope",
                "the session-candidate key carried on the scope",
                "claude_code.interaction",
                vec![s("span.type", "interaction")],
            )],
        )
        .scope_attrs(vec![s("session.id", "sess-scope")]),
        Group::new(
            "com.anthropic.claude_code",
            vec![case(
                "cross_class",
                "cross_class/authority_key_on_resource",
                "the authority predicate's key carried on the resource",
                "claude_code.interaction",
                vec![s("session.id", "sess-auth-res")],
            )],
        )
        .resource(vec![s("service.name", "app"), s("span.type", "interaction")]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/unknown_fingerprint_on_resource",
                "an unknown-tier fingerprint key carried on the resource",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .resource(vec![
            s("service.name", "app"),
            s("gen_ai.operation.name", "chat"),
        ]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/unknown_fingerprint_on_scope",
                "an unknown-tier fingerprint key carried on the scope",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .scope_attrs(vec![s("openinference.span.kind", "LLM")]),
        Group::new(
            NEUTRAL_SCOPE,
            vec![case(
                "cross_class",
                "cross_class/scope_class_key_on_span",
                "a scope-class matcher keyed on a real attribute, carried on the span",
                "op",
                vec![s("http.route", "/x")],
            )],
        )
        .resource(vec![
            s("service.name", "gateway"),
            s("model_id", "gpt-4o-mini"),
        ]),
    ]
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn id_bytes(counter: u64, len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    let source = counter.to_be_bytes();
    for (index, slot) in out.iter_mut().enumerate() {
        // Deterministic, never all-zero (bytes_hex() renders an all-zero id as "").
        *slot = source[index % source.len()] ^ (0x5a + index as u8);
    }
    out
}

/// Runs every group through the real row writer and returns the JSONL body.
fn generate(groups: &[Group]) -> String {
    let datasources = DatasourceNames::defaults();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = String::new();

    for (position, group) in groups.iter().enumerate() {
        // 1-based, and the only source of trace/span ids: stable ids are what makes the
        // artifact byte-reproducible and what the differential joins fixtures back on.
        let counter = position as u64 + 1;
        let spans: Vec<Span> = group
            .cases
            .iter()
            .enumerate()
            .map(|(index, case)| Span {
                trace_id: id_bytes(counter, 16),
                span_id: id_bytes(counter * 1000 + index as u64 + 1, 8),
                parent_span_id: Vec::new(),
                trace_state: String::new(),
                name: case.span_name.clone(),
                kind: span::SpanKind::Internal as i32,
                start_time_unix_nano: START_NANOS,
                end_time_unix_nano: START_NANOS + 1_000_000,
                attributes: case.attributes.clone(),
                ..Default::default()
            })
            .collect();

        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: group.resource.clone(),
                    dropped_attributes_count: 0,
                    entity_refs: Vec::new(),
                }),
                scope_spans: vec![ScopeSpans {
                    scope: group.scope.clone(),
                    spans,
                    schema_url: group.schema_url.clone(),
                }],
                schema_url: String::new(),
            }],
        };

        let settings =
            AiClassificationSettings::at(true, RECEIVE_SECS);
        let (frames, stats) = encode_traces(
            &datasources,
            ORG_ID,
            &request,
            &SamplingPolicy::default(),
            &[],
            &settings,
        )
        .expect("encode_traces");
        assert_eq!(
            stats.rows,
            group.cases.len(),
            "every span must produce a row"
        );
        assert_eq!(stats.ai_spans_examined, stats.rows);

        let payload = String::from_utf8(frames[0].payload.clone()).expect("utf8 rows");
        let rows: Vec<&str> = payload.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(rows.len(), group.cases.len());

        // The classifier, called directly, so the raw session-key value (never stored)
        // is available for the hash-alignment leg.
        let resource_context = ResourceContext::new(registry(), &group.resource);
        let scope_context = resource_context.scope(group.scope.as_ref(), &group.schema_url);

        for (case, row_text) in group.cases.iter().zip(rows) {
            assert!(
                seen.insert(case.id.clone()),
                "duplicate fixture id {}",
                case.id
            );
            let row: Value = serde_json::from_str(row_text).expect("row json");
            let classification = scope_context.classify_span(&case.span_name, &case.attributes);
            let vendor = classification.vendor_slug().to_string();
            let state = classification.session_state;
            let hash = classification.session_key_hash();

            // The direct call and the row writer must agree — otherwise the fixture's
            // `rust` block would describe a classification the row never carried.
            assert_eq!(
                row["ai_vendor"].as_str(),
                Some(vendor.as_str()),
                "{}",
                case.id
            );
            assert_eq!(
                row["ai_session_key_state"].as_u64(),
                Some(state as u64),
                "{}",
                case.id
            );
            assert_eq!(
                row["ai_session_key_hash"].as_u64(),
                Some(hash),
                "{}",
                case.id
            );
            assert_eq!(
                row["ai_rules_version"].as_u64(),
                Some(registry().version() as u64),
                "{}",
                case.id
            );

            let session_key = classification.session_key.as_deref();
            if let Some(value) = session_key {
                // Third leg of the hash claim: the classifier's own hash is exactly
                // cityhash102 over the pinned construction.
                assert_eq!(
                    hash,
                    crate::cityhash102::city_hash64(value.as_bytes()),
                    "{}",
                    case.id
                );
            }

            let record = json!({
                "id": case.id,
                "category": case.category,
                "note": case.note,
                "rust": {
                    "vendor": vendor,
                    "session_state": state,
                    // A string: u64 hashes above 2^53 do not survive JSON.parse.
                    "session_key_hash": hash.to_string(),
                    "rules_version": registry().version(),
                    // Hex of the raw winning value, which no row carries. The
                    // hash-contract e2e replays exactly these bytes into ClickHouse.
                    "session_key_hex": session_key.map(|value| hex(value.as_bytes())),
                },
            });
            out.push_str(&serde_json::to_string(&record).expect("record json"));
            out.push('\n');
        }
    }
    out
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/adversarial/adversarial-spans.jsonl")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// Writes the artifact. Opt-in, because a test that writes into the source tree on
/// every `cargo test` would fight the determinism check it exists to feed.
#[test]
#[ignore = "regeneration: set ADVERSARIAL_FIXTURE_OUT"]
fn write_adversarial_fixture() {
    let Some(out) = std::env::var_os("ADVERSARIAL_FIXTURE_OUT") else {
        panic!("set ADVERSARIAL_FIXTURE_OUT to the artifact path");
    };
    let body = generate(&groups());
    let path = PathBuf::from(out);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create fixture directory");
    }
    std::fs::write(&path, &body).expect("write fixture");
    println!(
        "wrote {} spans, {} bytes to {}",
        body.lines().count(),
        body.len(),
        path.display()
    );
}

/// Regeneration is byte-stable: a missing artifact fails, a stale one fails with the
/// moved line.
///
/// This used to skip when the artifact was absent, so that "a fresh checkout of
/// apps/ingest alone still builds". That rationale is dead — since the TS-mirror test
/// the crate `include_str!`s `packages/domain/src/ai/vendors.ts` under `cfg(test)`, so
/// an apps/ingest-only tree does not compile at all. Meanwhile this golden is the only
/// gate on several rules (tier-2's guard, session authority for non-entry vendors), so
/// a sparse checkout or a bad merge that dropped the file would have left CI green with
/// the gate gone.
#[test]
fn fixture_is_reproducible() {
    let path = fixture_path();
    let checked_in = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "{} is missing ({error}) — this golden is the only gate on several rules; \
             regenerate it with ADVERSARIAL_FIXTURE_OUT (see this module's header)",
            path.display()
        )
    });
    let regenerated = generate(&groups());
    if regenerated != checked_in {
        let expected: Vec<&str> = checked_in.lines().collect();
        let actual: Vec<&str> = regenerated.lines().collect();
        let first_difference = expected
            .iter()
            .zip(&actual)
            .position(|(left, right)| left != right);
        panic!(
            "{} is stale ({} lines checked in, {} regenerated, first differing line {:?}). \
             Regenerate with ADVERSARIAL_FIXTURE_OUT=<path> cargo test --lib write_adversarial_fixture -- --ignored",
            path.display(),
            expected.len(),
            actual.len(),
            first_difference
        );
    }
}

/// Composition guard: every branch the plan's §6 fuzz surface names must be present,
/// so a future edit cannot quietly shrink the corpus.
#[test]
fn fixture_covers_every_branch() {
    let body = generate(&groups());
    let mut categories: BTreeMap<String, usize> = BTreeMap::new();
    let mut vendors: BTreeSet<String> = BTreeSet::new();
    let mut states: BTreeSet<u64> = BTreeSet::new();
    for line in body.lines() {
        let record: Value = serde_json::from_str(line).expect("record");
        *categories
            .entry(record["category"].as_str().expect("category").to_string())
            .or_default() += 1;
        vendors.insert(
            record["rust"]["vendor"]
                .as_str()
                .expect("vendor")
                .to_string(),
        );
        states.insert(record["rust"]["session_state"].as_u64().expect("state"));
    }

    for category in [
        "resolution/sufficient_scope",
        "resolution/insufficient_promoted",
        "resolution/insufficient_not_promoted",
        "resolution/attr_only",
        "resolution/cross_vendor",
        "resolution/unknown_tier",
        "resolution/non_ai",
        "values/typed",
        "values/present_empty",
        "keys/duplicate",
        "keys/near_miss",
        "unicode",
        "oversized",
        "pseudo_keys",
        "cross_class",
    ] {
        assert!(
            categories.contains_key(category),
            "missing category {category}"
        );
    }
    // Every session-key state, 0..=6.
    assert_eq!(
        states,
        (0..=6u64).collect::<BTreeSet<_>>(),
        "states covered"
    );
    // Every vendor in the registry classifies at least one fixture span.
    for vendor in registry().vendors() {
        assert!(
            vendors.contains(vendor.slug()),
            "no fixture span classifies as {}",
            vendor.slug()
        );
    }
    assert!(
        body.lines().count() >= 250,
        "corpus is too small to be adversarial"
    );
    assert!(body.len() < 1_000_000, "artifact must stay under ~1 MB");
}
