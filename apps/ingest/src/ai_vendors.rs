//! The AI vendor rule tables: vendor knowledge as code.
//!
//! One block per vendor — a `detect` predicate over [`SpanCtx`], ordered
//! session-key candidates whose `authority` is likewise a predicate, declared
//! prefilter hints, and decoy values. Each block's doc comment records what the
//! rules match, the one or two non-obvious reasons the shape is deliberate, and
//! the traps a maintainer must not walk into.
//!
//! Two vendor-set facts are baked in: `langgraph` is folded into `langchain`
//! (the LangSmith dialect is not span-locally separable), and
//! `openinference-openai` exists as a synthesized vendor for the shared OpenAI
//! instrumentor scope, which no framework may claim.
//!
//! Interning of the declared hints, the generated prefilter and the validation
//! of these tables happen in [`crate::ai_registry`]; evaluation lives in
//! [`crate::ai_classifier`]. `apps/ingest/fixtures/classification/` replays
//! recorded OTLP through the whole path and is the gate on any change here.

use crate::ai_classifier::SpanCtx;

/// The rules version stamped on every examined span (`AiRulesVersion`), including
/// non-AI ones. `0` is reserved for pre-rollout / flag-off rows, so this must
/// never be zero.
///
/// The number is a claim about rows already in the warehouse: the rollup keeps
/// `RowRulesVersionMin/Max` per hour, so two hours of rows carrying the same
/// version were computed by the same rules and are directly comparable. Bump it
/// on ANY semantic change to these tables — especially a bug fix, which is
/// exactly what makes two hours of rows incomparable. `1` is the initial
/// production ruleset; everything before the first deploy is part of it.
pub const RULES_VERSION: u32 = 1;

/// The closed vendor set. A classification result is one of these — there is no
/// constructor from a string, so minting an unlisted slug (unbounded
/// `LowCardinality` values, cross-tenant amplification) is not expressible.
/// Vendor discriminants are dense from 0 in declaration order; the reserved
/// `unknown:` buckets live at [`VendorId::UNKNOWN_BASE`]+ so new vendors extend
/// the dense range without renumbering them. The classifier packs vendors into
/// `u64` bitmasks via [`VendorId::index`], which folds the buckets back onto the
/// tail of the dense range.
///
/// The `Unknown*` variants are the reserved `unknown:` fingerprint buckets: they
/// are vendors for resolution purposes but carry no session-key rules, and no
/// vendor rule may mint one (see [`UNKNOWN_TIER`]).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
#[repr(u16)]
pub enum VendorId {
    Agno = 0,
    ClaudeAgentSdk = 1,
    Crewai = 2,
    Dspy = 3,
    EffectAi = 4,
    Flue = 5,
    GoogleAdk = 6,
    Haystack = 7,
    Langchain = 8,
    Litellm = 9,
    Llamaindex = 10,
    Mastra = 11,
    MicrosoftAgentFramework = 12,
    OpenaiAgentsSdk = 13,
    OpeninferenceOpenai = 14,
    PydanticAi = 15,
    SemanticKernel = 16,
    Smolagents = 17,
    SpringAi = 18,
    Strands = 19,
    VercelAiSdk = 20,
    UnknownGenai = 1000,
    UnknownOpeninference = 1001,
    UnknownOther = 1002,
}

impl VendorId {
    /// Number of vendors including the unknown buckets.
    pub const COUNT: usize = 24;

    /// First discriminant of the reserved `unknown:` buckets. Everything below is
    /// a dense vendor discriminant; everything at or above sorts after any vendor
    /// we will ever add.
    pub const UNKNOWN_BASE: u16 = 1000;

    /// The bitmask/table index: the discriminant for vendors, with the unknown
    /// buckets folded onto the tail of the dense `0..COUNT` range.
    pub fn index(self) -> usize {
        let disc = self as usize;
        if disc >= Self::UNKNOWN_BASE as usize {
            Self::COUNT - UNKNOWN_BUCKETS.len() + (disc - Self::UNKNOWN_BASE as usize)
        } else {
            disc
        }
    }

    /// The row-column slug. `unknown:*` names are reserved for the buckets.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Agno => "agno",
            Self::ClaudeAgentSdk => "claude_agent_sdk",
            Self::Crewai => "crewai",
            Self::Dspy => "dspy",
            Self::EffectAi => "effect_ai",
            Self::Flue => "flue",
            Self::GoogleAdk => "google_adk",
            Self::Haystack => "haystack",
            Self::Langchain => "langchain",
            Self::Litellm => "litellm",
            Self::Llamaindex => "llamaindex",
            Self::Mastra => "mastra",
            Self::MicrosoftAgentFramework => "microsoft_agent_framework",
            Self::OpenaiAgentsSdk => "openai_agents_sdk",
            Self::OpeninferenceOpenai => "openinference-openai",
            Self::PydanticAi => "pydantic_ai",
            Self::SemanticKernel => "semantic_kernel",
            Self::Smolagents => "smolagents",
            Self::SpringAi => "spring_ai",
            Self::Strands => "strands",
            Self::VercelAiSdk => "vercel_ai_sdk",
            Self::UnknownGenai => "unknown:genai",
            Self::UnknownOpeninference => "unknown:openinference",
            Self::UnknownOther => "unknown:other",
        }
    }

    /// `true` for the reserved `unknown:` fingerprint buckets — vendors for
    /// resolution purposes, but they carry no session-key rules.
    pub fn is_unknown_bucket(self) -> bool {
        matches!(
            self,
            Self::UnknownGenai | Self::UnknownOpeninference | Self::UnknownOther
        )
    }
}

/// The documented per-vendor session-key granularity. `Session` is the only
/// granularity that resolves at state 6; the rest cap at state 5.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Granularity {
    Session,
    Run,
    User,
    Instance,
}

impl Granularity {
    /// State 6 is reserved for `session` granularity; `run`/`user`/`instance`
    /// resolve at state 5.
    pub fn resolved_state(self) -> u8 {
        match self {
            Self::Session => 6,
            _ => 5,
        }
    }
}

/// One ordered session-key candidate: the span's state is the `max` over all
/// candidates, and the hash comes from the candidate that produced the winning
/// state, ties broken by candidate order.
#[derive(Clone, Copy)]
pub struct SessionCandidateDef {
    /// Span-local attribute key holding the identifier. Data, not code, so the
    /// registry interns it automatically — it does not need declaring in the
    /// vendor's `keys` hints.
    pub key: &'static str,
    /// Span-local predicate selecting session-authoritative spans;
    /// `|_| true` = every span of the vendor is authoritative. Any attribute
    /// key this function consults **must** be in the vendor's declared `keys`/
    /// `prefixes` hints (see [`VendorDef`]).
    pub authority: fn(&SpanCtx) -> bool,
    /// An empty value is state 4, not resolved.
    pub require_non_empty: bool,
    /// Validate against the vendor's `decoy_values`.
    pub reject_decoy_values: bool,
    /// Span-EVENT attribute key read as the value source when the span-local
    /// `key` is absent (llamaindex is the only user). Exact key, attr-first
    /// precedence, first event wins; validations apply to the event value
    /// exactly as to the attribute value. `None` = span attributes only.
    pub event_key: Option<&'static str>,
    pub granularity: Granularity,
    /// Value-conditional granularity (pydantic_ai's conversation id is the only
    /// user): when set, the resolved granularity is computed from the VALIDATED
    /// value (non-empty / non-decoy checks have already passed) instead of the
    /// static `granularity`, which then documents the candidate's ceiling. Must
    /// stay a pure function of the value bytes — no context — so it remains
    /// span-local, order-independent and transport-stable by construction.
    pub granularity_of_value: Option<fn(&str) -> Granularity>,
}

/// One vendor's rules.
///
/// # The detection contract
///
/// `detect` is an arbitrary span-local boolean predicate over [`SpanCtx`]. Two
/// structural requirements keep the classifier's fast path sound:
///
/// * **Declared prefilter hints.** Predicates are opaque, so the prefilter and
///   the candidate dispatch are built from `keys`/`prefixes`/`span_names`:
///   every exact attribute key `detect` or an `authority` function consults (on
///   *any* of the three lists), every key prefix it scans, and every exact span
///   name it compares must be declared — including keys read only inside a
///   conjunct. An undeclared key is invisible to the fast path; the
///   indexed-vs-direct differential turns that drift into a test failure over
///   the fixture/corpus (see `ai_classifier`'s module docs). Session-candidate
///   keys are data and interned automatically.
/// * **Monotone in span evidence.** The scope hoist evaluates `detect` once
///   with an empty span; a `true` there is reused for every span of the scope.
///   Every predicate here is an OR of positive tests, narrowed only by
///   conjunctions, which cannot make an empty span match where a fuller one
///   does not.
///
///   The two negations that exist are safe: crewai's detect refuses a foreign
///   `openinference.instrumentation.` scope, which is negation on SCOPE evidence
///   (constant across the hoist), and flue's conversation-id `authority` rejects
///   `flue.task.id`, and authorities are evaluated per span and never hoisted. A
///   `detect` that negated SPAN evidence would need a per-vendor opt-out from
///   the hoist, which does not exist — build it before writing one.
#[derive(Clone, Copy)]
pub struct VendorDef {
    pub id: VendorId,
    /// The span-local detection predicate.
    pub detect: fn(&SpanCtx) -> bool,
    /// Every exact attribute key the vendor's predicates consult.
    pub keys: &'static [&'static str],
    /// Every attribute-key prefix the vendor's predicates scan.
    pub prefixes: &'static [&'static str],
    /// Every exact span name the vendor's predicates compare against.
    pub span_names: &'static [&'static str],
    pub session_candidates: &'static [SessionCandidateDef],
    /// Literal values a candidate must not resolve to.
    pub decoy_values: &'static [&'static str],
}

/// An unknown-tier fingerprint: classifies a span as AI (into a reserved
/// `unknown:*` bucket) when no vendor matched. Span-local; same declared-hint
/// contract as [`VendorDef`].
#[derive(Clone, Copy)]
pub struct UnknownRuleDef {
    pub bucket: VendorId,
    pub detect: fn(&SpanCtx) -> bool,
    pub keys: &'static [&'static str],
    pub prefixes: &'static [&'static str],
}

/// Every vendor, in **resolution order**: the slice is evaluated
/// first-match-wins per span, so the order is load-bearing wherever two vendors'
/// evidence co-occurs on one span. Two principles:
///
/// * **Specific instrumentor scopes before generic dialect families.** A vendor
///   claimed by its own library-owned scope (or, for mastra, its self-minted
///   resource) must outrank another vendor's attribute evidence riding under
///   that scope. `claude_agent_sdk` leads because the adversarial fixture pins
///   its scope against five other vendors' attributes on one span; the three
///   vendors with no standalone scope/resource evidence at all (`effect_ai`,
///   `spring_ai`, `vercel_ai_sdk` — dialect families detected by span evidence
///   alone) come last.
/// * Two placements are pinned by the adversarial fixture: `mastra` precedes
///   `agno` (mastra's self-minted resource beats agno's `agno.` attribute
///   family) and `openinference-openai` precedes `crewai` (its scope beats
///   crewai's bare `task_key`).
///
/// Real wire data never exercises the order: the at-most-one-vendor tests hold
/// with **zero** overlapping spans over the vendored fixture and the whole
/// corpus. Only the adversarial fixture constructs multi-vendor spans, and a
/// handful of those still carry two vendors' *own* namespaced evidence stapled
/// onto one span (mastra's resource vs `agno.`; `spring.ai.` vs `mastra.`;
/// google_adk's scope vs `gen_ai.system=langchain`). Removing the overlap would
/// mean weakening a rule that is correct in isolation, on evidence no wire
/// capture has ever produced, so the order stays load-bearing for exactly those
/// shapes and the fixture pins it.
pub const VENDORS: &[VendorDef] = &[
    CLAUDE_AGENT_SDK,
    DSPY,
    FLUE,
    GOOGLE_ADK,
    HAYSTACK,
    LANGCHAIN,
    LITELLM,
    LLAMAINDEX,
    MASTRA,
    AGNO,
    MICROSOFT_AGENT_FRAMEWORK,
    OPENAI_AGENTS_SDK,
    OPENINFERENCE_OPENAI,
    CREWAI,
    PYDANTIC_AI,
    SEMANTIC_KERNEL,
    SMOLAGENTS,
    STRANDS,
    EFFECT_AI,
    SPRING_AI,
    VERCEL_AI_SDK,
];

/// The reserved `unknown:` buckets, in [`VendorId`] discriminant order — they
/// occupy the table slots after [`VENDORS`].
pub const UNKNOWN_BUCKETS: &[VendorId] = &[
    VendorId::UnknownGenai,
    VendorId::UnknownOpeninference,
    VendorId::UnknownOther,
];

/// Decoy keys — never consult these as session candidates (deliberately not
/// compiled: the rule is "never read", so the detector must not be able to):
///
/// * `agno.agent.id` / `agno.team.id`: agent identity — constant for the object's
///   life, in the same namespace as the real key, shared by concurrent users.
/// * `graph.node.id`: regenerated at every span start, so it is per-run, not
///   per-node. `graph.node.parent_id` points at another such ephemeral id.
/// * `service.instance.id`: OTel-SDK uuid4, one per process.
/// * `llm.input_messages.N.message.tool_calls.M.tool_call.id`: repeats across a
///   HITL request/resume pair, but correlates one tool call.
///
/// Traps:
///
/// * `session.id` is ALWAYS present — agno mints a uuid4 when the app passes none
///   and sticks it on the Agent instance, so in a long-lived server it is one
///   constant for every user, indistinguishable on the wire from a real one.
/// * `agent.continue_run()` is uninstrumented: HITL completions surface as
///   parentless roots with neither `session.id` nor `agno.run.id`.
/// * Under default config agno emits no `gen_ai.*` attribute at all — pure
///   OpenInference dialect. LLM span names are the agno class, never the model,
///   so no span-name rule is possible.
pub const AGNO: VendorDef = VendorDef {
    id: VendorId::Agno,
    detect: detect_agno,
    keys: &["openinference.span.kind", "session.id"],
    prefixes: &["agno.", "agno.workflow."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            authority: agno_session_id_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "agno.run.id",
            authority: agno_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

fn detect_agno(s: &SpanCtx) -> bool {
    // The instrumentor's own module path, passed to `get_tracer(__name__, …)` —
    // library-owned and per-package, so there is no collision inside the
    // OpenInference family. It reaches the LLM/TOOL spans that carry no `agno.`
    // attribute at all, and the instrumentor only wraps agno entry points, so no
    // non-AI span can land in this scope.
    s.scope_name() == "openinference.instrumentation.agno"
        // The vendor's own namespace, for a rewritten or dropped scope.
        || s.any_attr_prefix("agno.")
}

/// Authority for `agno.run.id`: AGENT-kind spans, or the workflow-key
/// population. No presence branch — `agno.run.id` is written only by the run and
/// workflow wrappers and is never spread by the context mechanism, so a presence
/// branch would be dead code.
fn agno_session_authority(s: &SpanCtx) -> bool {
    s.attr("openinference.span.kind") == Some("AGENT") || s.any_attr_prefix("agno.workflow.")
}

/// Authority for `session.id`: [`agno_session_authority`] plus a presence-gated
/// branch. Under agno's session context manager the instrumentor splices
/// `session.id` onto LLM and TOOL spans too — the only customer-side mechanism
/// that puts a session key on the `continue_run` orphans. Presence-gating keeps
/// state 3 reachable: an AGENT span missing the key still reports 3, and a span
/// matching only this branch has the key by construction.
fn agno_session_id_authority(s: &SpanCtx) -> bool {
    agno_session_authority(s) || s.has_attr("session.id")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `prompt.id` (log records only): a bare uuid4 stable for one user turn, and
///   adjacent to `session.id`. Joining on it fragments a conversation into turns.
/// * `agent_id`: a subagent invocation inside one session; the readable role is
///   `subagent_type` on the parent span.
/// * `user.account_uuid` (plus `organization.id`, `user.account_id`,
///   `user.email`): account identity, constant for the account's life.
///   `user.email` is PII and must not be indexed.
/// * `tool_use_id`, `client_request_id`: one tool call, one HTTP attempt.
///
/// Traps:
///
/// * The SDK emits nothing — `query()` spawns the Claude Code CLI and the CLI is
///   the OTel producer, so the whole configuration surface is environment
///   variables. In TypeScript `options.env` REPLACES the child environment, so a
///   customer who does not spread `process.env` loses every `OTEL_*` var.
/// * There is no session-spanning root span: each turn is its own trace and the
///   conversation is the `session.id` group-by. Trace ≠ conversation here.
/// * `gen_ai.system` is the hardcoded literal `anthropic` on every `llm_request`
///   regardless of where the request went. `gen_ai.request.model` carries the
///   truth, and this key must NEVER become a claude matcher — the corpus'
///   openrouter capture carries 153 such spans. No clause here reads it.
/// * Approval outcome is span-invisible — the only signal is structural (an
///   approved call has an execution child).
pub const CLAUDE_AGENT_SDK: VendorDef = VendorDef {
    id: VendorId::ClaudeAgentSdk,
    detect: detect_claude_agent_sdk,
    keys: &["span.type", "service.name"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            authority: claude_agent_sdk_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "user.id",
            authority: claude_agent_sdk_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

fn detect_claude_agent_sdk(s: &SpanCtx) -> bool {
    // (1) Scope family — primary, library-owned. The CLI hardcodes
    // `com.anthropic.claude_code.tracing` for spans, `.events` for logs and the
    // bare `com.anthropic.claude_code` for metrics; the family test covers all
    // three because log/metric ingest needs the same vendor mapping.
    // Exact-or-dotted-prefix rather than bare `starts_with`, so an unrelated
    // `com.anthropic.claude_codeX` sibling product does not match. Scope matching
    // is hoisted per-ScopeSpans and never prefiltered, so this needs no hint.
    let scope = s.scope_name();
    if scope == "com.anthropic.claude_code" || scope.starts_with("com.anthropic.claude_code.") {
        return true;
    }

    // Every span this dialect emits carries `span.type`. Both fallback clauses
    // below require it as dialect co-evidence, which is also what keeps them
    // dispatch-covered: `span.type` is a declared key, so every span either
    // clause can accept reaches this detector through the key hint (the span-name
    // PREFIX in clause 2 is not declarable — `span_names` dispatch is exact-name
    // only).
    let span_type = s.attr("span.type");

    // (2) Span-name namespace — the rename-proof fingerprint for a
    // scope-rewriting collector. The `claude_code.` vendor namespace lives ONLY
    // in span names; every attribute key in the dialect is bare. Conjunctive with
    // `span.type` presence rather than unconditional, because span names are
    // customer data in other dialects (crewai builds `<crew name>.kickoff`, so a
    // crew named `claude_code` would break the at-most-one-vendor invariant).
    // Zero recall cost — every wire span carries both.
    if s.span_name().starts_with("claude_code.") && span_type.is_some() {
        return true;
    }

    // (3) Guarded bare-key dialect match, for scope AND name rewritten with the
    // native resource default preserved. The value set includes `hook` (a beta
    // flag) and `subagent.spawn` (unreachable in the shipped CLI) so the rule
    // survives those flags flipping on. The `service.name` guard removes the
    // openrouter collision class: those spans also carry a bare `span.type` but
    // `service.name=openrouter`, so they fail both operands.
    matches!(
        span_type,
        Some(
            "interaction"
                | "llm_request"
                | "tool"
                | "tool.execution"
                | "tool.blocked_on_user"
                | "hook"
                | "subagent.spawn"
        )
    ) && s.resource("service.name") == Some("claude-code")
}

fn claude_agent_sdk_session_authority(s: &SpanCtx) -> bool {
    s.has_attr("span.type")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `crew_key`: an md5 of the crew's CONFIGURATION text, so two customers
///   running the same published template share it forever.
/// * `crew_id`: uuid4 per Crew OBJECT — per-run for a server that builds a Crew
///   per request, process-wide for a module-level one. Instance granularity
///   masquerading as session granularity.
/// * `task_key` / `task_id`: a task TEMPLATE hash and a per-Task uuid4, both
///   sub-run granularity.
/// * `graph.node.id`: the agent ROLE string — a definition, not a run.
/// * `coding_agent`: an environment fingerprint of the machine, stamped
///   process-wide when CrewAI's product telemetry is enabled.
/// * `service.name`: process identity.
///
/// Traps:
///
/// * A useful CrewAI trace needs TWO OpenInference packages: the entire LLM layer
///   (tokens, models, prompts) comes from `openinference-instrumentation-openai`.
/// * CrewAI ships anonymous product telemetry that is ON BY DEFAULT and installed
///   at import time. If the customer already registered a TracerProvider, CrewAI
///   adopts it, so its product-analytics spans are created by the CUSTOMER's
///   tracer under scope `crewai.telemetry` and shipped to the customer's backend.
/// * Every CrewAI span name is built from user-supplied strings (crew, agent, task
///   and tool names, with raw uuid fallbacks), so span names are
///   high-cardinality, PII-adjacent customer data — usable only as a suffix test.
/// * HITL emits no span, event or attribute — a gated turn is indistinguishable
///   in shape from an ordinary tool turn.
pub const CREWAI: VendorDef = VendorDef {
    id: VendorId::Crewai,
    detect: detect_crewai,
    keys: &[
        "task_key",
        "tool.result_as_answer",
        "tool.description_updated",
        "tool.cache_function",
        "openinference.span.kind",
        "coding_agent",
    ],
    prefixes: &["crew_", "flow_", "flow.node."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            // "Any crewai-classified span", expressed span-locally as the
            // vendor's own detect. A scope-equality authority would be redundant
            // on the scope path and wrong on the degradation path: a
            // scope-stripped crewai span under `using_session()` still carries
            // `session.id` (the context attributes are read at span end
            // regardless of scope naming). `detect_crewai` rather than
            // `|_| true` because the per-vendor golden histograms evaluate
            // crewai's candidates over EVERY span of a capture, including the
            // sibling instrumentor's.
            authority: detect_crewai,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// Tiered: exact scopes, then a foreign-OpenInference-scope refusal, then
// attribute-evidence conjunctions, then a span-name-suffix last resort. The
// refusal is a negation on SCOPE evidence only, so detect stays monotone in span
// evidence and the scope-decided hoist shortcut remains sound.
fn detect_crewai(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // T1 — the instrumentor package's own module path, library-owned and
    // independent of anything the customer names. Reaches the TOOL spans that
    // carry no `crew_*` key at all.
    if scope == "openinference.instrumentation.crewai" {
        return true;
    }
    // T1b — CrewAI's OWN product-analytics tracer name, reached whenever the
    // customer left telemetry at its default and installed a TracerProvider before
    // building a Crew. Vendor is unambiguously crewai, but these spans are product
    // analytics, not agent/LLM activity, so crewai's AI-span rollups inflate
    // wherever the telemetry leak occurs.
    if scope == "crewai.telemetry" {
        return true;
    }
    // Refusal — a DIFFERENT OpenInference instrumentor owns this span; never
    // claim it. Protects the at-most-one-vendor invariant against customer
    // attributes colliding with the bare `crew_`/`task_key` evidence below.
    if scope.starts_with("openinference.instrumentation.") {
        return false;
    }

    // Crewai's own attribute evidence — bare, unnamespaced keys that must never
    // classify alone. The three CrewAI-only BaseTool fields are used deliberately
    // instead of the shared `tool.name`/`description`/`parameters` OI-semconv keys.
    let crewai_attr_evidence = s.any_attr_prefix("crew_")
        || s.has_attr("task_key")
        || s.has_attr("tool.result_as_answer")
        || s.has_attr("tool.description_updated")
        || s.has_attr("tool.cache_function")
        || s.any_attr_prefix("flow_")
        || s.any_attr_prefix("flow.node.");
    if !crewai_attr_evidence {
        return false;
    }

    // T2 — scope-stripped fallback. `openinference.span.kind` rides every crewai
    // span and survives a scope rewrite because it is an attribute;
    // `coding_agent` is the rename-proof fingerprint, stamped by CrewAI's own
    // span processor when product telemetry is on. Neither may classify alone —
    // `coding_agent` in particular is stamped on every span of the host provider.
    if s.has_attr("openinference.span.kind") || s.has_attr("coding_agent") {
        return true;
    }

    // T3 — span-name suffix last resort, only reachable with crewai attribute
    // evidence in hand. Suffix-only because the name PREFIX is customer data.
    // Under simulated degradation (scope renamed and all `openinference.*` keys
    // dropped) this recovers every crewai-scope span with no foreign matches.
    let name = s.span_name();
    name.ends_with("._execute_core") || name.ends_with(".kickoff") || name.ends_with(".run")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `service.instance.id`: OTel-Python's per-PROCESS uuid4, on the resource of
///   every span. In a script it looks like a session id; in a long-lived server
///   it silently merges every session in the process.
/// * `llm.invocation_parameters`: a byte-identical JSON blob per run. It groups
///   like a key but identifies the sampling config.
/// * `metadata`: an opaque JSON blob customers commonly bury a session id inside.
///   Not reachable — there is no agreed inner field name.
///
/// Traps:
///
/// * DSPy spans carry ZERO usage and ZERO cost data — the instrumentor has no
///   usage extractor. A customer who wants token/cost data must install a second
///   instrumentor beneath DSPy (litellm or openai).
/// * Nothing in DSPy mints, defaults or infers an identifier of any granularity.
///   Absent `using_session()`, a DSPy trace has no session id, no run id and no
///   invocation id. `dspy.History` is a signature INPUT FIELD serialised into
///   `input.value` — the whole conversation, and no key to it.
/// * `dspy.ReAct` swallows tool exceptions, so a failing agent leaves one ERROR
///   span under an all-OK ancestry and root-keyed error rollups report success.
/// * Thread fan-out shreds the trace: neither `ThreadPoolExecutor.submit` nor
///   DSPy's own parallel executor copies the OTel context, so each worker's
///   outermost `forward` starts a BRAND-NEW parentless trace with no session key
///   and no ordering signal beyond wall clock. `dspy.Evaluate` and every
///   teleprompter thread internally by default.
/// * `scope.version` is the instrumentor's release, not dspy's, so version-gated
///   ingest behaviour cannot key on it.
/// * The outermost span is whatever module the app calls first, so there is no
///   session, request, turn or invocation container — a conversation cannot be
///   inferred from the trace graph.
pub const DSPY: VendorDef = VendorDef {
    id: VendorId::Dspy,
    detect: detect_dspy,
    keys: &[],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.scope_name() == "openinference.instrumentation.dspy",
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "user.id",
            authority: |s| s.scope_name() == "openinference.instrumentation.dspy",
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// Exact scope equality is the whole rule, deliberately. DSPy has no attribute
// namespace of its own — its entire key surface is the shared OpenInference
// dialect that five sibling corpus scopes emit identically — its span names are
// customer Python identifiers, and its resource is stock OTel-Python. A span-name
// grammar (`Predict(...).forward`, `.forward`/`.__call__` suffixes) is both too
// weak to be evidence and unnecessary while the scope holds; on scope loss the
// honest outcome is `unknown:openinference` via `openinference.span.kind`.
//
// Rules here must stay VALUE-BLIND: the openrouter capture contains the string
// `openinference.instrumentation.dspy` as traceback TEXT inside prompt payload
// values, so a value-substring rule would cross-fire there. Scope equality cannot.
fn detect_dspy(s: &SpanCtx) -> bool {
    // The instrumentor package's own module path, unchangeable by the app. It
    // reaches the zero-payload adapter and module spans no attribute rule can, and
    // it is the ONLY DSPy discriminator that exists.
    s.scope_name() == "openinference.instrumentation.dspy"
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.response.id` and its duplicate
///   `http.response.header.x-generation-id`: the provider generation id, one per
///   LLM call. The duplicate is doubly tempting — it appears on a second span type
///   and reads like a cross-span join key.
/// * `service.name`: process identity, and uniquely dangerous here because it is
///   ALSO the instrumentation scope name, so it looks like a stable grouping key
///   in two different places.
/// * `effect.fiberId` (a span-EVENT attribute): a fiber is finer than a run and
///   recycled within a process.
///
/// Traps:
///
/// * Non-scalar values are stringified with 2-space indentation —
///   `gen_ai.response.finish_reasons` arrives as `"[\n  \"stop\"\n]"`, never an
///   array. Effect also stamps `StatusCode.OK` on every successful span.
/// * Span names are TypeScript module paths, not operations; the tool name lives
///   in the bare `tool` attribute, not in the `Toolkit.handle` span name.
/// * `LanguageModel.generateText` is SINGLE-SHOT. The loop, the agent identity,
///   the fan-out and any HITL gate are all caller-written, so two Effect AI apps
///   can produce completely different trace shapes from the same library — which
///   is also why the framework has no session key.
/// * The library owns no attribute namespace: the complete native span-attribute
///   key set is generic `gen_ai.*` plus the bare words `tool`, `parameters`,
///   `toolChoice` and `concurrency`. Detection is therefore span-name-first, and
///   full rename-proofing is impossible for this vendor.
pub const EFFECT_AI: VendorDef = VendorDef {
    id: VendorId::EffectAi,
    detect: detect_effect_ai,
    keys: &[
        "telemetry.sdk.name",
        // Resource key read by the `scope.name == service.name` guard leg;
        // declared here because `resource()` reads the same prefiltered view as
        // `attr()`.
        "service.name",
        // Tier-3 bare-word conjunction.
        "toolChoice",
        "concurrency",
    ],
    prefixes: &[],
    span_names: EFFECT_AI_SPAN_NAMES,
    session_candidates: &[],
    decoy_values: &[
        // The literal 9-character string, not a missing value: Effect serialises
        // an unset option as the text `undefined`, which `present()` and
        // `non_empty` both wave through. Any key routed through Effect's
        // attribute path can be present-but-meaningless this way.
        "undefined",
    ],
};

/// The @effect/ai operation span names — the module-path method names the library
/// itself opens spans under, and the vendor's declared span-name hint (the
/// prefilter dispatches span names by EXACT match, so every name a clause
/// compares has to be in this list). The first three are wire-observed; the rest
/// are read out of the library source.
///
/// The set is split by *how distinctive the name is*:
/// [`EFFECT_AI_GUARDED_SPAN_NAMES`] is the ordinary-English subset that only
/// classifies alongside Effect-ecosystem evidence; the remainder are unambiguous
/// TypeScript module paths and stay unguarded, so a collector that rewrites the
/// resource cannot un-classify the token-bearing spans.
const EFFECT_AI_SPAN_NAMES: &[&str] = &[
    "LanguageModel.generateText",
    "Chat.generateText",
    "Toolkit.handle",
    "LanguageModel.streamText",
    "LanguageModel.generateObject",
    "Chat.streamText",
    "Chat.generateObject",
    "Chat.export",
    "Chat.exportJson",
    "EmbeddingModel.embed",
    "EmbeddingModel.embedMany",
    "PersistedChat.get",
    "PersistedChat.getOrCreate",
];

/// The ordinary-English `Class.method` subset of [`EFFECT_AI_SPAN_NAMES`]: names
/// any tracer on earth could plausibly emit. These classify only with
/// Effect-ecosystem evidence; the rest of the set stays unguarded.
const EFFECT_AI_GUARDED_SPAN_NAMES: &[&str] = &[
    "Chat.generateText",
    "Chat.streamText",
    "Chat.generateObject",
    "Chat.export",
    "Chat.exportJson",
    "Toolkit.handle",
];

/// Leg 1 of the Effect-ecosystem guard, and the only leg strong enough to carry a
/// span name that is ordinary English (tier 2 below).
///
/// `@effect/opentelemetry` always writes `telemetry.sdk.name="@effect/opentelemetry"`.
/// It identifies the process as an Effect app that wired that package — NOT as an
/// AI app and NOT the span as an AI span: an Effect HTTP service with no
/// `@effect/ai` dependency emits the identical resource, and plain HTTP client
/// spans inside these very captures satisfy it. Absent entirely under the
/// otlp-tracer wiring, which is why leg 2 exists.
fn effect_opentelemetry_resource(s: &SpanCtx) -> bool {
    s.resource("telemetry.sdk.name") == Some("@effect/opentelemetry")
}

/// Effect-ecosystem evidence — a GUARD, never a classifying clause: both legs
/// hold on processes with no `@effect/ai` dependency at all, and leg 2 holds on
/// 100% of the corpus' openrouter capture, whose false-positive ceiling is zero
/// vendor claims.
///
/// Used by tier 3 ONLY. Tier 3's other conjunct (`toolChoice` ∧ `concurrency`,
/// keys that co-occur on no other capture's spans) is specific enough that leg 2
/// widens a narrow clause; tier 2's other conjunct is a set of ordinary-English
/// names, where leg 2 would widen a broad one.
fn effect_ecosystem_evidence(s: &SpanCtx) -> bool {
    effect_opentelemetry_resource(s)
        // The structural fingerprint of @effect/opentelemetry's tracer: the scope
        // name IS the app's service.name. This is the only Effect-ecosystem
        // evidence that survives BOTH wiring variants — but it is NEVER usable
        // alone: the openrouter capture satisfies it on every span. Non-empty
        // equality, so an app with no service.name fails closed.
        || match (s.scope_name(), s.resource("service.name")) {
            ("", _) => false,
            (scope, Some(service)) => scope == service,
            (_, None) => false,
        }
}

fn detect_effect_ai(s: &SpanCtx) -> bool {
    let name = s.span_name();

    // -- Tier 2: ordinary-English Class.method names, GUARDED. Unguarded these
    // would classify ANY span named `Chat.export` or `Toolkit.handle`, from any
    // tracer, as effect_ai. Explicit FP-vs-FN trade: an Effect app on the
    // otlp-tracer wiring behind a collector that REWRITES service.name loses these
    // spans entirely, which is accepted — a false positive mislabels another
    // tenant's data, this false negative only degrades to unclassified.
    //
    // The guard is leg 1 ALONE, deliberately narrower than tier 3's
    // `effect_ecosystem_evidence`: leg 2 (`scope_name == service.name`) is the
    // `getTracer(serviceName)` idiom, not Effect evidence, and paired with six
    // ordinary-English names it would classify any app using that idiom. Dropping
    // it here costs no corpus recall.
    if EFFECT_AI_GUARDED_SPAN_NAMES.contains(&name) {
        return effect_opentelemetry_resource(s);
    }

    // -- Tier 1: distinctive @effect/ai module-path span names, unguarded.
    // Unambiguous TypeScript module paths with zero hits in any other capture, so
    // a resource-mangling collector cannot un-classify the token-bearing spans.
    if EFFECT_AI_SPAN_NAMES.contains(&name) {
        return true;
    }

    // -- Tier 3: rename-proof bare-word conjunction, GUARDED. `toolChoice` and
    // `concurrency` are the ONLY attributes @effect/ai passes at span creation, so
    // this is the one clause with a chance of surviving a release where every span
    // name changes. Guarded because the keys are unnamespaced English; the guard
    // is the disjunction so the clause survives the otlp-tracer wiring too.
    // Subsumed by tier 1 on today's corpus — it buys nothing until a rename, which
    // is the point.
    if s.has_attr("toolChoice") && s.has_attr("concurrency") {
        return effect_ecosystem_evidence(s);
    }

    false
}

/// Decoy keys — never consult these as session candidates:
///
/// * `flue.session.name`: the decoy that looks most like a session key. It is a
///   process-wide literal (`default`) or, on delegated work,
///   `task:default:<taskId>` — a session-slot name encoding the delegation tree,
///   changing WITHIN one trace.
/// * `flue.parent_session.name`, `flue.harness.name`: constant build/profile names.
/// * `flue.submission.id`, `flue.operation.id`: one per delivery / per agent
///   operation. Session-shaped and stable within a trace, which makes them the
///   most convincing wrong answer; they are run ids.
/// * `flue.task.id`: correlates a delegate's subtree.
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per model call / per tool call.
///   The tool-call id is also stamped on delegated `invoke_agent` spans, which
///   makes it look like a parent-child correlation key.
///
/// Why `gen_ai.conversation.id` and not `flue.instance.id` is THE session key:
/// three granularities are live on every Flue span at once — the durable agent
/// instance (coarser; one instance holds many conversations), the conversation,
/// and the submission/operation (one delivery). The conversation is the unit that
/// survives across traces and that the runtime re-loads history under.
///
/// Traps:
///
/// * SILENT ZERO: `gen_ai.conversation.id` is on 100% of spans, but the
///   AUTHORITATIVE population is the root `invoke_agent` span, which ends and
///   exports last. An ingest that resolves a trace's session on first sight and
///   never revisits silently un-sessions every multi-batch trace.
/// * Subagent spans carry their own sub-conversation ids, which is why the
///   authority below restricts to `flue.operation.kind=prompt`.
/// * Flue emits no `gen_ai.system`; provider attribution must read
///   `gen_ai.provider.name`. `gen_ai.agent.name` is the ACTING agent only on
///   `invoke_agent` spans — nested chat and tool spans report the registered ROOT
///   agent, so per-agent rollups keyed on it are wrong for delegated model calls.
/// * `flue.instance.id` deliberately does not reject decoy values: a customer
///   calling `init(agent, { id: "default" })` produces a state-5 hash of
///   `"default"` that collides across every such customer. Accepted — an instance
///   name is customer-authored identity.
pub const FLUE: VendorDef = VendorDef {
    id: VendorId::Flue,
    detect: detect_flue,
    keys: &[
        "flue.operation.kind",
        // The delegation guard on the conversation-id authority.
        "flue.task.id",
    ],
    prefixes: &["flue."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            // The negation half is vacuous on today's wire — no prompt span
            // carries `flue.task.id` — and defends a real shape. A delegated
            // subagent produces ONE `invoke_agent` span because the adapter
            // suppresses the subagent's own operation_start; if that dedup is ever
            // filtered, dropped or refactored away, the delegate's own span
            // arrives with kind=prompt PLUS `flue.task.id` and a SUB-conversation
            // id, and without this test that id would be promoted to state 6.
            // With it the span stays unauthoritative and resolves at instance
            // granularity instead, which is correct.
            //
            // Key ABSENCE rather than a value test, deliberately: the
            // Cloudflare-Workers wiring keeps both `flue.task.id` and
            // `flue.operation.kind`, so the whole predicate is variant-stable.
            authority: |s| {
                s.attr("flue.operation.kind") == Some("prompt") && !s.has_attr("flue.task.id")
            },
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "flue.instance.id",
            // No authority predicate — every span of the vendor is authoritative.
            authority: |_| true,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Instance,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[
        // The value of `flue.session.name` and `flue.harness.name` on every span:
        // a harness/session-slot constant, not an identity. Listed so validation
        // rejects it if a future Flue version routes it into a candidate key.
        "default",
    ],
};

fn detect_flue(s: &SpanCtx) -> bool {
    // Hardcoded in `@flue/opentelemetry` and the only tracer the adapter ever
    // uses; it reaches the span types that carry no `gen_ai.*` key. Standalone
    // because nothing but this adapter emits under an npm-scoped tracer name — the
    // one way to break that is the customer passing their own shared tracer via
    // `options.tracer`, in which case the `flue.` prefix is the discriminator.
    s.scope_name() == "@flue/opentelemetry"
        // The vendor's own namespace.
        || s.any_attr_prefix("flue.")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gcp.vertex.agent.event_id`: a per-ADK-Event uuid, session-shaped and
///   adjacent to `session_id` in the same namespace, but it changes several times
///   per turn.
/// * `gen_ai.tool.call.id`: repeats across the HITL ask/deny and ask/approve span
///   pairs, which makes it look like a correlation key. It correlates tool calls.
/// * `service.name`: process identity.
///
/// Traps:
///
/// * `call_llm` and `generate_content` are near-duplicate nested spans, 1:1, so
///   any per-span LLM-call or token rollup double-counts. Both must be kept —
///   they are the two session-candidate populations. Dedupe downstream on
///   (`gcp.vertex.agent.event_id`, parent).
/// * `gen_ai.system` is `gemini` on `generate_content` regardless of the actual
///   provider. `gen_ai.request.model` carries the truth.
/// * The session anchor is always a child (`invoke_agent`), never the trace root,
///   so a root-only reader gets nothing.
/// * Native ADK sets only `error.type=TOOL_ERROR` and leaves status UNSET — an
///   ERROR status or exception event on an ADK span is not a native signal.
/// * Runner-driven ADK honours no OTLP env var: a customer scripting ADK must
///   register their own TracerProvider or nothing is sent.
pub const GOOGLE_ADK: VendorDef = VendorDef {
    id: VendorId::GoogleAdk,
    detect: detect_google_adk,
    keys: &[
        "gen_ai.system",
        "gen_ai.operation.name",
        "gen_ai.request.model",
    ],
    prefixes: &["gcp.vertex.agent."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            // Wire carriers are `invoke_agent` and `generate_content` spans; the
            // value is the ADK Session id. `invoke_workflow` is the schema-v2 root
            // — the implicit DEFAULT on Vertex Agent Engine, so real customers hit
            // it without opting in — which carries `gen_ai.conversation.id` at
            // span start. Without the disjunct that root's conversation id, the
            // only root-readable session key ADK ever emits, would be rejected as
            // unauthoritative.
            authority: |s| {
                matches!(
                    s.attr("gen_ai.operation.name"),
                    Some("invoke_agent" | "generate_content" | "invoke_workflow")
                )
            },
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "gcp.vertex.agent.session_id",
            authority: |s| s.attr("gen_ai.system") == Some("gcp.vertex.agent"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "gcp.vertex.agent.invocation_id",
            authority: |s| s.has_attr("gen_ai.request.model"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// All three clauses are vendor-owned literals, so no guard conjunction is needed.
// An `attribute_count == 0` positive discriminator for the attribute-less
// `invocation` roots was declined: zero-attribute INTERNAL spans are the least
// distinctive shape in any fleet, and the scope clause already classifies them.
fn detect_google_adk(s: &SpanCtx) -> bool {
    // ADK's hardcoded instrumenting module name — library-owned, namespaced and
    // stable across the package. It classifies the attribute-less `invocation`
    // root, which nothing else can, and the schema-v2 rollout does not rename it.
    s.scope_name() == "gcp.vertex.agent"
        // Survives a scope-rewriting bridge or collector.
        || s.any_attr_prefix("gcp.vertex.agent.")
        // `call_llm` stamps `gen_ai.system` to the vendor literal. Shadowed by the
        // prefix clause today, but kept as the survivor for attribute-stripping
        // pipelines. DO NOT add `gen_ai.system == "gemini"`: ADK stamps that
        // regardless of the actual provider and it would collide with any real
        // Gemini/google-genai instrumentation — a prohibition that must extend to
        // any future google_genai vendor, which would otherwise claim ADK's
        // `generate_content` spans and trip the at-most-one-vendor test.
        || s.attr("gen_ai.system") == Some("gcp.vertex.agent")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `haystack.pipeline.metadata`: the only customer-writable attribute in the
///   dialect, and therefore the obvious place to stash an id — but it is an opaque
///   blob fixed at Pipeline construction and shared by every session.
/// * `haystack.component.name`: a static pipeline-topology label. Grouping by it
///   yields one bucket per component for the deployment's lifetime.
/// * `haystack.agent.step`: a per-step counter restarting at 0 inside every run.
/// * `service.instance.id`: OTel-Python's per-process uuid4.
///
/// Traps:
///
/// * `haystack.pipeline.output_data` is the literal `{}` on every pipeline span
///   and always will be: the tags are serialized at span OPEN, before the pipeline
///   has run. The real outputs are on the component/agent spans.
/// * Span names are static and non-unique within a trace, so root detection must
///   be structural. All identity is in attributes.
/// * Haystack cannot report an error to a tracing backend at all: status is UNSET
///   and `hasError` false on every span, including an always-failing tool.
/// * HITL is native but emits nothing, and a REJECTED tool call produces no tool
///   span at all because the hook strips the call before execution.
pub const HAYSTACK: VendorDef = VendorDef {
    id: VendorId::Haystack,
    detect: detect_haystack,
    keys: &[],
    prefixes: &["haystack."],
    span_names: &[
        "haystack.pipeline.run",
        "haystack.component.run",
        "haystack.agent.run",
        "haystack.agent.step",
        "haystack.agent.step.llm",
        "haystack.agent.step.tool",
    ],
    session_candidates: &[],
    decoy_values: &[],
};

fn detect_haystack(s: &SpanCtx) -> bool {
    // The ONLY library-owned scope name Haystack can produce (its OpenTelemetry
    // connector hardcodes `get_tracer("haystack")`), and the one current Haystack
    // docs steer customers to. A bare product-name tracer is a real if remote
    // collision risk. On the `enable_tracing()` path the scope is whatever Tracer
    // the app constructed, which no allowlist can enumerate — hence the other two
    // clauses.
    s.scope_name() == "haystack"
        // The `haystack.` namespace is exclusively Haystack's, so it classifies
        // unconditionally.
        || s.any_attr_prefix("haystack.")
        // Library-constant span names, passed by haystack-ai itself and never by
        // the customer. This clause is what classifies the attribute-less
        // `haystack.agent.step.llm` spans under the DEFAULT content-tracing-off
        // config, where no attribute fingerprint can see them. An exact set rather
        // than a `haystack.` name prefix, deliberately: the prefilter dispatches
        // span names by EXACT match only, so a prefix comparison could never be
        // covered by declarable hints and a future span name would pass the direct
        // path while silently missing the fast path. A new Haystack span type needs
        // a hint and a clause entry here.
        || matches!(
            s.span_name(),
            "haystack.pipeline.run"
                | "haystack.component.run"
                | "haystack.agent.run"
                | "haystack.agent.step"
                | "haystack.agent.step.llm"
                | "haystack.agent.step.tool"
        )
}

/// `langgraph` is folded into this vendor: the LangSmith dialect is not
/// span-locally separable from plain LangChain.
///
/// Decoy keys — never consult these as session candidates:
///
/// * `langsmith.trace.session_name` / `langsmith.trace.session_id` /
///   `langsmith.metadata.LANGSMITH_PROJECT`: "session" is LangSmith's legacy word
///   for a tracing PROJECT. The value is a deployment-wide constant that never
///   changes for the life of the process; joining on it merges every trace the
///   deployment ever produced.
/// * `langsmith.metadata.checkpoint_ns` /
///   `langsmith.metadata.langgraph_checkpoint_ns`: look session-shaped
///   (`<node>:<uuid4>`) and sit in the same namespace as `thread_id`, but they
///   change several times per turn and correlate a Pregel task.
/// * `langsmith.metadata.revision_id`: deployment identity (`git describe` of the
///   process CWD by default). Also a leak — it publishes the host repo's git state.
/// * `service.instance.id`: OTel-SDK per-process uuid4.
///
/// Traps:
///
/// * SILENT ZERO: a plain `provider.force_flush()` exports NOTHING. langsmith
///   converts runs into spans on its own background worker, so the standard OTel
///   shutdown recipe yields an empty pipeline with no error. Applies to every
///   LangChain-based integration.
/// * `langsmith.metadata.*` is NOT a fixed key set: langchain-core copies every
///   scalar entry of the `configurable` dict into inheritable metadata (excluding
///   only `__`-prefixed keys and the literal `api_key`), and langsmith mirrors
///   every `LANGCHAIN_*`/`LANGSMITH_*` env var. Treat it as unbounded-cardinality
///   customer data (PII risk, attribute-count blowup). The session key below is a
///   customer-namespace key that merely happens to be conventional — a customer
///   passing `configurable.thread_id` with other semantics poisons it. The same
///   mechanism is why `thread_id` reaches every span including the root.
/// * `gen_ai.system` is substring-guessed from the model name and defaults to
///   `langchain`. Provider attribution keyed on it is wrong.
/// * LangGraph's native HITL gate produces no dedicated span, attribute or event:
///   the interrupted span carries an ERROR status and a `GraphInterrupt` exception
///   event, so successful approval pauses look like errors.
/// * Each `ainvoke()` is its own trace and an interrupt/resume pair splits one
///   logical turn into two, so a per-trace head sampler shreds a session
///   geometrically. There is no run-granularity join key in this dialect either —
///   no invocation id, no run id — hence exactly one candidate below.
/// * Span names are pure customer input (graph node names, the compiled graph
///   name), so no span-name predicate may be written. The type discriminator is
///   the `langsmith.span.kind` attribute.
pub const LANGCHAIN: VendorDef = VendorDef {
    id: VendorId::Langchain,
    detect: detect_langchain,
    keys: &["gen_ai.system"],
    prefixes: &["langsmith."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "langsmith.metadata.thread_id",
            // No authority predicate — every span of the vendor is authoritative.
            authority: |_| true,
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[
        // LangSmith's default project name when no project env var is set, and
        // therefore the most common value of `langsmith.trace.session_name` in the
        // wild. Listed as a value so any future candidate carrying it is forced to
        // state 4 rather than 6.
        "default",
    ],
};

// A `langsmith.internal_provider` RESOURCE conjunct is deliberately NOT part of
// this predicate. It has zero wire witnesses corpus-wide, and as a standalone
// disjunct it is either redundant (the provider is private to langsmith, so the
// marker co-occurs only with the langsmith scope) or a latent process-wide false
// positive — a globally registered internal provider stamps every co-tenant
// library's spans with the marker resource.
fn detect_langchain(s: &SpanCtx) -> bool {
    // One hardcoded `get_tracer("langsmith")` call site for the whole package, with
    // no version and no schema_url. A bare, unnamespaced word, but a product name
    // rather than a generic term, and nothing else in the OTel ecosystem claims it.
    // Two things temper that: with no version and no schema_url there is no
    // secondary confirmation for a tiebreak, and the scope is the LangSmith
    // dialect's rather than LangGraph's — plain LangChain and bare `@traceable`
    // spans land in it too, which is exactly this vendor.
    s.scope_name() == "langsmith"
        // Library-owned, product-named prefix written for every exported run.
        // Rename-proofs against scope rewrite or loss.
        || s.any_attr_prefix("langsmith.")
        // `gen_ai.system` defaults to the literal "langchain" for every non-LLM
        // run. Always co-occurs with the clauses above, so it adds no corpus
        // coverage — it exists purely to survive a `langsmith.*` namespace rename.
        // Generic KEY but vendor-named VALUE. NEVER extend it to "openai" or
        // "anthropic": those are guessed by substring-matching the model name and
        // collide with real provider-SDK instrumentation.
        || s.attr("gen_ai.system") == Some("langchain")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `service.instance.id`, `model_id`, `deployment.environment` (all RESOURCE
///   attributes): process and deployment identity. `service.instance.id` is the
///   archetypal fixture-shaped trap — one value per capture, one value for
///   millions of sessions in a long-lived gateway.
/// * `litellm.call_id`, `gen_ai.response.id`, `llm.openrouter.id`: one per
///   completion call. `litellm.call_id` is the authority predicate below precisely
///   because it marks the request population.
/// * `metadata.user_api_key_hash`: key identity.
/// * `metadata.requester_metadata`: the only channel for application metadata, and
///   it arrives as a stringified PYTHON DICT, not JSON. Customers will hide their
///   session id in it; it is not reachable and must never be treated as a key.
///
/// Traps:
///
/// * LiteLLM is a gateway, not an agent framework, so most real LiteLLM telemetry
///   arrives UNDERNEATH another framework's spans — a per-trace vendor scalar is
///   wrong for every passthrough deployment.
/// * SILENT ZERO: with a parent span present and `USE_OTEL_LITELLM_REQUEST_SPAN`
///   unset — the DEFAULT for any wrapper — LiteLLM creates no span and stamps its
///   whole attribute set onto the CALLER's span. If that span has already ended
///   (its success callback runs after a synchronous `with` block exits) the SDK
///   discards every attribute with a log line and nothing else. Any framework that
///   wraps LiteLLM without the flag exports LLM spans with no LLM attributes.
/// * Every `litellm_request` span carries 33 `metadata.*` attributes of which 30
///   are the empty string in SDK mode — always present, so presence-based rules see
///   them as populated. Hence the `""` decoy below.
/// * Span names are customer-overridable via `metadata.generation_name`, so no
///   span-name predicate is safe for this vendor.
/// * `gen_ai.operation.name` is the litellm call type (`acompletion`), not the
///   semconv `chat`, so an unknown-tier rule switching on that VALUE will not
///   recognise default-dialect LiteLLM.
/// * `gen_ai.system` is the routed provider, never `litellm`. LiteLLM
///   self-identifies in exactly one place in the whole integration:
///   `gen_ai.framework="litellm"` on the opt-in METRICS.
/// * There is NO error signal of any kind when the application fails — both native
///   span types set OK explicitly. Only a failed LLM call reaches the failure path.
/// * The default topology is ONE INDEPENDENT TRACE PER HTTP REQUEST. With no
///   session key either, neither a trace id nor an attribute joins two calls of one
///   conversation; adding a customer parent span triggers the trap above.
pub const LITELLM: VendorDef = VendorDef {
    id: VendorId::Litellm,
    detect: detect_litellm,
    // `litellm.call_id` is consulted by the session authority only; detect reads
    // nothing but the scope column (see detect_litellm).
    keys: &["litellm.call_id"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "metadata.user_api_key_end_user_id",
            authority: litellm_session_authority,
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "metadata.user_api_key_user_id",
            authority: litellm_session_authority,
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[
        // 30 of the 33 `metadata.*` keys on every `litellm_request` span are the
        // empty string in SDK mode. Presence matches all of them, so any
        // presence-only session resolution would collapse every LiteLLM trace in
        // the fleet onto one `""` group — the single most important validation
        // fact for this vendor.
        "",
        // LiteLLM's proxy sentinel for the global admin. A proxy deployment stamps
        // it into `metadata.user_api_key_user_id` for every admin-key request,
        // producing a deployment-wide constant that looks like a real user id.
        "default_user_id",
    ],
};

// The scope equality is the ENTIRE predicate, deliberately. An unguarded
// `litellm.` prefix clause would steal the host framework's spans under LiteLLM's
// default no-primary-span config (which stamps the caller's span with litellm's
// whole attribute set), and its guarded form is subsumed by the scope. A
// `model_id` resource conjunct is likewise out: LiteLLM installs the GLOBAL
// TracerProvider, so `model_id` is a process-wide resource every co-tenant
// library inherits.
//
// Rename evasion is the ACCEPTED ceiling: `OTEL_TRACER_NAME` renames the scope
// and the spans degrade to `unknown:genai` / `unknown:other`. No span-local signal
// separates "litellm under a renamed scope" from "foreign span stamped by
// passthrough" — the attribute sets are identical by construction.
fn detect_litellm(s: &SpanCtx) -> bool {
    // The default `LITELLM_TRACER_NAME`, and the ONLY thing that classifies
    // `raw_gen_ai_request` spans, which carry no `gen_ai.*`, no `litellm.*` and no
    // stable attribute namespace at all. In proxy deployments this scope also
    // carries non-AI spans — still LiteLLM's spans, so vendor attribution stays
    // correct even when "is this an AI span" does not.
    s.scope_name() == "litellm"
}

fn litellm_session_authority(s: &SpanCtx) -> bool {
    s.has_attr("litellm.call_id")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `session_id`: LlamaIndex's `Memory.session_id` is the chat-store partition
///   key — the one thing actually named a session — and it NEVER reaches
///   telemetry. Expecting it is the natural mistake.
/// * `span_id`, `id_`: LlamaIndex's own string span id and a per-EVENT uuid4, both
///   living in the SAME event attribute map as the real run id. The event fallback
///   below reads one exact key and must never fuzzy-match "a session-shaped uuid
///   in the event attrs".
/// * `llamaindex.step.input_event`: the workflow event CLASS NAME — a
///   low-cardinality constant a naive group-by could mistake for a thread key.
///
/// Traps:
///
/// * The classification surface (attributes) and the value surface (span events)
///   are disjoint: three attribute keys total, and everything a consumer wants —
///   prompts, tool arguments and results, agent replies, model name — is in span
///   EVENT attributes. Dropping span events keeps 100% of the classification
///   signal and loses ~82% of the payload.
/// * Native HITL suspends by raising an internal control-flow exception and
///   REPLAYING the step, so each approval produces an ERROR span with an
///   `exception` event reading `Waiting for event …` followed by a successful one.
///   Those ERROR spans are not failures, and the exception message is the only tell.
/// * `instrument_tags` is the only extension point, and it prefixes dot-less keys
///   with `llamaindex.` while passing dotted keys through verbatim. Because it is a
///   free-form tag dict there is NO canonical LlamaIndex session attribute key, so
///   this vendor carries no session-granularity candidate. Session support
///   requires per-tenant configuration.
/// * The default resource has ONE attribute and no `telemetry.sdk.*` at all — the
///   library builds it with the bare `Resource(attributes=…)` constructor.
pub const LLAMAINDEX: VendorDef = VendorDef {
    id: VendorId::Llamaindex,
    detect: detect_llamaindex,
    keys: &[],
    // `tags.llamaindex.` is an EVENT-attribute prefix (detect clause 3 and the
    // candidate's event fallback read it); event attribute keys feed the same
    // candidate dispatch as span attribute keys, so the declaration lives here.
    prefixes: &["llamaindex.", "tags.llamaindex."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "llamaindex.run_id",
            // No authority predicate — every span of the vendor is authoritative.
            authority: |_| true,
            require_non_empty: true,
            reject_decoy_values: false,
            // The attribute-less `*.run` spans (including every trace root) carry
            // exactly one `workflow.output` event whose `tags.llamaindex.run_id`
            // holds the run id, and on spans carrying both the span attribute and
            // the event tag the values never disagree — so attr-first precedence
            // is deterministic.
            event_key: Some("tags.llamaindex.run_id"),
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// A `service.name == "llamaindex.opentelemetry"` RESOURCE conjunct is deliberately
// not part of this predicate: a resource is process-wide, so in a default-resource
// LlamaIndex app that also runs httpx/openai auto-instrumentation an OR-clause
// would steal those spans. Bare event NAMES are generic strings subsumed by the
// tags clause, and a span-name grammar is out because the name set is open
// (customer class names) and `.run` collides ecosystem-wide.
fn detect_llamaindex(s: &SpanCtx) -> bool {
    // The library's hardcoded tracer name. The only clause that needs no attributes
    // at all: it classifies the attribute-less `*.run` spans, most of which are
    // trace roots. `get_tracer()` is called with no version and no schema_url, so
    // neither can distinguish LlamaIndex releases.
    s.scope_name() == "llamaindex.opentelemetry.tracer"
        // The vendor's own namespace: native step/run keys, plus anything
        // `instrument_tags` prefixes into it, so the namespace is closed over the
        // vendor. This is the scope-rewrite safety net at the vendor tier — an
        // unknown-tier `llamaindex.` fingerprint would be dead code behind it.
        || s.any_attr_prefix("llamaindex.")
        // Dispatcher-mirrored span events repeat the tag map as `tags.<key>` event
        // attributes with the native keys pre-prefixed. The only clause that
        // reaches the attribute-less `*.run` spans if a collector rewrites or drops
        // the scope. Vendor-namespaced, so unconditional.
        || s.events()
            .any(|event| event.any_attr_prefix("tags.llamaindex."))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `mastra.metadata.resumedFromSpanId`: a session-shaped hex id that equals the
///   resumed root's dangling `parentSpanId`, so it reads like a correlation key.
///   It is a SPAN id scoped to one suspend→resume hop.
/// * `mastra.metadata.resumed`: a constant `true` marker, not an identifier — but
///   the only span-local way to recognise resume roots whose parents dangle.
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per LLM call / per tool call.
/// * `service.name`: process identity, and the only attribute on the LOG signal's
///   resource.
///
/// Traps:
///
/// * Mastra's HITL resume re-parents the new root onto the span that was live when
///   the run suspended, and under the default `includeInternalSpans: false` that
///   span is never exported. Spans therefore declare parents no record contains:
///   root detection MUST be "parent absent from the trace", not "no parent id".
/// * A tool span can be ended twice with progressively-enriched error info and both
///   ends exported, producing two spans under one span id with conflicting
///   `error.type`.
/// * Mastra emits no `gen_ai.system`; provider attribution lives in
///   `gen_ai.provider.name`. `gen_ai.operation.name` doubles as Mastra's span-type
///   field, so most of its values are not semconv operation names.
/// * Mastra reads no `OTEL_EXPORTER_OTLP_*` variable and silently installs a no-op
///   observability layer if the config shape is wrong. Both failure modes are
///   silent, which bounds how much Mastra data arrives from env-configured apps.
pub const MASTRA: VendorDef = VendorDef {
    id: VendorId::Mastra,
    detect: detect_mastra,
    keys: &["telemetry.sdk.name", "mastra.span.type"],
    prefixes: &["mastra."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            authority: mastra_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "mastra.metadata.runId",
            authority: mastra_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "mastra.metadata.resourceId",
            authority: mastra_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

fn detect_mastra(s: &SpanCtx) -> bool {
    // The only NATIVE framework-identifying resource attribute in the corpus.
    // Mastra abuses the standard OTel key: its exporter builds the resource from
    // scratch with `telemetry.sdk.name` = the exporter package name. Standalone
    // sufficiency holds BY CONSTRUCTION, not by assuming a single-vendor process:
    // this resource is minted per exported span inside Mastra's own converter — no
    // resource detector, no merge with a global SDK Resource — and Mastra never
    // routes spans through a process-wide TracerProvider, so a co-loaded
    // auto-instrumentation's spans carry the NodeSDK resource. NOTE the asymmetry:
    // the LOG signal's resource is built separately and carries `service.name`
    // only, so this predicate classifies spans but never log records.
    s.resource("telemetry.sdk.name") == Some("@mastra/otel-exporter")
        // The exporter's hardcoded scope name. Nothing else can land in it: Mastra
        // converts finished spans and pushes them straight into its own
        // BatchSpanProcessor, so no third-party instrumentation can write there.
        || s.scope_name() == "@mastra/otel-exporter"
        // The exporter-owned `mastra.` namespace, written unconditionally on every
        // span. The only customer injection path (`tracingOptions.metadata`) lands
        // on Mastra's own spans by construction, so this stays a standalone
        // rename-proof disjunct: a scope+resource rename (both pin the npm package
        // name, so they rename together) degrades to `mastra`, not to unknown.
        || s.any_attr_prefix("mastra.")
}

// Deliberately `has_attr("mastra.span.type")` rather than `|_| true`: under the
// scope and resource clauses a hypothetical attribute-less span in the scope
// would correctly NOT be session-authoritative. The key is a total cover on the
// corpus, so the two are indistinguishable there.
fn mastra_session_authority(s: &SpanCtx) -> bool {
    s.has_attr("mastra.span.type")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.agent.id`: the trap here. A per-Agent-OBJECT uuid4 — the only
///   cross-trace constant in a single-agent capture, several distinct values inside
///   one workflow run, and a process-wide singleton in a server.
/// * `workflow.id`: per `WorkflowBuilder.build()`. Use it to stitch build→run,
///   never to define a session — a server builds once at import.
/// * `service.instance.id`: per-process uuid4.
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per LLM call / per tool call. The
///   tool-call id repeats across the HITL approval and the resumed tool span.
/// * `edge_group.id`: scoped to the workflow graph.
///
/// Traps:
///
/// * The OTLP protocol default is **grpc**, against the OTel spec's http/protobuf.
///   A customer pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at an HTTP collector and
///   setting nothing else captures NOTHING, silently. Highest-frequency onboarding
///   failure for this vendor.
/// * `gen_ai.provider.name` is a ClassVar of the emitting client class, not the
///   endpoint contacted. `server.address` carries the truth.
/// * Workflow message delivery is modelled with span LINKS, not parent/child, so a
///   parser walking only `parentSpanId` loses the causality. `SpanCtx` exposes no
///   link accessor — links are generic OTel and a dangerous fingerprint.
/// * The native approval gate emits nothing: a DENIED call produces no tool span at
///   all, and the only evidence is a string inside the next chat span's messages.
/// * Scope loss is this vendor's real cliff: `chat` spans carry no
///   framework-specific attribute at all, so there is nothing to conjoin on and
///   every token count degrades to `unknown:genai`. A
///   `gen_ai.provider.name == "openai"` rule is not the answer — openrouter carries
///   1,477 spans with that exact value.
pub const MICROSOFT_AGENT_FRAMEWORK: VendorDef = VendorDef {
    id: VendorId::MicrosoftAgentFramework,
    detect: detect_microsoft_agent_framework,
    keys: &["gen_ai.provider.name", "gen_ai.operation.name"],
    // `message.` is consulted only inside the guarded workflow-plumbing conjunct;
    // conjunct-only prefixes still have to be declared or the indexed path sees
    // them as absent (the prefilter self-consistency test pins that).
    prefixes: &[
        "agent_framework.",
        "executor.",
        "edge_group.",
        "message.",
    ],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            authority: |s| s.attr("gen_ai.operation.name") == Some("invoke_agent"),
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[
        // The framework's local-history sentinel. It guards against writing this
        // into its own session id, but an integration that feeds
        // `response.conversation_id` back in as the next run's option would stamp
        // it on every `invoke_agent` span as a process-wide constant.
        "agent_framework_local_history_persistence",
        // The telemetry layer's fallback when an identity cannot be resolved.
        // Never a session id.
        "unknown",
    ],
};

fn detect_microsoft_agent_framework(s: &SpanCtx) -> bool {
    // The framework's hardcoded default instrumenting module name — ONE scope for
    // agent, chat, tool, workflow, executor, edge-group and message spans. It must
    // stand alone: the `chat <model>` spans carry no framework-specific attribute
    // and nothing else here classifies them. Accepted cost: `get_tracer()` and
    // `create_workflow_span()` are PUBLIC API, so app-authored spans land in this
    // scope too.
    s.scope_name() == "agent_framework"
        // Value-PREFIX, not equality: the exact provider constant covers the
        // `invoke_agent` spans and the prefix additionally covers the framework's
        // harness agents. No non-MAF span carries a `gen_ai.provider.name` starting
        // with it, so it is a strict recall superset at zero cost. Subclasses that
        // REPLACE the value (A2A, github.copilot, anthropic.claude, azure.ai.foundry)
        // stay permanently unreachable by value — claiming `anthropic.claude` as MAF
        // evidence would steal Anthropic-SDK spans — and are covered by the scope.
        || s.attr("gen_ai.provider.name")
            .is_some_and(|value| value.starts_with("microsoft.agent_framework"))
        // The vendor's own attribute namespace, so it stays unconditional.
        || s.any_attr_prefix("agent_framework.")
        // `executor.*` and `edge_group.*` are NOT vendor-named: they are stock
        // scheduler vocabulary (Airflow, Spark, any task-queue app) — the same
        // genericity class as a bare `workflow.` prefix, which had to be dropped
        // after it fired on most of the corpus' eve_slack capture. The guard is
        // free: every `executor.process` span carries `message.type` and every
        // `edge_group.process` span `message.source_id`, so recall is identical
        // while a lone `executor.*` app key no longer classifies. Bare `message.`
        // deliberately stays out: the `message.send` spans remain scope-only false
        // negatives rather than letting one generic key claim a vendor.
        || ((s.any_attr_prefix("executor.") || s.any_attr_prefix("edge_group."))
            && s.any_attr_prefix("message."))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `service.instance.id`: stock OTel-Python per-process uuid4.
/// * `graph.node.id`: despite the name, the AGENT NAME copied verbatim — a
///   constant per agent definition.
/// * `llm.output_messages.0.message.tool_calls.0.tool_call.id` and its input
///   mirror: provider tool-call ids that repeat across the approval-pending and
///   executed spans of one HITL turn.
/// * `openinference.project.name`: a Phoenix PROJECT name — a deployment-wide
///   constant.
///
/// Traps:
///
/// * THE landmine: the SDK's documented session idiom (`trace(…, group_id=…)` /
///   `RunConfig.group_id`) is accepted, stored on the Trace object, exported to
///   OpenAI's own backend — and thrown away by the OTLP bridge, which reads only
///   `trace.name`. A customer who did exactly what the SDK told them produces 100%
///   unsessioned traces, with no error and no warning. Same for
///   `RunConfig.trace_metadata`.
/// * The SDK's own trace/span ids never reach OTLP either, so there is no way to
///   correlate a maple trace back to the OpenAI dashboard in either direction.
/// * Span names are customer text everywhere (workflow, agent and tool names), so
///   they are unusable as rules, and `llm.system` is the constant `openai`
///   regardless of the actual provider — only `llm.model_name` carries the truth.
/// * Native HITL fires correctly but is invisible: the PENDING span's
///   `output.value` is a multi-kilobyte Python `repr()` containing every tool's
///   JSON schema and live object addresses, and nothing marks which span is which.
/// * The only failure shape is an OTel status message holding a Python dict
///   literal — no exception event, no `error.type`. The parent chain stays OK.
/// * Without the OpenInference instrumentor nothing reaches an OTLP endpoint at
///   all, and `set_tracing_disabled(True)` kills the bridge too — the correct
///   wiring keeps SDK tracing enabled and REPLACES its processors.
pub const OPENAI_AGENTS_SDK: VendorDef = VendorDef {
    id: VendorId::OpenaiAgentsSdk,
    detect: detect_openai_agents_sdk,
    keys: &["openinference.span.kind"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // The authority is deliberately BROAD. Under `using_session()` — the only
        // configuration in which this vendor ever emits a session key — the
        // OpenInference tracer merges the context attributes into EVERY span's
        // start attributes, so the broad authority encodes the wire fact that every
        // span is a legitimate place to expect and read the key. Narrowing to the
        // workflow-root population would zero the key hash on most spans and
        // under-state the dropped-group-id landmine by default.
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// No attribute conjunct, deliberately: every span attribute this vendor emits is
// the generic OpenInference dialect shared by ~40 sibling instrumentors, and
// `llm.system` is the hardcoded literal "openai" even for Anthropic models — any
// attribute clause either adds nothing or steals sibling vendors' spans. On a
// scope rename the spans degrade to `unknown:openinference`, never to a wrong
// vendor.
fn detect_openai_agents_sdk(s: &SpanCtx) -> bool {
    // The instrumentor package's own module path; `scope.version` is the
    // INSTRUMENTOR release, never the SDK's. It catches every span including the
    // trace root, which carries a single attribute and is otherwise unclassifiable.
    //
    // EXACT equality, never `starts_with`: `openinference.instrumentation.openai` —
    // the synthesized `openinference-openai` vendor — is a string PREFIX of this
    // scope name, so prefix matching would make the two vendors evaluation-order-
    // dependent on each other's spans. The at-most-one-vendor tests plus both
    // vendors' adversarial-fixture cases pin both directions.
    s.scope_name() == "openinference.instrumentation.openai_agents"
}

/// Synthesized vendor — no framework seed owns it. `openinference.instrumentation.openai`
/// is a shared instrumentor other stacks load alongside their framework (the crewai
/// captures prove co-tenancy; the smoke test proves standalone use), so no framework
/// may claim it: a crewai rule on this scope would mislabel every OpenAI-SDK span in
/// the fleet.
///
/// It carries the token/model/prompt payload for crewai and any other host framework
/// that drives the OpenAI SDK — per-span vendor attribution means these spans are
/// `openinference-openai` even inside another vendor's trace.
pub const OPENINFERENCE_OPENAI: VendorDef = VendorDef {
    id: VendorId::OpeninferenceOpenai,
    detect: |s| s.scope_name() == "openinference.instrumentation.openai",
    keys: &[],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // The same OpenInference `using_session()` context mechanism as the
        // framework instrumentors.
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.scope_name() == "openinference.instrumentation.openai",
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per model call / per tool call.
/// * `service.instance.id`: OTel-Python's per-process uuid4, and in a multi-trace
///   capture the ONLY key spanning both traces — which is exactly the trap.
/// * `gen_ai.agent.name`: baggage-propagated to every child span, so it looks like
///   a per-run join key. It is a static agent NAME, constant per deployed agent.
///
/// Traps:
///
/// * `gen_ai.conversation.id` is on ~every span and is a FRESH UUIDv7 PER RUN
///   whenever the customer passes neither `conversation_id=` nor
///   `message_history=`, so presence is worthless as evidence of a session. Two
///   tells: the value is a UUIDv7 (customer-chosen ids usually are not), and it
///   partitions a trace exactly like the run id. The first is enforced by the
///   value-conditional granularity below; the second is trace-level and stays
///   documentation only.
/// * Sub-agents invoked as tools mint their OWN conversation id, so multi-agent apps
///   are session-fragmented unless the customer forwards `conversation_id` down.
/// * Propagation is in-process OTel BAGGAGE, not W3C headers: nothing is injected
///   into outbound HTTP, and only Pydantic AI's own three span types splice it in —
///   a span opened by CUSTOMER code inside an agent run gets no keys.
/// * `error.type` is NOT emitted — status plus the `exception` event are the only
///   error signal, so a presence rule on `error.type` finds nothing. The
///   declarative approval gate emits no span for the proposal or the denial;
///   only the APPROVED call produces a tool span.
/// * `logfire.json_schema` / `logfire.msg` are emitted with the Logfire SDK ABSENT
///   — they are a dialect, not a vendor tag, and would claim every span of any
///   Logfire-instrumented application. Tier 4 below uses `logfire.json_schema`
///   only inside a 3-way conjunction, never alone.
/// * `gen_ai.system` and `gen_ai.provider.name` hold the provider: there is no
///   `gen_ai.system` value that identifies Pydantic AI.
/// * There is NO framework-level notion of a trace spanning two top-level runs: an
///   N-step pipeline is N traces unless the customer opens their own parent span.
pub const PYDANTIC_AI: VendorDef = VendorDef {
    id: VendorId::PydanticAi,
    detect: detect_pydantic_ai,
    keys: &[
        "gen_ai.operation.name",
        "logfire.json_schema",
        "gen_ai.agent.call.id",
        "operation.cost",
        "model_request_parameters",
    ],
    prefixes: &["pydantic_ai.", "gen_ai.aggregated_usage."],
    span_names: &[],
    session_candidates: &[
        // Granularity is VALUE-CONDITIONAL: a strict-UUIDv7 value resolves at run
        // granularity (state 5), any other value at session granularity (state 6).
        // This is a span-local proxy for the blocked trace-level partition test —
        // pydantic mints `conversation_id = str(uuid7())` fresh PER RUN whenever the
        // customer passes neither `conversation_id=` nor `message_history=`, so a
        // UUIDv7 value is a run id wearing a session key. Two known, accepted
        // misses: a `message_history=`-threaded session inherits the first run's
        // UUIDv7 and is labeled run, and a customer minting their own UUIDv7 session
        // ids is labeled run — both label-only, since states 5 and 6 hash the same
        // value and joins are unaffected either way.
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            authority: |s| s.has_attr("gen_ai.operation.name"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: Some(|value| {
                if is_strict_uuidv7(value) {
                    Granularity::Run
                } else {
                    Granularity::Session
                }
            }),
        },
        // Pydantic's run id: a fresh UUIDv7 per run, never inherited from
        // `message_history`. In the demoted case above both candidates resolve at
        // state 5 and the tie-break keeps candidate order, so the hash is always
        // `cityHash64(gen_ai.conversation.id)` — the demotion moves the state label,
        // never the hash.
        SessionCandidateDef {
            key: "gen_ai.agent.call.id",
            authority: |s| s.has_attr("gen_ai.operation.name"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

/// Strict RFC 9562 UUIDv7 shape: `xxxxxxxx-xxxx-7xxx-Nxxx-xxxxxxxxxxxx`, hex
/// digits case-insensitive, version nibble exactly `7` and variant nibble in
/// `[89ab]`. Deliberately strict: a value that merely CONTAINS a UUID
/// (prefixed/suffixed customer id) is treated as customer-chosen and therefore a
/// session.
fn is_strict_uuidv7(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, &byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        14 => byte == b'7',
        19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => byte.is_ascii_hexdigit(),
    })
}

fn detect_pydantic_ai(s: &SpanCtx) -> bool {
    // Tier 1 — the library's hardcoded scope name, used for every span it emits.
    // The scope version IS the pydantic-ai package version. A pydantic-ai app that
    // adopts Logfire still emits this scope (Logfire only supplies the
    // TracerProvider), so tier 4 is purely the scope-rewrite fallback.
    s.scope_name() == "pydantic-ai"
        // Tier 2 — the vendor's own namespace, for a rewritten or dropped scope.
        // Also catches the deferral path's `pydantic_ai.tool.deferral.name`.
        || s.any_attr_prefix("pydantic_ai.")
        // Tier 3 — Pydantic-invented, documented non-semconv usage namespace. Same
        // carrier population as tier 2; kept because each survives a rename of the
        // other. If semconv ever standardizes this exact prefix, the
        // at-most-one-vendor test is the tripwire.
        || s.any_attr_prefix("gen_ai.aggregated_usage.")
        // Tier 4 — the logfire co-signal conjunction, recovering the
        // chat/execute_tool population on scope loss. `logfire.json_schema` is a
        // cross-vendor dialect stamped on every span of any Logfire-instrumented
        // app and `gen_ai.operation.name` is the unknown tier itself, so neither is
        // ever safe alone. The third conjunct is pydantic-specific co-evidence
        // guarding against a future Logfire-dialect emitter adopting gen_ai
        // semconv — a structural, not corpus-visible, risk. `operation.cost` is the
        // only one of the three that reaches embeddings spans, which carry no
        // baggage and therefore no `gen_ai.agent.call.id`.
        || (s.has_attr("logfire.json_schema")
            && s.has_attr("gen_ai.operation.name")
            && (s.has_attr("gen_ai.agent.call.id")
                || s.has_attr("operation.cost")
                || s.has_attr("model_request_parameters")))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.agent.id`: THE decoy — session-shaped on the wire but per-agent-OBJECT
///   identity, so in a server one agent serves every user while in an orchestration
///   it splits one logical run across a value per worker. It has no relationship to
///   the thread that carries conversation state.
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per LLM call / per tool call.
///   Retries do NOT reuse the tool-call id, so it cannot group retry attempts.
/// * `messaging.destination`: looks like a durable actor address and is the ONLY
///   attribute shared across an orchestration run's fragmented traces — the most
///   tempting stitch key in the corpus. Per-run and per-actor.
/// * `service.instance.id`: per-process uuid4.
/// * `CHAT_MESSAGE_INDEX` (log records only): a within-request message ordinal.
///
/// Traps:
///
/// * SILENT ZERO: the diagnostics env vars must be set BEFORE the first
///   `import semantic_kernel` — they are read into module-level constants and never
///   re-read. Set later, the trace is not empty, it is silently GenAI-less. Expect
///   customer reports of "SK sends telemetry but no LLM data".
/// * `gen_ai.system` is the CONNECTOR class constant `openai` even for Anthropic
///   models, which is why an equality test on it must NEVER be an SK matcher — it
///   would steal every genuine OpenAI-SDK span.
/// * SK's values are off-semconv: `gen_ai.operation.name` is
///   `chat.completions`/`chat.streaming_completions`, and
///   `gen_ai.response.finish_reason` is a Python enum repr (`FinishReason.STOP`) in
///   a singular key holding a comma-joined LIST. `server.address` is a full URL.
/// * Falsy execution settings are filtered out with a bare truthiness test, so
///   `temperature=0` is silently ABSENT and a genuine 0-token count is dropped
///   rather than recorded. Absence does not mean the caller left the default.
/// * Every native span name is templated with unbounded data (agent name, model,
///   plugin/function, and a per-run orchestration GUID), so span-name grouping and
///   any span-name rule are unusable — this vendor has no span-name predicate.
/// * SK's in-process runtime does NOT continue the caller's trace across its actor
///   message bus: it computes a null context and starts a BRAND NEW TRACE, attaching
///   span LINKS instead. One orchestration run can be ten traces, so anything
///   trace-level is wrong for orchestrated SK by construction.
/// * SK Python has no tool-approval / interrupt / resume primitive at all, and a
///   filter denial still produces a full OK-status tool span. HITL is invisible.
/// * With shipped defaults three of the five scopes never emit, so a customer who
///   wires an OTLP exporter and no env vars sends SK traces consisting solely of
///   `AutoFunctionInvocationLoop` and `agent_runtime` spans — vendor-classifiable,
///   GenAI-empty, and invisible to the unknown tier too. Do NOT "fix" that by
///   dropping the scope clauses: un-classifying them loses them entirely.
pub const SEMANTIC_KERNEL: VendorDef = VendorDef {
    id: VendorId::SemanticKernel,
    detect: detect_semantic_kernel,
    keys: &[
        "gen_ai.operation.name",
        "sk.available_functions",
        "gen_ai.response.finish_reason",
    ],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[],
    decoy_values: &[],
};

fn detect_semantic_kernel(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // SK's four tracers are all `get_tracer(__name__)` calls, so the scope name IS
    // the dotted module path inside the semantic_kernel package — library-owned and
    // unproducible by app code. A prefix rather than an enumeration of the four
    // module paths: the module-path rename is the highest-probability future
    // breakage for this vendor, and the prefix survives any refactor and any fifth
    // call site.
    if scope.starts_with("semantic_kernel.") {
        return true;
    }

    // The pathological scope: `agent_runtime ` plus a runtime name, with a literal
    // SPACE and no vendor namespace. The trailing space is load-bearing. Pinning
    // the one shipped runtime's name instead would make any other runtime a silent
    // total miss — its spans carry only `messaging.*` keys, and a generic
    // `messaging.` rule would sweep in every Kafka/RabbitMQ span in a real app.
    // Residual risk, accepted: the tracing helpers are PUBLIC exports, so a
    // third-party runtime reusing SK's telemetry code is attributed to SK —
    // one-directional, and arguably correct since it IS SK's telemetry code.
    if scope.starts_with("agent_runtime ") {
        return true;
    }

    // ---- scope-loss fallbacks (a collector/bridge rewrote or dropped the scope) ----

    // The exact key, not an `sk.` prefix: this is the only `sk.*` key SK emits, so
    // recall is identical while the false-positive surface shrinks from "any app
    // key starting with two letters" to "an app minting this exact 26-char key". A
    // future second `sk.*` key would ride on spans inside a `semantic_kernel.*`
    // scope and be caught above anyway. This is the ONLY signal on
    // `AutoFunctionInvocationLoop` spans, which carry no `gen_ai.*` key at all.
    if s.has_attr("sk.available_functions") {
        return true;
    }

    // SK-invented operation value, not an OTel semconv value; every other vendor
    // emits "chat".
    if s.attr("gen_ai.operation.name") == Some("chat.streaming_completions") {
        return true;
    }

    // The non-streaming twin. `chat.completions` alone is generic enough to collide
    // with other vendors, which is what the conjunction fixes: the co-evidence is
    // SK's Python-enum-repr bug — it joins `str(fr)` over `FinishReason` enum
    // members, so the value arrives as `FinishReason.STOP` instead of a semconv
    // value, and `FinishReason.`-prefixed values appear nowhere else in the corpus
    // (openrouter carries the same singular key on thousands of spans, all with
    // plain semconv values). If SK ever fixes the enum repr this clause goes quiet
    // and those spans degrade to `unknown:genai`.
    s.attr("gen_ai.operation.name") == Some("chat.completions")
        && s.attr("gen_ai.response.finish_reason")
            .is_some_and(|value| value.starts_with("FinishReason."))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `service.instance.id`: OTel-Python's per-process uuid4.
/// * `metadata`: the third slot of the same `using_attributes` call that carries
///   `session.id`, so it rides every span and looks first-class. It is an opaque
///   customer JSON blob that CHANGES per turn inside one session.
/// * `tag.tags`: fourth slot of the same call — per-call labels, not identity.
/// * `llm.output_messages.0.message.tool_calls.0.tool_call.id`: per tool call.
/// * `openinference.project.name`: a deployment-wide constant.
///
/// Traps:
///
/// * smolagents contains ZERO telemetry code. Everything maple will ever see is
///   authored by the third-party OpenInference instrumentor, so the framework
///   version is never on the wire and span shapes track the instrumentor.
/// * The instrumentor patches Model subclasses by scanning the smolagents module at
///   instrument() time, so a customer's own Model subclass — the normal way to wire
///   a private gateway — is NEVER traced: the trace keeps its AGENT/CHAIN/TOOL spans
///   and silently loses every LLM span. That is not an error, it is this case.
/// * There is no agent name/id/role attribute: agent identity lives only in the span
///   name, and every `@tool`-decorated function produces a span literally named
///   `SimpleTool`. `tool.name` carries the real tool name; span names are not rules.
/// * `smolagents.task` is OFF BY ONE when an agent is reused: the wrapper reads the
///   task before the wrapped `run()` assigns it, so it holds the PREVIOUS turn's
///   text. Use `input.value` on the same span instead.
/// * OpenInference's session propagation is a plain contextvar only its own tracer
///   reads — a span created with a stock tracer inside the very same
///   `using_attributes(...)` block gets nothing, so any customer-authored or
///   third-party span in a smolagents trace is session-blind.
/// * `agent.run(reset=False)` preserves MEMORY, not the trace: every run opens a new
///   trace and smolagents exposes no run/thread/conversation id, so cross-turn
///   correlation exists ONLY through the customer-supplied `session.id`.
/// * There is no approval/interrupt-and-resume mechanism: `interrupt()` aborts a
///   run, it cannot suspend a pending tool call. Expect no native HITL signal.
pub const SMOLAGENTS: VendorDef = VendorDef {
    id: VendorId::Smolagents,
    detect: detect_smolagents,
    keys: &["openinference.span.kind"],
    prefixes: &["smolagents."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        SessionCandidateDef {
            key: "user.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// The honest ceiling is on the record: on scope rewrite or loss, ~85% of this
// vendor's spans (every step, model and tool span) carry NOTHING
// smolagents-specific — outside `smolagents.*` there is no key either capture
// holds that another OpenInference vendor would not also emit — and they fall to
// `unknown:openinference`. That degradation is correct: loss of the vendor label
// only, never silent total loss, and any attribute-only rule for those spans would
// be an invented fingerprint.
fn detect_smolagents(s: &SpanCtx) -> bool {
    // The instrumentor module's own `__name__`, not app-derivable (the customer
    // supplies only a TracerProvider). It is also the ONLY signal that classifies
    // the LLM/TOOL/CHAIN populations, so gating it on attribute evidence would
    // leave most of this vendor's spans unattributed. EXACT equality also refuses a
    // scope like `trace-capture.smolagents`, which CONTAINS the substring
    // `smolagents` — a contains/suffix scope rule would wrongly claim it.
    s.scope_name() == "openinference.instrumentation.smolagents"
        // The vendor's own namespace, a scope-loss fallback reaching only the AGENT
        // spans (nothing else carries a `smolagents.` key).
        || s.any_attr_prefix("smolagents.")
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.response.id`, `spring.ai.tool.call.id`: per LLM call / per tool call.
///
/// Traps:
///
/// * The instrumentation scope identifies SPRING BOOT, not Spring AI: `scope.name`
///   is `org.springframework.boot` and `scope.version` is the Boot version. A Boot
///   app with no Spring AI on the classpath emits spans in the identical scope —
///   the strongest argument in the corpus for attribute-based classification.
/// * `gen_ai.system` is the CLIENT implementation, not the provider: Anthropic
///   models routed through the OpenAI-compatible client report `openai`.
/// * A trace's first record can contain only the HTTP POST span — neither a
///   classifiable span nor the session key — so a first-batch classifier sees that
///   trace as non-AI for one batch.
/// * Spring AI produces no ERROR-status span: the default exception processor
///   swallows tool exceptions and feeds the message back to the model, so a failing
///   tool span ends OK with the error text in `spring.ai.tool.call.result`.
/// * About a quarter of native spans are advisor bookkeeping with no AI payload,
///   and one span name is malformed by a Spring AI name-derivation bug (the literal
///   `tool _calling `, stray underscore and trailing space). Span-name rules must
///   not be used.
pub const SPRING_AI: VendorDef = VendorDef {
    id: VendorId::SpringAi,
    detect: detect_spring_ai,
    keys: &["gen_ai.system", "spring.ai.kind"],
    prefixes: &["spring.ai."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "spring.ai.chat.client.conversation.id",
            authority: |s| s.attr("spring.ai.kind") == Some("chat_client"),
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[
        // ChatMemory's documented default conversation id. Not observed on the wire
        // (the convention omits the key when unset), but an integration passing the
        // literal default into the advisor param would produce a process-wide
        // constant that must never be joined on.
        "default",
    ],
};

fn detect_spring_ai(s: &SpanCtx) -> bool {
    // Spring AI's own attribute namespace: `spring.ai.kind`, `spring.ai.advisor.*`,
    // `spring.ai.tool.*`, `spring.ai.chat.client.*`, and the future
    // embedding/image/vector-store conventions, which also emit `spring.ai.kind`.
    s.any_attr_prefix("spring.ai.")
        // The OTel-semconv-shaped form of the same fact; survives a `spring.ai.*`
        // rename. A customer stamping `gen_ai.system="spring_ai"` on their own
        // Observations is claiming the vendor namespace and gets classified
        // accordingly.
        || s.attr("gen_ai.system") == Some("spring_ai")
        // Tool-less ChatModel spans carry the full `gen_ai.*` block and NO
        // `spring.ai.*` key, because the tool-names attribute is omitted when no
        // tool callbacks are configured. The negative form ("not an
        // io.opentelemetry.instrumentation scope AND gen_ai.system == openai") is
        // banned by the corpus: openrouter carries 1,477 spans with that value under
        // its own scope. The Boot scope is usable ONLY as a conjunct — alone it
        // would also claim the plain HTTP CLIENT spans in these very captures and
        // every Spring MVC / RestClient / JDBC / @Observed span in a real app.
        || (s.scope_name() == "org.springframework.boot"
            && s.attr("gen_ai.system") == Some("openai"))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `event_loop.parent_cycle_id`: looks like a parent pointer and is WRONG under
///   concurrency — the invocation state dict is SHARED across every graph node
///   running as its own task, so it routinely names another agent's cycle. Never
///   use it to reconstruct causality.
/// * `event_loop.cycle_id`: a fresh uuid4 per event-loop cycle — sub-run
///   granularity, changing several times inside one turn.
/// * `gen_ai.tool.call.id`: deliberately REPEATS across the interrupted and resumed
///   copies of the same tool span, which makes it look like a cross-trace
///   correlation key. It correlates one tool call.
/// * `service.instance.id`: per-process uuid4, the most convincing decoy here.
/// * `gen_ai.agent.name`: a role name shared by every session that agent serves.
///
/// Traps:
///
/// * `gen_ai.usage.*` on `invoke_agent` spans is the Agent instance's LIFETIME
///   total, not the turn's, so summing them across a session over-counts several
///   fold. Sum the `chat` spans instead. An opt-in flag silently inverts which of
///   the two is right, with no attribute to tell them apart.
/// * The native interrupt stops the event loop and returns; resuming requires a new
///   agent call, which opens a NEW root trace. The interrupted tool span is exported
///   with status OK and no tool status, and a second span with the same tool-call id
///   appears in the resume trace with the real outcome. Any tool-call count or
///   duration rollup double-counts the abandoned copy; classification is unaffected.
/// * `gen_ai.system` is the constant `strands-agents` — the framework, never the
///   model vendor. Convenient for classification, useless for provider attribution.
/// * Strands emits no span for the model HTTP request; latency attribution below
///   `chat` needs separate instrumentation, whose spans belong to another vendor.
/// * `session.id` is on the wire only because the customer passed it through
///   `Agent(trace_attributes=…)` — the literal string appears nowhere in
///   strands-agents. A span-local static rule cannot know the customer's chosen key
///   name; the hardcoded candidate is kept because it IS the key AgentCore's ADOT
///   layer injects for free. The general fix is per-org overlay rules.
pub const STRANDS: VendorDef = VendorDef {
    id: VendorId::Strands,
    detect: detect_strands,
    keys: &[
        "gen_ai.system",
        "gen_ai.provider.name",
        // The guard on the `event_loop.` fallback.
        "gen_ai.operation.name",
    ],
    prefixes: &["event_loop."],
    span_names: &[],
    session_candidates: &[
        SessionCandidateDef {
            key: "session.id",
            authority: |s| {
                s.attr("gen_ai.system") == Some("strands-agents")
                    || s.attr("gen_ai.provider.name") == Some("strands-agents")
            },
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

fn detect_strands(s: &SpanCtx) -> bool {
    // The tracer module sets its service name to `__name__`, so the scope name IS
    // the dotted module path inside the strands package — not influenceable by the
    // app, and it reaches the `invoke_graph` root, which carries only three
    // attributes. `get_tracer()` is called with no version, so `scope.version` is
    // EMPTY and can never detect the SDK release.
    s.scope_name() == "strands.telemetry.tracer"
        // ONE expression, two semconv flavours: the tracer emits `gen_ai.system` on
        // the legacy branch and `gen_ai.provider.name` INSTEAD on the experimental
        // branch — mutually exclusive, one fact, which is why they live in one
        // predicate rather than as two rules that could later be ranked apart. The
        // value is the FRAMEWORK name. Exact equality, never substring or prefix, so
        // openrouter's `gen_ai.system="openai"` spans are untouched.
        || s.attr("gen_ai.system") == Some("strands-agents")
        || s.attr("gen_ai.provider.name") == Some("strands-agents")
        // `event_loop.` is NOT a vendor-named namespace: "event loop" is generic
        // async-runtime vocabulary and an asyncio/uvloop monitoring instrumentation
        // emitting `event_loop.*` keys is entirely plausible. The guard cannot be
        // strands' OWN evidence without collapsing into the two clauses above (the
        // point of a prefix tier is to survive a `gen_ai.*` rename), so it is
        // generic-AI evidence instead: every `event_loop.*` span carries
        // `gen_ai.operation.name`, and both semconv flavours emit that key. Zero
        // recall cost, and an asyncio-monitor span has no `gen_ai.*` at all.
        || (s.any_attr_prefix("event_loop.") && s.has_attr("gen_ai.operation.name"))
}

/// Decoy keys — never consult these as session candidates:
///
/// * `gen_ai.response.id`, `gen_ai.tool.call.id`: per LLM call / per tool call.
/// * `gen_ai.agent.name`, its legacy twin `ai.telemetry.functionId`, the SPAN
///   attribute literally named `resource.name`, and `operation.name`: four spellings
///   of the same process-lifetime constant derived from `telemetry.functionId`.
///
/// Traps:
///
/// * SILENT ZERO: AI SDK v7 removed the per-call telemetry switch — telemetry now
///   needs a separate package registered once at startup, and without it the SDK
///   emits no spans, no warning and no error. Every v5/v6 integration guide still in
///   circulation produces a silently empty pipeline on v7.
/// * TWO DIALECTS, ONE VENDOR: the same library ships two mutually exclusive span
///   schemas with different span names, tree shapes and attribute namespaces. Scope
///   name (`gen_ai` vs `ai`) is the ONLY clean discriminator — legacy spans also
///   carry `gen_ai.*` attributes, so attribute-presence detection fails, and both
///   integrations can be registered at once into one trace.
/// * `gen_ai.provider.name` is the CLIENT ROUTE, not the model vendor;
///   `ai.response.providerMetadata` (opt-in) reveals the real upstream. Span names
///   embed the MODEL ID, never the agent, so attributing a `chat` or
///   `execute_tool` span to an agent requires walking the parent chain.
/// * DOCS BUG: the docs document runtime context landing as
///   `ai.settings.runtimeContext.*`; the source emits `ai.settings.context.*` in both
///   dialects. A session rule built from the docs joins on a key that does not exist.
/// * `enrichSpan` (GenAI dialect only) is a second, undocumented injection point
///   applied to EVERY span type at creation — the only way a customer can get a
///   session key onto the token-bearing spans. Its keys are entirely app-chosen, so
///   it is invisible to any closed-key rule.
/// * The legacy dialect DROPS the post-approval tool span; the GenAI dialect parents
///   it to `invoke_agent` (the trace root), not to a `step`. Native HITL emits no
///   approval span, event or attribute in either dialect.
/// * ONE TRACE PER `generate()` CALL — a HITL approval resume is a second call and
///   therefore a second trace. Any notion of turn, conversation or workflow must
///   come from a customer span or the session key.
/// * Unverified, no capture and no source here: apps on Vercel with OTel Trace Drains
///   are reported to receive `vercel.*` attributes. If real, that is a HOSTING signal
///   and must not become a vendor matcher — a self-hosted AI SDK app emits none of it.
pub const VERCEL_AI_SDK: VendorDef = VendorDef {
    id: VendorId::VercelAiSdk,
    detect: detect_vercel_ai_sdk,
    keys: &["gen_ai.operation.name", "gen_ai.execute_tool.duration"],
    prefixes: &["ai."],
    span_names: &[],
    session_candidates: &[],
    decoy_values: &[],
};

// This vendor is narrow BY CHOICE. A `scope == "gen_ai" && has_attr("gen_ai.operation.name")`
// disjunct was considered and rejected: it reads as a conjunction but is not one —
// `gen_ai.operation.name` is REQUIRED on every GenAI-semconv span, so the clause
// reduces to "a tracer named exactly `gen_ai` claims any GenAI span inside it", over
// a scope name that is customer data. An app that hand-rolls
// `trace.getTracer('gen_ai')` — the natural name, and the reason the SDK hardcoded it
// — would have had every LLM span attributed here, and no corpus capture can witness
// that failure. The cost is that default-config GenAI-dialect `chat` spans, which
// emit no supplemental `ai.*` for clause (A) to reach, stay `unknown:genai`: a known,
// accepted false negative.
fn detect_vercel_ai_sdk(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // (A) Both dialects: the `ai.*` attribute namespace, guarded by the SDK's two
    // hardcoded tracer names. Both are bare, unnamespaced, unversioned words that
    // any app hand-rolling an AI tracer would plausibly pick, so neither ever stands
    // alone — the vendor's own namespace is the other half. The guard is what
    // un-claims eve_slack's `ai.eve.turn` spans (scope `eve`, carrying
    // `ai.telemetry.functionId`), the corpus-proven false positive, which now falls
    // through to the unknown tier's `ai.` fingerprint.
    ((scope == "ai" || scope == "gen_ai") && s.any_attr_prefix("ai."))
        // (B) Scope-independent AI-SDK-invented markers, kept for the custom-tracer
        // wiring, where the scope is app-chosen. `agent_step` is not a semconv
        // `gen_ai.operation.name` value and `gen_ai.execute_tool.duration` is
        // AI-SDK-invented (a duration stamped as a span attribute). Zero hits in
        // every other capture.
        || s.attr("gen_ai.operation.name") == Some("agent_step")
        || s.has_attr("gen_ai.execute_tool.duration")
}

/// The unknown tier: fingerprints that classify a span as AI without a vendor
/// match, bucketed into the reserved `unknown:*` vendors. Evaluated only when no
/// vendor matched, in this slice's order — which is load-bearing for the third
/// rule (see its comment).
pub const UNKNOWN_TIER: &[UnknownRuleDef] = &[
    UnknownRuleDef {
        bucket: VendorId::UnknownGenai,
        detect: |s| s.has_attr("gen_ai.operation.name"),
        keys: &["gen_ai.operation.name"],
        prefixes: &[],
    },
    UnknownRuleDef {
        bucket: VendorId::UnknownOpeninference,
        detect: |s| s.has_attr("openinference.span.kind"),
        keys: &["openinference.span.kind"],
        prefixes: &[],
    },
    // `input.value`/`output.value` fire ONLY in co-occurrence with an OpenInference
    // attribute. Both keys are unnamespaced English — `input.value` on a
    // form-handling span means nothing about AI — so the co-evidence is the whole
    // rule, in both of the family's spellings: the marker key
    // `openinference.span.kind` and the `llm.*` namespace its semconv defines
    // alongside it. That is why this rule sits ABOVE the bare `llm.` rule and not
    // at the end: a span carrying `input.value` + `llm.*` is OpenInference dialect
    // and belongs in `unknown:openinference`, not the `unknown:other` catch-all it
    // would otherwise fall into.
    UnknownRuleDef {
        bucket: VendorId::UnknownOpeninference,
        detect: |s| {
            (s.has_attr("input.value") || s.has_attr("output.value"))
                && (s.has_attr("openinference.span.kind") || s.any_attr_prefix("llm."))
        },
        keys: &["input.value", "output.value", "openinference.span.kind"],
        prefixes: &["llm."],
    },
    UnknownRuleDef {
        bucket: VendorId::UnknownOther,
        detect: |s| s.any_attr_prefix("llm."),
        keys: &[],
        prefixes: &["llm."],
    },
    UnknownRuleDef {
        bucket: VendorId::UnknownOther,
        detect: |s| s.any_attr_prefix("traceloop."),
        keys: &[],
        prefixes: &["traceloop."],
    },
    // Reachable because vercel_ai_sdk's `ai.` prefix evidence is conjunctive on
    // scope: an `ai.*`-prefixed span outside the AI SDK's own `ai`/`gen_ai` scopes
    // lands here — on the wire, eve_slack's `ai.eve.turn` trace roots.
    UnknownRuleDef {
        bucket: VendorId::UnknownOther,
        detect: |s| s.any_attr_prefix("ai."),
        keys: &[],
        prefixes: &["ai."],
    },
];

#[cfg(test)]
mod tests {
    use crate::ai_registry::{registry, Vendor};

    /// `packages/domain/src/ai/vendors.ts`, compiled in verbatim.
    ///
    /// The read path needs this vocabulary as a closed TypeScript union — the
    /// `AiVendor` column's domain — and reading the real file is the cheapest
    /// honest way to check it: no codegen, no build-step coupling, no generated
    /// file to keep in sync, and no second hand-kept copy that can agree with
    /// neither side. (A hand-copied list *was* the mechanism, and it made this
    /// test a tautology: the TypeScript file was unread by anything in either
    /// language.) `AI_VENDOR_LABELS` needs no check here — it is typed
    /// `Record<AiVendor, string>`, so a missing or extra label is a `tsc` error.
    ///
    /// Reaching out of the crate is safe **because this module is `cfg(test)`**:
    /// `cfg` strips the item before macro expansion, so `cargo build --release`
    /// never opens the path. That matters — `apps/ingest/Dockerfile` builds with
    /// `apps/ingest/` as its whole context, where `packages/` does not exist.
    const VENDORS_TS: &str = include_str!("../../../packages/domain/src/ai/vendors.ts");

    /// The string literals of `export const AI_VENDORS = [ … ] as const`, in
    /// file order.
    fn typescript_ai_vendors() -> Vec<&'static str> {
        let open = "export const AI_VENDORS = [";
        let start = VENDORS_TS
            .find(open)
            .expect("vendors.ts declares `export const AI_VENDORS = [`")
            + open.len();
        let body = &VENDORS_TS[start..];
        let end = body
            .find("] as const")
            .expect("vendors.ts closes AI_VENDORS with `] as const`");
        body[..end]
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.split('"').next())
            .collect()
    }

    #[test]
    fn slug_set_mirrors_the_typescript_vendors() {
        let emitted: Vec<&str> = registry().vendors().iter().map(Vendor::slug).collect();
        let typescript = typescript_ai_vendors();
        assert!(
            typescript.len() >= 20,
            "parsed only {} slugs out of vendors.ts — the array's shape changed \
             and this parser stopped seeing it: {typescript:?}",
            typescript.len()
        );
        assert_eq!(
            emitted, typescript,
            "the AiVendor slug set drifted from packages/domain/src/ai/vendors.ts — \
             update AI_VENDORS (and AI_VENDOR_LABELS) there"
        );
    }
}
