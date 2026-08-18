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

/// Classify every span in a decoded trace request and stamp the `maple_ai.*`
/// attributes onto the matching spans. Non-AI spans are left untouched (apart
/// from the namespace strip).
pub fn stamp_trace_request(request: &mut ExportTraceServiceRequest) {
    for resource_spans in &mut request.resource_spans {
        let resource_attrs: &[KeyValue] = resource_spans
            .resource
            .as_ref()
            .map(|resource| resource.attributes.as_slice())
            .unwrap_or(&[]);
        for scope_spans in &mut resource_spans.scope_spans {
            let scope_name = scope_spans
                .scope
                .as_ref()
                .map(|scope| scope.name.as_str())
                .unwrap_or("");
            for span in &mut scope_spans.spans {
                span.attributes
                    .retain(|attr| !attr.key.starts_with(ATTR_NAMESPACE));
                let classification = classify_span(&SpanView {
                    scope_name,
                    span_name: &span.name,
                    span_attrs: &span.attributes,
                    resource_attrs,
                    events: &span.events,
                });
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

fn string_attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_string(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_string())),
        }),
    }
}

/// Borrowed view of one span. Attribute lookups are first-occurrence-wins
/// linear scans over the raw protobuf key/value lists.
pub struct SpanView<'a> {
    pub scope_name: &'a str,
    pub span_name: &'a str,
    pub span_attrs: &'a [KeyValue],
    pub resource_attrs: &'a [KeyValue],
    pub events: &'a [Event],
}

fn attr_str<'a>(attrs: &'a [KeyValue], key: &str) -> &'a str {
    attrs
        .iter()
        .find(|attr| attr.key == key)
        .and_then(|attr| attr.value.as_ref())
        .and_then(|value| match value.value.as_ref() {
            Some(any_value::Value::StringValue(text)) => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("")
}

impl SpanView<'_> {
    fn attr(&self, key: &str) -> &str {
        attr_str(self.span_attrs, key)
    }

    fn has_attr(&self, key: &str) -> bool {
        self.span_attrs.iter().any(|attr| attr.key == key)
    }

    fn attr_prefix(&self, prefix: &str) -> bool {
        self.span_attrs
            .iter()
            .any(|attr| attr.key.starts_with(prefix))
    }

    fn resource(&self, key: &str) -> &str {
        attr_str(self.resource_attrs, key)
    }

    fn event_attr_prefix(&self, prefix: &str) -> bool {
        self.events
            .iter()
            .any(|event| event.attributes.iter().any(|kv| kv.key.starts_with(prefix)))
    }

    fn session_value(&self, key: &str) -> Option<String> {
        let value = self
            .span_attrs
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
}

type DetectFn = fn(&SpanView) -> bool;

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

pub fn classify_span(view: &SpanView) -> Option<AiClassification> {
    for vendor in VENDORS {
        if (vendor.detect)(view) {
            let session_id = vendor
                .session_keys
                .iter()
                .find_map(|key| view.session_value(key));
            return Some(AiClassification {
                vendor: vendor.id,
                session_id,
            });
        }
    }
    for (id, detect) in UNKNOWN_TIER {
        if detect(view) {
            return Some(AiClassification {
                vendor: id,
                session_id: None,
            });
        }
    }
    None
}

fn detect_claude_agent_sdk(v: &SpanView) -> bool {
    const SPAN_TYPES: [&str; 7] = [
        "interaction",
        "llm_request",
        "tool",
        "tool.execution",
        "tool.blocked_on_user",
        "hook",
        "subagent.spawn",
    ];
    if v.scope_name == "com.anthropic.claude_code"
        || v.scope_name.starts_with("com.anthropic.claude_code.")
    {
        return true;
    }
    if v.span_name.starts_with("claude_code.") && v.has_attr("span.type") {
        return true;
    }
    SPAN_TYPES.contains(&v.attr("span.type")) && v.resource("service.name") == "claude-code"
}

fn detect_dspy(v: &SpanView) -> bool {
    v.scope_name == "openinference.instrumentation.dspy"
}

fn detect_eve(v: &SpanView) -> bool {
    // "eve" alone is a bare English word; require the turn span name too.
    v.scope_name == "eve" && v.span_name == "ai.eve.turn"
}

fn detect_flue(v: &SpanView) -> bool {
    v.scope_name == "@flue/opentelemetry" || v.attr_prefix("flue.")
}

fn detect_google_adk(v: &SpanView) -> bool {
    v.scope_name == "gcp.vertex.agent"
        || v.attr_prefix("gcp.vertex.agent.")
        || v.attr("gen_ai.system") == "gcp.vertex.agent"
}

fn detect_haystack(v: &SpanView) -> bool {
    const SPAN_NAMES: [&str; 6] = [
        "haystack.pipeline.run",
        "haystack.component.run",
        "haystack.agent.run",
        "haystack.agent.step",
        "haystack.agent.step.llm",
        "haystack.agent.step.tool",
    ];
    v.scope_name == "haystack" || v.attr_prefix("haystack.") || SPAN_NAMES.contains(&v.span_name)
}

fn detect_langchain(v: &SpanView) -> bool {
    // langgraph deliberately folds in here; the LangSmith dialect is not
    // span-locally separable.
    v.scope_name == "langsmith"
        || v.attr_prefix("langsmith.")
        || v.attr("gen_ai.system") == "langchain"
}

fn detect_litellm(v: &SpanView) -> bool {
    // No `litellm.` attr-prefix clause: that would steal the host framework's
    // spans (litellm.call_id rides along inside other frameworks' spans).
    v.scope_name == "litellm"
}

fn detect_llamaindex(v: &SpanView) -> bool {
    v.scope_name == "llamaindex.opentelemetry.tracer"
        || v.attr_prefix("llamaindex.")
        || v.event_attr_prefix("tags.llamaindex.")
}

fn detect_mastra(v: &SpanView) -> bool {
    v.resource("telemetry.sdk.name") == "@mastra/otel-exporter"
        || v.scope_name == "@mastra/otel-exporter"
        || v.attr_prefix("mastra.")
}

fn detect_agno(v: &SpanView) -> bool {
    v.scope_name == "openinference.instrumentation.agno" || v.attr_prefix("agno.")
}

fn detect_microsoft_agent_framework(v: &SpanView) -> bool {
    v.scope_name == "agent_framework"
        || v.attr("gen_ai.provider.name")
            .starts_with("microsoft.agent_framework")
        || v.attr_prefix("agent_framework.")
        || ((v.attr_prefix("executor.") || v.attr_prefix("edge_group."))
            && v.attr_prefix("message."))
}

fn detect_openai_agents_sdk(v: &SpanView) -> bool {
    // Exact equality, never starts_with: "openinference.instrumentation.openai"
    // is a string prefix of this scope.
    v.scope_name == "openinference.instrumentation.openai_agents"
}

fn detect_openinference_openai(v: &SpanView) -> bool {
    v.scope_name == "openinference.instrumentation.openai"
}

fn detect_crewai(v: &SpanView) -> bool {
    if v.scope_name == "openinference.instrumentation.crewai" || v.scope_name == "crewai.telemetry"
    {
        return true;
    }
    // A different OpenInference instrumentor owns this span.
    if v.scope_name.starts_with("openinference.instrumentation.") {
        return false;
    }
    let evidence = v.attr_prefix("crew_")
        || v.has_attr("task_key")
        || v.has_attr("tool.result_as_answer")
        || v.has_attr("tool.description_updated")
        || v.has_attr("tool.cache_function")
        || v.attr_prefix("flow_")
        || v.attr_prefix("flow.node.");
    if !evidence {
        return false;
    }
    if v.has_attr("openinference.span.kind") || v.has_attr("coding_agent") {
        return true;
    }
    v.span_name.ends_with("._execute_core")
        || v.span_name.ends_with(".kickoff")
        || v.span_name.ends_with(".run")
}

fn detect_pydantic_ai(v: &SpanView) -> bool {
    v.scope_name == "pydantic-ai"
        || v.attr_prefix("pydantic_ai.")
        || v.attr_prefix("gen_ai.aggregated_usage.")
        || (v.has_attr("logfire.json_schema")
            && v.has_attr("gen_ai.operation.name")
            && (v.has_attr("gen_ai.agent.call.id")
                || v.has_attr("operation.cost")
                || v.has_attr("model_request_parameters")))
}

fn detect_semantic_kernel(v: &SpanView) -> bool {
    // The trailing space in "agent_runtime " is load-bearing.
    v.scope_name.starts_with("semantic_kernel.")
        || v.scope_name.starts_with("agent_runtime ")
        || v.has_attr("sk.available_functions")
        || v.attr("gen_ai.operation.name") == "chat.streaming_completions"
        || (v.attr("gen_ai.operation.name") == "chat.completions"
            && v.attr("gen_ai.response.finish_reason")
                .starts_with("FinishReason."))
}

fn detect_smolagents(v: &SpanView) -> bool {
    v.scope_name == "openinference.instrumentation.smolagents" || v.attr_prefix("smolagents.")
}

fn detect_strands(v: &SpanView) -> bool {
    v.scope_name == "strands.telemetry.tracer"
        || v.attr("gen_ai.system") == "strands-agents"
        || v.attr("gen_ai.provider.name") == "strands-agents"
        || (v.attr_prefix("event_loop.") && v.has_attr("gen_ai.operation.name"))
}

fn detect_effect_ai(v: &SpanView) -> bool {
    // These span names are generic enough that they require the Effect SDK's
    // resource fingerprint; the LanguageModel./EmbeddingModel./PersistedChat.
    // names stand on their own.
    const GUARDED_SPAN_NAMES: [&str; 6] = [
        "Chat.generateText",
        "Chat.streamText",
        "Chat.generateObject",
        "Chat.export",
        "Chat.exportJson",
        "Toolkit.handle",
    ];
    const UNGUARDED_SPAN_NAMES: [&str; 7] = [
        "LanguageModel.generateText",
        "LanguageModel.streamText",
        "LanguageModel.generateObject",
        "EmbeddingModel.embed",
        "EmbeddingModel.embedMany",
        "PersistedChat.get",
        "PersistedChat.getOrCreate",
    ];
    if GUARDED_SPAN_NAMES.contains(&v.span_name) {
        return v.resource("telemetry.sdk.name") == "@effect/opentelemetry";
    }
    if UNGUARDED_SPAN_NAMES.contains(&v.span_name) {
        return true;
    }
    if v.has_attr("toolChoice") && v.has_attr("concurrency") {
        return v.resource("telemetry.sdk.name") == "@effect/opentelemetry"
            || (!v.scope_name.is_empty() && v.scope_name == v.resource("service.name"));
    }
    false
}

fn detect_spring_ai(v: &SpanView) -> bool {
    v.attr_prefix("spring.ai.")
        || v.attr("gen_ai.system") == "spring_ai"
        || (v.scope_name == "org.springframework.boot" && v.attr("gen_ai.system") == "openai")
}

fn detect_vercel_ai_sdk(v: &SpanView) -> bool {
    ((v.scope_name == "ai" || v.scope_name == "gen_ai") && v.attr_prefix("ai."))
        || v.attr("gen_ai.operation.name") == "agent_step"
        || v.has_attr("gen_ai.execute_tool.duration")
}

fn detect_unknown_genai(v: &SpanView) -> bool {
    v.has_attr("gen_ai.operation.name")
}

fn detect_unknown_openinference(v: &SpanView) -> bool {
    v.has_attr("openinference.span.kind")
        || ((v.has_attr("input.value") || v.has_attr("output.value")) && v.attr_prefix("llm."))
}

fn detect_unknown_other(v: &SpanView) -> bool {
    v.attr_prefix("llm.") || v.attr_prefix("traceloop.") || v.attr_prefix("ai.")
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

    #[test]
    fn scope_detected_vendors_with_session_ids() {
        classified(
            "com.anthropic.claude_code",
            "claude_code.interaction",
            &[("session.id", "cc-1")],
            &[],
            "claude_agent_sdk",
            Some("cc-1"),
        );
        classified(
            "openinference.instrumentation.dspy",
            "predict",
            &[("session.id", "d-1")],
            &[],
            "dspy",
            Some("d-1"),
        );
        classified(
            "eve",
            "ai.eve.turn",
            &[("eve.session.id", "e-1")],
            &[],
            "eve",
            Some("e-1"),
        );
        classified(
            "@flue/opentelemetry",
            "prompt",
            &[("gen_ai.conversation.id", "f-1")],
            &[],
            "flue",
            Some("f-1"),
        );
        classified(
            "gcp.vertex.agent",
            "invoke_agent",
            &[("gcp.vertex.agent.session_id", "g-1")],
            &[],
            "google_adk",
            Some("g-1"),
        );
        classified(
            "langsmith",
            "chain",
            &[("langsmith.metadata.thread_id", "l-1")],
            &[],
            "langchain",
            Some("l-1"),
        );
        classified(
            "openinference.instrumentation.agno",
            "agent.run",
            &[("session.id", "a-1")],
            &[],
            "agno",
            Some("a-1"),
        );
        classified(
            "agent_framework",
            "invoke_agent",
            &[("gen_ai.conversation.id", "m-1")],
            &[],
            "microsoft_agent_framework",
            Some("m-1"),
        );
        classified(
            "openinference.instrumentation.openai_agents",
            "agent",
            &[("gen_ai.conversation.id", "o-1")],
            &[],
            "openai_agents_sdk",
            Some("o-1"),
        );
        classified(
            "openinference.instrumentation.openai",
            "chat",
            &[("session.id", "oo-1")],
            &[],
            "openinference-openai",
            Some("oo-1"),
        );
        classified(
            "crewai.telemetry",
            "Crew.kickoff",
            &[("session.id", "c-1")],
            &[],
            "crewai",
            Some("c-1"),
        );
        classified(
            "pydantic-ai",
            "agent run",
            &[("gen_ai.conversation.id", "p-1")],
            &[],
            "pydantic_ai",
            Some("p-1"),
        );
        classified(
            "openinference.instrumentation.smolagents",
            "step",
            &[("session.id", "s-1")],
            &[],
            "smolagents",
            Some("s-1"),
        );
        classified(
            "strands.telemetry.tracer",
            "invoke",
            &[("session.id", "st-1")],
            &[],
            "strands",
            Some("st-1"),
        );
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
            key: "session.id".to_string(),
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
                            name: "@mastra/otel-exporter".to_string(),
                            ..Default::default()
                        }),
                        spans: vec![Span {
                            name: "agent.generate".to_string(),
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
                            name: "@opentelemetry/instrumentation-http".to_string(),
                            ..Default::default()
                        }),
                        spans: vec![Span {
                            name: "POST /checkout".to_string(),
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
