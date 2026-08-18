//! AI agent span classification: vendor detection + session-ID extraction.
//!
//! Runs at decode time (`enrich_trace_request`), before the write path forks,
//! so the stamps ride inside the OTLP payload itself and reach both the native
//! row encoder and the forward-to-collector path — same as the `maple_org_id`
//! resource enrichment. A span that matches a vendor (or, failing that, a
//! generic AI dialect) gets these span attributes appended:
//!
//! - `maple_ai.vendor.id` — vendor slug
//! - `maple_ai.vendor.version` — identified vendor version, currently always `"0"`
//! - `maple_ai.session.id` — the vendor's own session identifier, verbatim
//!
//! Any customer-supplied `maple_ai.*` keys are stripped first; the gateway is
//! the authority for this namespace, like it is for `maple_org_id`.
//!
//! Detection is ordered first-match over the vendor predicates below; the
//! session ID is the first non-empty session-granularity attribute for the
//! matched vendor. Vendors without a session-level identifier (their
//! instrumentation only emits run/user-scoped IDs, or nothing) get no
//! `maple_ai.session.id`.
//!
//! # Performance shape
//!
//! This runs on the per-span hot path (budget: ~50ns mean per span, see
//! `benches/ai_session_bench.rs`), so the predicates never scan the attribute
//! list themselves. Scope and resource facts are computed once per
//! `ScopeSpans`/`ResourceSpans`; each span gets a single pass over its
//! attributes (first-byte dispatch) that fills a [`SpanEvidence`] struct, and
//! the overwhelmingly common no-evidence span exits before any vendor
//! predicate runs. The predicates are pure field reads over those facts.
//!
//! Detection compares string-typed attribute values only. That is exact:
//! every value a predicate tests is a non-numeric literal, so a bool/int/
//! double value could never match anyway. Session IDs do stringify scalar
//! values, since a numeric conversation ID is a real session.

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::trace::v1::span::Event;

pub const ATTR_NAMESPACE: &str = "maple_ai.";
pub const VENDOR_ID_ATTR: &str = "maple_ai.vendor.id";
pub const VENDOR_VERSION_ATTR: &str = "maple_ai.vendor.version";
pub const SESSION_ID_ATTR: &str = "maple_ai.session.id";
pub const VENDOR_VERSION: &str = "0";

#[derive(Debug, PartialEq)]
pub struct AiClassification {
    pub vendor: &'static str,
    pub session_id: Option<String>,
}

/// Borrowed view of one span, the unit [`classify_span`] works on.
#[derive(Debug)]
pub struct SpanView<'a> {
    pub scope_name: &'a str,
    pub span_name: &'a str,
    pub span_attrs: &'a [KeyValue],
    pub resource_attrs: &'a [KeyValue],
    pub events: &'a [Event],
}

/// Classify every span in a decoded trace request and stamp the `maple_ai.*`
/// attributes onto the matching spans. Non-AI spans are left untouched (apart
/// from the namespace strip, which only runs when a `maple_ai.*` key exists).
pub fn stamp_trace_request(request: &mut ExportTraceServiceRequest) {
    for resource_spans in &mut request.resource_spans {
        let resource = resource_facts(
            resource_spans
                .resource
                .as_ref()
                .map_or(&[][..], |resource| resource.attributes.as_slice()),
        );
        for scope_spans in &mut resource_spans.scope_spans {
            let scope = scope_facts(
                scope_spans
                    .scope
                    .as_ref()
                    .map_or("", |scope| scope.name.as_str()),
                &resource,
            );
            for span in &mut scope_spans.spans {
                let (classification, has_maple_ai) = {
                    let ev = collect_evidence(&span.attributes, &span.events);
                    (
                        classify_from_facts(&scope, &resource, &span.name, &ev, &span.attributes),
                        ev.has_maple_ai,
                    )
                };
                if has_maple_ai {
                    span.attributes
                        .retain(|attr| !attr.key.starts_with(ATTR_NAMESPACE));
                }
                let Some(classification) = classification else {
                    continue;
                };
                span.attributes
                    .push(string_attribute(VENDOR_ID_ATTR, classification.vendor));
                span.attributes
                    .push(string_attribute(VENDOR_VERSION_ATTR, VENDOR_VERSION));
                if let Some(session_id) = classification.session_id {
                    span.attributes
                        .push(string_attribute(SESSION_ID_ATTR, &session_id));
                }
            }
        }
    }
}

/// Classify a single span. Prefer [`stamp_trace_request`] on the hot path — it
/// hoists the per-scope and per-resource fact computation this recomputes.
pub fn classify_span(view: &SpanView) -> Option<AiClassification> {
    let resource = resource_facts(view.resource_attrs);
    let scope = scope_facts(view.scope_name, &resource);
    let ev = collect_evidence(view.span_attrs, view.events);
    classify_from_facts(&scope, &resource, view.span_name, &ev, view.span_attrs)
}

fn string_attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    }
}

// ---------------------------------------------------------------------------
// Facts: everything the predicates read, computed up front.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ResourceFacts<'a> {
    mastra_sdk: bool,
    effect_sdk: bool,
    service_name: &'a str,
}

fn resource_facts(attrs: &[KeyValue]) -> ResourceFacts<'_> {
    let mut facts = ResourceFacts::default();
    for attr in attrs {
        match attr.key.as_str() {
            "telemetry.sdk.name" => match value_str(attr) {
                "@mastra/otel-exporter" => facts.mastra_sdk = true,
                "@effect/opentelemetry" => facts.effect_sdk = true,
                _ => {}
            },
            "service.name" if facts.service_name.is_empty() => {
                facts.service_name = value_str(attr);
            }
            _ => {}
        }
    }
    facts
}

/// Scope-level facts, computed once per `ScopeSpans`. `any` is true when the
/// scope alone can decide a vendor; the flags that only narrow span evidence
/// (`spring_boot`, `vercel_ai`, `matches_service_name`, the crewai refusal)
/// deliberately don't set it, so they never force predicate evaluation on
/// evidence-free spans.
#[expect(
    clippy::struct_excessive_bools,
    reason = "this is a set of independent evidence flags, not state; an enum would be wrong"
)]
#[derive(Default)]
struct ScopeFacts {
    any: bool,
    claude: bool,
    dspy: bool,
    eve: bool,
    flue: bool,
    google_adk: bool,
    haystack: bool,
    langsmith: bool,
    litellm: bool,
    llamaindex: bool,
    mastra: bool,
    agno: bool,
    agent_framework: bool,
    openai_agents: bool,
    openinference_openai: bool,
    crewai: bool,
    openinference_foreign: bool,
    pydantic: bool,
    semantic_kernel: bool,
    smolagents: bool,
    strands: bool,
    spring_boot: bool,
    vercel_ai: bool,
    matches_service_name: bool,
}

fn scope_facts(scope_name: &str, resource: &ResourceFacts) -> ScopeFacts {
    let mut facts = ScopeFacts::default();
    if scope_name.is_empty() {
        return facts;
    }
    match scope_name {
        "com.anthropic.claude_code" => facts.claude = true,
        "openinference.instrumentation.dspy" => facts.dspy = true,
        "eve" => facts.eve = true,
        "@flue/opentelemetry" => facts.flue = true,
        "gcp.vertex.agent" => facts.google_adk = true,
        "haystack" => facts.haystack = true,
        "langsmith" => facts.langsmith = true,
        "litellm" => facts.litellm = true,
        "llamaindex.opentelemetry.tracer" => facts.llamaindex = true,
        "@mastra/otel-exporter" => facts.mastra = true,
        "openinference.instrumentation.agno" => facts.agno = true,
        "agent_framework" => facts.agent_framework = true,
        // Exact equality, never starts_with: "openinference.instrumentation.
        // openai" is a string prefix of the agents scope.
        "openinference.instrumentation.openai_agents" => facts.openai_agents = true,
        "openinference.instrumentation.openai" => facts.openinference_openai = true,
        "openinference.instrumentation.crewai" | "crewai.telemetry" => facts.crewai = true,
        "openinference.instrumentation.smolagents" => facts.smolagents = true,
        "pydantic-ai" => facts.pydantic = true,
        "strands.telemetry.tracer" => facts.strands = true,
        "org.springframework.boot" => facts.spring_boot = true,
        "ai" | "gen_ai" => facts.vercel_ai = true,
        _ => {
            if scope_name.starts_with("com.anthropic.claude_code.") {
                facts.claude = true;
            } else if scope_name.starts_with("openinference.instrumentation.") {
                facts.openinference_foreign = true;
            } else if scope_name.starts_with("semantic_kernel.")
                // The trailing space in "agent_runtime " is load-bearing.
                || scope_name.starts_with("agent_runtime ")
            {
                facts.semantic_kernel = true;
            }
        }
    }
    facts.any = facts.claude
        || facts.dspy
        || facts.eve
        || facts.flue
        || facts.google_adk
        || facts.haystack
        || facts.langsmith
        || facts.litellm
        || facts.llamaindex
        || facts.mastra
        || facts.agno
        || facts.agent_framework
        || facts.openai_agents
        || facts.openinference_openai
        || facts.crewai
        || facts.pydantic
        || facts.semantic_kernel
        || facts.smolagents
        || facts.strands;
    facts.matches_service_name = scope_name == resource.service_name;
    facts
}

/// Everything the vendor predicates read from a span's own attributes,
/// collected in one pass. Value slots hold the first string value seen;
/// presence bits count any value type, matching `has_attr` semantics.
#[expect(
    clippy::struct_excessive_bools,
    reason = "this is a set of independent evidence flags, not state; an enum would be wrong"
)]
#[derive(Default)]
struct SpanEvidence<'a> {
    /// Any field below (except `has_maple_ai`) is set.
    any: bool,
    has_maple_ai: bool,
    // Value slots.
    span_type: &'a str,
    has_span_type: bool,
    gen_ai_system: &'a str,
    gen_ai_operation_name: &'a str,
    has_gen_ai_operation_name: bool,
    gen_ai_provider_name: &'a str,
    gen_ai_finish_reason: &'a str,
    // Key-prefix bits.
    flue: bool,
    gcp_vertex_agent: bool,
    haystack: bool,
    langsmith: bool,
    llamaindex: bool,
    mastra: bool,
    agno: bool,
    agent_framework: bool,
    executor: bool,
    edge_group: bool,
    message: bool,
    crew: bool,
    flow_underscore: bool,
    flow_node: bool,
    pydantic_ai: bool,
    gen_ai_aggregated_usage: bool,
    smolagents: bool,
    event_loop: bool,
    spring_ai: bool,
    ai: bool,
    llm: bool,
    traceloop: bool,
    // Exact-key presence bits.
    task_key: bool,
    tool_result_as_answer: bool,
    tool_description_updated: bool,
    tool_cache_function: bool,
    openinference_span_kind: bool,
    coding_agent: bool,
    logfire_json_schema: bool,
    gen_ai_agent_call_id: bool,
    operation_cost: bool,
    model_request_parameters: bool,
    sk_available_functions: bool,
    gen_ai_execute_tool_duration: bool,
    tool_choice: bool,
    concurrency: bool,
    input_value: bool,
    output_value: bool,
    // Span events.
    llamaindex_event: bool,
}

fn value_str(attr: &KeyValue) -> &str {
    match attr.value.as_ref().and_then(|value| value.value.as_ref()) {
        Some(any_value::Value::StringValue(text)) => text.as_str(),
        _ => "",
    }
}

#[expect(
    clippy::cognitive_complexity,
    clippy::too_many_lines,
    reason = "a flat first-byte dispatch table; splitting it would obscure the single-pass shape it exists for"
)]
fn collect_evidence<'a>(span_attrs: &'a [KeyValue], events: &'a [Event]) -> SpanEvidence<'a> {
    let mut ev = SpanEvidence::default();
    for attr in span_attrs {
        let key = attr.key.as_str();
        // First-byte dispatch: a non-AI key takes the match jump plus at most
        // a handful of failed starts_with probes, no hashing.
        match key.as_bytes().first() {
            Some(b'a') => {
                if key.starts_with("ai.") {
                    ev.ai = true;
                } else if key.starts_with("agno.") {
                    ev.agno = true;
                } else if key.starts_with("agent_framework.") {
                    ev.agent_framework = true;
                } else {
                    continue;
                }
            }
            Some(b'c') => match key {
                "coding_agent" => ev.coding_agent = true,
                "concurrency" => ev.concurrency = true,
                _ if key.starts_with("crew_") => ev.crew = true,
                _ => continue,
            },
            Some(b'e') => {
                if key.starts_with("executor.") {
                    ev.executor = true;
                } else if key.starts_with("edge_group.") {
                    ev.edge_group = true;
                } else if key.starts_with("event_loop.") {
                    ev.event_loop = true;
                } else {
                    continue;
                }
            }
            Some(b'f') => {
                if key.starts_with("flue.") {
                    ev.flue = true;
                } else if key.starts_with("flow_") {
                    ev.flow_underscore = true;
                } else if key.starts_with("flow.node.") {
                    ev.flow_node = true;
                } else {
                    continue;
                }
            }
            Some(b'g') => {
                if let Some(rest) = key.strip_prefix("gen_ai.") {
                    match rest {
                        "system" => {
                            if ev.gen_ai_system.is_empty() {
                                ev.gen_ai_system = value_str(attr);
                            }
                        }
                        "operation.name" => {
                            ev.has_gen_ai_operation_name = true;
                            if ev.gen_ai_operation_name.is_empty() {
                                ev.gen_ai_operation_name = value_str(attr);
                            }
                        }
                        "provider.name" => {
                            if ev.gen_ai_provider_name.is_empty() {
                                ev.gen_ai_provider_name = value_str(attr);
                            }
                        }
                        "response.finish_reason" => {
                            if ev.gen_ai_finish_reason.is_empty() {
                                ev.gen_ai_finish_reason = value_str(attr);
                            }
                        }
                        "agent.call.id" => ev.gen_ai_agent_call_id = true,
                        "execute_tool.duration" => ev.gen_ai_execute_tool_duration = true,
                        _ if rest.starts_with("aggregated_usage.") => {
                            ev.gen_ai_aggregated_usage = true;
                        }
                        _ => continue,
                    }
                } else if key.starts_with("gcp.vertex.agent.") {
                    ev.gcp_vertex_agent = true;
                } else {
                    continue;
                }
            }
            Some(b'h') => {
                if key.starts_with("haystack.") {
                    ev.haystack = true;
                } else {
                    continue;
                }
            }
            Some(b'i') => {
                if key == "input.value" {
                    ev.input_value = true;
                } else {
                    continue;
                }
            }
            Some(b'l') => {
                if key.starts_with("langsmith.") {
                    ev.langsmith = true;
                } else if key.starts_with("llamaindex.") {
                    ev.llamaindex = true;
                } else if key.starts_with("llm.") {
                    ev.llm = true;
                } else if key == "logfire.json_schema" {
                    ev.logfire_json_schema = true;
                } else {
                    continue;
                }
            }
            Some(b'm') => {
                if key.starts_with("mastra.") {
                    ev.mastra = true;
                } else if key.starts_with("message.") {
                    ev.message = true;
                } else if key == "model_request_parameters" {
                    ev.model_request_parameters = true;
                } else if key.starts_with(ATTR_NAMESPACE) {
                    ev.has_maple_ai = true;
                    continue;
                } else {
                    continue;
                }
            }
            Some(b'o') => match key {
                "openinference.span.kind" => ev.openinference_span_kind = true,
                "output.value" => ev.output_value = true,
                "operation.cost" => ev.operation_cost = true,
                _ => continue,
            },
            Some(b'p') => {
                if key.starts_with("pydantic_ai.") {
                    ev.pydantic_ai = true;
                } else {
                    continue;
                }
            }
            Some(b's') => match key {
                "span.type" => {
                    ev.has_span_type = true;
                    if ev.span_type.is_empty() {
                        ev.span_type = value_str(attr);
                    }
                }
                "sk.available_functions" => ev.sk_available_functions = true,
                _ if key.starts_with("smolagents.") => ev.smolagents = true,
                _ if key.starts_with("spring.ai.") => ev.spring_ai = true,
                _ => continue,
            },
            Some(b't') => match key {
                "task_key" => ev.task_key = true,
                "toolChoice" => ev.tool_choice = true,
                "tool.result_as_answer" => ev.tool_result_as_answer = true,
                "tool.description_updated" => ev.tool_description_updated = true,
                "tool.cache_function" => ev.tool_cache_function = true,
                _ if key.starts_with("traceloop.") => ev.traceloop = true,
                _ => continue,
            },
            _ => continue,
        }
        ev.any = true;
    }
    for event in events {
        for attr in &event.attributes {
            if attr.key.starts_with("tags.llamaindex.") {
                ev.llamaindex_event = true;
                ev.any = true;
                break;
            }
        }
        if ev.llamaindex_event {
            break;
        }
    }
    ev
}

// ---------------------------------------------------------------------------
// Span-name sets (exact membership, first-byte gated).
// ---------------------------------------------------------------------------

const HAYSTACK_SPAN_NAMES: [&str; 6] = [
    "haystack.pipeline.run",
    "haystack.component.run",
    "haystack.agent.run",
    "haystack.agent.step",
    "haystack.agent.step.llm",
    "haystack.agent.step.tool",
];

/// These span names are generic enough that they require the Effect SDK's
/// resource fingerprint; the LanguageModel./EmbeddingModel./PersistedChat.
/// names stand on their own.
const EFFECT_GUARDED_SPAN_NAMES: [&str; 6] = [
    "Chat.generateText",
    "Chat.streamText",
    "Chat.generateObject",
    "Chat.export",
    "Chat.exportJson",
    "Toolkit.handle",
];
const EFFECT_UNGUARDED_SPAN_NAMES: [&str; 7] = [
    "LanguageModel.generateText",
    "LanguageModel.streamText",
    "LanguageModel.generateObject",
    "EmbeddingModel.embed",
    "EmbeddingModel.embedMany",
    "PersistedChat.get",
    "PersistedChat.getOrCreate",
];

#[derive(PartialEq)]
enum EffectNameTier {
    Guarded,
    Unguarded,
    No,
}

fn effect_name_tier(span_name: &str) -> EffectNameTier {
    if EFFECT_GUARDED_SPAN_NAMES.contains(&span_name) {
        EffectNameTier::Guarded
    } else if EFFECT_UNGUARDED_SPAN_NAMES.contains(&span_name) {
        EffectNameTier::Unguarded
    } else {
        EffectNameTier::No
    }
}

/// Can this span name alone put the span in front of the vendor predicates?
/// Only haystack and effect_ai detect on bare span names; everything else's
/// span-name tests are gated behind scope or attribute evidence.
fn span_name_candidate(span_name: &str) -> bool {
    match span_name.as_bytes().first() {
        Some(b'h') => HAYSTACK_SPAN_NAMES.contains(&span_name),
        Some(b'C' | b'T' | b'L' | b'E' | b'P') => effect_name_tier(span_name) != EffectNameTier::No,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Vendor predicates: pure field reads over the precomputed facts.
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    scope: &'a ScopeFacts,
    resource: &'a ResourceFacts<'a>,
    span_name: &'a str,
    ev: &'a SpanEvidence<'a>,
}

type DetectFn = fn(&Ctx) -> bool;

struct Vendor {
    id: &'static str,
    detect: DetectFn,
    /// Session-granularity span attribute keys; the first non-empty value wins.
    session_keys: &'static [&'static str],
}

/// Ordered: first match wins. Vendors with a dedicated instrumentation scope
/// come first; the three detected purely from span evidence (`effect_ai`,
/// `spring_ai`, `vercel_ai_sdk`) come last.
static VENDORS: &[Vendor] = &[
    Vendor {
        id: "claude_agent_sdk",
        detect: detect_claude_agent_sdk,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "dspy",
        detect: detect_dspy,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "eve",
        detect: detect_eve,
        session_keys: &["eve.session.id"],
    },
    Vendor {
        id: "flue",
        detect: detect_flue,
        session_keys: &["gen_ai.conversation.id"],
    },
    Vendor {
        id: "google_adk",
        detect: detect_google_adk,
        session_keys: &["gen_ai.conversation.id", "gcp.vertex.agent.session_id"],
    },
    Vendor {
        id: "haystack",
        detect: detect_haystack,
        session_keys: &[],
    },
    Vendor {
        id: "langchain",
        detect: detect_langchain,
        session_keys: &["langsmith.metadata.thread_id"],
    },
    Vendor {
        id: "litellm",
        detect: detect_litellm,
        session_keys: &[],
    },
    Vendor {
        id: "llamaindex",
        detect: detect_llamaindex,
        session_keys: &[],
    },
    Vendor {
        id: "mastra",
        detect: detect_mastra,
        session_keys: &["gen_ai.conversation.id"],
    },
    Vendor {
        id: "agno",
        detect: detect_agno,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "microsoft_agent_framework",
        detect: detect_microsoft_agent_framework,
        session_keys: &["gen_ai.conversation.id"],
    },
    Vendor {
        id: "openai_agents_sdk",
        detect: detect_openai_agents_sdk,
        session_keys: &["session.id", "gen_ai.conversation.id"],
    },
    Vendor {
        id: "openinference-openai",
        detect: detect_openinference_openai,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "crewai",
        detect: detect_crewai,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "pydantic_ai",
        detect: detect_pydantic_ai,
        session_keys: &["gen_ai.conversation.id"],
    },
    Vendor {
        id: "semantic_kernel",
        detect: detect_semantic_kernel,
        session_keys: &[],
    },
    Vendor {
        id: "smolagents",
        detect: detect_smolagents,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "strands",
        detect: detect_strands,
        session_keys: &["session.id"],
    },
    Vendor {
        id: "effect_ai",
        detect: detect_effect_ai,
        session_keys: &[],
    },
    Vendor {
        id: "spring_ai",
        detect: detect_spring_ai,
        session_keys: &["spring.ai.chat.client.conversation.id"],
    },
    Vendor {
        id: "vercel_ai_sdk",
        detect: detect_vercel_ai_sdk,
        session_keys: &["ai.settings.context.eve.session.id"],
    },
];

/// Generic AI-dialect buckets, consulted only when no vendor matched. Ordered.
static UNKNOWN_TIER: &[(&str, DetectFn)] = &[
    ("unknown:genai", detect_unknown_genai),
    ("unknown:openinference", detect_unknown_openinference),
    ("unknown:other", detect_unknown_other),
];

fn classify_from_facts(
    scope: &ScopeFacts,
    resource: &ResourceFacts,
    span_name: &str,
    ev: &SpanEvidence,
    span_attrs: &[KeyValue],
) -> Option<AiClassification> {
    // The common case: nothing about this span can match any predicate.
    if !scope.any && !ev.any && !resource.mastra_sdk && !span_name_candidate(span_name) {
        return None;
    }
    let ctx = Ctx {
        scope,
        resource,
        span_name,
        ev,
    };
    for vendor in VENDORS {
        if (vendor.detect)(&ctx) {
            let session_id = vendor
                .session_keys
                .iter()
                .find_map(|key| session_value(span_attrs, key));
            return Some(AiClassification {
                vendor: vendor.id,
                session_id,
            });
        }
    }
    for (id, detect) in UNKNOWN_TIER {
        if detect(&ctx) {
            return Some(AiClassification {
                vendor: id,
                session_id: None,
            });
        }
    }
    None
}

/// Session-key lookup, only reached on matched AI spans. Stringifies scalar
/// values; a numeric conversation ID is a real session.
fn session_value(span_attrs: &[KeyValue], key: &str) -> Option<String> {
    let value = span_attrs
        .iter()
        .find(|attr| attr.key == key)?
        .value
        .as_ref()?;
    let text = match value.value.as_ref()? {
        any_value::Value::StringValue(text) => text.clone(),
        any_value::Value::IntValue(int) => int.to_string(),
        any_value::Value::DoubleValue(double) => double.to_string(),
        any_value::Value::BoolValue(flag) => flag.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn detect_claude_agent_sdk(c: &Ctx) -> bool {
    const SPAN_TYPES: [&str; 7] = [
        "interaction",
        "llm_request",
        "tool",
        "tool.execution",
        "tool.blocked_on_user",
        "hook",
        "subagent.spawn",
    ];
    c.scope.claude
        || (c.ev.has_span_type && c.span_name.starts_with("claude_code."))
        || (SPAN_TYPES.contains(&c.ev.span_type) && c.resource.service_name == "claude-code")
}

fn detect_dspy(c: &Ctx) -> bool {
    c.scope.dspy
}

fn detect_eve(c: &Ctx) -> bool {
    // "eve" alone is a bare English word; require the turn span name too.
    c.scope.eve && c.span_name == "ai.eve.turn"
}

fn detect_flue(c: &Ctx) -> bool {
    c.scope.flue || c.ev.flue
}

fn detect_google_adk(c: &Ctx) -> bool {
    c.scope.google_adk || c.ev.gcp_vertex_agent || c.ev.gen_ai_system == "gcp.vertex.agent"
}

fn detect_haystack(c: &Ctx) -> bool {
    c.scope.haystack
        || c.ev.haystack
        || (c.span_name.as_bytes().first() == Some(&b'h')
            && HAYSTACK_SPAN_NAMES.contains(&c.span_name))
}

fn detect_langchain(c: &Ctx) -> bool {
    // langgraph deliberately folds in here; the LangSmith dialect is not
    // span-locally separable.
    c.scope.langsmith || c.ev.langsmith || c.ev.gen_ai_system == "langchain"
}

fn detect_litellm(c: &Ctx) -> bool {
    // No `litellm.` attr-prefix clause: that would steal the host framework's
    // spans (litellm.call_id rides along inside other frameworks' spans).
    c.scope.litellm
}

fn detect_llamaindex(c: &Ctx) -> bool {
    c.scope.llamaindex || c.ev.llamaindex || c.ev.llamaindex_event
}

fn detect_mastra(c: &Ctx) -> bool {
    c.resource.mastra_sdk || c.scope.mastra || c.ev.mastra
}

fn detect_agno(c: &Ctx) -> bool {
    c.scope.agno || c.ev.agno
}

fn detect_microsoft_agent_framework(c: &Ctx) -> bool {
    c.scope.agent_framework
        || c.ev
            .gen_ai_provider_name
            .starts_with("microsoft.agent_framework")
        || c.ev.agent_framework
        || ((c.ev.executor || c.ev.edge_group) && c.ev.message)
}

fn detect_openai_agents_sdk(c: &Ctx) -> bool {
    c.scope.openai_agents
}

fn detect_openinference_openai(c: &Ctx) -> bool {
    c.scope.openinference_openai
}

#[expect(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "span-name suffixes like ._execute_core, not file extensions"
)]
fn detect_crewai(c: &Ctx) -> bool {
    if c.scope.crewai {
        return true;
    }
    // A different OpenInference instrumentor owns this span.
    if c.scope.openinference_foreign {
        return false;
    }
    let evidence = c.ev.crew
        || c.ev.task_key
        || c.ev.tool_result_as_answer
        || c.ev.tool_description_updated
        || c.ev.tool_cache_function
        || c.ev.flow_underscore
        || c.ev.flow_node;
    if !evidence {
        return false;
    }
    if c.ev.openinference_span_kind || c.ev.coding_agent {
        return true;
    }
    c.span_name.ends_with("._execute_core")
        || c.span_name.ends_with(".kickoff")
        || c.span_name.ends_with(".run")
}

fn detect_pydantic_ai(c: &Ctx) -> bool {
    c.scope.pydantic
        || c.ev.pydantic_ai
        || c.ev.gen_ai_aggregated_usage
        || (c.ev.logfire_json_schema
            && c.ev.has_gen_ai_operation_name
            && (c.ev.gen_ai_agent_call_id || c.ev.operation_cost || c.ev.model_request_parameters))
}

fn detect_semantic_kernel(c: &Ctx) -> bool {
    c.scope.semantic_kernel
        || c.ev.sk_available_functions
        || c.ev.gen_ai_operation_name == "chat.streaming_completions"
        || (c.ev.gen_ai_operation_name == "chat.completions"
            && c.ev.gen_ai_finish_reason.starts_with("FinishReason."))
}

fn detect_smolagents(c: &Ctx) -> bool {
    c.scope.smolagents || c.ev.smolagents
}

fn detect_strands(c: &Ctx) -> bool {
    c.scope.strands
        || c.ev.gen_ai_system == "strands-agents"
        || c.ev.gen_ai_provider_name == "strands-agents"
        || (c.ev.event_loop && c.ev.has_gen_ai_operation_name)
}

fn detect_effect_ai(c: &Ctx) -> bool {
    match effect_name_tier(c.span_name) {
        EffectNameTier::Guarded => c.resource.effect_sdk,
        EffectNameTier::Unguarded => true,
        EffectNameTier::No => {
            c.ev.tool_choice
                && c.ev.concurrency
                && (c.resource.effect_sdk || c.scope.matches_service_name)
        }
    }
}

fn detect_spring_ai(c: &Ctx) -> bool {
    c.ev.spring_ai
        || c.ev.gen_ai_system == "spring_ai"
        || (c.scope.spring_boot && c.ev.gen_ai_system == "openai")
}

fn detect_vercel_ai_sdk(c: &Ctx) -> bool {
    (c.scope.vercel_ai && c.ev.ai)
        || c.ev.gen_ai_operation_name == "agent_step"
        || c.ev.gen_ai_execute_tool_duration
}

fn detect_unknown_genai(c: &Ctx) -> bool {
    c.ev.has_gen_ai_operation_name
}

fn detect_unknown_openinference(c: &Ctx) -> bool {
    c.ev.openinference_span_kind || ((c.ev.input_value || c.ev.output_value) && c.ev.llm)
}

fn detect_unknown_other(c: &Ctx) -> bool {
    c.ev.llm || c.ev.traceloop || c.ev.ai
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};

    fn attrs(pairs: &[(&str, &str)]) -> Vec<KeyValue> {
        pairs
            .iter()
            .map(|(key, value)| string_attribute(key, value))
            .collect()
    }

    fn classify(
        scope_name: &str,
        span_name: &str,
        span: &[(&str, &str)],
        resource: &[(&str, &str)],
    ) -> Option<AiClassification> {
        let span_attrs = attrs(span);
        let resource_attrs = attrs(resource);
        classify_span(&SpanView {
            scope_name,
            span_name,
            span_attrs: &span_attrs,
            resource_attrs: &resource_attrs,
            events: &[],
        })
    }

    fn classified(
        scope_name: &str,
        span_name: &str,
        span: &[(&str, &str)],
        resource: &[(&str, &str)],
        vendor: &str,
        session_id: Option<&str>,
    ) {
        let result = classify(scope_name, span_name, span, resource)
            .unwrap_or_else(|| panic!("expected {vendor}, span was not classified"));
        assert_eq!(result.vendor, vendor);
        assert_eq!(result.session_id.as_deref(), session_id);
    }

    /// (scope, span name, span attrs, expected vendor, expected session id)
    type VendorCase<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str)], &'a str, &'a str);

    #[test]
    #[expect(clippy::too_many_lines, reason = "one table entry per vendor")]
    fn scope_detected_vendors_with_session_ids() {
        let cases: &[VendorCase] = &[
            (
                "com.anthropic.claude_code",
                "claude_code.interaction",
                &[("session.id", "cc-1")],
                "claude_agent_sdk",
                "cc-1",
            ),
            (
                "openinference.instrumentation.dspy",
                "predict",
                &[("session.id", "d-1")],
                "dspy",
                "d-1",
            ),
            (
                "eve",
                "ai.eve.turn",
                &[("eve.session.id", "e-1")],
                "eve",
                "e-1",
            ),
            (
                "@flue/opentelemetry",
                "prompt",
                &[("gen_ai.conversation.id", "f-1")],
                "flue",
                "f-1",
            ),
            (
                "gcp.vertex.agent",
                "invoke_agent",
                &[("gcp.vertex.agent.session_id", "g-1")],
                "google_adk",
                "g-1",
            ),
            (
                "langsmith",
                "chain",
                &[("langsmith.metadata.thread_id", "l-1")],
                "langchain",
                "l-1",
            ),
            (
                "openinference.instrumentation.agno",
                "agent.run",
                &[("session.id", "a-1")],
                "agno",
                "a-1",
            ),
            (
                "agent_framework",
                "invoke_agent",
                &[("gen_ai.conversation.id", "m-1")],
                "microsoft_agent_framework",
                "m-1",
            ),
            (
                "openinference.instrumentation.openai_agents",
                "agent",
                &[("gen_ai.conversation.id", "o-1")],
                "openai_agents_sdk",
                "o-1",
            ),
            (
                "openinference.instrumentation.openai",
                "chat",
                &[("session.id", "oo-1")],
                "openinference-openai",
                "oo-1",
            ),
            (
                "crewai.telemetry",
                "Crew.kickoff",
                &[("session.id", "c-1")],
                "crewai",
                "c-1",
            ),
            (
                "pydantic-ai",
                "agent run",
                &[("gen_ai.conversation.id", "p-1")],
                "pydantic_ai",
                "p-1",
            ),
            (
                "openinference.instrumentation.smolagents",
                "step",
                &[("session.id", "s-1")],
                "smolagents",
                "s-1",
            ),
            (
                "strands.telemetry.tracer",
                "invoke",
                &[("session.id", "st-1")],
                "strands",
                "st-1",
            ),
        ];
        for (scope_name, span_name, span_attrs, vendor, session_id) in cases {
            classified(
                scope_name,
                span_name,
                span_attrs,
                &[],
                vendor,
                Some(session_id),
            );
        }
    }
    #[test]
    fn vendors_without_session_ids() {
        for (scope, span_name) in [
            ("haystack", "haystack.pipeline.run"),
            ("litellm", "completion"),
            ("llamaindex.opentelemetry.tracer", "query"),
        ] {
            // Run/user-scoped IDs are deliberately not session IDs.
            classified(
                scope,
                span_name,
                &[
                    ("llamaindex.run_id", "r-1"),
                    ("metadata.user_api_key_user_id", "u-1"),
                ],
                &[],
                match scope {
                    "haystack" => "haystack",
                    "litellm" => "litellm",
                    _ => "llamaindex",
                },
                None,
            );
        }
        classified(
            "semantic_kernel.functions",
            "chat.completions",
            &[],
            &[],
            "semantic_kernel",
            None,
        );
        classified(
            "",
            "LanguageModel.generateText",
            &[],
            &[],
            "effect_ai",
            None,
        );
    }

    #[test]
    fn vendor_matched_but_session_key_absent_or_empty() {
        classified(
            "openinference.instrumentation.dspy",
            "predict",
            &[],
            &[],
            "dspy",
            None,
        );
        classified(
            "openinference.instrumentation.dspy",
            "predict",
            &[("session.id", "")],
            &[],
            "dspy",
            None,
        );
    }

    #[test]
    fn session_key_order_takes_first_non_empty() {
        classified(
            "gcp.vertex.agent",
            "invoke_agent",
            &[
                ("gcp.vertex.agent.session_id", "fallback"),
                ("gen_ai.conversation.id", "primary"),
            ],
            &[],
            "google_adk",
            Some("primary"),
        );
        classified(
            "gcp.vertex.agent",
            "invoke_agent",
            &[
                ("gen_ai.conversation.id", ""),
                ("gcp.vertex.agent.session_id", "fallback"),
            ],
            &[],
            "google_adk",
            Some("fallback"),
        );
    }

    #[test]
    fn integer_session_ids_are_stringified() {
        let span_attrs = vec![KeyValue {
            key: "session.id".to_owned(),
            value: Some(AnyValue {
                value: Some(any_value::Value::IntValue(4211)),
            }),
        }];
        let resource_attrs = Vec::new();
        let result = classify_span(&SpanView {
            scope_name: "openinference.instrumentation.dspy",
            span_name: "predict",
            span_attrs: &span_attrs,
            resource_attrs: &resource_attrs,
            events: &[],
        })
        .unwrap();
        assert_eq!(result.session_id.as_deref(), Some("4211"));
    }

    #[test]
    fn claude_agent_sdk_attribute_tiers() {
        classified(
            "",
            "claude_code.tool",
            &[("span.type", "tool")],
            &[],
            "claude_agent_sdk",
            None,
        );
        classified(
            "",
            "anything",
            &[("span.type", "llm_request"), ("session.id", "cc-2")],
            &[("service.name", "claude-code")],
            "claude_agent_sdk",
            Some("cc-2"),
        );
        // span.type alone, without the claude-code service, is not enough.
        assert!(classify("", "anything", &[("span.type", "llm_request")], &[]).is_none());
    }

    #[test]
    fn eve_requires_scope_and_turn_span_name() {
        assert!(classify("eve", "other", &[], &[]).is_none());
        assert!(classify("other", "ai.eve.turn", &[], &[]).is_none());
    }

    #[test]
    fn eve_model_spans_classify_as_vercel_and_share_the_session() {
        classified(
            "ai",
            "ai.generateText",
            &[
                ("ai.model.id", "claude-opus-5"),
                ("ai.settings.context.eve.session.id", "e-1"),
            ],
            &[],
            "vercel_ai_sdk",
            Some("e-1"),
        );
    }

    #[test]
    fn plain_vercel_span_has_no_session() {
        classified(
            "ai",
            "ai.generateText",
            &[("ai.model.id", "gpt-5")],
            &[],
            "vercel_ai_sdk",
            None,
        );
    }

    #[test]
    fn openai_agents_scope_is_not_claimed_by_openinference_openai() {
        // Exact-equality trap: one scope is a string prefix of the other.
        classified(
            "openinference.instrumentation.openai_agents",
            "agent",
            &[("session.id", "o-2")],
            &[],
            "openai_agents_sdk",
            Some("o-2"),
        );
    }

    #[test]
    fn crewai_refuses_foreign_openinference_scopes() {
        assert_eq!(
            classify(
                "openinference.instrumentation.langchain",
                "Crew.kickoff",
                &[("crew_key", "x"), ("openinference.span.kind", "AGENT")],
                &[],
            )
            .map(|c| c.vendor),
            // Falls through to the generic OpenInference bucket, not crewai.
            Some("unknown:openinference"),
        );
        classified(
            "",
            "Crew.kickoff",
            &[("crew_key", "x"), ("session.id", "c-2")],
            &[],
            "crewai",
            Some("c-2"),
        );
    }

    #[test]
    fn mastra_detected_from_resource_sdk() {
        classified(
            "",
            "agent.generate",
            &[("gen_ai.conversation.id", "ma-1")],
            &[("telemetry.sdk.name", "@mastra/otel-exporter")],
            "mastra",
            Some("ma-1"),
        );
    }

    #[test]
    fn effect_guarded_span_names_require_the_effect_sdk_resource() {
        classified(
            "my-service",
            "Chat.generateText",
            &[],
            &[("telemetry.sdk.name", "@effect/opentelemetry")],
            "effect_ai",
            None,
        );
        assert!(classify("my-service", "Chat.generateText", &[], &[]).is_none());
    }

    #[test]
    fn llamaindex_detected_from_event_attributes() {
        let events = vec![Event {
            attributes: vec![string_attribute("tags.llamaindex.run_id", "r-1")],
            ..Default::default()
        }];
        let result = classify_span(&SpanView {
            scope_name: "",
            span_name: "query",
            span_attrs: &[],
            resource_attrs: &[],
            events: &events,
        })
        .unwrap();
        assert_eq!(result.vendor, "llamaindex");
        assert_eq!(result.session_id, None);
    }

    #[test]
    fn spring_ai_boot_scope_needs_the_openai_system() {
        classified(
            "org.springframework.boot",
            "chat",
            &[
                ("gen_ai.system", "openai"),
                ("spring.ai.kind", "chat_client"),
                ("spring.ai.chat.client.conversation.id", "sp-1"),
            ],
            &[],
            "spring_ai",
            Some("sp-1"),
        );
    }

    #[test]
    fn unknown_tier_buckets() {
        classified(
            "",
            "chat gpt-5",
            &[("gen_ai.operation.name", "chat")],
            &[],
            "unknown:genai",
            None,
        );
        classified(
            "",
            "llm",
            &[("openinference.span.kind", "LLM")],
            &[],
            "unknown:openinference",
            None,
        );
        classified(
            "",
            "llm",
            &[("input.value", "hi"), ("llm.model_name", "gpt-5")],
            &[],
            "unknown:openinference",
            None,
        );
        classified(
            "",
            "llm",
            &[("llm.model_name", "gpt-5")],
            &[],
            "unknown:other",
            None,
        );
        classified(
            "",
            "task",
            &[("traceloop.workflow.name", "w")],
            &[],
            "unknown:other",
            None,
        );
        classified(
            "",
            "gen",
            &[("ai.model.id", "m")],
            &[],
            "unknown:other",
            None,
        );
    }

    #[test]
    fn non_ai_spans_are_untouched() {
        assert!(classify(
            "@opentelemetry/instrumentation-http",
            "POST /checkout",
            &[("http.route", "/checkout"), ("http.method", "POST")],
            &[("service.name", "checkout")],
        )
        .is_none());
        assert!(classify("", "SELECT users", &[("db.system", "postgres")], &[]).is_none());
    }

    fn attr_value(attrs: &[KeyValue], key: &str) -> Option<String> {
        attrs.iter().find(|kv| kv.key == key).map(|kv| {
            match kv.value.as_ref().and_then(|v| v.value.as_ref()) {
                Some(any_value::Value::StringValue(text)) => text.clone(),
                other => panic!("expected string value for {key}, got {other:?}"),
            }
        })
    }

    #[test]
    fn stamp_trace_request_stamps_ai_spans_and_skips_the_rest() {
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: attrs(&[("service.name", "agent-app")]),
                    ..Default::default()
                }),
                scope_spans: vec![
                    ScopeSpans {
                        scope: Some(InstrumentationScope {
                            name: "@mastra/otel-exporter".to_owned(),
                            ..Default::default()
                        }),
                        spans: vec![Span {
                            name: "agent.generate".to_owned(),
                            attributes: attrs(&[
                                ("gen_ai.conversation.id", "conv-42"),
                                // Customer-supplied stamps are stripped; the
                                // gateway owns this namespace.
                                ("maple_ai.vendor.id", "spoofed"),
                                ("maple_ai.session.id", "spoofed"),
                            ]),
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                    ScopeSpans {
                        scope: Some(InstrumentationScope {
                            name: "@opentelemetry/instrumentation-http".to_owned(),
                            ..Default::default()
                        }),
                        spans: vec![Span {
                            name: "POST /checkout".to_owned(),
                            attributes: attrs(&[("http.route", "/checkout")]),
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
        };

        stamp_trace_request(&mut request);

        let ai_span = &request.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(
            attr_value(&ai_span.attributes, VENDOR_ID_ATTR).as_deref(),
            Some("mastra")
        );
        assert_eq!(
            attr_value(&ai_span.attributes, VENDOR_VERSION_ATTR).as_deref(),
            Some("0")
        );
        assert_eq!(
            attr_value(&ai_span.attributes, SESSION_ID_ATTR).as_deref(),
            Some("conv-42")
        );
        assert_eq!(
            ai_span
                .attributes
                .iter()
                .filter(|kv| kv.key.starts_with(ATTR_NAMESPACE))
                .count(),
            3,
            "spoofed stamps must be stripped, not duplicated"
        );

        let http_span = &request.resource_spans[0].scope_spans[1].spans[0];
        assert!(!http_span
            .attributes
            .iter()
            .any(|kv| kv.key.starts_with(ATTR_NAMESPACE)));
    }
}
