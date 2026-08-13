//! The AI vendor rule tables — vendor knowledge as code, now with genuine Rust
//! predicates (write-side plan v2 §1).
//!
//! One block per vendor: a `detect` **function** over [`SpanCtx`], ordered
//! session-key candidates whose `authority` is likewise a function, declared
//! prefilter hints, and decoy values. The rule *content* is still the 1:1
//! transcription from the retired `registry.json` artifact (registry_version 1),
//! which was compiled from the 20 wire-verified seeds in trace-capture
//! (`frameworks/<slug>/registry-seed.yaml`) plus one synthesized vendor. Each
//! block carries its seed provenance and the seed review's justifications and
//! caveats as doc comments — the review record lives next to the code that acts
//! on it. The wire evidence itself (captures, NOTES.md, verify-seed.ts) stays in
//! trace-capture.
//!
//! **Phase 1 transcribed; phase 2 fixed.** The first pass reproduced the v1
//! matcher semantics exactly — every `detect` was the OR of that vendor's old
//! matchers, with the old *insufficient* scope/resource matchers folded in as
//! `(sufficient_evidence) || (insufficient_evidence && attr_evidence)`, a
//! conjunct subsumed by `attr_evidence` alone and written out only as the record
//! of where a real gate had to go. Phase 2 (2026-08-13) went through every vendor
//! against its seed's `algebra_violations` and the fix queue and turned those
//! spots into genuine conjunctions, negations and value tests: generic scopes and
//! bare English keys are now guarded by vendor evidence, the rename-proof
//! fingerprints v1 could not express are live, and each block's doc comment
//! carries the adjudication (SHIPPED / DECLINED with wire evidence / DEFERRED
//! with the reason). Items still deferred are dated and point at the decision
//! that deferred them — there are deliberately no `TODO(phase-2)` markers left.
//! Classification is no longer byte-identical to v1; the fixture replay, the
//! corpus goldens and the FP ceilings are what pin the differences.
//!
//! ## Mapping from the retired phase-1 encoding
//!
//! * matcher (`class` + `PredicateDef`) → a call on the [`SpanCtx`] accessor the
//!   class named: `Attr` → [`SpanCtx::attr`]/[`SpanCtx::has_attr`]/
//!   [`SpanCtx::any_attr_prefix`], `Resource` → [`SpanCtx::resource`],
//!   `Scope`+`scope.name` pseudo-key → [`SpanCtx::scope_name`], span-name eq →
//!   [`SpanCtx::span_name`]. Class-directed lookup is therefore encoded in
//!   *which accessor the function calls* — a predicate that read only span
//!   attributes still reads only span attributes.
//! * `sufficient: true` → an unguarded disjunct of `detect`;
//!   `sufficient: false` → the `(insufficient && attr_evidence)` conjunct.
//! * the global priority ladder → the order of the [`VENDORS`] slice
//!   (first-match-wins; rationale on the slice), with the unknown tier
//!   ([`UNKNOWN_TIER`], its v1 internal order) evaluated only when no vendor
//!   matched.
//! * `AuthorityDef::AnyOf` → a plain `||` inside the authority function.
//!
//! Two vendor-set facts are baked in and not to be re-litigated (plan D2/D3):
//! `langgraph` is folded into `langchain`, and `openinference-openai` exists as
//! a synthesized vendor for the shared instrumentor scope.
//!
//! Interning of the declared hints, the generated prefilter and the validation
//! of these tables happen in [`crate::ai_registry`]; evaluation lives in
//! [`crate::ai_classifier`].

use crate::ai_classifier::SpanCtx;

/// The rules version stamped on every examined span (`AiRulesVersion`), including
/// non-AI ones. `0` is reserved for pre-rollout / flag-off rows, so this must
/// never be zero. Bump it on ANY semantic change to the tables in this module and
/// record the change in the changelog below — the rollup keeps
/// `RowRulesVersionMin/Max` per hour, so the version is what makes "these counts
/// were computed by v7 rules" auditable (write-side plan v2 §6, Rule lifecycle &
/// validation).
///
/// The changelog counts from **deployment**, not from development churn: a
/// version is a claim about rows already in the warehouse ("these counts were
/// computed by v7 rules"), and nothing here has ever been deployed, so the whole
/// pre-rollout pass is one version. Once v1 ships, that stops: any semantic
/// change to these tables after the first deploy bumps the constant and adds an
/// entry below, even a change that "only fixes a bug" — especially then, since a
/// fix is exactly what makes two hours of rows incomparable.
///
/// Changelog:
///
/// * `1` — the initial production ruleset: the 20 wire-verified seeds +
///   `openinference-openai`, **including** the phase-2 predicate fixes. Two
///   pre-rollout passes fed into it and neither bumped the version:
///   - the transcription of the retired `registry.json` artifact (its
///     `registry_version` 1; same emitted-column semantics) and the ENGINE rework
///     that followed (predicates as code, ordered first-match resolution), which
///     changed the rule representation and not one classification outcome — the
///     fixture goldens were byte-identical across it;
///   - the phase-2 RULE fixes, which *did* change outcomes, deliberately, one
///     reviewed golden diff at a time (trace-capture `docs/phase2-fix-queue.md`):
///     vercel_ai_sdk's scope-gated `ai.*` evidence (the `ai.eve.turn` false
///     positives eliminated, the `gen_ai`-scope true positives recovered),
///     litellm reduced to a scope-only detect, langchain's dropped resource
///     clause, crewai's bare-key conjunctions + foreign-OpenInference refusal +
///     broadened session authority, agno's presence-gated `session.id` branch,
///     haystack's exact span-name set, llamaindex's event-borne detect and
///     event-sourced run id, claude_agent_sdk's dot-boundary scope family and
///     conjunctive span-name/value-set clauses, pydantic_ai's UUIDv7-conditional
///     conversation-id granularity + hardened logfire tier, google_adk's
///     `invoke_workflow` authority disjunct, effect_ai's split span-name tier with
///     the ecosystem-evidence guard, spring_ai's Boot-scope conjunct,
///     semantic_kernel's scope prefix families + narrowed bare `sk.` key +
///     `FinishReason.` fallback, microsoft_agent_framework's provider value-prefix
///     and guarded plumbing prefixes, strands' guarded `event_loop.`, flue's
///     delegated-prompt authority guard, and the unknown tier's
///     `input.value`/`output.value` co-evidence rule.
pub const RULES_VERSION: u32 = 1;

/// The closed vendor set. A classification result is one of these — there is no
/// constructor from a string, so minting an unlisted slug (the
/// LowCardinality-cardinality and tenant-amplification bug the plan calls out) is
/// not expressible. Discriminants are the index into [`VENDORS`] +
/// the unknown buckets, in declaration order; the classifier packs them into
/// `u64` bitmasks via [`VendorId::index`].
///
/// The `Unknown*` variants are the reserved `unknown:` fingerprint buckets: they
/// are vendors for resolution purposes but carry no session-key rules, and no
/// seed may mint one (see [`UNKNOWN_TIER`]).
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
    UnknownGenai = 21,
    UnknownOpeninference = 22,
    UnknownOther = 23,
}

impl VendorId {
    /// Number of vendors including the unknown buckets.
    pub const COUNT: usize = 24;

    /// The bitmask/table index — discriminant order.
    pub fn index(self) -> usize {
        self as usize
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

/// The documented per-vendor session-key granularity (plan §1). `Session` is the
/// only granularity that resolves at state 6; the rest cap at state 5.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Granularity {
    Session,
    Run,
    User,
    Instance,
}

impl Granularity {
    /// State 6 is reserved for `session` granularity; `run`/`user`/`instance`
    /// resolve at state 5 (plan §2 step 5).
    pub fn resolved_state(self) -> u8 {
        match self {
            Self::Session => 6,
            _ => 5,
        }
    }
}

/// One ordered session-key candidate (plan §2 step 5): the span's state is the
/// `max` over all candidates, and the hash comes from the candidate that produced
/// the winning state, ties broken by candidate order.
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
    /// `non_empty` validation: an empty value is state 4, not resolved.
    pub require_non_empty: bool,
    /// `not_in_decoy_values` validation against the vendor's `decoy_values`.
    pub reject_decoy_values: bool,
    /// Span-EVENT attribute key read as the value source when the span-local
    /// `key` is absent (phase-2 LL2; llamaindex is the first user). Exact key,
    /// attr-first precedence, first event wins; validations apply to the event
    /// value exactly as to the attribute value. `None` = span attributes only.
    pub event_key: Option<&'static str>,
    pub granularity: Granularity,
    /// Value-conditional granularity (phase-2 P1; pydantic_ai is the first
    /// user): when set, the resolved granularity is computed from the
    /// VALIDATED value (non-empty / non-decoy checks have already passed)
    /// instead of the static `granularity`, which then documents the
    /// candidate's ceiling. Pure function of the value bytes — no context, so
    /// it stays span-local, order-independent and transport-stable by
    /// construction. `None` = the static granularity, which is every candidate
    /// but pydantic_ai's conversation id today.
    pub granularity_of_value: Option<fn(&str) -> Granularity>,
}

/// One vendor's rules. The doc comment on each `VendorDef` const is the seed
/// review's record: provenance, justifications, decoy keys and caveats.
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
///   name it compares must be declared. An undeclared key is invisible to the
///   fast path; the indexed-vs-direct differential turns that drift into a test
///   failure over the fixture/corpus (see `ai_classifier`'s module docs).
///   Session-candidate keys are data and interned automatically.
/// * **Monotone in span evidence.** The scope hoist evaluates `detect` once
///   with an empty span; a `true` there is reused for every span of the scope.
///   Every current predicate is monotone: they are ORs of positive tests, and
///   the phase-2 conjunctions only ever *narrow* a disjunct, which cannot make
///   an empty span match where a fuller one does not.
///
///   Two phase-2 negations exist and neither breaks the shortcut: crewai's
///   detect refuses a foreign `openinference.instrumentation.` scope, which is
///   negation on SCOPE evidence (constant across the hoist), and flue's
///   conversation-id `authority` rejects `flue.task.id`, which is a session
///   candidate — authorities are evaluated per span and never hoisted.
///   DEFERRED, 2026-08-13: a `detect` that negates SPAN evidence would still
///   need a per-vendor opt-out from the hoist. None was written in phase 2 and
///   none is planned, so the opt-out stays unbuilt rather than speculative —
///   this note is the contract that has to be honoured if one ever lands.
#[derive(Clone, Copy)]
pub struct VendorDef {
    pub id: VendorId,
    /// The span-local detection predicate (plan v2 §1).
    pub detect: fn(&SpanCtx) -> bool,
    /// Every exact attribute key the vendor's predicates consult.
    pub keys: &'static [&'static str],
    /// Every attribute-key prefix the vendor's predicates scan.
    pub prefixes: &'static [&'static str],
    /// Every exact span name the vendor's predicates compare against.
    pub span_names: &'static [&'static str],
    pub session_candidates: &'static [SessionCandidateDef],
    /// Literal values a candidate must not resolve to (`not_in_decoy_values`).
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
/// first-match-wins per span (write-side plan v2 §1), so the order is
/// load-bearing wherever two vendors' evidence co-occurs on one span. It is
/// derived from the retired v1 priority ladder — specifically, the ordering that
/// ladder actually produced on every overlapping span of the corpus, the
/// vendored classification fixture and the adversarial fixture —
/// which reduces to two principles:
///
/// * **Specific instrumentor scopes before generic dialect families.** A vendor
///   claimed by its own library-owned scope (or, for mastra, its self-minted
///   resource) must outrank another vendor's attr evidence riding under that
///   scope — v1's `3xxxx` sufficient band beat every `2xxxx` attr hit.
///   `claude_agent_sdk` leads because the adversarial fixture pins its scope
///   against five other vendors' attrs on one span
///   (`oversized/spilled_registry_keys`), and the three vendors with no
///   standalone scope/resource evidence at all (`effect_ai`, `spring_ai`,
///   `vercel_ai_sdk` — dialect families detected by span evidence alone) come
///   last, in their v1 attr-priority order.
/// * Within that, vendors keep their v1 sufficient-matcher priority order, with
///   two placements pinned by the adversarial fixture: `mastra` precedes `agno`
///   (mastra's self-minted resource beat agno's `agno.` attr family) and
///   `openinference-openai` precedes `crewai` (its scope beat crewai's bare
///   `task_key` attr).
///
/// Real wire data never exercises the order: the at-most-one-vendor tests hold
/// with **zero** overlapping spans over the vendored fixture and the whole
/// corpus (10,886 spans), before and after phase 2. Only the adversarial
/// fixture constructs multi-vendor spans, and this order reproduces the v1
/// ladder's winner on every one of them.
///
/// Phase 2's conjunctions shrank that set — crewai's guarded `task_key` no
/// longer contests `openinference.instrumentation.openai`'s scope, for one —
/// and **4 constructed spans still carry two or more vendors' evidence**
/// (measured 2026-08-13): `cross_vendor/mastra_resource_vs_agno_attr`,
/// `cross_vendor/two_attr_bands`,
/// `cross_vendor/sufficient_scope_with_foreign_system` and
/// `oversized/spilled_registry_keys`. DEFERRED, deliberately: each is a genuine
/// collision between two vendors' *own* namespaced evidence stapled onto one
/// span (mastra's self-minted resource vs `agno.`; `spring.ai.` vs `mastra.`;
/// google_adk's scope vs `gen_ai.system=langchain`), so removing the overlap
/// would mean weakening a rule that is correct in isolation, on evidence no
/// wire capture has ever produced. The order stays load-bearing for exactly
/// those shapes, which is why it is written down here and pinned by the
/// fixture.
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

/// Seed: frameworks/agno/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `agno.agent.id` (wire): The Agent object's id (agno/_runs_wrapper.py:168). CONSTANT across
///   all 6 traces of agno_user ("user-assistant") — the single most convincing false session
///   key in this framework: root-only, stable across turns, stable across the whole process,
///   and adjacent to the real key in the same namespace. It is agent identity: two concurrent
///   users of the same Agent share it.
///
/// * `agno.team.id` (wire): Team analogue of agno.agent.id ("research-orchestrator",
///   _runs_wrapper.py:145). Same trap, and it is the key on the agno_agents ROOT span, so a
///   root-only reader is maximally likely to grab it.
///
/// * `graph.node.id` (wire): Looks like a durable node identity but is regenerated per
///   execution (_generate_node_id() at every start_span): 6 distinct values for the SAME agent
///   across agno_user's 6 turns. Per-run, not per-node and not per-session.
///   graph.node.parent_id points at another such ephemeral id.
///
/// * `service.instance.id` (wire): OTel-SDK-minted uuid4, one per PROCESS. Constant within a
///   capture and session-shaped, but it is process identity — in a long-lived server it is
///   constant across every session forever.
///
/// * `llm.input_messages.N.message.tool_calls.M.tool_call.id` (wire): Provider tool-call ids
///   echoed into the message history; they repeat across the HITL request/resume span pair,
///   which makes them look like a correlation key. They correlate one tool call, not a session.
///
/// # Caveats (the seed review's rationale record)
///
/// * `session_id_default_is_instance_granularity`: The corpus' sharpest session trap.
///   agno/agent/_session.py:52-58 mints a uuid4 when no session_id is passed AND assigns it
///   back to the Agent instance ('sticky'), so session.id is ALWAYS present (verdict A) but in
///   a long-lived server sharing one Agent object it is a single constant for every user and
///   every conversation, indistinguishable on the wire from a well-behaved per-conversation id.
///   No validation token can detect this — it is well-formed, non-empty and not a sentinel.
///   NOTES.md previously claimed the key appears only when the app passes session_id=; the
///   source says otherwise and this seed follows the source.
///
/// * `continue_run_is_uninstrumented`: openinference-instrumentation-agno 1.0.1 wraps the four
///   _run entry points and nothing on the resume path, so agent.continue_run() — agno's OWN
///   native HITL completion call — emits no AGENT span. Its LLM and tool spans surface as
///   parentless roots in fresh traces with neither session.id nor agno.run.id. In agno_user
///   this is 3 spans / 3 traces (33% of the traces, 100% of the approval-execution evidence).
///   The denied turn's rejection and the approved turn's actual delete_file execution are both
///   stranded. This is a fixture of a real upstream gap, not a harness artefact.
///
/// * `context_leak_merges_top_level_runs`: The instrumentor uses start_span +
///   use_span(end_on_exit=False) and does not detach cleanly on the async path, so a subsequent
///   top-level run inherits the previous run's context. In agno_agents summary_agent.arun (a
///   completely separate await summarizer.arun call) is parented to research_orchestrator.arun
///   and the whole process lands in ONE trace — with the child STARTING 3 ms AFTER its parent
///   ENDED (parent +0..12245 ms, child +12248..15391 ms). Consumers must tolerate children
///   whose time range falls outside the parent's, parent durations that do not bound their
///   subtree, and unrelated sibling runs silently merged. This also produces the root_middle
///   arrival: the root ends before its last children.
///
/// * `root_middle_arrival`: agno_agents is the corpus' root-middle case: the root
///   research_orchestrator.arun arrives in record seq 2 of 4 because it ended before
///   summary_agent.arun (which the context leak reparented under it) even started. A root-
///   anchored ingest path would have to buffer past the root's arrival, not just until it — the
///   assumption 'the root is the last span of its trace' fails here in the opposite direction
///   from BatchSpanProcessor's usual root-last ordering.
///
/// * `token_count_total_only_on_ainvoke`: llm.token_count.total is set ONLY in the ainvoke
///   wrapper (_model_wrapper.py:519-520); the invoke, invoke_stream and ainvoke_stream wrappers
///   omit it while all four set prompt/completion. Wire-confirmed: 0/9 LLM spans in agno_user
///   (sync run()) vs 9/9 in agno_agents (async arun()). Any dashboard reading
///   llm.token_count.total silently reports zero total tokens for every synchronous agno app;
///   prompt+completion must be summed instead.
///
/// * `span_names_do_not_identify_the_model`: LLM span names are the agno CLASS
///   (OpenRouter.invoke / OpenRouter.ainvoke) for every model — agno_agents mixes
///   openai/gpt-4o-mini (6) and anthropic/claude-haiku-4.5 (3) under one span name. Only
///   llm.model_name carries the truth, and llm.provider is the agno class name 'OpenRouter',
///   not a semconv provider value. Reinforces that span-name rules are useless here (and this
///   seed writes none).
///
/// * `zero_gen_ai_by_default`: Under default config agno emits NOT ONE gen_ai.* attribute
///   across all 37 spans — it is a pure OpenInference-dialect framework. Any ingest path that
///   keys AI-ness on gen_ai.operation.name sees zero agno spans. Only the openinference-genai-
///   semconv variant changes this, and it is off by default.
///
/// * `all_spans_internal_no_events`: 37/37 spans are kind=1 (INTERNAL); no SERVER/CLIENT spans,
///   no span events, no logs, no metrics. The one ERROR span (fetch_transport_data, code=2 with
///   message 'transport data service unavailable (503)') is native agno: the tool raises,
///   FunctionCall records the failure, the parent AGENT span stays OK and the run degrades
///   gracefully. Span kind carries zero classification signal.
///
/// * `attribute_typing_is_mixed`: Unlike the Java frameworks, values keep their OTLP types:
///   token counts arrive as intValue, llm.tools.N.tool.json_schema / llm.invocation_parameters
///   / tool.parameters / agno.tools as JSON stringValue. Canonical stringification (the
///   verifier's rule) is what makes eq() comparable across them.
///
/// Config variants that change the wire shape (`openinference-genai-semconv`, `using-session-
/// context-manager`): recorded in full in the seed's `variants:` block — re-read it before
/// touching this vendor's rules.
pub const AGNO: VendorDef = VendorDef {
    id: VendorId::Agno,
    detect: detect_agno,
    keys: &["openinference.span.kind", "session.id"],
    prefixes: &["agno.", "agno.workflow."],
    span_names: &[],
    session_candidates: &[
        // verdict: A.
        SessionCandidateDef {
            key: "session.id",
            authority: agno_session_id_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: A.
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
    // owned_by: library, source: wire.
    // The scope name is the instrumentor's own module path, passed as get_tracer(__name__,
    // __version__, tracer_provider) in openinference/instrumentation/agno/__init__.py —
    // library-owned, namespaced, per-package (each openinference-instrumentation-* artifact
    // gets its own scope, so there is no cross-vendor collision inside the OpenInference
    // family). It catches 17/17 + 20/20 spans, including the 11 + 15 LLM/TOOL spans that
    // carry no agno.* attribute at all and the 3 continue_run orphans. The instrumentor
    // only wraps agno agent/team/workflow/tool/model entry points, so no non-AI span can
    // land in this scope.
    s.scope_name() == "openinference.instrumentation.agno"
        // source: wire.
        || s.any_attr_prefix("agno.")
}

/// Authority for `agno.run.id`: AGENT-kind spans, or the workflow-key
/// population (a v1 `AnyOf`, now a plain `||`). No presence branch here —
/// `agno.run.id` is written only by _runs_wrapper.py:350-351 /
/// _workflow_wrapper.py:176 and never spread by the context mechanism, so a
/// presence branch would be dead code.
fn agno_session_authority(s: &SpanCtx) -> bool {
    s.attr("openinference.span.kind") == Some("AGENT") || s.any_attr_prefix("agno.workflow.")
}

/// Authority for `session.id`: [`agno_session_authority`] plus a presence-gated
/// branch (phase-2 A3, integration decision). Under the seed's
/// using-session-context-manager variant, get_attributes_from_context() splices
/// session.id onto LLM and TOOL spans too (_model_wrapper.py:370,427,498,561,
/// _tools_wrapper.py:101,161) — the only customer-side mechanism that puts a
/// session key on the continue_run orphans — and the v1 authority reported
/// those spans state 2 with a valid key in hand. The branch is presence-gated,
/// so state-3 reachability is preserved (an AGENT span missing the key still
/// reports 3, and a span matching only this branch has the key by construction,
/// landing at 4 or 6). Golden-neutral: under default config session.id lives
/// only on AGENT spans (6/17 + 5/20 wire). Deviates from the seed's recorded
/// "not self-referential" rationale — documented in the seed caveat.
fn agno_session_id_authority(s: &SpanCtx) -> bool {
    agno_session_authority(s) || s.has_attr("session.id")
}

/// Seed: frameworks/claude_agent_sdk/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `prompt.id` (wire): Log records only (20/20 and 29/29). A bare uuid4 that is stable for
///   the whole of one user turn — session-shaped and adjacent to session.id in the same
///   attribute set, but claude_agent_sdk_user shows 6 distinct values under one session.
///   Joining on it fragments a conversation into turns.
///
/// * `agent_id` (wire): Opaque 17-hex subagent instance id on 7/32 llm_request and 3/32 tool
///   spans in claude_agent_sdk_agents (4 distinct values, one per worker). Identifies a
///   subagent invocation inside one session; the human-readable role lives on the PARENT tool
///   span as subagent_type. Never a session.
///
/// * `user.account_uuid` (wire): Wire-observed in captures/claude_agent_sdk_probe/_probe2
///   (first-party auth), on every span. A bare UUID sitting next to session.id in the same base
///   attribute set — maximally session-shaped, and actually the ACCOUNT identity: constant for
///   the life of the account. The same applies to its companions organization.id,
///   user.account_id and user.email (the last is PII and must not be indexed).
///
/// * `tool_use_id` (wire): Log records only (5/20 and 14/29). Anthropic toolu_* id; correlates
///   a tool_decision to its tool_result, not a session.
///
/// * `client_request_id` (wire): Wire-observed on llm_request in the probe captures (absent
///   through an LLM gateway). Per-HTTP-attempt id — the finest granularity in the dialect.
///
/// Harness-only keys in the fixture captures (not framework signal): `capture.id`,
/// `deployment.environment`, `service.name`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `telemetry_is_the_cli_not_the_sdk`: The Claude Agent SDK emits nothing. query() spawns the
///   Claude Code CLI and the CLI is the OTel producer, so 100% of the configuration surface is
///   environment variables passed through options.env — and in TypeScript options.env REPLACES
///   the child environment rather than merging it (Python merges), so a customer who sets env
///   without spreading process.env silently loses PATH, auth and every OTEL_* var. Version skew
///   is a live risk: the SDK ships a bundled CLI (2.1.141 here) that differs from the machine's
///   (2.1.154), and the dialect version travels in the scope, not the package.
///
/// * `trace_per_turn_not_per_session`: There is NO session-spanning root span. Six turns
///   produced six traces sharing one session.id; a subagent fan-out stays inside its turn's
///   trace. Any product view that equates 'trace' with 'conversation' is wrong for this vendor
///   — the conversation is the session.id group-by, and that group-by is the ONLY thing holding
///   the turns together.
///
/// * `root_arrives_last_every_time`: 4/4 multi-batch traces are root-last, and the
///   claude_agent_sdk_agents trace arrived across EIGHT OTLP records with its
///   claude_code.interaction root in record 8 of 8 (seq 24) — 19.4 s after the trace began.
///   This is BatchSpanProcessor semantics (spans queue on end, parents end last), not a quirk.
///   Any per-trace decision keyed on the root is structurally impossible. It costs nothing here
///   because every span carries both the classifier and the session key, so all 7 traces are
///   classified AND session-keyed in their first record.
///
/// * `approval_outcome_is_span_invisible`: claude_code.tool.blocked_on_user reports
///   decision=unknown, source=unknown for every APPROVED call (7/7 in agents, 2/3 in user);
///   only the DENIED call shows decision=reject. The true outcome is in the tool_decision LOG
///   record (accept/user_temporary vs reject/user_reject). The span-only signal for approval is
///   structural: an approved call has a claude_code.tool.execution child, a denied one has
///   none. HITL is therefore not expressible in this seed's predicate algebra at all.
///
/// * `numbers_are_strings`: Almost every numeric and boolean value arrives as OTLP stringValue
///   — input_tokens="1228", success="true", duration_ms="3356", attempt="1" — and
///   gen_ai.response.finish_reasons arrives as the JSON-ish string ["end_turn"], not an
///   arrayValue. Duration is duplicated and stringly typed: duration_ms on tool/
///   llm_request/tool.execution/tool.blocked_on_user, interaction.duration_ms on the root (the
///   root does NOT carry duration_ms), alongside the real start/end timestamps.
///
/// * `provider_attribution_is_wrong`: gen_ai.system is the hardcoded literal "anthropic" on
///   every llm_request (source zv7), regardless of where the request actually went — every call
///   in these captures was served by OpenRouter via ANTHROPIC_BASE_URL. gen_ai.request.model /
///   model carry the truth (anthropic/claude-haiku-4.5, anthropic/claude-sonnet-4.5). Provider
///   attribution keyed on gen_ai.system is silently wrong for any LLM-gateway deployment, which
///   is the normal enterprise setup for this CLI.
///
/// * `mcp_tool_name_placeholder_in_logs`: tool_decision and tool_result log records report
///   tool_name="mcp_tool" for EVERY MCP tool (source B7(): any name starting with mcp__
///   collapses to the literal mcp_tool), and mcp_server.name / mcp_tool.name are the literal
///   "custom" unless the server is on an internal allowlist. The real identity is only in
///   tool_parameters ({"mcp_server_name":"tracetools","mcp_tool_name":"get_weather"}). SPANS
///   are unaffected — claude_code.tool carries the fully-qualified
///   mcp__tracetools__get_weather. Log-derived tool metrics will collapse every MCP tool into
///   one bucket.
///
/// * `no_telemetry_sdk_resource_attrs`: The resource is built from scratch by Fc7()
///   (resourceFromAttributes + osDetector + host.arch + envDetector), never from
///   defaultResource(), so telemetry.sdk.name / .language / .version are ABSENT — 55/55 spans,
///   49/49 log records and every metric block carry exactly {service.name, service.version,
///   os.type, os.version, host.arch} plus whatever OTEL_RESOURCE_ATTRIBUTES adds. No SDK-
///   language signal is available to ingest, and service.version (2.1.154) is the CLI version,
///   which is also the logs/metrics scope version — a usable cross-check.
///
/// * `subagent_nesting_is_real`: Subagent spans hang off the orchestrator's
///   claude_code.tool.execution for that Agent/Task call, so a 4-worker delegation is ONE
///   32-span trace with real parent links, and the three parallel workers genuinely overlap on
///   the wire (weather 2741→ 5393 ms, transport 3350→6372 ms, budget 3066→8586 ms from
///   interaction start). The SDK option is named `Task` but the tool surfaces in spans and
///   messages as `Agent`; the readable role is subagent_type on the parent claude_code.tool
///   span (4/7), while the child spans carry only the opaque agent_id.
///
/// * `error_representation`: The only ERROR-status span in the corpus is the native
///   claude_code.tool.execution for fetch_transport_data: status {code: 2, message: "transport
///   data service unavailable (503)"} plus success="false" and an `error` attribute — set by
///   the CLI itself, with no harness involvement. There are ZERO exception span events; the
///   only span event in the dialect is gen_ai.request.attempt. Failed LLM calls instead produce
///   llm_request spans with success=false/error/status_code plus api_error LOG records (wire-
///   observed in the probe captures).
///
/// * `pruned_agents_capture`: claude_agent_sdk_agents was pruned after the review's first pass:
///   a superseded failed run (28 spans, llm_request 404 error spans from OpenRouter dropping
///   anthropic/claude-3.5-haiku) was removed, leaving the 25 records / 32 spans / 1 trace
///   recorded in `captures:` above. NOTES.md's older 41-record / 60-span / 2-trace description
///   is the pre-prune superset and has been corrected.
///
/// * `probe_captures_excluded`: captures/claude_agent_sdk_probe and _probe2 (3 records each)
///   are deliberately NOT in `captures:` and not in the goldens. They are cited as source: wire
///   evidence for the firstparty-identity variant (organization.id / user.email /
///   user.account_uuid / user.account_id / client_request_id on every span) and for the
///   api_error log event, neither of which the golden captures exercise.
///
/// Rejected fingerprint, wire-checked 2026-08-13: `gen_ai.system == "anthropic"` must never
/// become a claude matcher — openrouter carries 153 `gen_ai.system="anthropic"` spans (plus
/// 1,477 `openai`, 8 `moonshotai`), a proven 153-span FP; this vendor's own llm_request spans
/// hardcode the literal regardless of the actual provider (see `provider_attribution_is_wrong`
/// below). No clause here reads the key.
///
/// Config variants that change the wire shape (`traces-off`, `session-id-off`, `firstparty-
/// identity`, `beta-tracing-detailed`): recorded in full in the seed's `variants:` block — re-
/// read it before touching this vendor's rules.
pub const CLAUDE_AGENT_SDK: VendorDef = VendorDef {
    id: VendorId::ClaudeAgentSdk,
    detect: detect_claude_agent_sdk,
    keys: &["span.type", "service.name"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // verdict: A.
        SessionCandidateDef {
            key: "session.id",
            authority: claude_agent_sdk_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: A.
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

// Phase 2 (fix-queue C1–C3, integration decisions): three ordered clauses replace
// the v1 block's three scope eq matchers (→ clause 1), the seven UNGUARDED
// `span.type` eq attr matchers (→ clauses 2+3), and the standalone insufficient
// `service.name=claude-code` resource matcher, whose only v1 role was conditional
// promotion by a span.type hit — clause 3 IS that conjunction, written honestly.
fn detect_claude_agent_sdk(s: &SpanCtx) -> bool {
    // (1) Scope family — primary, library-owned. Hardcoded in the CLI bundle:
    // HV() = trace.getTracer("com.anthropic.claude_code.tracing", "1.0.0") — the trace
    // scope's version is the DIALECT version (1.0.0), stable across CLI releases; the
    // LOG scope is getLogger("com.anthropic.claude_code.events", <CLI version>) and the
    // METRIC scope the bare getMeter("com.anthropic.claude_code", <CLI version>) —
    // neither carries spans, but maple's log/metric ingest needs the same vendor
    // mapping and the family test covers all three. Wire: 23/23 claude_agent_sdk_user
    // + 32/32 claude_agent_sdk_agents + 3/3 + 3/3 probe spans, all on the .tracing
    // scope; the string "com.anthropic" appears in NO other corpus capture (grep, 58
    // dirs, 2026-08-13). Exact-or-dotted-prefix rather than bare starts_with (the
    // dot-boundary narrowing is an integration decision): a future
    // com.anthropic.claude_code.<anything> rename/addition classifies while an
    // unrelated "com.anthropic.claude_codeX" sibling-product scope does not. Scope
    // matching is hoisted per-ScopeSpans (never prefiltered per-attribute), so the
    // prefix comparison needs no declared hint. [C1]
    let scope = s.scope_name();
    if scope == "com.anthropic.claude_code" || scope.starts_with("com.anthropic.claude_code.") {
        return true;
    }

    // Every span this dialect emits carries `span.type` — the CLI's NvH() attribute
    // builder stamps it into the startSpan attributes of every span type (seed
    // key_at_root_start citation); wire: 61/61 spans across all four claude captures.
    // Both fallback clauses below require it as dialect co-evidence, which is also
    // what keeps them dispatch-covered: `span.type` is a declared key, so every span
    // either clause can accept reaches this detector through the key hint (the
    // span-name PREFIX in clause 2 is not declarable — `span_names` dispatch is
    // exact-name only).
    let span_type = s.attr("span.type");

    // (2) Span-name namespace — rename-proof fingerprint for the scope-rewritten
    // path. The `claude_code.` vendor namespace lives ONLY in span names (every
    // attribute key in the dialect is bare). Wire: all 61 span names are
    // claude_code.{interaction|llm_request|tool|tool.execution|tool.blocked_on_user};
    // no other corpus capture contains the string "claude_code." (grep, 58 dirs).
    // Conjunctive with span.type presence — NOT unconditional as queue C2 wrote it —
    // because span names are customer data in other dialects (crewai builds
    // "<crew name>.kickoff": a crew named "claude_code" would collide and break the
    // at-most-one-vendor invariant). Zero recall cost: 61/61 wire spans carry both.
    // [C2, tightened per the integration decision]
    if s.span_name().starts_with("claude_code.") && span_type.is_some() {
        return true;
    }

    // (3) Guarded bare-key dialect match — scope AND name rewritten, native resource
    // default preserved. `span.type` value set: 5 wire values plus `hook`
    // (beta-tracing-detailed variant, source Pv7()) and `subagent.spawn` (source
    // Dv7(); unreachable in CLI 2.1.154 — d5H() returns false — listed so the rule
    // survives the flag flipping on; both per seed attr_matchers, kept in v2 by
    // integration decision). Guard: Fc7() seeds service.name="claude-code" as the
    // NATIVE DEFAULT (source_code citation — never on the corpus wire because the
    // harness set OTEL_SERVICE_NAME; zero corpus spans carry the value, so zero FP
    // surface today), then merges osDetector/hostDetector/envDetector on top, so
    // OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES wins. The conjunction removes the
    // openrouter collision class the v1 TODO tracked: 4,094/4,097 openrouter spans
    // carry `span.type` (values span|generation — disjoint anyway) AND
    // service.name=openrouter, so they fail both operands. (The queue's older 3,539
    // figure was stale; 4,094 is the 2026-08-13 recheck.) [C2; C3's negation is
    // subsumed by this conjunction]
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

/// Seed: frameworks/crewai/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `crew_key` (wire): An md5 of the crew's CONFIGURATION, not an identity: 7/25 and 6/17
///   spans, a single value per capture. crew.py:879-883 computes it as an md5 over the pipe-
///   joined agent.key list plus task.key list — pure configuration text, no instance id — so
///   two different customers running the same published crew template produce the SAME crew_key
///   forever, and every run of one deployment shares it. Joining on it would merge unrelated
///   tenants' conversations.
///
/// * `crew_id` (wire): uuid4 minted per Crew OBJECT (str(crew.id), _wrappers.py:482). It is
///   constant across all 6 turns here only because the fixture builds one Crew and calls
///   kickoff() once; a server that constructs a Crew per request gets a fresh value per RUN,
///   and a module-level Crew gets one value for the whole PROCESS lifetime. Instance
///   granularity masquerading as session granularity — the exact trap §3 warns about.
///
/// * `task_key` (wire): md5 of the task's description + expected_output (task.py:596-601)
///   (6/25, 5/17, one distinct value per task). Stable across runs and across customers using
///   the same task text; identifies a task TEMPLATE, not an execution and not a session.
///
/// * `task_id` (wire): uuid4 per Task object (6/25, 5/17). Sub-run granularity — six distinct
///   values inside one fixture 'conversation'.
///
/// * `graph.node.id` (wire): The agent ROLE string ("Helpful Assistant", "weather_worker").
///   Constant across every turn in crewai_user, so it looks like a stable correlation key; it
///   identifies an agent definition, not a session or user.
///
/// * `coding_agent` (source_code): Set process-wide by CrewAI's CommonAttributesSpanProcessor
///   when product telemetry is enabled (telemetry.py:112-121, utils.detect_coding_agent).
///   Values are a closed set (claude_code | cursor | codex | vscode_terminal | non_interactive
///   | unknown) — an environment fingerprint of the machine, never an identity. Not observed
///   here (telemetry disabled).
///
/// * `service.name` (wire): Harness-set here [H] (crewai-user-flow / crewai-orchestration); in
///   a real deployment it is the app's service name — process identity, never session identity.
///
/// # Caveats (the seed review's rationale record)
///
/// * `two_mandatory_instrumentors`: A useful CrewAI trace requires TWO OpenInference packages,
///   and only one of them is crewai's. Installing openinference-instrumentation-crewai alone
///   yields CHAIN/AGENT/TOOL spans with zero token counts, zero model ids and zero prompts —
///   52% and 47% of the spans in these captures (the entire LLM layer) come from openinference-
///   instrumentation-openai. CrewAI 1.x demoted LiteLLM to an optional extra and calls
///   providers through the native openai SDK, so openinference-instrumentation-litellm would
///   capture nothing; the correct pairing is version-dependent and will change again if CrewAI
///   switches client.
///
/// * `crewai_product_telemetry_can_leak_into_customer_collectors`: CrewAI ships anonymous
///   product telemetry that is ON BY DEFAULT and installed at import time, exporting to a
///   hardcoded https://telemetry.crewai.com:4319 (telemetry/constants.py). Two consequences for
///   maple. (a) If the customer already installed a real TracerProvider, Telemetry.set_tracer()
///   (telemetry.py:254-268) does NOT create its own — CrewAI's `Crew Created` / `Crew
///   Execution` / `Task Execution` / `Tool Usage` / `Human Feedback` spans are then created by
///   the CUSTOMER's tracer under scope `crewai.telemetry` and shipped to the customer's
///   backend. This is the ordinary OpenInference setup order, so it is likely, not exotic. (b)
///   Regardless of which provider wins, CommonAttributesSpanProcessor is attached to the
///   customer's provider and stamps `coding_agent` on every span it emits. The only clean opt-
///   out is CREWAI_DISABLE_TELEMETRY=true set BEFORE crewai is imported (what this fixture
///   does); OTEL_SDK_DISABLED=true also works but kills the customer's own spans too.
///
/// * `span_names_are_customer_data`: Every CrewAI span name is built from user-supplied
///   strings: `<crew name or Crew_<uuid>>.kickoff`, `<agent role>.<task name>._execute_core`,
///   `<tool name>.run`, `<flow name>.<method name>`. Unnamed crews/flows fall back to a raw
///   uuid in the name (_wrappers.py:249, 267), making span name a high-cardinality, PII-
///   adjacent field. Combined with the algebra's lack of a suffix operator this rules span
///   names out both as matchers and as grouping keys.
///
/// * `llm_model_attributes_disagree`: On the same ChatCompletion span,
///   llm.invocation_parameters reports "model": "gpt-4o-mini" (CrewAI strips a recognised
///   openai/ prefix before calling the SDK) while llm.model_name, read from the response, says
///   openai/gpt-4o-mini. The secondary model keeps anthropic/claude-haiku-4.5 in both. Neither
///   is reliably the id the customer passed. Additionally llm.system is the literal "openai" on
///   all 21 LLM spans including the 3 anthropic/claude-haiku-4.5 calls, because it names the
///   CLIENT SDK, not the provider — provider attribution keyed on llm.system is silently wrong.
///   llm.provider is not emitted at all.
///
/// * `no_native_hitl_telemetry`: CrewAI's HITL (Task(human_input=True) -> HumanInputProvider)
///   emits NO span, NO span event and NO attribute — and crewai_user proves it: the two HITL
///   turns really did gate a destructive tool (turn 5 denied, turn 6 approved) yet their
///   subtrees are indistinguishable in shape from an ordinary tool turn (AGENT + 4
///   ChatCompletion + 2 delete_file.run). Natively the pause is visible only indirectly: a TOOL
///   span whose output.value is APPROVAL_REQUIRED, then the user's reply reappearing inside a
///   later ChatCompletion span's llm.input_messages.N.message.content as "User feedback: …".
///   Nothing in this seed's algebra can detect a HITL gate. CrewAI's own product telemetry does
///   have a `Human Feedback` span (telemetry.py:1134) — reachable only via the leak path above.
///   Earlier revisions of this fixture papered over the gap with a harness
///   `human_approval_gate` span; it was removed on 2026-08-11 because the invisibility is the
///   fixture.
///
/// * `memory_telemetry_is_events_not_spans`: The instrumentor's four memory wrappers do NOT
///   create spans: _log_span_event (_wrappers.py:340-353) adds a span EVENT named
///   long_term_memory.save / long_term_memory.search / short_term_memory.save /
///   short_term_memory.search to whatever span is current AND flattens the payload onto that
///   span as <event name>.<key> attributes (including `value`, `results`, `query` — raw memory
///   content). Not present here twice over: crewai 1.15.12 removed crewai.memory.long_term and
///   .short_term in favour of unified memory, so the wrappers hit the ModuleNotFoundError
///   branch and are never installed. On crewai 1.10.x-era installs these events and attributes
///   appear on AGENT/TOOL spans and would be attributed to whatever span happened to be active.
///
/// * `graph_node_parent_id_is_not_the_topology`: graph.node.parent_id (4/17 in crewai_agents,
///   0/25 in crewai_user) is derived from the agent's INDEX IN crew.agents (_find_parent_agent,
///   _wrappers.py:331-338 — 'the previous agent in the list is the parent'), not from
///   execution. The three fanned-out workers are siblings, yet budget_worker reports
///   graph.node.parent_id=weather_worker. It is also absent whenever the agent is first in the
///   list, which is why single-agent crewai_user has none. The real topology is the span
///   parent/child links; graph.node.* must not be used to reconstruct it.
///
/// * `no_automatic_flush_and_no_export_by_default`: CrewAI registers nothing for customer
///   traces: without the customer's own TracerProvider + exporter, and without an explicit
///   force_flush()/shutdown() before exit, a short-lived CrewAI process exports NOTHING or
///   drops its tail batch. Bounds how much crewai data maple should expect from scripts and CLI
///   usage.
///
/// * `no_harness_spans`: [H] Both captures are 100% native as of the 2026-08-11 regeneration:
///   25/25 and 17/17 spans come from openinference.instrumentation.{crewai,openai}, and
///   scenario_a.py / scenario_b.py / common.py contain no tracer, no span, no set_attribute, no
///   set_status and no record_exception (grep-verified). The only harness code left is
///   telemetry.py's TracerProvider + BatchSpanProcessor + OTLPSpanExporter(endpoint) wiring,
///   the CREWAI_DISABLE_TELEMETRY / CREWAI_TRACING_ENABLED env defaults, and
///   force_flush()/shutdown() at exit — all permitted. The prior revision emitted 4
///   human_approval_gate spans in a `trace-capture.crewai` scope and stamped framework=crewai /
///   capture.id on the resource; both were removed, so the resource is now service.name +
///   telemetry.sdk.* only and the harness bucket is empty in both goldens.
///
/// * `exception_event_is_native`: The single `exception` span event and the single ERROR status
///   in crewai_agents (fetch_transport_data.run) are NATIVE: _BaseToolRunWrapper calls
///   set_status(ERROR) + record_exception(exception) at _wrappers.py:1080-1084 after starting
///   the span with record_exception=False/set_status_on_exception=False. No scenario code
///   touches it. Unlike google_adk, exception events ARE a usable native CrewAI tool-failure
///   signal — but note CrewAI then swallows the error and feeds 'Error executing tool: …' back
///   to the agent, so the enclosing AGENT and CHAIN spans both end OK.
///
/// * `batching_is_coarse_and_root_arrives_last`: The BatchSpanProcessor emits one OTLP record
///   per ~2 s flush, each a single resourceSpans block whose scopeSpans array interleaves both
///   instrumentation scopes. Both traces are multi-record and in both the root arrives in the
///   LAST record (root_last: 2) — the CrewAI root ends only when the whole conversation ends,
///   14.3 s after it started in crewai_user. A root-anchored ingest path would have to buffer
///   the entire conversation.
///
/// Config variants that change the wire shape (`oi-event-listener`, `oi-genai-semconv`,
/// `crewai-product-telemetry-adopts-app-provider`): recorded in full in the seed's `variants:`
/// block — re-read it before touching this vendor's rules.
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
        // verdict: C.
        SessionCandidateDef {
            key: "session.id",
            // Phase 2 (crewai spec §4, integration decision): broadened from the v1
            // scope-equality to "any crewai-classified span", expressed span-locally as
            // the vendor's own detect. The v1 scope-eq authority was redundant on the
            // scope path and actively wrong on the T2/T3 degradation path: a
            // scope-stripped crewai span under using_session() still carries session.id
            // (get_attributes_from_context runs at span end regardless of scope naming)
            // yet scope-eq authority reported it state 2 instead of resolving. Using
            // `detect_crewai` — rather than the spec's literal `|_| true` — is what
            // keeps the per-vendor golden histograms byte-identical: the seed-state
            // view evaluates crewai's candidates over EVERY span of the capture, and
            // `|_| true` would have flipped the 13/8 openinference-openai
            // ChatCompletion spans from state 2 to state 3 ({2:13,3:12} → {3:25}),
            // which the spec's own zero-movement prediction rules out.
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

// Phase-2 predicate (fix-queue CR2, CR3 guarded half, X4; CR1 stays dead —
// cross-span, constraint 1, mitigated by the synthesized openinference-openai
// vendor). Tiered: exact scopes, then a foreign-OI-scope refusal, then
// attr-evidence conjunctions, then a span-name-suffix last resort. The refusal is
// a negation on SCOPE evidence only, so detect stays monotone in span evidence
// and the scope-decided hoist shortcut remains sound.
fn detect_crewai(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // T1 — owned_by: library, source: wire.
    // The scope name is the instrumentor package's own module __name__ passed to
    // trace_api.get_tracer(__name__, __version__, tracer_provider)
    // (openinference/instrumentation/crewai/__init__.py:120-121); version is the package's
    // __version__. Library-owned, namespaced, stable, and independent of anything the
    // customer names. Catches 12/12 and 9/9 CrewAI spans in the captures — CHAIN kickoff,
    // AGENT _execute_core and TOOL run — including the TOOL spans that carry no crew_* key
    // at all. No non-CrewAI span was observed in this scope.
    if scope == "openinference.instrumentation.crewai" {
        return true;
    }
    // T1b — owned_by: library, source: source_code.
    // CrewAI's OWN product-analytics tracer name, hardcoded at 21 call sites in
    // crewai/telemetry/telemetry.py (trace.get_tracer("crewai.telemetry")). Not observed in
    // these captures because the fixture sets CREWAI_DISABLE_TELEMETRY=true, but it reaches
    // a CUSTOMER's collector whenever the customer left telemetry at its default and
    // installed a TracerProvider before building a Crew (see variants.crewai-product-
    // telemetry-adopts-app-provider). Vendor is unambiguously crewai; the spans are product
    // analytics, not AI operations (`Crew Created`, `Tool Usage`, `Human Feedback`, …), kept
    // vendor=crewai with this caveat per integration decision D-6 — a consumer must not
    // treat them as agent/LLM activity, and crewai's AI-span rollups inflate accordingly
    // wherever the telemetry-leak variant occurs in production.
    if scope == "crewai.telemetry" {
        return true;
    }
    // Refusal — a DIFFERENT OpenInference instrumentor owns this span; never claim it.
    // Wire: the 13/25 + 8/17 ChatCompletion spans (openinference.instrumentation.openai)
    // carry token counts/models/prompts but zero crewai keys; capture smoke-test carries
    // that scope with no CrewAI in the process. Protects the at-most-one-vendor invariant
    // against customer attrs colliding with the bare crew_/task_key evidence below.
    if scope.starts_with("openinference.instrumentation.") {
        return false;
    }

    // Crewai's own attribute evidence — bare/unnamespaced keys that must never classify
    // alone (X4; the v1 standalone matchers were the corpus-safe-by-luck case the plan
    // names). Wire counts, crewai_user/crewai_agents: crew_* 7/6 spans
    // (_wrappers.py:481-505 kickoff, :391-394 _execute_core); task_key 6/5
    // (_wrappers.py:381, unconditional on _execute_core); the three CrewAI-only BaseTool
    // fields tool.result_as_answer / tool.description_updated / tool.cache_function 5/3
    // (_wrappers.py:1055-1076 — the shared tool.name/description/parameters OI-semconv keys
    // are deliberately NOT used); flow_* / flow.node.* source_code only
    // (_wrappers.py:590-591, 712-713), 0 wire spans, guarded like everything else.
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

    // T2 — scope-stripped fallback (X4 conjunction + CR3's guarded half).
    // openinference.span.kind rides EVERY crewai span (25/25, 17/17 wire) and survives a
    // scope rewrite because it is an attribute; coding_agent is stamped by CrewAI's
    // CommonAttributesSpanProcessor (telemetry.py:103-122) when product telemetry is on —
    // the only rename-proof fingerprint, source_code evidence, 0/42 wire (fixture disables
    // telemetry). CR3's process-scoping half stays dead (cross-span, constraint 1):
    // coding_agent ALONE must never classify — it is stamped on every span of the host
    // provider. Shared-evidence-set reading per the integration decision (the tool.* keys
    // participate, not just the queue's literal task_key/crew_/flow_ set).
    if s.has_attr("openinference.span.kind") || s.has_attr("coding_agent") {
        return true;
    }

    // T3 — span-name suffix last resort (CR2), only reachable with crewai attr evidence in
    // hand. Suffix-only because the name prefix is customer data (crew/agent/task/tool
    // names, uuid fallbacks — _wrappers.py:239-330). Wire: every crewai-scope span ends in
    // exactly one of these (6+5 ._execute_core, 1+1 .kickoff, 5+3 .run). Simulated
    // degradation (scope renamed AND all openinference.* attr keys dropped): recovers
    // 12/12 and 9/9, 0 misses, 0 foreign matches corpus-wide. The oi-event-listener
    // variant's `.execute` / `.llm_call` names are deliberately NOT listed (unexercised,
    // over-fit risk; that variant still classifies via T1).
    let name = s.span_name();
    name.ends_with("._execute_core") || name.ends_with(".kickoff") || name.ends_with(".run")
}

/// Seed: frameworks/dspy/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `service.instance.id` (wire): Random uuid4 auto-detected by the OTel Python SDK once per
///   process (sdk/resources/__init__.py:507-528) and stamped on the RESOURCE of every span —
///   411674cf-... for dspy_user, 8f8942de-... for dspy_agents. Perfectly session-shaped and
///   perfectly stable across a whole capture, which is exactly why it is dangerous: in a script
///   it looks like a session id, in a long-lived server it silently merges every session in the
///   process. Never join on it.
///
/// * `llm.invocation_parameters` (wire): Byte-identical JSON blob ('{"temperature": 0.0,
///   "max_tokens": 600}') on every LM.__call__ span in a run — a constant that groups like a
///   key but identifies only the sampling config, in the same family as
///   langsmith.trace.session_name.
///
/// * `metadata` (source_code): The third CONTEXT_ATTRIBUTES entry (using_metadata /
///   using_attributes, context_attributes.py:18-26). Written as a JSON blob under the bare key
///   'metadata'; customers commonly bury a session or thread id inside it. Not a join key: the
///   algebra cannot reach into a JSON value, and there is no agreed inner field name.
///
/// # Caveats (the seed review's rationale record)
///
/// * `no_token_counts_no_cost_anywhere`: DSPy spans carry ZERO usage and ZERO cost data. Not
///   one llm.token_count.*, gen_ai.usage.*, cost, or price key exists on any span in dspy_user
///   or dspy_agents (grep-verified across both records.jsonl). This is a source-level property,
///   not a run artifact: openinference-instrumentation-dspy's attribute surface is exactly
///   {span kind, input/output value+mime, llm.model_name, llm.provider,
///   llm.invocation_parameters, llm.input_messages, llm.output_messages, retrieval.documents}
///   (__init__.py:1157-1171) — no usage extractor exists, and the _LMCallWrapper never touches
///   response.usage. Re-verified against the regenerated 2026-08-11 captures. The dialect DOES
///   define the keys and openinference-instrumentation-openai emits them (crewai_user, same
///   corpus), so a DSPy customer who wants token/cost data must install a SECOND instrumentor
///   beneath DSPy (litellm or openai). Maple must expect DSPy traces with complete
///   prompt/completion content and no measurable spend. NOTES.md previously claimed these keys
///   were present; corrected in the same pass.
///
/// * `session_id_is_pure_opt_in`: Verdict C is unusually strong here. Nothing in DSPy or the
///   instrumentor mints, defaults, or infers a session id — no uuid4 fallback (contrast
///   google_adk), no config-time id (contrast spring_ai's ChatMemory), no per-run id at all.
///   Absent using_session(), a DSPy trace has NO identifier of any granularity: not a session
///   id, not a run id, not an invocation id. dspy.History, DSPy's own conversation abstraction,
///   is a signature INPUT FIELD whose contents are serialised into input.value — carrying the
///   whole conversation and no key to it. The upside is that when the customer does opt in,
///   coverage is total (every span) and root-start-visible.
///
/// * `span_amplification`: One logical LLM step is 5 spans: <Module>.forward -> Predict.forward
///   -> Predict(<Signature>).forward -> <Adapter>.__call__ -> LM.__call__, with only the last
///   carrying model/messages. ReAct multiplies it by iteration count and adds a synthetic
///   finish.__call__ TOOL span per successful run (6 in dspy_user, 3 in dspy_agents) that is
///   control flow, not a tool call. Observed ratio: 87 spans for a 6-turn chat, 73 spans for
///   one research briefing; 15 and 13 LM.__call__ spans respectively, i.e. ~5 spans of overhead
///   per real model call. Any per-span cost model or 'LLM calls' rollup must count
///   openinference.span.kind=LLM only.
///
/// * `signature_names_are_erased`: Predict span names read Predict(StringSignature).forward,
///   not the customer's signature class name, whenever the signature was built dynamically
///   (dspy.ReAct and dspy.ChainOfThought both do this) — 15/15 and 13/13 occurrences here.
///   Combined with module/tool span names being raw customer class names, span.name in DSPy is
///   neither stable nor framework-identifying in either direction.
///
/// * `adapter_fallback_duplicates_subtrees`: When ChatAdapter fails to parse a completion, DSPy
///   retries the same logical call through JSONAdapter, so one Predict(...).forward span holds
///   TWO adapter children, each with its own LM.__call__ — a genuine double-charge of the same
///   logical step. Observed during wiring validation (an earlier probe capture held 1
///   JSONAdapter.__call__ against 6 ChatAdapter.__call__); it did not recur in the 2026-08-11
///   captures, which are 28/28 ChatAdapter.__call__ and 0 JSONAdapter.__call__. Source-level,
///   not run-specific: dspy/adapters/chat_adapter.py:54-87 constructs a JSONAdapter and retries
///   through it whenever ChatAdapter parsing fails, gated by use_json_adapter_fallback (default
///   True). Dedupe by parent, not by name.
///
/// * `react_swallows_tool_errors`: The corpus' only DSPy span event is the single `exception`
///   on fetch_transport_data.__call__ (dspy_agents), and it is NATIVE, not [H]: the
///   instrumentor's _ToolCallWrapper opens the span with OTel's default record_exception=True /
///   set_status_on_exception=True (__init__.py:830) and never catches, so the SDK records
///   exception.type/message/stacktrace/escaped and ends the span ERROR (code 2,
///   'TransportDataError: transport data service unavailable (503)'). It does NOT propagate:
///   dspy.ReAct catches every tool exception and folds 'Execution error in <tool>: ...' into
///   its trajectory text, so the parent ReAct.forward and every ancestor end OK. In dspy_agents
///   exactly 1 of 73 spans is ERROR while the run is a business-level failure (a degraded
///   briefing). Worse after de-harnessing: that ERROR span sits in the ORPHAN
///   TransportWorker.forward trace, so the orchestrator trace — the one an operator would open
///   — contains no error at all. Trace-level error rollups keyed on the root will report 100%
///   success for DSPy agents that are failing.
///
/// * `optimizer_traffic_is_indistinguishable`: dspy.Evaluate and every teleprompter
///   (BootstrapFewShot, MIPROv2, ...) drive dspy.Module.__call__ and dspy.Predict.forward, so
///   an offline compile or eval sweep emits spans identical in scope, name grammar and
///   attribute set to production serving traffic, at orders-of-magnitude higher volume and
///   typically with heavy internal threading (hence the orphan-trace behaviour, at scale).
///   Nothing in the algebra — and nothing on the wire — separates a DSPy optimization run from
///   a DSPy production run. This is the single biggest volume risk for the vendor and it is not
///   addressable by sampling rules maple can write.
///
/// * `thread_fanout_orphans_are_native`: DSPy fan-out shreds the trace.
///   `ThreadPoolExecutor.submit` does not copy contextvars, and dspy.Parallel/ParallelExecutor
///   copies only its own thread_local_overrides ContextVar (dspy/utils/parallelizer.py) — never
///   the full contextvars.Context — so the OTel current span never reaches the worker thread
///   and each worker's outermost <Module>.forward starts a BRAND-NEW parentless trace. The
///   2026-08-11 dspy_agents capture is the direct evidence: 4 traces for one briefing, 3 of
///   them orphans (61/73 spans), the three worker roots starting within 0.6 ms of each other
///   (real parallelism) and one of them holding the run's only ERROR span. An earlier version
///   of this fixture hid the effect with an explicit otel_context.attach() inside each worker;
///   that was removed per REVIEW_IMPLEMENTATION §2 — the broken shape IS the fixture.
///   Consequences for maple: a DSPy fan-out has no trace-level parent, no session key, and no
///   ordering signal beyond wall-clock; trace-per-request assumptions fail, and the same
///   mechanism applies at scale to dspy.Evaluate and every teleprompter (which thread
///   internally by default).
///
/// * `scope_version_is_the_instrumentor_not_dspy`: scope.version is 0.1.38 — openinference-
///   instrumentation-dspy's version, passed as __version__ to get_tracer (__init__.py:86-87).
///   It tracks the instrumentor's release line, not dspy 3.3.0. Nothing on the wire reveals
///   which DSPy version produced the trace, so version-gated ingest behaviour cannot key on
///   scope.version.
///
/// * `all_spans_are_internal_and_ok`: Every span in both captures is SpanKind INTERNAL (kind=1)
///   — span kind carries no information for DSPy, matching 15/22 corpus frameworks. Statuses
///   are equally uninformative: every wrapper explicitly sets OK (code 1), so 87/87 + 72/73
///   spans are OK and the lone ERROR is the tool span above. There is no UNSET span anywhere,
///   which is itself a de-harnessing tell — the pre-2026-08-11 captures had 15 UNSET spans and
///   all 15 were fixture-made.
///
/// * `no_container_span_means_no_turn_boundary`: The instrumentor's outermost span is whatever
///   <Module>.forward the app calls first, so there is no session, request, turn or invocation
///   container. dspy_user is 6 independent traces rooted at ChatAssistant.forward, one per
///   turn, and nothing on the wire says they belong together or in what order (start timestamps
///   only). A customer who wants turn boundaries must create them: either a surrounding
///   framework span (HTTP server, task queue) or using_session(). Maple cannot infer a DSPy
///   conversation from the trace graph — there is no edge to infer it from.
///
/// Config variants that change the wire shape (`openinference-genai-semconv`): recorded in full
/// in the seed's `variants:` block — re-read it before touching this vendor's rules.
pub const DSPY: VendorDef = VendorDef {
    id: VendorId::Dspy,
    detect: detect_dspy,
    keys: &[],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // verdict: C.
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.scope_name() == "openinference.instrumentation.dspy",
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: C.
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

// Phase 2 (fix-queue D1/D2, 2026-08-13): re-adjudicated, shape CONFIRMED — the exact
// scope equality below IS the v2 rule (integration decision D-1). DSPy has no
// attribute namespace of its own: its entire key surface is the shared OpenInference
// dialect (emitted identically by 5 sibling corpus scopes), its span names are
// customer Python identifiers, and its resource is stock OTel-Python. D1's span-name
// grammar (`Predict(...).forward` / `.forward|.__call__` suffixes) stays DECLINED:
// simultaneously too weak to be evidence (any framework producing <Class>.forward
// collides — a customer module named Predict in ANY OpenInference framework matches
// the "strong" form) and unnecessary while the scope holds; with D-1 the scope-loss
// outcome is unknown:openinference via openinference.span.kind (160/160 coverage),
// the honest ceiling. D2's nearest-dspy-ancestor attribution for nested
// litellm/openai scopes stays DO-NOT-FIX: constraint 1 blocks it and the wire proves
// it unorderable anyway (9/9 multi-batch dspy traces are root-LAST). Read-path
// consequence, preserved deliberately: a DSPy trace's per-trace vendor is a SET, and
// the token-bearing spans belong to the inner vendor — dspy's own spans carry zero
// usage/cost keys. Rules here must also stay VALUE-BLIND: openrouter's capture
// contains 'openinference.instrumentation.dspy' as traceback TEXT inside prompt
// payload values (dspy scenario file paths recorded provider-side) — a
// value-substring rule would cross-fire there; scope equality cannot.
fn detect_dspy(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Derived from the instrumentor package's own module path: DSPyInstrumentor._instrument
    // does trace_api.get_tracer(__name__, __version__, tracer_provider) at
    // openinference/instrumentation/dspy/__init__.py:86-87, where __name__ is literally
    // 'openinference.instrumentation.dspy'. Library-owned, namespaced, and unchangeable by
    // the app (the app can only swap the TracerProvider). Catches 87/87 + 73/73 spans —
    // every span in both captures, which after the 2026-08-11 de-harnessing are 100% native
    // — including the zero-payload adapter and module spans that no attribute rule can
    // reach. This is the ONLY DSPy discriminator that exists — see the seed's
    // attr_matchers.why and algebra_violations.
    s.scope_name() == "openinference.instrumentation.dspy"
}

/// Seed: frameworks/effect_ai/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.response.id` (wire): Provider generation id
///   (`gen-1785983725-oBoxbOOzp5dMRarKSjdf`), one distinct value per LLM call — 10 distinct in
///   effect_ai_user's single 6-turn session. Session-shaped opaque token; correlates one
///   request.
///
/// * `http.response.header.x-generation-id` (wire): The SAME OpenRouter generation id,
///   duplicated onto the http.client POST span by @effect/platform's blanket response-header
///   capture. Doubly tempting because it appears on a second span type and looks like a cross-
///   span join key; it joins one LLM call to its HTTP span, nothing more.
///
/// * `service.name` (wire): Process identity. Uniquely dangerous in this framework because it
///   is ALSO the instrumentation scope name (internal/tracer.js:273), so it shows up as a per-
///   app constant in two different places and reads like a stable grouping key. It is constant
///   forever for a deployment — joining on it merges every session of every user into one.
///
/// * `effect.fiberId` (wire): SPAN EVENT attribute (never a span attribute) on every
///   Effect.log* event, e.g. `#15`/`#16`/`#17` for the three parallel workers. Identifies a
///   fiber — finer-grained than a run, recycled within a process.
///
/// Harness-only keys in the fixture captures (not framework signal): `session.id`,
/// `capture.id`, `framework.name`, `conversation.turn`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `single_trace_whole_session`: effect_ai_user is the ONLY corpus capture in which one trace
///   covers an entire multi-turn session: all 6 turns, 62 spans, one trace id, one root. This
///   is not a framework guarantee — it follows from the scenario running the whole conversation
///   inside one Effect.withSpan in one process. It matters twice: it is why trace id
///   accidentally substitutes for a session key here (see unlinkable_populations), and it is
///   why spans_per_turn for this capture is measured as the user_turn.N SUBTREE size
///   (6/6/6/12/12/19, +1 root = 62) rather than spans-per-trace as in the trace-per-turn
///   frameworks.
///
/// * `failure_repaints_the_whole_ancestry`: An Effect failure sets ERROR on every enclosing
///   span, not just the one that failed, because each ancestor's Effect also fails. The
///   effect_ai_probe capture (not a golden) shows one provider transport error turning
///   http.client POST, LanguageModel.generateText, Chat.generateText, agent_step.assistant,
///   agent.assistant, user_turn.4 AND the trace root all ERROR from one cause — 7 red spans,
///   one incident. Any error-rate or error-count metric over Effect spans is inflated by trace
///   depth. The inverse also holds: with a tool declared failureMode: "return", the failure is
///   caught inside Toolkit.handle, so Toolkit.handle stays OK and only the handler's own span
///   is red — if the customer wrote no handler span, the failure is invisible.
///
/// * `status_ok_is_stamped_explicitly`: Effect sets StatusCode.OK on EVERY successful span
///   (internal/tracer.js:88-91), so 105/106 spans here have status code 1 rather than the UNSET
///   (0) that most instrumentation leaves. Consumers that treat 'has an explicit status' as a
///   signal, or that count OK-vs-UNSET, will read Effect traces differently from every other
///   framework in the corpus.
///
/// * `attribute_types_are_preserved`: Unlike spring_ai's Micrometer bridge, Effect preserves
///   OTLP scalar types: intValue/boolValue/doubleValue survive
///   (gen_ai.usage.input_tokens=intValue 138, conversation.approval_gated=boolValue false). But
///   anything non-scalar is stringified by Inspectable.toStringUnknown with 2-space
///   indentation, so arrays arrive PRETTY-PRINTED as JSON text: gen_ai.response.finish_reasons
///   is the string "[\n  \"stop\"\n]", never an arrayValue. Parsers must handle whitespace
///   inside these values. gen_ai.request.temperature=0 also arrives as intValue, not
///   doubleValue.
///
/// * `span_names_are_module_paths_not_operations`: GenAI semconv would name the LLM span `chat
///   openai/gpt-4o-mini` with SpanKind.CLIENT; @effect/ai names it `LanguageModel.generateText`
///   with SpanKind.INTERNAL. Every span in both captures is INTERNAL except the 18 http.client
///   POST spans (CLIENT). Span kind is useless for classification here, and any UI that derives
///   an operation label from the span name will show the TypeScript method rather than the
///   model or the tool — the tool name lives in the bare `tool` attribute, not in the
///   `Toolkit.handle` span name.
///
/// * `no_agent_loop_in_the_library`: LanguageModel.generateText is SINGLE-SHOT: one provider
///   request, tool calls resolved, results NOT fed back. The loop, the agent identity, the
///   worker fan-out and the HITL gate are all caller-written, so two Effect AI apps can produce
///   completely different trace shapes from the same library. This is the root cause of
///   false_negatives entry 1 and of the framework having no session: the library models a call,
///   not a conversation.
///
/// * `hitl_is_simulated_and_the_deny_branch_leaves_no_tool_span`: [H] @effect/ai has no
///   interrupt / approval / resumable-run mechanism of any kind (no `interrupt`, nothing in
///   Tool/Toolkit). The hitl.* spans are the fixture's. Fixture-shape consequence to keep in
///   mind when reading the capture: in the deny turn the model asked in prose and never called
///   delete_file, so effect_ai_user contains NO failed delete_file span — the denial appears
///   only as hitl.user_decision{approved=false} plus the absence of a tool call, while the
///   approve turn shows the full hitl.request_approval -> tool.delete_file chain.
///
/// * `two_records_per_scenario_by_scope_close`: Export is BatchSpanProcessor + a scoped flush:
///   NodeSdk.layer's release runs forceFlush() then shutdown() when the program scope closes
///   (NodeSdk.js:21), so there is no shutdown() call to make and no lost-spans-on-exit failure
///   mode. Both captures are exactly 2 records (one 5 s timer tick, one final flush) with the
///   root arriving last in both — the standard root-last pattern, at n=2.
///
/// * `app_spans_are_the_customer_idiom_not_a_fidelity_violation`: [H] §2 FIDELITY JUDGMENT
///   (2026-08-11, re-review): the 49 harness spans were audited span-population by span-
///   population against 'would an unmodified real customer app plausibly contain this?' and ALL
///   were kept — effect_ai is the corpus case where harness spans and customer app spans are
///   the same artefact. An Effect application IS a tree of Effect.withSpan / Effect.fn spans:
///   the framework creates no root, no agent, no loop, no turn, no session and no HITL, so an
///   app that did NOT write these spans would be a LESS representative fixture, not a cleaner
///   one (strip the roots and Chat.generateText becomes the root — an attribute-less span, see
///   customer_realism_gap). Per population: scenario_*.* roots = the app entrypoint every
///   Effect service has; user_turn.N + session.id = the injection point that IS this
///   framework's only session mechanism (see session.candidates.why); agent.* / agent_step.* =
///   the caller-written loop the library forces (see no_agent_loop_in_the_library); worker.* /
///   orchestrator.fan_out / agent.orchestrator / agent.summary_agent = orchestration the
///   library has no concept of; tool.* = Effect.fn handlers, the default Effect way to write a
///   function, and the reason the failureMode:"return" error is visible at all; hitl.* =
///   simulated because the library has no interrupt (see
///   hitl_is_simulated_and_the_deny_branch_leaves_no_tool_span). Verified negative on all four
///   removal triggers: ZERO raw-OTel usage (no @opentelemetry/api import, no
///   getTracer/startSpan/setAttribute/recordException/setStatus/addEvent anywhere under src/),
///   ZERO trace-capture.* scopes, ZERO shape repairs (nothing re-parents, merges or orphan-
///   fixes a native span), and ZERO native-span mutation — wire-confirmed: the complete
///   attribute set of the native spans is LanguageModel.generateText{gen_ai.*, toolChoice,
///   concurrency}, Toolkit.handle{tool, parameters}, Chat.generateText{} with no events on any
///   of them, so all 9 Effect.annotateCurrentSpan calls demonstrably landed on spans the
///   scenario itself opened (harness_mutated_spans: 0).
///
/// * `harness_writes_gen_ai_request_model_onto_app_spans`: [H] Fixture artefact kept
///   deliberately, recorded so it is never read as native: 4 harness spans carry the semconv
///   key gen_ai.request.model — scenario_a.user_flow (scenario-a.ts:102) and the three worker.*
///   spans (scenario-b.ts:39) — alongside agent.model. It is plausible customer behaviour (apps
///   do tag their own agent spans with semconv keys) and it is not maple dialect, so §2 does
///   not require its removal, but it has one consequence: this vendor's matchers are span-name-
///   based and correctly ignore all 4 (harness_matched: 0), while an UNKNOWN-TIER rule shaped
///   as key_prefix("gen_ai.") would classify them. The fallback_fingerprints count
///   (gen_ai.operation.name on 10/62 + 8/44, LanguageModel.generateText only) is the native
///   population and is unaffected — operation.name appears on no harness span. Any consumer
///   measuring 'gen_ai spans' by namespace rather than by this key will read 66/62 and 47/44.
///
/// * `harness_spans_are_the_whole_agent_layer`: [H] 30/62 and 19/44 spans are harness-authored
///   via Effect.withSpan / Effect.fn (agent.*, agent_step.*, worker.*, user_turn.*, tool.*,
///   hitl.*, orchestrator.fan_out, scenario_a.user_flow, scenario_b.orchestration), and both
///   trace roots are among them. Unlike spring_ai's ObservationRegistry spans these are not
///   disguised as framework spans — but they DO land in the framework's scope (there is only
///   one scope), so scope is again no help; provenance is. None of them matches a vendor rule
///   (harness_matched: 0) and none mutates a native span (harness_mutated_spans: 0): every
///   Effect.annotateCurrentSpan call in the scenarios targets a span the scenario itself
///   opened.
///
/// * `phase_2_tier_split` (2026-08-13, queue E1–E3): this vendor owns no attribute namespace —
///   the complete native span-attribute key set across all 39 @effect/ai spans is generic
///   `gen_ai.*` plus the four bare words `tool`, `parameters`, `toolChoice`, `concurrency`
///   (no `effect.*` span attribute exists; `effect.fiberId`/`effect.logLevel` are span-EVENT
///   attributes on harness spans). So detection is span-name-first, and phase 2 splits the 13
///   names by distinctiveness rather than adding a namespace rule that has nothing to match:
///   the 6 ordinary-English `Class.method` names are guarded by Effect-ecosystem evidence,
///   the 7 module-path names stay standalone, and the `toolChoice`+`concurrency` pair is the
///   guarded rename-proof last resort. Full rename-proofing is impossible for this vendor.
///
/// Config variants that change the wire shape (`otlp-tracer`, `effect-v4-unstable-ai`):
/// recorded in full in the seed's `variants:` block — re-read it before touching this vendor's
/// rules.
pub const EFFECT_AI: VendorDef = VendorDef {
    id: VendorId::EffectAi,
    detect: detect_effect_ai,
    keys: &[
        "telemetry.sdk.name",
        // Resource key read by the `scope.name == service.name` guard leg (queue
        // E2); declared here because `resource()` reads the same prefiltered view
        // as `attr()` (claude_agent_sdk's `service.name` clause is the precedent).
        "service.name",
        // Tier-3 bare-word conjunction (queue E3).
        "toolChoice",
        "concurrency",
    ],
    prefixes: &[],
    span_names: EFFECT_AI_SPAN_NAMES,
    session_candidates: &[],
    decoy_values: &[
        // wire: The literal 9-character string, not a missing value. Effect's
        // unknownToAttributeValue (internal/utils.js:13-20) falls through to
        // Inspectable.toStringUnknown, so an unset option is serialised as the text
        // `undefined`: 10/10 and 8/8 LanguageModel.generateText spans carry
        // concurrency="undefined" and 10/10 + 6/8 carry toolChoice="undefined". Any future or
        // customer-supplied key routed through Effect's attribute path can be present-but-
        // meaningless in exactly this way, which `present()` and `non_empty` both wave through.
        "undefined",
    ],
};

/// The @effect/ai operation span names (source: wire for the first three,
/// source_code for the rest). Span names are the module-path method names the
/// library itself opens spans under — the one span-name family in the tables,
/// kept as a named const because it doubles as the vendor's declared span-name
/// hint (the prefilter dispatches span names by EXACT match, so every name a
/// clause compares has to be in this list).
///
/// Phase 2 splits the set in two by *how distinctive the name is*, not by
/// provenance: [`EFFECT_AI_GUARDED_SPAN_NAMES`] is the ordinary-English subset
/// that only classifies alongside Effect-ecosystem evidence; the remainder
/// (`LanguageModel.*`, `EmbeddingModel.*`, `PersistedChat.*`) are unambiguous
/// TypeScript module paths and stay unguarded, so a collector that rewrites the
/// resource cannot un-classify the token-bearing spans.
const EFFECT_AI_SPAN_NAMES: &[&str] = &[
    // source: wire.
    "LanguageModel.generateText",
    // source: wire.
    "Chat.generateText",
    // source: wire.
    "Toolkit.handle",
    // source: source_code.
    "LanguageModel.streamText",
    // source: source_code.
    "LanguageModel.generateObject",
    // source: source_code.
    "Chat.streamText",
    // source: source_code.
    "Chat.generateObject",
    // source: source_code.
    "Chat.export",
    // source: source_code.
    "Chat.exportJson",
    // source: source_code.
    "EmbeddingModel.embed",
    // source: source_code.
    "EmbeddingModel.embedMany",
    // source: source_code.
    "PersistedChat.get",
    // source: source_code.
    "PersistedChat.getOrCreate",
];

/// The ordinary-English `Class.method` subset of [`EFFECT_AI_SPAN_NAMES`]: names
/// that any tracer on earth could plausibly emit (the seed's own
/// `false_positives.why` names exactly these shapes). Phase 2 guards them with
/// Effect-ecosystem evidence; the rest of the set stays unguarded.
const EFFECT_AI_GUARDED_SPAN_NAMES: &[&str] = &[
    // wire: 10/62 + 6/44.
    "Chat.generateText",
    // source: source_code.
    "Chat.streamText",
    // source: source_code.
    "Chat.generateObject",
    // source: source_code.
    "Chat.export",
    // source: source_code.
    "Chat.exportJson",
    // wire: 2/62 + 3/44.
    "Toolkit.handle",
];

/// Leg 1 of the Effect-ecosystem guard, and the only leg strong enough to carry a
/// span name that is ordinary English (tier 2 below).
///
/// source: wire.
/// NATIVE and hardcoded: @effect/opentelemetry Resource.configToAttributes
/// (Resource.js:23-33) always writes telemetry.sdk.name="@effect/opentelemetry" plus
/// telemetry.sdk.language=nodejs|webjs, and notably NO telemetry.sdk.version. Wire-
/// confirmed identical on 100% of resourceSpans blocks in both captures, and on zero
/// spans anywhere else in the corpus. It identifies the process as an Effect app that
/// wired @effect/opentelemetry's NodeSdk/WebSdk — NOT as an AI app and NOT the span as
/// an AI span: an Effect HTTP service with no @effect/ai dependency emits the identical
/// resource, and inside these very captures 10/62 and 8/44 spans under it are plain HTTP
/// client spans (maple's own Effect backend would satisfy it too). Absent entirely under
/// the otlp-tracer variant, which is why leg 2 exists at all.
fn effect_opentelemetry_resource(s: &SpanCtx) -> bool {
    s.resource("telemetry.sdk.name") == Some("@effect/opentelemetry")
}

/// Effect-ecosystem evidence — a GUARD, never a classifying clause: both legs hold
/// on processes that have no @effect/ai dependency at all (see the per-leg notes),
/// and leg 2 holds on 5,153/5,153 openrouter spans, whose asserted FP ceiling is
/// zero vendor claims.
///
/// Used by tier 3 ONLY. Tier 3's other conjunct (`toolChoice` ∧ `concurrency`, keys
/// that co-occur on zero spans in every other capture) is specific enough to make
/// leg 2 a widening of a narrow clause; tier 2's other conjunct is a set of
/// ordinary-English `Class.method` names, where leg 2 would be a widening of a broad
/// one — see the tier-2 note.
fn effect_ecosystem_evidence(s: &SpanCtx) -> bool {
    effect_opentelemetry_resource(s)
        // source: wire (queue E2).
        // The structural fingerprint of @effect/opentelemetry's tracer: the scope name IS
        // the app's service.name (internal/tracer.js:273 for NodeSdk; OtlpTracer.js:19-21
        // for the otlp-tracer variant, where leg 1 is absent — so this is the only
        // Effect-ecosystem evidence that survives BOTH wiring variants). Wire: holds on
        // 106/106 effect_ai spans (scope "effect-ai-user"/"effect-ai-agents" == service.name).
        // NEVER alone: the openrouter capture satisfies it on 5,153/5,153 spans (scope
        // "openrouter" == service.name "openrouter"). Non-empty equality, so an app with no
        // service.name (nameless scope, OTel getTracer does not coerce) fails closed.
        || match (s.scope_name(), s.resource("service.name")) {
            ("", _) => false,
            (scope, Some(service)) => scope == service,
            (_, None) => false,
        }
}

fn detect_effect_ai(s: &SpanCtx) -> bool {
    let name = s.span_name();

    // -- Tier 2: ordinary-English Class.method names, GUARDED (phase-2, queue E1/E2).
    // Chat.js:87-131, Toolkit.js:105. Wire: Chat.generateText 10/62 + 6/44 (zero
    // attributes — the name is its only signal); Toolkit.handle 2/62 + 3/44 (bare
    // `tool`/`parameters`). Before phase 2 these bare eq rules classified ANY span named
    // `Chat.export` or `Toolkit.handle`, from any tracer, as effect_ai. The guard costs
    // zero corpus recall (all 12 + 9 golden spans carry telemetry.sdk.name) and is an
    // explicit FP-vs-FN trade: an Effect app on the otlp-tracer variant behind a collector
    // that REWRITES service.name loses these spans entirely (they carry no other evidence)
    // — accepted, because an FP mislabels another tenant's data while this FN only
    // degrades to unclassified. Integration decision: guard the 6, keep tier 1 unguarded.
    //
    // The guard is leg 1 ALONE, deliberately narrower than tier 3's
    // `effect_ecosystem_evidence`. Leg 2 (`scope_name == service.name`) is the
    // `getTracer(serviceName)` idiom, not Effect evidence: it holds on 5,153/5,153
    // openrouter spans, i.e. on 100% of one unrelated vendor's traffic. Paired with six
    // ordinary-English names — four of which appear on no wire span in the corpus at all
    // — it would classify any app using that idiom and emitting a span named
    // `Toolkit.handle` or `Chat.export` as effect_ai. Measured cost of dropping it here:
    // zero. All 170 effect_ai corpus spans carry leg 1, and no guarded-name span anywhere
    // in the corpus lacks it, so the replay, the histogram, the FP ceilings, the
    // differential and the exclusivity invariant are all unmoved. The otlp-tracer variant
    // leg 2 exists for keeps its coverage in tier 3, where the paired conjunct is specific.
    if EFFECT_AI_GUARDED_SPAN_NAMES.contains(&name) {
        return effect_opentelemetry_resource(s);
    }

    // -- Tier 1: distinctive @effect/ai module-path span names, unguarded.
    // Literals passed to Effect.useSpan / Effect.makeSpanScoped / Effect.fn inside
    // @effect/ai 0.37.0 (LanguageModel.js:245/273/304, EmbeddingModel.js:135-171,
    // Chat.js:395/399). Wire: LanguageModel.generateText 10/62 + 8/44 (the only
    // gen_ai.*-bearing spans); the rest source_code-only. Unambiguous TypeScript module
    // paths — zero hits in any other capture — so they stay standalone evidence and a
    // resource-mangling collector cannot un-classify the token-bearing spans.
    if EFFECT_AI_SPAN_NAMES.contains(&name) {
        return true;
    }

    // -- Tier 3 (queue E3): rename-proof bare-word conjunction, GUARDED.
    // @effect/ai passes toolChoice + concurrency at span creation on every
    // LanguageModel.generate* call — the ONLY attributes it passes at creation, so this is
    // the one clause with a chance of surviving the effect-v4-unstable-ai variant, where
    // every span name changes. Wire: co-occur on 10/10 + 8/8 LanguageModel.generateText
    // spans and on zero spans in every other capture (neither key appears anywhere else,
    // even singly). Guarded because the keys are unnamespaced English (seed
    // algebra_violations #3); the guard is the disjunction so the clause survives the
    // otlp-tracer variant too. Corpus-subsumed by tier 1 today — it buys nothing until a
    // rename, which is the point.
    if s.has_attr("toolChoice") && s.has_attr("concurrency") {
        return effect_ecosystem_evidence(s);
    }

    false
}

/// Seed: frameworks/flue/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `flue.session.name` (wire): THE decoy of this framework, and the one that looks most like
///   a session key. In flue_user it is the constant `default` on 25/25 spans — a process-wide
///   literal, not an id. In flue_agents it is `default` on the orchestrator's 4 spans and
///   `task:default:<taskId>` on the other 17: it names Pi's harness session slot and encodes
///   the delegation tree, changing WITHIN a single trace and turn. Joining on it merges every
///   `default` session of every customer.
///
/// * `flue.parent_session.name` (wire): The other half of the delegation edge; `default` on
///   17/21 flue_agents spans, absent everywhere in flue_user. Constant-valued, present only on
///   delegated work.
///
/// * `flue.harness.name` (wire): `default` on 46/46 spans — the Pi harness profile name, a
///   build-time constant. Never varies per customer, session or run.
///
/// * `flue.submission.id` (wire): sub_<ULID>, one per dispatch() delivery — 8 distinct values
///   across the 8 flue_user traces sharing ONE conversation id. Session-shaped and stable
///   within a trace, which makes it the most convincing wrong answer; it is a run id.
///
/// * `flue.operation.id` (wire): op_<ULID> per agent operation. Tracks the same granularity as
///   flue.submission.id and is likewise reborn every turn.
///
/// * `flue.task.id` (wire): task_<ULID> per subagent delegation, 17/21 flue_agents spans, 4
///   distinct values in one trace. Correlates a delegate's subtree, not a session.
///
/// * `gen_ai.response.id` (wire): Provider response id on every chat span; unique per model
///   call.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_… / toolu_…). Also stamped on
///   delegated invoke_agent spans as the parent's `task` call id, which makes it look like a
///   parent-child correlation key; it correlates one tool call.
///
/// # Caveats (the seed review's rationale record)
///
/// * `session_granularity_rationale`: Why maple treats gen_ai.conversation.id (not
///   flue.instance.id) as THE session key, per §3's multi-granularity rule. Three granularities
///   are live on every Flue span at once: flue.instance.id (durable agent instance — coarser
///   than a session; a long-lived instance holds many conversations), gen_ai.conversation.id
///   (the conversation — session), and flue.submission.id / flue.operation.id (one delivery —
///   run). The middle one is the session because it is the unit that (a) survives across traces
///   — one id over all 8 flue_user traces — and (b) is what the runtime re-loads history under.
///   flue.instance.id is only session-SHAPED here because each scenario is a single process
///   running a single instance; that coincidence is a fixture property, not a Flue property.
///   The subtlety is that the conversation key is also present at a FINER granularity on the
///   same wire: subagent spans carry their own conv_ ids (5 distinct in the one flue_agents
///   trace), so the key must be read only where flue.operation.kind=prompt. docs/session-
///   identity.md's flue row, which calls flue.instance.id THE session key, is stale and
///   contradicted by this seed.
///
/// * `session_key_arrives_last`: SILENT-ZERO TRAP. gen_ai.conversation.id is on 100% of spans,
///   but the AUTHORITATIVE population is the root invoke_agent span, which ends last and so
///   exports last: 5/5 multi-batch traces are root-last, and only 4/9 traces (all single-batch)
///   have the session key visible in their first record. An ingest that resolves a trace's
///   session on first sight, and does not revisit, silently un-sessions every trace long enough
///   to span two batches — the more spans a turn has, the likelier it is to be lost. Resolution
///   must be revisitable.
///
/// * `no_gen_ai_system`: Flue emits NO gen_ai.system. It uses the newer gen_ai.provider.name
///   spelling (=openrouter here) and puts the provider's own model id, slashes intact, in
///   gen_ai.request.model (`anthropic/claude-haiku-4.5`) and the span name. Any cross-framework
///   rule or dashboard keyed on gen_ai.system sees nothing for Flue, and provider attribution
///   must read gen_ai.provider.name.
///
/// * `agent_attribution_is_wrong_on_chat_spans`: gen_ai.agent.name is the ACTING agent only on
///   invoke_agent spans. On the chat and execute_tool spans nested inside a delegate it reports
///   the registered root agent: all 3 `chat` spans under invoke_agent budget_worker say
///   gen_ai.agent.name=ResearchOrchestrator, and flue.agent.name says the same on 21/21 spans
///   (source: dist/index.mjs:159,194 read event.agentName, which identifiers() also feeds).
///   Per-agent token or latency rollups keyed on gen_ai.agent.name are silently wrong for every
///   delegated model call; use span parentage, flue.task.id or flue.session.name.
///
/// * `content_ships_customer_stack_traces`: Content-on-by-default is not limited to prompts.
///   The one ERROR span in flue_agents carries an `exception` span event whose
///   exception.stacktrace contains absolute filesystem paths of the running application
///   (/Users/.../frameworks/flue/src/tools.ts:53 and node_modules paths). Errors thrown by
///   customer tool code put their source layout on the wire under the default configuration,
///   gated only by { content: false } — which also removes prompts.
///
/// * `payload_is_mostly_content`: Content attributes are 84% of all span-attribute bytes in
///   flue_user (76.6 KB of 91.6 KB) and 73% in flue_agents, on conversations of 80-word
///   replies. The single largest attribute observed is a 4,973-byte gen_ai.input.messages; the
///   per-span ceiling is 56 KiB. Volume control for Flue is the content policy, not trace count
///   — and unlike sampling, it is a code change (see content_toggles).
///
/// * `no_error_status_without_a_thrown_error`: Status is UNSET (code 0) on 45/46 spans; the
///   single ERROR is the tool that throws. Flue sets error.type + ERROR status + an exception
///   event together in one place (dist/index.mjs:447-462), so present(error.type) and
///   status.code=ERROR are equivalent for Flue — unlike google_adk, where they diverge. The
///   exception event here is NATIVE, not fixture-injected.
///
/// * `harness_resource_attributes`: [H] The resource attributes framework.name=flue and
///   framework.version=2.0.3 are the FIXTURE's, from src/telemetry.ts:32-33 — not Flue's. Flue
///   contributes no resource attribute at all. Any earlier note treating them as a native
///   resource-level vendor signal (a resource matcher candidate) is wrong; see
///   classification.resource_matchers.why.
///
/// * `dedupe_makes_span_counts_uneven`: A delegated subagent produces ONE invoke_agent span
///   (from task_start), not two, because dist/index.mjs:116 suppresses the subagent's own
///   operation_start. That is why 4 of the 5 invoke_agent spans in flue_agents lack
///   flue.operation.kind and gen_ai.input/output.messages coverage differs between root and
///   delegate invocations — not a capture gap.
///
/// * `delegation_tree_stays_read_path` — F2, adjudicated DECLINED 2026-08-13:
///   `value_prefix(flue.session.name, "task:")` reads orchestrator-vs-delegate attribution,
///   which is attribution, not classification or session keying — plan scope sends it to the
///   read path. Its write-side value would be nil anyway: `flue.task.id` presence already
///   separates the same populations span-locally (17/21 = exactly the `task:*` spans), so the
///   only thing the value adds is the parent edge encoded in it. `flue.session.name` stays a
///   decoy key.
///
/// * `latent_openai_namespace_cross_fire` (watch item, no action): when
///   `gen_ai.provider.name == "openai"`, Flue's adapter also stamps
///   `openai.api.type=chat_completions|responses` on chat spans (dist/index.mjs:403-408 —
///   source-only, since every corpus request went through OpenRouter). No rule keys on
///   `openai.*` today (openinference-openai is scope-gated), but any future vendor or
///   unknown-tier rule using that prefix will fire on Flue chat spans, which Flue's own
///   predicate also matches. The at-most-one-vendor test is exactly the tripwire for it.
///
/// * `instance_id_accepts_the_literal_default` (recorded, deliberate): the `flue.instance.id`
///   candidate does not reject decoy values, faithful to the seed's `validation: [non_empty]`.
///   A customer calling `init(agent, { id: "default" })` therefore produces a state-5 hash of
///   `"default"` that collides across every such customer's instance rollups (the hash is
///   unsalted by design). Accepted: an instance name is customer-authored identity, unlike the
///   harness constants the decoy list targets.
///
/// Config variants that change the wire shape (`cloudflare-workers-tracing`, `custom-tracer-
/// scope`): recorded in full in the seed's `variants:` block — re-read it before touching this
/// vendor's rules.
pub const FLUE: VendorDef = VendorDef {
    id: VendorId::Flue,
    detect: detect_flue,
    keys: &[
        "flue.operation.kind",
        // Phase-2 F1: the delegation guard on the conversation-id authority.
        "flue.task.id",
    ],
    prefixes: &["flue."],
    span_names: &[],
    session_candidates: &[
        // verdict: A — authority extended by phase-2 fix-queue F1.
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            // eq-half wire: 8/25 flue_user (one per dispatch, all resolving the SAME
            // conv_01KZADQ7NQ… id) and 1/21 flue_agents (the orchestrator root; the
            // other 4 invoke_agent spans are delegates carrying their own conv_ ids —
            // 5 distinct ids live in that one trace, which is what this authority
            // exists to exclude).
            //
            // Negation half (F1): today 0 prompt spans carry flue.task.id (0/8, 0/1,
            // 0/1 across flue_user/flue_agents/flue_smoke) while ALL 17
            // delegate-context spans in flue_agents do, so the guard is vacuous on the
            // corpus — it defends a real shape. A delegated subagent produces ONE
            // invoke_agent span because dist/index.mjs:116 suppresses the subagent's
            // own operation_start; if that dedup guard is ever filtered, dropped or
            // refactored away, the delegate's own span arrives with kind=prompt PLUS
            // flue.task.id and a SUB-conversation id, and without this test that id is
            // promoted to state 6. With it the span stays unauthoritative and resolves
            // at instance granularity (state 5) instead, which is correct.
            //
            // Key ABSENCE, not a value test, deliberately: under the
            // cloudflare-workers-tracing variant flue.task.id is kept (seed variants),
            // as is flue.operation.kind, so the whole predicate is variant-stable.
            authority: |s| {
                s.attr("flue.operation.kind") == Some("prompt") && !s.has_attr("flue.task.id")
            },
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: A.
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
        // wire: The value of flue.session.name (46/46 spans) and flue.harness.name (46/46). Any
        // candidate resolving to the literal `default` is a harness/session-slot constant, not
        // an identity — listed so not_in_decoy_values rejects it if a future Flue version ever
        // routes it into a candidate key.
        "default",
    ],
};

fn detect_flue(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded in @flue/opentelemetry 2.0.3 dist/index.mjs:94
    // (trace.getTracerProvider().getTracer('@flue/opentelemetry')) — package-scoped,
    // library-owned, and the only tracer the adapter ever uses. Catches 25/25 + 21/21
    // spans, including the source-only span types (flue.coordinator, `flue.operation
    // shell`) that carry no gen_ai.* key. Standalone evidence because nothing but this
    // adapter emits under an npm-scoped tracer name; the one way to break that is the
    // customer passing their own shared tracer via options.tracer — see
    // variants.custom-tracer-scope and false_positives, in which configuration the
    // `flue.` prefix is the discriminator.
    s.scope_name() == "@flue/opentelemetry"
        // source: wire.
        || s.any_attr_prefix("flue.")
}

/// Seed: frameworks/google_adk/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gcp.vertex.agent.event_id` (wire): Per-ADK-Event UUID, 23/39 and 22/30 spans, 14 distinct
///   values inside the single google_adk_agents trace. Session-shaped (bare uuid4) and adjacent
///   to session_id in the same namespace, but changes several times per turn.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id or ADK-synthesised adk-<uuid4>.
///   Repeats across the HITL ask/deny and ask/approve span pairs, which makes it look like a
///   correlation key; it correlates tool calls, not sessions.
///
/// * `service.name` (wire): Harness-set here [H]; in real deployments it is the app's service
///   name — process identity, never session identity.
///
/// # Caveats (the seed review's rationale record)
///
/// * `call_llm_generate_content_double_count`: call_llm and generate_content are near-duplicate
///   nested spans, 1:1 in both captures, with identical durations and overlapping usage attrs.
///   Any per-span LLM-call or token rollup double-counts unless one is dropped — but they are
///   also the seed's two session-candidate populations: dropping call_llm loses the only
///   gcp.vertex.agent.session_id carrier and the content blobs; dropping generate_content loses
///   half the gen_ai.conversation.id carriers. Keep both, dedupe downstream on
///   (gcp.vertex.agent.event_id, parent).
///
/// * `gen_ai_system_is_not_the_provider`: gen_ai.system is 'gemini' on generate_content
///   (tracing.py:770, guessed regardless of provider) and the literal 'gcp.vertex.agent' on
///   call_llm. Every request here actually went to openrouter/openai/gpt-4o-mini and
///   openrouter/anthropic/claude-haiku-4.5 via LiteLlm. Provider attribution keyed on
///   gen_ai.system is silently wrong; gen_ai.request.model carries the truth.
///
/// * `execute_tool_placeholder_blobs`: execute_tool spans hardcode
///   gcp.vertex.agent.llm_request/llm_response to the literal string '{}' (tracing.py:225-226)
///   while call_llm carries the real 1.7-8.6 KB blobs. present() matches both — a value-quality
///   fact, not a classification error (the spans ARE google_adk spans); content-aware consumers
///   must check for the placeholder.
///
/// * `root_anchored_resolution_descends`: §3's root-most-anchoring must be allowed to descend:
///   the anchor is always a child (invoke_agent), never the trace root — a root-only reader
///   gets zero attributes from 9/9 traces.
///
/// * `harness_injected_exception_event`: [H] The one exception span event and the one ERROR
///   status (google_adk_agents, execute_tool fetch_transport_data) come from
///   scenario_b.py:82-83 (record_exception/set_status in a BasePlugin on_tool_error_callback).
///   Native ADK sets only error.type=TOOL_ERROR and leaves status UNSET. Do not treat exception
///   events or ERROR status as native ADK signals — use present(error.type). Counted in
///   harness_mutated_spans.
///
/// * `notes_hitl_claim_unverified`: NOTES.md claims the confirmation handshake is visible
///   inside the llm_request/llm_response blobs; the string adk_request_confirmation occurs
///   nowhere in either capture (nor the pre-prune .bak). The HITL flow IS present but only as 4
///   execute_tool delete_file spans pairing on gen_ai.tool.call.id — no confirmation span, no
///   confirmation attribute; HITL is invisible to any rule in this seed's algebra.
///
/// * `adk_exports_nothing_by_default`: Runner-driven ADK honours no OTLP env var — a customer
///   scripting ADK must register their own TracerProvider or nothing is sent. Bounds how much
///   google_adk data maple should expect from non-`adk web` deployments.
///
/// Config variants that change the wire shape (`adk-schema-v2`): recorded in full in the seed's
/// `variants:` block — re-read it before touching this vendor's rules.
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
        // verdict: A.
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            // A v1 `AnyOf`, now a plain `||`. Wire carriers are exactly
            // op=invoke_agent (8+7) and op=generate_content (9+8); the value is
            // Session.id (tracing.py:170,596), one value across all 8 google_adk_user
            // traces. `invoke_workflow` is phase-2 G2 (integration decision: ACCEPTED
            // on the source citation, consistent with the claude_agent_sdk precedent
            // for source-cited clauses): the adk-schema-v2 root — the implicit DEFAULT
            // on Vertex Agent Engine, so real customers hit it without opting in —
            // replaces `invocation` with `invoke_workflow {entrypoint}` carrying
            // gen_ai.operation.name=invoke_workflow AND gen_ai.conversation.id at span
            // start (node_tracing.py:189-211, verified against ADK 2.6.2 source;
            // exercised_in_captures: false — 0/131 corpus ADK spans). Without the
            // disjunct, the v2 root's conversation.id — the only root-readable session
            // key ADK ever emits — would be rejected as unauthoritative (state 2 with
            // a valid key in hand). Exact-value test, zero corpus movement.
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
        // verdict: A.
        SessionCandidateDef {
            key: "gcp.vertex.agent.session_id",
            authority: |s| s.attr("gen_ai.system") == Some("gcp.vertex.agent"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: A.
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

// Phase 2 (fix-queue G1, 2026-08-13): re-adjudicated, shape CONFIRMED — all three
// clauses are vendor-owned literals; no guard conjunction is needed (X4 does not
// bind) and none was added. G1's `attribute_count == 0` positive discriminator for
// the `invocation` roots stays DECLINED: zero-attribute INTERNAL spans are the least
// distinctive shape in any fleet, the scope clause already classifies all 9 roots,
// and scope loss degrading the root to non-AI is the seed's recorded, accepted
// posture (the other populations fall to unknown:genai via gen_ai.operation.name,
// 22/39 + 21/30).
fn detect_google_adk(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded in google/adk/telemetry/tracing.py:102
    // (instrumenting_module_name="gcp.vertex.agent", version=ADK release,
    // schema_url=Schemas.V1_36_0). Library-owned, namespaced, stable across the package.
    // Catches 39/39 + 30/30 spans including the attribute-less `invocation` root, which
    // nothing else can classify. No non-AI span was observed in this scope (see
    // false_positives for the untested co-tenancy caveat). The adk-schema-v2 variant
    // does not rename the scope, so detection is v2-proof as-is.
    s.scope_name() == "gcp.vertex.agent"
        // source: wire. 23/39 + 22/30 spans (call_llm, generate_content, execute_tool);
        // survives a scope-rewriting bridge/collector.
        || s.any_attr_prefix("gcp.vertex.agent.")
        // source: wire. call_llm stamps gen_ai.system to the vendor literal
        // (tracing.py:362): 9/39 + 8/30, call_llm only. Fully shadowed by the prefix
        // clause on today's wire (every call_llm also carries gcp.vertex.agent.* keys,
        // and the identity keys are NOT gated by ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS —
        // that toggle gates only the four content blobs, telemetry/context.py:211) but
        // kept as the survivor for attribute-stripping pipelines: vendor-owned-by-value,
        // one map lookup, zero corpus FPs. DO NOT add gen_ai.system == "gemini":
        // tracing.py:770 stamps it regardless of the actual provider and it would
        // collide with any real Gemini/google-genai instrumentation (seed prohibition —
        // and that prohibition must extend to any future google_genai vendor, which
        // would otherwise claim ADK's 9+8 generate_content golden spans and trip the
        // at-most-one-vendor CI).
        || s.attr("gen_ai.system") == Some("gcp.vertex.agent")
}

/// Seed: frameworks/haystack/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `haystack.pipeline.metadata` (wire): The only customer-writable attribute in the dialect
///   and therefore the obvious place an integrator would stash an id — but it is an opaque JSON
///   blob ('{}' on 10/10 pipeline spans here), fixed at Pipeline construction, and shared by
///   every session that pipeline instance serves. Never join on it.
///
/// * `haystack.component.name` (wire): The only human-meaningful identity in the dialect
///   ('assistant', 'orchestrator', 'weather_worker'). It is a static pipeline-topology label —
///   one constant value forever, on 6/38 and 9/42 spans — not an instance identifier. Grouping
///   by it yields one bucket per component for the lifetime of the deployment.
///
/// * `haystack.agent.step` (wire): A per-step counter (0, 1, ...) restarting at 0 inside every
///   agent run; 9/38 and 9/42 spans. Session-shaped only in that it is a small stable-looking
///   scalar.
///
/// * `service.instance.id` (wire): The most session-shaped value in these captures — a bare
///   uuid4, exactly one per capture — and it is neither native Haystack nor a session: the OTel
///   Python SDK mints it per PROCESS in Resource.create(). It looks like a session id only
///   because each fixture scenario is one short-lived process; in a long-lived server it is
///   constant across every session that server ever handles.
///
/// Harness-only keys in the fixture captures (not framework signal): `capture.id`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `harness_named_scope_native_spans`: [H] The instrumentation scope in both captures is
///   trace-capture.haystack — a harness-chosen string (frameworks/haystack/telemetry.py:48). It
///   is NOT evidence of harness provenance: every one of the 80 spans is emitted by haystack-
///   ai's own tracing calls through opentelemetry-haystack's OpenTelemetryTracer, and the
///   harness contributes only the tracer NAME. Provenance grep over frameworks/haystack/*.py
///   finds zero start_as_current_span, zero set_attribute, zero record_exception, zero
///   set_status, zero add_event outside telemetry.py's provider wiring — hence harness: 0 and
///   harness_mutated_spans: 0 in the goldens. The inverse of the spring_ai case (native-looking
///   scope, harness spans): here the scope name is the only harness artifact and the spans
///   under it are entirely native. It is deliberately absent from scope_matchers.
///
/// * `values_are_not_all_strings`: NOT all attribute values are strings —
///   haystack/tracing/utils.py coerce_tag_value() passes bool/str/int/float through UNTOUCHED
///   and only JSON-encodes everything else. On the wire that means intValue for
///   haystack.agent.step, haystack.agent.steps_taken, haystack.agent.max_steps,
///   haystack.component.visits and haystack.pipeline.max_runs_per_component, and doubleValue
///   for haystack.agent.step.tool.output whenever a tool returns a number (haystack_agents:
///   calculate -> 750). A consumer that assumes stringValue drops or mistypes them; under the
///   canonical stringification in scripts/verify-seed.ts they compare as '1' / '750'.
///
/// * `pipeline_output_data_is_always_empty`: haystack.pipeline.output_data is the literal '{}'
///   on 10/10 pipeline spans in both captures, and always will be: pipeline.py:385-393 passes
///   the still-empty pipeline_outputs dict in the tag map, and OpenTelemetryTracer.trace()
///   serializes the tags at span OPEN, before the pipeline has run. Same for
///   haystack.pipeline.metadata='{}' when no metadata is set. A google_adk-style placeholder
///   blob: present() matches, the content is worthless. The real outputs are on the
///   component/agent spans.
///
/// * `root_is_not_findable_by_name`: Span names are static and non-unique within a trace: the
///   single haystack_agents trace contains FOUR haystack.pipeline.run spans (1 root + 3 worker
///   sub-pipelines invoked as PipelineTools), 9 haystack.component.run, 9 haystack.agent.step
///   and 9 haystack.agent.step.llm. All identity is in attributes. Root detection must be
///   structural.
///
/// * `content_encoding_is_value_dependent`: Content tags are JSON strings EXCEPT where the
///   payload contains a non-JSON-serialisable object, in which case coerce_tag_value falls back
///   to Python repr(). Measured: 16/18 haystack.agent.step.llm.input values are JSON and 2/18
///   are repr (the haystack_agents orchestrator, whose tool list holds PipelineTool objects);
///   4/5 haystack.agent.tools are JSON and 1/5 is repr; llm.output is JSON 18/18. Parsers must
///   tolerate both, per-value — it is not a fixed property of the key.
///
/// * `no_error_signal_of_any_kind`: hasError is false on 80/80 spans and status is UNSET on
///   80/80, including the always-failing fetch_transport_data 503 in haystack_agents. Failure
///   surfaces only as the string {"error": "..."} inside the content-gated
///   haystack.agent.step.tool.output. Combined with the missing status/event surface in the
///   Span ABC, Haystack cannot report an error to a tracing backend at all.
///
/// * `hitl_is_native_but_invisible`: Scenario A exercises Haystack's first-class
///   ConfirmationHook/before_tool gate (only the stdin UI is substituted). It produces NO
///   telemetry: the approval decision gets no span and no event, and a REJECTED tool call
///   produces no haystack.agent.step.tool span at all, because the hook strips the call before
///   the execution stage. Wire-confirmed: the denied delete_file(/tmp/report-final.txt) turn
///   has 2 agent steps and zero tool spans, while the approved delete_file(/tmp/scratch-
///   notes.txt) turn has 1 tool span. HITL is invisible to every rule in this seed's algebra;
///   the only trace of a denial is a sentence inside a content blob.
///
/// * `harness_class_names_leak_into_native_values`: [H] haystack.component.fully_qualified_type
///   on the briefing_notes span reads 'scenario_b.BriefingNotes' — a harness-authored component
///   class. The SPAN is native (emitted by PipelineBase._create_component_span), so it is not
///   harness by provenance; only the value names fixture code. Worth flagging because
///   fully_qualified_type is otherwise the best available signal for what a component actually
///   is, and in customer data it will name customer classes just as often.
///
/// * `parallel_fanout_is_real_and_context_propagates`: Verified from the wire, not prose: the
///   three worker tool spans in haystack_agents start within 0.7 ms of each other and overlap
///   for seconds (2088 / 5020 / 4743 ms durations under one 7592 ms step span). Agent
///   dispatches tool calls through a ThreadPoolExecutor bounded by tool_concurrency_limit
///   (default 4) and propagates context with contextvars.copy_context(), so the child spans
///   nest correctly across the thread boundary — no orphans, no split traces.
///
/// * `execution_mode_records_the_sync_async_path`: haystack.pipeline.execution_mode is 'sync'
///   on 10/10 pipeline spans here. AsyncPipeline takes a parallel code path (pipeline.py:906,
///   agent.py:1203) with the same span names and the same tag vocabulary, so nothing in this
///   seed changes — but it is the attribute to check when reconciling a customer's async
///   deployment.
///
/// Config variants that change the wire shape (`content-tracing-disabled`, `opentelemetry-
/// connector`, `openinference-haystack`): recorded in full in the seed's `variants:` block —
/// re-read it before touching this vendor's rules.
///
/// Phase-2 note (fix-queue X2, integration decision D-3): the empty-fallback gap is
/// closed by the span-name clause in `detect_haystack` below, NOT by an unknown-tier
/// `haystack.*` line — such a line would be unreachable by construction (the vendor's
/// own unconditional `haystack.` prefix clause matches the identical population first).
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
    // owned_by: library, source: source_code.
    // NOT observed in these captures — recorded from
    // haystack_integrations/components/connectors/opentelemetry/opentelemetry_connector
    // .py:84, which hardcodes opentelemetry.trace.get_tracer("haystack") — the ONLY
    // library-owned scope name Haystack can produce, and the one the current Haystack docs
    // steer customers to (see the opentelemetry-connector variant). A bare product-name
    // tracer is a real if remote collision risk, called out under false_positives. On the
    // enable_tracing() path exercised here the scope is whatever Tracer the app constructed
    // — in these captures the harness's trace-capture.haystack [H], which is DELIBERATELY
    // NOT transcribed: it does not exist in customer data, and no allowlist can enumerate
    // app-chosen names. Redundant with the span-name clause for every span Haystack itself
    // can emit today; kept as the record of the one library-owned scope and as a guard for
    // any future connector span under a non-haystack.* name.
    s.scope_name() == "haystack"
        // source: wire. 38/38 + 42/42 spans carry >=1 of the dialect's 28 haystack.* keys
        // (content tracing ON); the namespace is exclusively Haystack's — no other corpus
        // capture has any haystack.* key. Vendor-owned namespace => unconditional per X4.
        || s.any_attr_prefix("haystack.")
        // source: wire + source_code (phase-2, fix-queue X2 / the content-off gap).
        // Library-constant span names, passed by haystack-ai itself (pipeline.py:385,
        // core/pipeline/base.py:978, agent.py:862, agent.py:1145, tool_calling.py:192),
        // never by the customer — 80/80 corpus spans carry one of the six. This clause is
        // what classifies the attribute-less haystack.agent.step.llm spans under the
        // DEFAULT HAYSTACK_CONTENT_TRACING_ENABLED=false config (agent.py:1162 opens them
        // with no tags), where no attribute fingerprint — vendor-tier or unknown-tier —
        // can see them. Deviation from the spec's `starts_with("haystack.")` form,
        // deliberate: the prefilter dispatches span names by EXACT match only, so a
        // prefix comparison could never be covered by declarable hints (a future span
        // name would pass the direct path and silently miss the fast path); the exact
        // six-name set is the spec's own named-safer alternative and matches the declared
        // `span_names` hints one-to-one. A new Haystack span type needs a hint+predicate
        // entry here — same maintenance class as the seed's enumerated posture.
        // Corpus FP sweep: 0 spans outside the haystack captures carry any of these names.
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

/// Seed: frameworks/langgraph/registry-seed.yaml (write-side plan D2: `langgraph` → `langchain`
/// — the LangSmith dialect is not span-locally separable).
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `langsmith.trace.session_name` (wire): THE prime decoy of this framework: 'session' here
///   is LangSmith's legacy word for a tracing PROJECT. The value is $LANGSMITH_PROJECT (default
///   'default'), a deployment-wide constant that never changes for the life of the process —
///   42/42 spans hold langgraph_user and 17/17 hold langgraph_agents. Joining on it merges
///   every trace the deployment ever produced into one 'session'.
///
/// * `langsmith.trace.session_id` (source_code): Same thing as session_name, as a UUID: the
///   LangSmith project id (_otel_exporter.py:97,552, set from run_info.session_id). Not
///   observed here because OTEL-only mode never talks to the LangSmith API and so never learns
///   a project id — but a hosted/hybrid customer emits it, and it looks exactly like a session
///   uuid.
///
/// * `langsmith.metadata.LANGSMITH_PROJECT` (wire): The same project name again, arriving by a
///   different route: every LANGCHAIN_* / LANGSMITH_* environment variable is mirrored into
///   metadata (langsmith/env/_runtime_env.py:171-199, minus an exclusion list and any name
///   containing key/secret/token). Constant per deployment. 42/42 + 17/17.
///
/// * `langsmith.metadata.checkpoint_ns` (wire): Looks session-shaped (<node>:<uuid4>) and sits
///   in the same namespace as thread_id, but it is the per-node-task checkpoint namespace:
///   11/42 + 11/11 spans, 11 distinct values inside langgraph_user and 5 inside the SINGLE
///   langgraph_agents trace. Promoted by an ensure_config allowlist (runnables/config.py:297)
///   that also covers 'model'. Present even when the customer passes no configurable at all.
///
/// * `langsmith.metadata.langgraph_checkpoint_ns` (wire): Same value as checkpoint_ns on the
///   node-span population (34/42 + 16/17, 12 and 5 distinct values). Changes several times per
///   turn; correlates a Pregel task, never a conversation.
///
/// * `langsmith.metadata.revision_id` (wire): Deployment identity, not session identity:
///   $LANGCHAIN_REVISION_ID or, by default, `git describe --tags --always --dirty` of the
///   process CWD (_runtime_env.py:193-201). Constant for the life of a deploy; 04d3fbf-dirty on
///   59/59 spans here. Also a leak: it publishes the host repo's git state.
///
/// * `service.instance.id` (wire): OTel-SDK-minted uuid4, one per PROCESS (resource attribute).
///   In a one-scenario-one-process fixture it aliases the session perfectly and in a long-lived
///   server it aliases nothing. Never join on it.
///
/// # Caveats (the seed review's rationale record)
///
/// * `two_stage_flush_or_nothing`: A plain provider.force_flush() exports NOTHING. langsmith
///   converts runs into spans on its own background worker, so at process exit the
///   TracerProvider's queue is still empty. The capture only works because
///   common.py:flush_tracing() first calls
///   langchain_core.tracers.langchain.wait_for_all_tracers() and get_client().flush(), and only
///   then force_flush()+shutdown(). Any customer (or maple onboarding doc) that follows the
///   standard OTel shutdown recipe gets an empty pipeline with no error — a silent-zero trap
///   that applies to every LangChain-based integration, not just LangGraph.
///
/// * `metadata_namespace_is_an_open_door`: langsmith.metadata.* is NOT a fixed key set. Two
///   blanket loops feed it: (1) langchain-core copies every scalar entry of the `configurable`
///   dict into inheritable LangSmith metadata — the only exclusions are keys starting with '__'
///   and the single literal 'api_key' (runnables/config.py:151-167), so ARBITRARY customer-
///   chosen keys (user ids, tenant ids, emails, anything) arrive as span attributes on every
///   span of the tree; (2) langsmith mirrors every LANGCHAIN_*/ LANGSMITH_* environment
///   variable into metadata, minus a small exclusion list and any name containing
///   key/secret/token (_runtime_env.py:171-199). Consequences: maple must treat
///   langsmith.metadata.* as unbounded-cardinality customer data (PII risk, attribute-count
///   blowup), and the seed's session key is a customer-namespace key that merely happens to be
///   conventional — a customer passing configurable.thread_id with non-session semantics would
///   poison it. The upside is that the same mechanism is exactly why thread_id reaches 42/42
///   spans including the root.
///
/// * `gen_ai_system_is_guessed_from_the_model_string`: _set_gen_ai_system() substring-matches
///   the model name against a hardcoded table (anthropic/claude, gpt/openai, gemini, mistral,
///   groq, ...), defaulting to 'langchain'. Every request in these captures went to OpenRouter,
///   yet llm spans report gen_ai.system=openai (5) and anthropic (3). Provider attribution
///   keyed on gen_ai.system is silently wrong; gen_ai.request.model carries the truth
///   (openai/gpt-4o-mini, anthropic/claude-haiku-4.5).
///
/// * `interrupts_are_error_spans`: LangGraph's native HITL gate (interrupt() +
///   Command(resume=...)) produces no dedicated span, attribute or event. The interrupted
///   tool_executor span simply carries status.code=2 and an `exception` event with
///   exception.type='Exception' and the GraphInterrupt repr in exception.message. 2 of the 3
///   ERROR spans in the corpus are successful approval pauses. Also: a DENIED tool never
///   produces a tool span at all — the denial exists only inside the parent node's
///   gen_ai.completion blob.
///
/// * `one_invoke_one_trace_multiplies_traces_per_session`: Each graph.ainvoke() is its own
///   trace, and an interrupt/resume pair splits one logical turn into two traces: 6 user turns
///   -> 8 traces in langgraph_user, all joined only by langsmith.metadata.thread_id. Cost/quota
///   reasoning must not equate traces with turns, and any per-trace head sampler shreds a
///   session geometrically (a 6-turn session survives intact with probability p^8).
///
/// * `no_native_span_or_trace_identity_attributes`: langsmith.trace.id, langsmith.span.id and
///   langsmith.span.dotted_order are absent from the wire — identity is carried purely by
///   native OTel traceId/spanId/parentSpanId. There is consequently NO run-granularity join key
///   of any kind in this dialect (no invocation id, no run id), which is why this seed has
///   exactly one session candidate and no run-granular one.
///
/// * `span_kind_and_names_are_useless_for_classification`: 59/59 spans are INTERNAL (kind=1).
///   Span NAMES are pure customer input — they are the graph node names (assistant,
///   tool_executor, route, orchestrator, budget_worker) and the compiled graph name; without
///   builder.compile(name=...) the root is the literal string 'LangGraph'. No span-name
///   predicate may be written for this framework. The type discriminator is the attribute
///   langsmith.span.kind (chain|llm|tool observed; retriever|prompt|parser|embedding also exist
///   in source).
///
/// * `attribute_values_are_properly_typed`: Unlike spring_ai, this exporter preserves OTLP
///   types: gen_ai.usage.* arrive as intValue, langsmith.metadata.ls_temperature as
///   doubleValue, langsmith.metadata.stream as boolValue. Canonical stringification therefore
///   matters for eq() predicates over these keys (bool -> "true"/"false").
///
/// * `stale_probe_capture_present`: captures/langgraph_smoke (1 record, 3 spans, 1 trace) is a
///   throwaway OTel-wiring probe from the same review. It is deliberately NOT listed in
///   captures: above and must never be counted as fixture data; §7 regeneration should delete
///   it.
///
/// Config variants that change the wire shape (`langsmith-internal-provider`): recorded in full
/// in the seed's `variants:` block — re-read it before touching this vendor's rules.
pub const LANGCHAIN: VendorDef = VendorDef {
    id: VendorId::Langchain,
    detect: detect_langchain,
    keys: &["gen_ai.system"],
    prefixes: &["langsmith."],
    span_names: &[],
    session_candidates: &[
        // verdict: B.
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
        // source_code: LangSmith's default project name when neither LANGSMITH_PROJECT nor
        // LANGCHAIN_PROJECT nor LANGCHAIN_SESSION is set (utils.py:446-462). It is therefore
        // the most common value of langsmith.trace.session_name and
        // langsmith.metadata.LANGSMITH_PROJECT in the wild. Not observed here (the harness sets
        // the project to the capture id [H]), and listed as a value so that any future
        // candidate carrying it is forced to state 4 rather than 6.
        "default",
    ],
};

// Phase-2 predicate (langgraph spec L-extra-1, integration decision): the v1
// `langsmith.internal_provider` resource conjunct is DROPPED, not ported. It was
// source_code-only (zero wire witnesses: 0/62 spans across all three langgraph
// capture dirs, 0 corpus-wide), and v2 has no non-classifying tier — as a
// standalone disjunct it is either redundant (the provider is private to
// langsmith, so the marker co-occurs only with scope=langsmith) or a latent
// process-wide FP (a globally-registered internal provider would stamp every
// co-tenant library's spans with the marker resource). The seed's
// langsmith-internal-provider variant records "span attributes, scope and session
// behaviour are identical", so the scope + attr clauses below cover that variant
// with zero span loss. The seed entry stays as the review record.
fn detect_langchain(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded: trace.get_tracer("langsmith", tracer_provider=...) at
    // _otel_exporter.py:243 — one call site, one tracer for the whole package, no version
    // and no schema_url argument (wire confirms scope.version = "" and no schemaUrl on
    // 59/59 spans). It is a bare, unnamespaced word, but it is a product name rather than a
    // generic term like 'ai'/'gen_ai', and nothing else in the OTel ecosystem claims it
    // (phase-2 corpus sweep: zero non-langgraph spans with this scope across 57 captures).
    // Two things temper that: (a) with no version and no schema_url there is NO secondary
    // confirmation available for a tiebreak, unlike google_adk; (b) the scope is the
    // LangSmith dialect's, not LangGraph's — plain LangChain and bare @traceable spans land
    // in it too (see false_positives), which is exactly the `langchain` vendor per D2.
    s.scope_name() == "langsmith"
        // source: wire. Library-owned, product-named prefix (langsmith.span.kind /
        // trace.name / trace.session_name are written for every exported run,
        // _otel_exporter.py:546-555): 42/42 + 17/17 spans. Rename-proofs against scope
        // rewrite/loss; corpus sweep: zero foreign spans carry any langsmith.* key.
        || s.any_attr_prefix("langsmith.")
        // source: wire. gen_ai.system defaults to the literal "langchain" for every
        // non-LLM run (_set_gen_ai_system fallback): 33/42 + 9/17, always co-occurring
        // with the clauses above, so this adds zero corpus coverage — it exists purely to
        // survive a langsmith.* namespace rename. Generic KEY but vendor-named VALUE;
        // corpus sweep: zero foreign spans (openrouter's 1,477 gen_ai.system values are
        // "openai", never "langchain"). NEVER extend to values "openai"/"anthropic" —
        // those are guessed by substring-matching the model name and collide with real
        // provider SDK instrumentation.
        || s.attr("gen_ai.system") == Some("langchain")
}

/// Seed: frameworks/litellm/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `service.instance.id` (wire): RESOURCE attribute, a fresh uuid4 per PROCESS generated by
///   the OTel Python SDK (sdk/resources/__init__.py:507-528), not by LiteLLM. Because each
///   scenario is one process it takes exactly one value per capture and looks like a perfect
///   session id; in a long-lived gateway it is one value for millions of sessions. The
///   archetypal fixture-shaped trap: predicates fall through to resource attributes, so a
///   candidate on this key would resolve on EVERY span.
///
/// * `model_id` (wire): RESOURCE attribute; defaults to OTEL_MODEL_ID or, failing that,
///   service.name (opentelemetry.py:254-255, 370) — here the literal 'litellm-user' / 'litellm-
///   agents'. Deployment identity, constant forever.
///
/// * `deployment.environment` (wire): RESOURCE attribute from OTEL_ENVIRONMENT_NAME, default
///   'production' (opentelemetry.py:253). A process-wide constant.
///
/// * `litellm.call_id` (wire): A fresh uuid4 per completion() call (17 distinct values across
///   17 spans). Correlates one LLM request, not a conversation — and it is the authority
///   predicate for the candidates above precisely because it marks the request population.
///
/// * `gen_ai.response.id` (wire): Provider response id (gen-1785983497-…), unique per call.
///
/// * `llm.openrouter.id` (wire): The same provider response id repeated on raw_gen_ai_request
///   under the provider-prefixed namespace. Unique per call.
///
/// * `metadata.user_api_key_hash` (wire): Hash of the virtual key. Key identity, not session
///   identity — and empty in SDK mode like the other 29 blank metadata.* keys.
///
/// * `metadata.requester_metadata` (wire): The only channel for application metadata, and it
///   arrives as a stringified PYTHON DICT (single quotes), not JSON. A customer will inevitably
///   hide their own session id in here; it is not parseable by the algebra and must never be
///   treated as a key.
///
/// # Caveats (the seed review's rationale record)
///
/// * `litellm_is_usually_a_passthrough`: The most important fact about this vendor: LiteLLM is
///   a gateway, not an agent framework, so most real LiteLLM telemetry arrives UNDERNEATH
///   another framework's spans rather than on its own. Expect litellm to co-occur with a second
///   AI vendor in the same trace far more often than it appears alone, and expect its spans to
///   be leaves. Vendor must be per-span; a per-trace vendor scalar is wrong for every
///   passthrough deployment.
///
/// * `silent_attribute_loss_landmine`: SOURCE-VERIFIED, opentelemetry.py:1206 (sync) and 1936
///   (async): should_create_primary_span = parent_span is None or
///   get_secret_bool('USE_OTEL_LITELLM_REQUEST_SPAN'). With a parent span present and the flag
///   unset — the DEFAULT for any wrapper — LiteLLM creates no span and stamps every
///   gen_ai./llm./litellm./metadata. attribute onto the caller's span (line 1224). If that
///   caller's span has already ended (LiteLLM's success callback runs after a synchronous
///   `with` block exits) the OTel SDK discards each set_attribute with a 'Setting attribute on
///   ended span' log line and nothing else. The first run of this fixture produced 28 spans
///   with ZERO token, model or message data and no error. Any framework that wraps LiteLLM
///   without setting this flag exports LLM spans with no LLM attributes — a silent-zero trap
///   maple should expect to see in the wild.
///
/// * `cost_is_only_inside_a_json_string`: There is no gen_ai.usage.cost attribute. Per-call
///   cost exists on the trace ONLY as `response_cost` inside the hidden_params JSON string
///   attribute (e.g. {"model_id": null, …, "response_cost": 0.00011625, …}, ~1.4 KB), and a
///   second time inside metadata.usage_object / llm.<provider>.usage, both of which are Python
///   repr() with single quotes rather than JSON. First-class cost exists only on the opt-in
///   gen_ai.client.token.cost metric.
///
/// * `thirty_of_thirty_three_metadata_keys_are_blank`: Every litellm_request span carries
///   exactly 33 metadata.* attributes of which 30 are the empty string in SDK mode
///   (user_api_key_hash, _team_id, _org_id, _user_id, _end_user_id, spend_logs_metadata,
///   team_alias, …). They are pure noise — about half the attribute count of the corpus' widest
///   span — but always present, so present()-based rules and non-null-based dashboards both see
///   them as populated.
///
/// * `six_attribute_families_on_one_span`: A single litellm_request span carries 50-63
///   attributes spanning six vocabularies at once: OTel gen_ai semconv, Traceloop/OpenLLMetry
///   llm.*, INDEXED gen_ai.completion.<i>.function_call.*, LiteLLM's own litellm.*, 33
///   metadata.*, and the bare unnamespaced hidden_params. Widest single span in the corpus; any
///   family-based classifier will see several families fire simultaneously.
///
/// * `span_names_are_customer_overridable`: metadata={'generation_name': …} replaces the span
///   name for BOTH litellm_request (opentelemetry.py:2718-2722) and raw_gen_ai_request
///   (opentelemetry.py:1306). Combined with the gen-ai-latest-experimental rename, no span-name
///   predicate is safe for this vendor — which is why none appears in this seed despite
///   `litellm_request` being an unusually distinctive name.
///
/// * `scope_name_is_env_overridable`: LITELLM_TRACER_NAME = os.getenv('OTEL_TRACER_NAME',
///   'litellm') (opentelemetry.py:70) — read at MODULE IMPORT, so the scope name a customer's
///   spans arrive under is app-controllable. The default is a bare, unversioned, schema-less
///   word: scope.version and scope.schemaUrl are both empty on all 34 native spans because
///   get_tracer is called with the name alone (opentelemetry.py:561). otel-v2 passes a version;
///   v1 never does.
///
/// * `gen_ai_system_is_the_provider_not_litellm`: gen_ai.system is `openrouter` on all 17
///   litellm_request spans — the routed provider, never `litellm`. gen_ai.request.model is the
///   provider-side name (openai/gpt-4o-mini) while litellm.provider.model is the routed LiteLLM
///   name (openrouter/openai/gpt-4o-mini); the two differ on every span. LiteLLM self-
///   identifies in exactly one place in the whole integration: gen_ai.framework="litellm" on
///   the opt-in METRICS (opentelemetry.py:1471). No trace attribute names the framework.
///
/// * `operation_name_is_not_a_semconv_value`: gen_ai.operation.name = `acompletion` (the
///   litellm call type: completion / acompletion / …), not `chat`. It only becomes `chat` under
///   the gen-ai-latest-experimental opt-in. NOTES.md previously claimed `chat` for the default
///   dialect; the wire disagrees and the wire wins. Any unknown-tier rule that switches on the
///   VALUE of gen_ai.operation.name will not recognise default-dialect LiteLLM.
///
/// * `values_are_python_repr_not_json`: gen_ai.input.messages / gen_ai.output.messages /
///   hidden_params are real JSON, but metadata.usage_object, metadata.requester_metadata and
///   every llm.<provider>.* blob are Python str()/repr() with single quotes and None/True/False
///   literals. A JSON parser fails on them. All attribute values arrive as OTLP stringValue,
///   including counts and booleans (llm.is_streaming="False").
///
/// * `native_spans_are_always_ok`: Both native span types set StatusCode.OK explicitly
///   (opentelemetry.py:1282, 1313) rather than leaving UNSET. Wire-confirmed after the fidelity
///   pass: 34/34 spans carry status code 1 and 0 span events — including litellm_agents, whose
///   fetch_transport_data tool raised a 503 and whose model wrote about the failure in prose.
///   There is NO error signal of any kind on a LiteLLM trace when the APPLICATION fails; only a
///   failed LLM call reaches _handle_failure, which no scenario exercised. otel-v2 changes the
///   success status to UNSET.
///
/// * `default_topology_is_one_trace_per_request`: WIRE-VERIFIED 2026-08-11, the headline fact
///   for maple. A customer calling litellm.acompletion() with no other instrumentation gets ONE
///   INDEPENDENT TRACE PER HTTP REQUEST — 2 spans, root litellm_request, child
///   raw_gen_ai_request, nothing linking it to the previous call. A 6-turn chat is 9
///   disconnected traces (litellm_user); a 5-agent orchestration with a real parallel fan-out
///   is 8 disconnected traces (litellm_agents). Combined with the total absence of a session
///   key, LiteLLM is the corpus' worst case for conversation reconstruction: neither a trace id
///   nor an attribute joins two calls of the same conversation. Any grouping maple offers here
///   must come from resource identity + time, or from the customer adding their own parent span
///   — which then triggers the no-primary-span landmine.
///
/// * `harness_no_longer_emits`: PROVENANCE, post-§7: the fixture (frameworks/litellm/**)
///   creates no spans and sets no attributes. telemetry.py wires LiteLLM's own OTel callback
///   and calls force_flush; agent.py/scenario_*.py call acompletion() and nothing else, and no
///   USE_OTEL_LITELLM_REQUEST_SPAN or content-capture override is set. The one fixture-visible
///   value on the wire is metadata.requester_metadata, which is LiteLLM's own application-
///   metadata channel (metadata={'metadata': {...}}), not instrumentation — a real customer's
///   app metadata lands in exactly the same place. captures/litellm_semconv_probe still
///   contains 4 pre-pass harness spans and is excluded from the goldens.
///
/// Config variants that change the wire shape (`gen-ai-latest-experimental`, `otel-v2`, `no-
/// primary-span`, `primary-span-forced`): recorded in full in the seed's `variants:` block —
/// re-read it before touching this vendor's rules.
pub const LITELLM: VendorDef = VendorDef {
    id: VendorId::Litellm,
    detect: detect_litellm,
    // `litellm.call_id` is consulted by the session authority only; detect reads
    // nothing but the scope column (see detect_litellm).
    keys: &["litellm.call_id"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // verdict: A.
        SessionCandidateDef {
            key: "metadata.user_api_key_end_user_id",
            authority: litellm_session_authority,
            require_non_empty: true,
            reject_decoy_values: true,
            event_key: None,
            granularity: Granularity::User,
            granularity_of_value: None,
        },
        // verdict: A.
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
        // wire: 30 of the 33 metadata.* keys on EVERY litellm_request span are the empty string
        // in SDK mode (only applied_guardrails, requester_metadata and usage_object hold data).
        // present() matches all of them, so any presence-only session resolution collapses
        // every LiteLLM trace in the fleet onto one "" group. This is the single most important
        // validation fact for this vendor.
        "",
        // source_code: LiteLLM's proxy sentinel for the global admin (proxy/_types.py:3106).
        // Not observed here (SDK mode blanks the key), but a proxy deployment stamps it into
        // metadata.user_api_key_user_id for every admin-key request, producing a deployment-
        // wide constant that looks like a real user id.
        "default_user_id",
    ],
};

// Phase-2 predicate (fix-queue LI2, applied as a DELETION): the v1 unguarded
// `litellm.` prefix matcher stole the host framework's spans under LiteLLM's
// default no-primary-span config (opentelemetry.py:1222-1226 stamps the CALLER's
// span with litellm's whole attribute set), and its guarded form
// `any_attr_prefix("litellm.") && scope == "litellm"` is subsumed by the scope
// clause — so the scope equality is the entire predicate. The v1 `model_id`
// resource conjunct is likewise gone: LiteLLM installs the GLOBAL TracerProvider,
// so `model_id` is a process-wide resource that every co-tenant library inherits
// (opentelemetry.py:364-374, 549-557); it stays as doc-comment evidence and a
// decoy key only. Rename evasion is the ACCEPTED ceiling (integration decision):
// OTEL_TRACER_NAME renames the scope and the spans degrade to unknown:genai
// (litellm_request carries gen_ai.operation.name 17/17) / unknown:other
// (raw_gen_ai_request via the `llm.` fingerprint) — no span-local signal
// separates "litellm under a renamed scope" from "foreign span stamped by
// passthrough", because the attribute sets are identical by construction.
fn detect_litellm(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded in litellm/integrations/opentelemetry.py:70 (LITELLM_TRACER_NAME) and again
    // in the v2 rewrite at otel/logger.py:69. It is the ONLY thing that classifies
    // `raw_gen_ai_request` (17 spans across the two captures), which carries no gen_ai.*,
    // no litellm.* and no stable attribute namespace at all. Catches 18/18 + 16/16 golden
    // spans and the 3 native spans of litellm_semconv_probe (the gen-ai-latest-experimental
    // dialect keeps the scope while renaming spans). Corpus negative sweep (phase-2 review):
    // zero spans in any other capture carry this scope. Two caveats: (a) the name is a bare
    // word and is overridable by the app via OTEL_TRACER_NAME — see the rename-evasion
    // ceiling above. (b) In proxy deployments and under otel-v2 this scope also carries
    // non-AI spans (`Received Proxy Server Request`, `{service} {call_type}`) — they are
    // still LiteLLM's spans, so vendor attribution stays correct even when 'is this an AI
    // span' does not.
    s.scope_name() == "litellm"
}

fn litellm_session_authority(s: &SpanCtx) -> bool {
    s.has_attr("litellm.call_id")
}

/// Seed: frameworks/llamaindex/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `session_id` (source_code): llama_index.core.memory.Memory.session_id (memory.py:254,
///   defaulting to generate_chat_store_key()) is the SQL/chat-store partition key that the
///   memory blocks read and write. It is the one thing in LlamaIndex actually named a session —
///   and it NEVER reaches telemetry: no span attribute, no event attribute, 0 occurrences in
///   either capture. Joining on it is impossible, and expecting it is the natural mistake.
///
/// * `span_id` (wire): Present on every dispatcher span EVENT (36+9+6 events per capture). It
///   is LlamaIndex's own string span id, format `ClassName.method-<uuid4>` — NOT the OTel span
///   id and not stable across anything. Session-shaped (a uuid4) and sitting next to
///   tags.llamaindex.run_id in the same event attribute map.
///
/// * `id_` (wire): Per-EVENT uuid4 on every span event; changes several times per span. The
///   most session-shaped bare uuid in the capture.
///
/// * `llamaindex.step.input_event` (wire): The workflow event CLASS NAME that triggered the
///   step (AgentSetup, ToolCall, AgentWorkflowStartEvent, WeatherTask, ...): 73/79 and 69/75
///   spans, only 6 distinct values, constant across runs. A low-cardinality string that a naive
///   group-by could mistake for a conversation/thread key.
///
/// Harness-only keys in the fixture captures (not framework signal): `llamaindex.agent_name`,
/// `llamaindex.agent_model`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `payload_lives_in_span_events`: The defining property of this dialect: the classification-
///   relevant surface (attributes) and the value-relevant surface (span events) are disjoint.
///   Three attribute keys total; everything a consumer wants — prompts, tool arguments, tool
///   results, agent replies, model name — is in flatten_dict()ed span EVENT attributes
///   (LLMChatStartEvent.messages, model_dict.model_name, step.output.output,
///   workflow.output.output). Any ingest path that drops span events keeps 100% of the
///   classification signal and loses ~82% of the payload.
///
/// * `no_model_no_tokens_no_cost`: There is no model name, no token count and no cost on any
///   span, in any signal. Model identity exists only inside the LLMChatStartEvent event
///   (model_dict.model_name), which is present on 9/18 and 8/16 astream_chat spans. Token usage
///   exists NOWHERE: LLMChatEndEvent/LLMChatInProgressEvent are dropped because the streaming
///   span closes when the coroutine returns the generator, before the stream is consumed
///   (base.py:306 `if current_span_id not in self.span_handler.all_spans`). Per-span cost/token
///   rollups are impossible for LlamaIndex.
///
/// * `double_llm_spans`: Every LLM call emits TWO OpenRouter.astream_chat spans with near-
///   identical timing (FunctionCallingLLM.astream_chat_with_tools -> astream_chat, both
///   dispatcher-decorated): 18 spans / 9 LLMChatStartEvents in llamaindex_user, 16/8 in
///   llamaindex_agents. Only the first carries the event. Any LLM-call count keyed on span name
///   double-counts; dedupe on (parent, LLMChatStartEvent presence).
///
/// * `hitl_error_spans_are_not_failures`: NATIVE HITL: ctx.wait_for_event(HumanResponseEvent,
///   waiter_event= InputRequiredEvent(...)) suspends by raising an internal control-flow
///   exception and REPLAYING the step, so each approval produces two FunctionTool.acall spans —
///   the first with StatusCode.ERROR, a SpanDropEvent and an `exception` event whose message is
///   `Waiting for event <class 'workflows.events.HumanResponseEvent'>`, then a successful one.
///   2 of the 3 ERROR spans in the corpus-for-this-framework are this pattern, not failures.
///   There is no HITL-specific attribute or event name: the approval gate is only detectable by
///   that exception message string, which the algebra cannot match.
///
/// * `error_status_is_native_and_shallow`: Unlike google_adk, the ERROR status and the
///   `exception` span event are NATIVE here (base.py:245-255 prepare_to_drop_span calls
///   record_exception + set_status). The real tool failure (fetch_transport_data 503) is marked
///   ERROR on FunctionTool.acall only; the parent BaseWorkflowAgent.call_tool stays OK because
///   the agent converts the exception into a ToolCallResult. exception.stacktrace frames are
///   dispatcher internals, not customer code.
///
/// * `instrument_tags_is_the_only_extension_point`: [H] scenario_b.py uses
///   instrument_tags({'agent_name','agent_model'}) around each worker run, producing
///   llamaindex.agent_name/llamaindex.agent_model on 62/75 spans. Those keys are FIXTURE-ONLY
///   and must not be transcribed. They are kept visible because they prove two registry-
///   relevant facts: (a) LlamaIndex has NO native agent-identity attribute — without tags,
///   agent identity is recoverable only from prompt text inside span events; (b)
///   instrument_tags is the injection point for any customer key, session ids included, and it
///   prefixes dot-less keys with 'llamaindex.' while passing dotted keys through verbatim
///   (base.py:191-196). NOT counted under harness_mutated_spans (fixed after cross-seed audit):
///   passing config through a first-class API (instrument_tags) is simulated customer action,
///   exactly like mastra's tracingOptions.metadata — 'mutated' is reserved for scenario code
///   calling telemetry APIs on native spans (record_exception/set_status/ add_event, the
///   google_adk case). The injected VALUES stay [H] and the keys are listed under harness_keys.
///
/// * `instrument_tags_injection`: Because the only injection point is a free-form tag dict,
///   there is NO canonical LlamaIndex session attribute key, and the seed carries no session
///   candidate (the earlier 'session.id' convention-bet candidate was removed by the cross-seed
///   audit — unobserved, non-native keys are not registrable). The mechanism itself, for the
///   education surface: wrap each run in `with instrument_tags({'<your-key>': sid}): await
///   agent.run(...)` — tags are read at span creation (dispatcher.py:361-375), so the key lands
///   on the ROOT and every descendant (unlike run_id, applied post-root); a dotted key is
///   written verbatim, a dot-less key becomes llamaindex.<key> (base.py:191-196). Session
///   support therefore requires per-tenant configuration (a per-org overlay rule or the
///   key_prefix-shaped candidate recorded in algebra_violations).
///
/// * `thinnest_resource_in_the_corpus`: The resource has TWO attributes (service.name plus the
///   fixture's framework=llamaindex [H]) and NO telemetry.sdk.* at all — not language, not
///   name, not version. This is not only a fixture artefact: the library's own default builds
///   the resource with the bare Resource(attributes=...) constructor rather than
///   Resource.create() (base.py:363-366,382), so the default customer path also ships a
///   resource with a single attribute and no SDK identification. Any ingest heuristic keyed on
///   telemetry.sdk.language sees nothing here.
///
/// * `run_id_is_the_only_native_correlator`: llamaindex.run_id is a genuinely useful correlator
///   at RUN granularity (it groups the 5 agent sub-runs inside the llamaindex_agents trace and
///   survives across the batch boundary), but it is one level below session and one level below
///   trace in llamaindex_agents. Recording it as a candidate at granularity: run is what keeps
///   state-5 visible in key_state_by_candidate; the max-reduction would otherwise print the
///   same histogram as a framework with no keys at all.
///
/// Config variants that change the wire shape (`app-owned-resource`): recorded in full in the
/// seed's `variants:` block — re-read it before touching this vendor's rules.
///
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
        // verdict: A.
        SessionCandidateDef {
            key: "llamaindex.run_id",
            // No authority predicate — every span of the vendor is authoritative.
            authority: |_| true,
            require_non_empty: true,
            reject_decoy_values: false,
            // Phase-2 LL2: the 12 attribute-less `*.run` spans (6+6 across the two
            // captures, incl. all 7 trace roots) carry exactly one workflow.output
            // event whose tags.llamaindex.run_id holds the run id — wire-verified,
            // and on the 142 spans carrying BOTH the span attr and event tags the
            // values never disagree (0/154 mismatches), so attr-first precedence is
            // deterministic and unobservable on the corpus. The fallback reads
            // exactly this one key and must never fuzzy-match "a session-shaped
            // uuid in the event attrs" — the decoys `span_id` and `id_` live in the
            // SAME event attribute map.
            event_key: Some("tags.llamaindex.run_id"),
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
    ],
    decoy_values: &[],
};

// Phase-2 predicate (fix-queue LL1 + X2 at the vendor tier; LL3 declined). The v1
// `service.name == "llamaindex.opentelemetry"` resource conjunct is NOT ported: a
// resource is process-wide — in a default-resource LlamaIndex app that also runs
// opentelemetry-instrumentation-httpx/openai, every httpx/openai span shares that
// resource, and an OR-clause would steal them. It never classified in v1
// (insufficient) and is observed on 0/154 corpus spans (both captures take the
// app-owned-resource variant, service.name=llamaindex-<captureId> [H]); it stays
// recorded here as the education-surface fact (base.py:363-366 hardcodes
// Resource(attributes={SERVICE_NAME: 'llamaindex.opentelemetry'}) whenever the app
// passes neither service_name_or_resource= nor tracer_provider=). Bare event NAMES
// (workflow.output / step.output / LLMChatStartEvent / SpanDropEvent) are the
// declined refinement of LL1: generic strings, subsumed by the tags clause on
// every wire span. LL3's span-name grammar (ends_with(".run")) stays declined —
// the name set is open (customer class names) and `.run` collides ecosystem-wide.
fn detect_llamaindex(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded in llama_index/observability/otel/base.py:398
    // (trace.get_tracer("llamaindex.opentelemetry.tracer")) — library-owned, namespaced,
    // and the ONLY scope in either capture (79/79 + 75/75 spans). The only clause that
    // needs no attributes at all: it classifies the 12 attribute-less `*.run` spans
    // (7 of which are the trace roots; the other 5 are mid-trace nested agent
    // boundaries in llamaindex_agents). get_tracer() is called with no version and no
    // schema_url, so scope.version and scope.schema_url are empty strings on every span
    // and cannot be used to distinguish LlamaIndex releases.
    s.scope_name() == "llamaindex.opentelemetry.tracer"
        // source: wire. 73/79 + 69/75 spans carry llamaindex.run_id /
        // llamaindex.step.input_event / llamaindex.step.input_summary (native,
        // workflows/context/context.py:280 + step_function.py:267-268); the bridge
        // prefixes any dot-less instrument_tags key with "llamaindex." (base.py:191-196),
        // so the namespace is closed over the vendor. Corpus FP scan: 0 llamaindex.*
        // span-attr keys outside the two llamaindex captures. v1 held this matcher as
        // insufficient; classifying on it is the vendor-tier resolution of X2 (the
        // scope-rewrite safety net) — an unknown-tier llamaindex. fingerprint would be
        // dead code behind this clause and is deliberately NOT added.
        || s.any_attr_prefix("llamaindex.")
        // source: wire (phase-2 LL1). Dispatcher-mirrored span events repeat the
        // instrument_tags map as tags.<key> event attributes, and the native keys are
        // pre-prefixed: tags.llamaindex.run_id / tags.llamaindex.step.* ride 53/55 +
        // 51/52 events (all but OTel-native `exception`), on 104/154 spans including
        // all 12 attribute-less `*.run` spans. The only clause that reaches those spans
        // if the scope is ever rewritten/dropped by a collector. Corpus FP scan:
        // tags.llamaindex.* event-attr keys occur ONLY in the two llamaindex captures
        // (147 + 141 occurrences; openrouter 0, eve_slack 0). Vendor-namespaced, so
        // unconditional per X4.
        || s.events()
            .any(|event| event.any_attr_prefix("tags.llamaindex."))
}

/// Seed: frameworks/mastra/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `mastra.metadata.resumedFromSpanId` (wire): Session-shaped hex id on all 15 resume-
///   population spans in mastra_user, and it looks like a correlation key because it equals the
///   resumed root's dangling parentSpanId. It is a SPAN id (of an internal, never-exported
///   span), scoped to one suspend→resume hop; two different values inside one 66-span session.
///
/// * `mastra.metadata.resumed` (wire): Constant literal 'true' on the 15 resume spans. A
///   boolean marker, not an identifier — but it is the only span-local way to recognise the
///   resume roots whose parents dangle (see algebra_violations).
///
/// * `gen_ai.response.id` (wire): On every `chat` span with a response (7/66 + 5/37); one
///   distinct value per LLM call, 7 values inside the single mastra_user session.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_… / toolu_bdrk_…). Per tool
///   invocation; the one value that repeats (call_nGuNvnEH… x2 in mastra_agents) does so only
///   because that span was exported twice.
///
/// * `service.name` (wire): mastra-<captureId> here [H]; in real deployments it is the
///   Observability config's serviceName — process/deployment identity, never session identity.
///   Note it is also the ONLY attribute on the log signal's resource.
///
/// Harness-only keys in the fixture captures (not framework signal):
/// `mastra.metadata.scenario`, `mastra.metadata.capture`, `mastra.metadata.turn`,
/// `mastra.metadata.approval`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `dangling_parents_on_resume`: Mastra's HITL resume re-parents the new root onto the span
///   that was live when the run suspended (@mastra/core dist/workflow-event-processor-
///   BbED1LMn.js:2207-2215 persists {traceId, spanId}; dist/agent-Dj30gJa3.js:34499-34506 feeds
///   it back as tracingOptions.parentSpanId). Under the default includeInternalSpans: false
///   that span is an INTERNAL loop span that is never exported, and BaseSpan.getParentSpanId
///   returns the persisted id verbatim without the usual internal-span skip
///   (@mastra/observability dist/index.js:2579-2584). Result: 2 spans in mastra_user declare
///   parents 85b7af4294e4b0ef / 5179d6fcaf30c7ba that no record ever contains. Root detection
///   MUST be 'parent absent from the trace' — mastra_user then has 9 roots across 7 traces,
///   with 2 traces holding 2 roots each.
///
/// * `duplicate_span_id_with_conflicting_error`: mastra_agents record seq 0 contains
///   `execute_tool fetch_transport_data` TWICE under one span id (9c1bf272f056c34a) — same
///   trace, same parent, same status (ERROR/503), same exception event, but error.type=unknown
///   on the first copy and error.type=TOOL_EXECUTION_FAILED on the second. error.type is
///   `span.errorInfo.id || 'unknown'` (otel-exporter dist/index.js:487), so the tool span was
///   ended twice with progressively-enriched errorInfo and both ends were exported. 37 spans,
///   36 distinct span ids. See algebra_violations.
///
/// * `no_gen_ai_system`: Mastra emits NO gen_ai.system. Provider attribution lives in
///   gen_ai.provider.name, normalized from the model string by an alias table
///   (dist/index.js:498-557): every call here went to OpenRouter, so the value is the literal
///   'openrouter' (not in the semconv's provider list) while gen_ai.request.model carries
///   openai/gpt-4o-mini or anthropic/claude-haiku-4.5. Any rule keyed on gen_ai.system misses
///   Mastra entirely.
///
/// * `operation_name_is_not_semconv`: gen_ai.operation.name doubles as Mastra's span-type
///   field: 6 of the 8 observed values (model_step, model_inference, memory_operation,
///   processor_run, workflow_step, workflow_parallel) are not semconv operation names, they are
///   span.type.toLowerCase(). Convenient for coverage, hostile to any consumer that validates
///   the enum.
///
/// * `nested_model_spans_double_count`: One LLM call produces up to three nested spans: `chat
///   <model>` (CLIENT, the only one with gen_ai.request/response/usage), `model_step <agent>`
///   and `model_inference <agent>` (both INTERNAL, carrying mastra.model_step.input/output
///   blobs). In mastra_user that is 9 chat / 9 model_step / 9 model_inference for 9 LLM calls;
///   in mastra_agents 5 / 8 / 8 (multi-step tool loops). Token and cost rollups must count
///   `chat` spans only.
///
/// * `span_kind_is_almost_useless`: getSpanKind maps MODEL_GENERATION / RAG_EMBEDDING /
///   MCP_TOOL_CALL to CLIENT and everything else to INTERNAL (dist/index.js:657-664). So 9+5
///   CLIENT spans and 89 INTERNAL — the trace root is INTERNAL even in the workflow scenario.
///
/// * `attribute_typing_is_mixed`: Unlike the Java frameworks, values keep their OTLP types:
///   token counts arrive as intValue, temperature as doubleValue,
///   gen_ai.response.finish_reasons as a JSON STRING '["stop"]' (JSON.stringify of a one-
///   element array, dist/index.js:449) and gen_ai.tool.definitions as a JSON string array.
///   Canonical stringification is required before any eq() comparison.
///
/// * `harness_metadata_shares_the_framework_namespace`: [H] The scenarios pass
///   tracingOptions.metadata {scenario, turn, capture, approval}; the exporter writes them into
///   mastra.metadata.* alongside the framework's own runId/threadId/resourceId. Zero spans are
///   harness-EMITTED and zero are harness-MUTATED (no manual span API is used anywhere under
///   frameworks/mastra/ — grep for startActiveSpan/setAttribute/recordException/addEvent
///   returns nothing), but 103/103 spans carry harness-authored attribute keys that a
///   customer's own metadata would occupy identically. See session.harness_keys.
///
/// * `exports_nothing_without_an_explicit_exporter`: Mastra reads no OTEL_EXPORTER_OTLP_*
///   variable: OtelExporter requires an explicit provider config and disables itself with
///   '[OtelExporter] Custom configuration requires endpoint' otherwise, and `observability`
///   must be an Observability INSTANCE — passing a plain config object silently installs
///   NoOpObservability. Both failure modes are silent, which bounds how much Mastra data
///   arrives from apps that were merely env-configured.
///
/// * `single_resource_block_per_record`: Every record is one resourceSpans block with one
///   scopeSpans block containing the whole batch (18/29/19 spans for mastra_user), so the
///   resource and scope are NOT duplicated per span — the opposite of spring_ai's one-span-per-
///   block shape.
///
/// Config variants that change the wire shape (`include-internal-spans`, `exclude-span-types`):
/// recorded in full in the seed's `variants:` block — re-read it before touching this vendor's
/// rules.
pub const MASTRA: VendorDef = VendorDef {
    id: VendorId::Mastra,
    detect: detect_mastra,
    keys: &["telemetry.sdk.name", "mastra.span.type"],
    prefixes: &["mastra."],
    span_names: &[],
    session_candidates: &[
        // verdict: B.
        SessionCandidateDef {
            key: "gen_ai.conversation.id",
            authority: mastra_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: A.
        SessionCandidateDef {
            key: "mastra.metadata.runId",
            authority: mastra_session_authority,
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Run,
            granularity_of_value: None,
        },
        // verdict: B.
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

// Phase 2 (fix-queue M1–M3 + expert M4, 2026-08-13): re-adjudicated, shape CONFIRMED.
// M1 (duplicate span id with conflicting error.type), M2 (resume roots with dangling
// parents) and M3 (harness-indistinguishable mastra.metadata.* provenance) all stay
// DO-NOT-FIX — each needs cross-span state or absent wire data; the caveats below are
// the permanent record, and classification is already correct and deterministic on
// every one of those shapes (both duplicate copies classify identically; both resume
// roots carry the session key). M4 — the `mastra.` namespace as a standalone
// rename-proof disjunct — is CONFIRMED as shipped: mastra.span.type is written
// unconditionally on every span (otel-exporter dist/index.js:419-420; 66/66 + 37/37 +
// 21/21 wire), the namespace is exporter-owned (the only customer injection path,
// tracingOptions.metadata -> mastra.metadata.*, lands on Mastra's own spans by
// construction — unlike llamaindex's instrument_tags there is no API that puts
// mastra.* on a non-Mastra span), and the negative sweep is clean: 0/4,097 openrouter,
// 0/2,328 eve_slack, 0/1,927 eve_slack_no_messages carry any `mastra.` key. A
// scope+resource rename (both pin the npm package name, so they rename together)
// degrades to `mastra`, not to unknown:genai.
fn detect_mastra(s: &SpanCtx) -> bool {
    // source: wire.
    // The only NATIVE framework-identifying resource attribute in the corpus. Mastra abuses
    // the standard OTel key: SpanConverter.initIfNeeded() (otel-exporter
    // dist/index.js:585-600) builds the resource from scratch with telemetry.sdk.name = the
    // exporter package name and telemetry.sdk.version = the exporter version (1.3.8), while
    // service.version carries the @mastra/core version. STANDALONE sufficiency is justified
    // by construction, not by single-vendor-process assumption: this resource is minted per
    // exported span inside Mastra's own converter — no resource detector, no merge with a
    // global SDK Resource — and Mastra never routes spans through a process-wide
    // TracerProvider. A Mastra app also running @opentelemetry/auto-instrumentations-node
    // therefore emits its HTTP / DB spans with the NodeSDK's own resource
    // (telemetry.sdk.name=opentelemetry); those spans cannot inherit this value. The only
    // ways to see it on a non-Mastra span are a customer explicitly setting
    // OTEL_RESOURCE_ATTRIBUTES or the exporter's own resourceAttributes option to this
    // value (it is merged last and would win), or a collector rewriting resources. Both are
    // pathological; the scope test agrees on 103/103 spans in these captures, so a wrong
    // sufficiency verdict changes nothing here. NOTE the asymmetry: the LOG signal's
    // resource is built separately (dist/index.js:936-941) and carries service.name ONLY,
    // so this predicate classifies spans but never log records.
    s.resource("telemetry.sdk.name") == Some("@mastra/otel-exporter")
        // owned_by: library, source: wire.
        // Hardcoded: SpanConverter sets scope = {name: params.packageName, version: <resolved
        // package version>} with packageName pinned to the literal '@mastra/otel-exporter' at
        // construction (otel-exporter dist/index.js:602-605, 910). Library-owned, npm-
        // namespaced, stable across the package; catches 66/66 + 37/37 spans and the single log
        // record (LoggerProvider.getLogger uses the same name, dist/index.js:944). Nothing else
        // can land in this scope: Mastra converts finished AISpans into ReadableSpans and
        // pushes them straight into its own BatchSpanProcessor (dist/index.js:963-967), so no
        // third-party instrumentation can write to it. The scope identifies the EXPORTER, not
        // the framework version — scope.version tracks @mastra/otel-exporter, and
        // @mastra/core's version is only visible as service.version.
        || s.scope_name() == "@mastra/otel-exporter"
        // source: wire.
        || s.any_attr_prefix("mastra.")
}

// Deliberately `has_attr("mastra.span.type")` rather than `|_| true` (phase-2
// re-adjudication kept the seed's non-self-referential choice): under detect clauses
// (a)/(b) a hypothetical attribute-less span in the scope would correctly NOT be
// session-authoritative. In-corpus the two are indistinguishable — the key is a total
// cover (66/66 + 37/37 + 21/21).
fn mastra_session_authority(s: &SpanCtx) -> bool {
    s.has_attr("mastra.span.type")
}

/// Seed: frameworks/microsoft_agent_framework/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.agent.id` (wire): THE trap in this framework. Per-Agent-OBJECT uuid4
///   (_agents.py:436-438), on all 13 invoke_agent spans. In the user capture ONE value covers
///   all 8 traces and it is the only cross-trace constant that exists — a session-shaped
///   coincidence of one process holding one Agent object. The agents capture shows the truth: 5
///   distinct values inside a single workflow run. In a server the Agent is a module-level
///   singleton, so joining on it merges every user of the process into one 'session'. Customers
///   may also pass Agent(id=...) explicitly, which makes it stable across restarts and even
///   more convincing. It is agent identity, never conversation identity.
///
/// * `workflow.id` (wire): Per WorkflowBuilder.build() uuid4. Genuinely joins the two agents-
///   capture traces (identical value on workflow.build and workflow.run), which makes it look
///   like a session key — but a server builds the workflow once at import and runs it for every
///   request, so the value is process-constant across unrelated runs. Use it to stitch
///   build->run, never to define a session.
///
/// * `service.instance.id` (wire): uuid4 minted per process by the OTel SDK resource detector;
///   one value per capture, so it is perfectly session-shaped in a one-process fixture and
///   perfectly useless in a server. Process identity.
///
/// * `gen_ai.response.id` (wire): Provider response id on every `chat` span; unique per LLM
///   call.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_... / toolu_...). It repeats
///   across the HITL approval span and the resumed execute_tool span, which makes it look like
///   a correlation key for the approval flow; it correlates one tool call, not a session.
///
/// * `edge_group.id` (wire): '<EdgeGroupType>/<uuid4>' per edge group; the 3 FanIn spans share
///   one value and look like a group id. Scoped to the workflow graph, not to a conversation.
///
/// Harness-only keys in the fixture captures (not framework signal): `hitl.approval.id`,
/// `hitl.mechanism`, `hitl.tool.name`, `hitl.tool.arguments`, `hitl.user.response`,
/// `hitl.approved`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `otlp_protocol_defaults_to_grpc`: _get_exporters_from_env() reads
///   OTEL_EXPORTER_OTLP_PROTOCOL with default="grpc" (observability.py:554), against the OTel
///   spec default of http/protobuf. A customer pointing OTEL_EXPORTER_OTLP_ENDPOINT at an HTTP
///   collector and setting nothing else sends gRPC to an HTTP port and captures NOTHING —
///   silently, with retries, no error surfaced to the app. Highest-frequency onboarding failure
///   to expect for this vendor. The fixture sets the var explicitly (telemetry.py:25).
///
/// * `cumulative_histograms_reexported_in_full`: All three instruments are CUMULATIVE
///   (aggregationTemporality=2) behind a PeriodicExportingMetricReader at 5 s
///   (observability.py:983). Every export re-ships every data point ever recorded: in the user
///   capture seq 5 and seq 6 are byte-identical metric payloads, as are seq 6 and seq 7 in the
///   agents capture. Any naive sum over records double-counts, and metric volume grows with
///   process lifetime, not with traffic.
///
/// * `unbounded_metric_cardinality_on_tool_duration`:
///   agent_framework.function.invocation.duration is recorded with the execute_tool SPAN's
///   attribute dict (_tools.py:793), so its dimensions include gen_ai.tool.call.id — a unique
///   id per invocation — plus gen_ai.tool.description and, under ENABLE_SENSITIVE_DATA, the
///   full gen_ai.tool.call.arguments JSON. Every tool call therefore creates a NEW permanent
///   cumulative time series carrying prompt-derived content. Combined with cumulative
///   temporality this is an unbounded, monotonically growing metric payload; wire-visible
///   already at 3 series in a 32-span capture.
///
/// * `metric_views_drop_everything_else`: configure_otel_providers() installs
///   create_metric_views(): View(instrument_name="agent_framework*"),
///   View(instrument_name="gen_ai*"), View(instrument_name="*", aggregation=DropAggregation())
///   (observability.py:688-692) on the GLOBAL MeterProvider. Calling the framework's
///   convenience setup therefore silently discards every other library's metrics in the process
///   — HTTP clients, runtime metrics, the app's own counters.
///
/// * `framework_overwrites_service_version`: create_resource() sets service.version to the
///   agent-framework package version when OTEL_SERVICE_VERSION is unset
///   (observability.py:669-671), and service.name to the literal 'agent_framework' when
///   OTEL_SERVICE_NAME is unset. Both captures show service.version=1.13.0 for an app that has
///   no such version. Resource-based app identity from this framework is not trustworthy.
///
/// * `gen_ai_provider_name_is_the_client_class`: gen_ai.provider.name is a ClassVar of
///   whichever client/agent class emitted the span, not the endpoint actually contacted:
///   'microsoft.agent_framework' on invoke_agent (_agents.py:754), 'openai' on chat
///   (agent_framework_openai _chat_completion_client.py:1193) — for traffic that went to
///   OpenRouter, including the anthropic/claude-haiku-4.5 calls. server.address carries the
///   truth (https://openrouter.ai/api/v1/ on 17/17 chat spans; the 'Unknown' first-request
///   value NOTES.md reported does not occur in these captures).
///
/// * `span_links_are_the_only_fan_in_encoding`: Workflow message delivery is modelled with OTel
///   span links, not parent/child: every executor.process / edge_group.process span is a direct
///   child of workflow.run and links back to the message.send span that published its input. 8
///   spans carry links in the agents capture; executor.process summary_agent carries 3 — the
///   fan-in join. A parser walking only parentSpanId sees flat siblings and loses the causality
///   entirely. Links are outside the predicate algebra (see algebra_violations).
///
/// * `no_native_hitl_telemetry`: @tool(approval_mode="always_require") is a genuine native gate
///   — the loop stops before the tool body runs — but it emits nothing: no span, no event, no
///   attribute. A DENIED call produces no execute_tool span at all, so the only wire evidence
///   is a string inside the next chat span's gen_ai.input.messages. Approval latency and
///   approval outcome are unobservable for this vendor.
///
/// * `harness_reparents_the_resume_traces`: [H] The 2 `approval delete_file` spans
///   (scenario_a_user.py:58, via the public create_workflow_span) WRAP the resuming
///   agent.run(), so in traces 17bcfafb and e12727cd the harness span is the ROOT and the
///   native invoke_agent is its child. Without the fixture those two resume runs would be
///   ordinary invoke_agent-rooted traces; the trace COUNT (8) is unaffected, the root identity
///   is not. Root-anchored readers must not learn 'MAF traces are rooted at a non-gen_ai span'
///   from this capture.
///
/// * `attribute_value_typing_is_mixed`: Unlike the Java frameworks, values arrive natively
///   typed: gen_ai.usage.input_tokens as intValue, gen_ai.request.temperature and
///   agent_framework.function.invocation.duration as doubleValue,
///   gen_ai.response.finish_reasons as an arrayValue of strings. Canonical stringification
///   (verify-seed.ts semantics) is what makes eq() predicates portable here; do not assume
///   stringValue.
///
/// * `semconv_flavour_is_latest_experimental_without_opt_in`: 1.13.0 emits the
///   gen_ai_latest_experimental flavour unconditionally — message content as
///   gen_ai.input.messages / gen_ai.output.messages JSON attributes, no gen_ai.user.message /
///   gen_ai.choice SPAN events, gen_ai.provider.name instead of gen_ai.system, only the new
///   gen_ai.usage.input_tokens/output_tokens names. There is no OTEL_SEMCONV_STABILITY_OPT_IN
///   switch anywhere in the package (grep: zero hits), so there is no stable-flavour variant to
///   model — but any consumer keyed on gen_ai.system or on the older event names sees nothing
///   from this vendor.
///
/// * `chat_spans_are_scope_only` — MS2, adjudicated DECLINED 2026-08-13: the 17 `chat <model>`
///   spans (9 user + 8 agents) carry no framework-specific attribute at all — their key sets
///   are pure `gen_ai.*` + `server.address` — so there is nothing to conjoin on, and the
///   queue's wanted rule (`gen_ai.provider.name == "openai"` plus a negation of the OpenAI-SDK
///   scope) is a corpus trap: openrouter carries 1,477 spans with that exact provider value
///   under its own scope, against an asserted ceiling of zero vendor claims. Disposition:
///   scope claims them; on scope loss they honestly degrade to `unknown:genai`. Do not
///   re-propose without new wire evidence. Scope loss is this vendor's real cliff — 13
///   invoke_agent survive on the provider prefix, 5 execute_tool on `agent_framework.`, 10
///   plumbing on the guarded conjunct, but the 17 chat spans (every token count) degrade, and
///   the 4 `message.send` + 2 `workflow.*` spans vanish below the unknown tier entirely.
///
/// * `span_links_stay_read_path` — MS3, DEFERRED 2026-08-13 (integration decision D-6): span
///   links are the only fan-in encoding here (8 linked spans in the agents capture, one with
///   3 links), but fan-in causality has no classification output column, so `SpanCtx`
///   exposes no link accessor at all. As a detect clause it would also be redundant (all 8
///   linked spans already match on scope + `executor.`/`edge_group.` evidence) and dangerous
///   as a fingerprint, since span links are generic OTel. Read-path note, no rule.
///
/// Config variants that change the wire shape (`sensitive-data-off`, `framework-logger-at-
/// info`): recorded in full in the seed's `variants:` block — re-read it before touching this
/// vendor's rules.
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
        // verdict: B.
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
        // source_code: LOCAL_HISTORY_CONVERSATION_ID sentinel (_sessions.py:1028). Stamped onto
        // ChatResponse.conversation_id when require_per_service_call_history_persistence is
        // used without service-side storage (_sessions.py:1341-1343). The framework itself
        // guards against writing it into AgentSession.service_session_id
        // (is_local_history_conversation_id checks at _agents.py:1135, 1170, 1193), but an
        // integration that feeds response.conversation_id back in as the next run's
        // conversation_id option would stamp it on every invoke_agent span as a process-wide
        // constant. Not observed on the wire.
        "agent_framework_local_history_persistence",
        // source_code: Fallback used across the telemetry layer when an identity cannot be
        // resolved (gen_ai.agent.id/gen_ai.agent.name default to 'unknown' at
        // observability.py:1833-1834, provider name at 1421). Never a session id; listed so a
        // resolver never treats a literal 'unknown' as a real value.
        "unknown",
    ],
};

fn detect_microsoft_agent_framework(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Hardcoded as the default instrumenting_module_name in
    // agent_framework/observability.py:992-996 (get_tracer), with
    // instrumenting_library_version = the package version. ONE scope for the whole
    // framework — agent, chat, tool, workflow, executor, edge-group and message spans all
    // land in it (53/53 spans across both captures, no schemaUrl, no scope attributes). It
    // must stand alone: the 17 `chat <model>` spans carry no framework-specific attribute
    // at all and nothing else in this seed classifies them. Accepted cost: get_tracer() and
    // create_workflow_span() are PUBLIC API, so app-authored spans land in this scope too —
    // see false_positives.
    s.scope_name() == "agent_framework"
        // source: wire (phase-2, fix-queue MS1).
        // Value-PREFIX, not equality: `Agent.AGENT_PROVIDER_NAME` (_agents.py:754) is the
        // exact string on 13/13 invoke_agent spans (8 user + 5 agents), and the prefix
        // additionally covers the harness agents' `microsoft.agent_framework.harness`
        // (_harness/_agent.py:265,677 — source-verified, not exercised on the wire). Corpus
        // scan: zero non-MAF spans carry any gen_ai.provider.name starting with this
        // prefix, so it is a strict recall superset at zero FP cost. Subclasses that
        // REPLACE the value (A2A, github.copilot, anthropic.claude, azure.ai.foundry) stay
        // permanently unreachable by value — claiming `anthropic.claude` as MAF evidence
        // would steal Anthropic-SDK spans — and are covered by the scope alone.
        || s.attr("gen_ai.provider.name")
            .is_some_and(|value| value.starts_with("microsoft.agent_framework"))
        // source: wire.
        // The vendor's own attribute namespace — X4's explicit carve-out, so it stays
        // unconditional. Wire: agent_framework.function.invocation.duration on 5/5
        // execute_tool spans (_tools.py:793).
        || s.any_attr_prefix("agent_framework.")
        // source: wire (phase-2, X4 sweep — the queue's own list missed this one).
        // `executor.id` / `executor.type` / `edge_group.*` are not vendor-named: they are
        // stock scheduler vocabulary (Airflow, Spark, any task-queue app), the same
        // genericity class as the `workflow.` prefix this seed already had to delete after
        // it fired on 2,037/2,328 eve_slack spans. Corpus disjointness was the only thing
        // protecting them — precisely the posture C2 was written to end. The guard is free:
        // all 5 `executor.process` spans carry message.type + message.payload_type and all
        // 5 `edge_group.process` spans carry message.source_id (10/10 co-occurrence in
        // microsoft_agent_framework_agents, from create_processing_span /
        // create_edge_group_processing_span), so recall is identical on the corpus while a
        // lone `executor.*` app key no longer classifies. Bare `message.` deliberately
        // stays out: the 4 `message.send` spans remain scope-only false negatives rather
        // than letting one generic `message.type` key claim a vendor.
        || ((s.any_attr_prefix("executor.") || s.any_attr_prefix("edge_group."))
            && s.any_attr_prefix("message."))
}

/// Seed: frameworks/openai_agents_sdk/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `service.instance.id` (wire): Stock OTel-Python resource attribute, a fresh uuid4 per
///   PROCESS (6a9de051-... / b944a5f5-...). In these fixtures one process is one scenario, so
///   it looks exactly like a session id and is constant across all 6 traces of
///   openai_agents_sdk_user. In a server it is one value for millions of conversations.
///
/// * `graph.node.id` (wire): 13/76 spans (8 + 5). Despite the name it is the AGENT NAME copied
///   verbatim (_processor.py:183, from AgentSpanData.name) — `assistant`, `budget_worker`. A
///   constant per agent definition, not an identifier of anything runtime.
///
/// * `llm.output_messages.0.message.tool_calls.0.tool_call.id` (wire): Provider tool-call id
///   (call_...), and its mirror llm.input_messages.N.message.tool_call_id. Repeats across the
///   approval-pending and executed delete_file spans of one HITL turn, which makes it look like
///   a correlation key; it correlates one tool call, never a session.
///
/// * `openinference.project.name` (source_code): Resource attribute set by
///   openinference.instrumentation.using_project (_projects.py:20-24). A Phoenix PROJECT name —
///   a deployment-wide constant, the same decoy shape as langsmith.trace.session_name. Never a
///   session.
///
/// # Caveats (the seed review's rationale record)
///
/// * `group_id_is_silently_dropped`: THE landmine. The SDK's documented session idiom —
///   trace(workflow_name, group_id=...) and RunConfig.group_id, described in its own docs as
///   the way to link multiple traces from one conversation — is accepted, stored on the Trace
///   object (tracing/traces.py:168,231-232, exported to OpenAI's backend as
///   payload['group_id']) and then thrown away by the OTLP path:
///   OpenInferenceTracingProcessor.on_trace_start reads ONLY trace.name (_processor.py:87-94).
///   grep group_id in the instrumentation package = 0 matches; the fixture used the idiom
///   correctly on all 6 turns and the value scenario-a-<hex8> appears 0 times in the capture
///   bytes. A customer who did everything the SDK told them to do produces 100% unsessioned
///   traces, with no error and no warning. Same for RunConfig.trace_metadata (Trace.metadata is
///   never read either).
///
/// * `sdk_trace_ids_dropped`: The SDK mints its own ids — trace_<32hex> and span_<24hex> —
///   which are the ids shown in the OpenAI traces dashboard. The bridge creates fresh W3C OTel
///   ids and emits neither SDK id as an attribute (_processor.py has no reference to
///   trace.trace_id outside its internal dict key). There is NO way to correlate a maple trace
///   back to the OpenAI dashboard, in either direction.
///
/// * `task_and_turn_spans_are_unmapped`: openai-agents 0.19.4 added TaskSpanData (one per
///   Runner.run, name = the workflow name) and TurnSpanData (one per agent-loop turn, carrying
///   turn index, agent_name and per-turn USAGE). OpenInference 1.6.2's _get_span_kind knows
///   neither type, so both fall through to CHAIN (_processor.py:235) and on_span_end's
///   isinstance chain matches nothing — their entire payload is discarded. Wire-confirmed: all
///   11 `Agent workflow` and all 17 `turn` spans carry exactly 2 attributes
///   (openinference.span.kind + llm.system). 28/76 spans in this corpus are content-free
///   scaffolding purely because the instrumentor lags the SDK, and the SDK's own per-run/per-
///   turn token usage never reaches OTLP.
///
/// * `trace_root_is_agent_not_chain`: The trace-root span (`user turn N`,
///   `amsterdam_research_briefing`) is openinference.span.kind=AGENT, hardcoded at
///   _processor.py:92 — NOT CHAIN. It is also the only span type that does not get llm.system,
///   so it carries exactly ONE attribute. An earlier revision of NOTES.md recorded it as CHAIN;
///   the wire disagrees (7/7 AGENT).
///
/// * `span_names_are_customer_text`: Span names are unusable as rules. The root's name is the
///   workflow name the customer passes to trace() (free text: `user turn 3`); `Agent workflow`
///   is merely RunConfig.workflow_name's DEFAULT; AGENT span names are agent names; TOOL span
///   names are tool names. On a resumed run the task span inherits the workflow name from the
///   persisted RunState (agents/run.py:607-665 resolve_trace_settings -> task_span(name=
///   trace_workflow_name)), which is why openai_agents_sdk_user contains two spans named `user
///   turn 6` at different depths of one trace.
///
/// * `llm_system_is_always_openai`: llm.system is the constant string openai on 69/76 spans,
///   set at span start from OpenInferenceLLMSystemValues.OPENAI (_processor.py:127) with no
///   reference to the actual provider. openai_agents_sdk_agents routes 3 of 8 generations to
///   anthropic/claude-haiku-4.5 through OpenRouter and still reports openai. Only
///   llm.model_name carries the truth, and llm.invocation_parameters carries the base_url
///   (https://openrouter.ai/api/v1/, credential-free — verified: 0 occurrences of api_key or
///   sk-or in either capture).
///
/// * `pending_approval_repr_leak`: Native HITL (@function_tool(needs_approval=True)) fires
///   correctly — 3 delete_file spans in openai_agents_sdk_user: one pending in the rejected
///   turn 5, one pending plus one executed in the approved turn 6. Both PENDING spans set
///   output.value to a 4,762/4,763-byte (one byte apart) Python repr(FunctionToolResult(...)) containing every tool's
///   JSON schema, the nested ToolApprovalItem and live object addresses (<... object at
///   0x10c343740>), with output.mime_type absent; the executed span is a clean 30-byte string.
///   Nothing in the span marks which is which — approval state is invisible to any rule.
///
/// * `errors_are_status_text_only`: The corpus' only failure (fetch_transport_data,
///   openai_agents_sdk_agents) is an OTel status code 2 whose message is the SDK SpanError
///   rendered as a Python dict literal: "Error running tool (non-fatal): {'tool_name':
///   'fetch_transport_data', 'error': 'transport data service unavailable (503)'}". No
///   exception event, no exception.type/message attribute, no error.type. Note the parent chain
///   stays OK — the agent recovered — so trace-level error rollups keyed on the root see a
///   clean trace.
///
/// * `payload_is_written_twice`: Every `generation` span carries the same messages twice:
///   flattened into indexed keys
///   (llm.input_messages.12.message.tool_calls.1.tool_call.function.arguments) AND as a JSON
///   blob in input.value/output.value. One 6-turn conversation with growing history reaches 8.1
///   KB of attributes on a single span and 55 KB in one OTLP record. There is no toggle that
///   drops only one half.
///
/// * `no_native_otel_export`: There is no OTel export in the SDK. Without openinference-
///   instrumentation- openai-agents nothing reaches an OTLP endpoint (the SDK POSTs to
///   api.openai.com/v1/traces/ingest instead), and calling set_tracing_disabled(True) to stop
///   that ALSO kills the bridge — the OpenInference processor feeds off the same pipeline, so
///   the correct wiring keeps SDK tracing enabled and replaces its processors
///   (exclusive_processor=True, the default). With exclusive_processor=False a customer double-
///   ships every trace to OpenAI and to maple.
///
/// * `unbatched_multi_scope_shape`: OTLP shape is one resourceSpans -> one scopeSpans -> N
///   spans per record, with the resource repeated per record. Records are BatchSpanProcessor-
///   timed, not trace-aligned: openai_agents_sdk_user packs traces 1-3 into record 0 and traces
///   4-6 into record 1, while openai_agents_sdk_agents splits ONE trace across both records (23
///   + 9 spans) with the root arriving last. record != trace in both directions.
///
/// Config variants that change the wire shape (`no-openinference-default`, `using-session`,
/// `genai-semconv-dual-write`, `no-task-turn-spans`): recorded in full in the seed's
/// `variants:` block — re-read it before touching this vendor's rules.
pub const OPENAI_AGENTS_SDK: VendorDef = VendorDef {
    id: VendorId::OpenaiAgentsSdk,
    detect: detect_openai_agents_sdk,
    keys: &["openinference.span.kind"],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // Phase 2 (fix-queue O1, 2026-08-13): the authority stays BROAD — the queue's
        // narrowing to the workflow-root population (AGENT && !graph.node.id) was
        // resolved-DECLINED (expert override, integration decision). Under using_session
        // — the only configuration in which this vendor ever emits a session key —
        // OITracer merges the context attributes into EVERY span's start attributes
        // (_tracers.py:166-184), so the broad authority encodes the wire fact that every
        // span is a legitimate place to expect (state 3) and read (state 6) the key;
        // narrowing would zero the key hash on 63/76 spans there and under-state the
        // group-id landmine by default. The root discriminator is recorded in the seed
        // for a future classification sub-tier (D-6), not here.
        // verdict: C, source: source_code.
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: C, source: source_code.
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

// Phase 2 (fix-queue O1–O3, 2026-08-13): re-adjudicated, shape CONFIRMED — the sole
// exact-scope clause below already is the v2 rule (integration decision D-1: exact
// scope-eq inside each vendor's detect, no shared family dispatcher). O1's authority
// narrowing was resolved-DECLINED (see the session candidates); O3's repr-leak flag is
// deferred to the read path. No attribute conjunct, deliberately: every span attribute
// this vendor emits is the generic OpenInference dialect shared by ~40 sibling
// instrumentors (seed attr_matchers.why), and llm.system is the hardcoded literal
// "openai" even for anthropic/claude-haiku-4.5 via OpenRouter (3/8 generations in the
// agents capture) — any attr clause either adds nothing or steals sibling vendors'
// spans. On a scope rename the spans degrade to unknown:openinference
// (openinference.span.kind is on 76/76), never to a wrong vendor.
fn detect_openai_agents_sdk(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // Library-owned and hardcoded: the instrumentor calls trace_api.get_tracer(__name__,
    // __version__, tracer_provider) where __name__ is the package path
    // openinference.instrumentation.openai_agents (openai_agents/__init__.py:41-43);
    // scope.version is the INSTRUMENTOR release (1.6.2), never the SDK release. It is the
    // only scope in either capture and catches 44/44 + 32/32 spans, including the trace-
    // root span, which carries a single attribute and is otherwise unclassifiable.
    // Standalone because the OITracer built here is used by nothing else in the process:
    // every span in this scope originates in the SDK's own tracing pipeline
    // (agents.tracing) or the realtime wrappers.
    //
    // EXACT equality, never starts_with (prefix-shadowing hazard, pinned by O2):
    // "openinference.instrumentation.openai" — the D3 openinference-openai vendor, on
    // the wire in crewai_user/crewai_agents/smoke-test — is a string PREFIX of this
    // scope name; prefix matching would make the two vendors evaluation-order-dependent
    // on each other's spans. The at-most-one-vendor tests plus both vendors'
    // sufficient_scope adversarial-fixture cases pin both directions.
    s.scope_name() == "openinference.instrumentation.openai_agents"
}

/// Seed: none — synthesized vendor (write-side plan D3); the shared instrumentor scope is
/// unclaimed by design.
///
/// Justification: openinference.instrumentation.openai is a shared instrumentor other stacks
/// load alongside their framework (crewai captures prove co-tenancy; smoke-test proves
/// standalone use). No framework seed may claim it (crewai's seed documents why: a crewai rule
/// on this scope would mislabel every OpenAI-SDK span in the fleet).
///
/// # Caveats (the seed review's rationale record)
///
/// * Carries the token/model/prompt payload for crewai (and any host framework that drives the
///   OpenAI SDK) — per-span vendor attribution means these spans are openinference-openai even
///   inside another vendor's trace.
pub const OPENINFERENCE_OPENAI: VendorDef = VendorDef {
    id: VendorId::OpeninferenceOpenai,
    // owned_by: library, source: wire.
    detect: |s| s.scope_name() == "openinference.instrumentation.openai",
    keys: &[],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[
        // verdict: C, source: source_code.
        // Same OpenInference using_session() context mechanism as the framework instrumentors.
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

/// Seed: frameworks/pydantic_ai/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.response.id` (wire): 9/19 + 9/20 `chat` spans, 18 distinct values for 18 spans
///   (gen-<epoch>-<rand> from OpenRouter). Per model call, never repeats across turns.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_… / toolu_…), 2/19 + 6/20 spans,
///   unique per call. Pydantic AI substitutes pyd_ai_<uuid4 hex> when the provider supplies
///   none (_utils.py:543-551). Correlates a tool call with its result inside
///   gen_ai.input.messages, not sessions.
///
/// * `service.instance.id` (wire): RESOURCE attribute, generated per process by the OTel Python
///   SDK (not by Pydantic AI): one uuid4 on all 19 spans of pydantic_ai_user and another on all
///   20 of pydantic_ai_agents. Perfectly session-shaped in a fixture where one process is one
///   scenario — and in pydantic_ai_agents it is the ONLY key that spans both traces, which is
///   exactly the trap: it would join the pipeline correctly here and join millions of unrelated
///   sessions in a long-lived server. The archetypal process-identity trap.
///
/// * `gen_ai.agent.name` (wire): Also baggage-propagated to every child span
///   (AGENT_NAME_BAGGAGE_KEY), so it looks like a per-run join key. It is a static agent NAME:
///   one value ('user_assistant') for all 19 spans of pydantic_ai_user, 5 constants in
///   pydantic_ai_agents. Constant forever per deployed agent.
///
/// Harness-only keys in the fixture captures (not framework signal): `capture.id`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `conversation_id_is_per_run_by_default`: gen_ai.conversation.id is on ~every span and is a
///   FRESH UUID7 PER RUN whenever the customer passes neither conversation_id= nor
///   message_history= (_agent_graph.py:231-255, branch 4; GraphAgentState.conversation_id
///   defaults to str(uuid7())). Presence is worthless as evidence of a session. Two red flags
///   maple can compute cheaply, neither expressible in the seed algebra: (1) the value is a
///   UUID7 — customer-chosen ids usually are not; (2) it partitions a trace exactly like
///   gen_ai.agent.call.id (the run id), which is the definitive tell. pydantic_ai_agents shows
///   4 conversation ids inside ONE trace (5 across its 2 traces, none shared); pydantic_ai_user
///   shows 1 across 8 traces. Treat a conversation id that never appears in more than one trace
///   AND coincides with a run id as a run, not a session. PHASE-2 (P1, DECIDED 2026-08-13):
///   red flag (1) is ENFORCED IN CODE — the candidate's granularity is value-conditional on
///   the strict UUIDv7 shape; red flag (2), the partition-identity test, remains
///   documentation-only (trace-level, blocked by constraint 1).
///
/// * `agent_delegation_fragments_the_conversation`: Sub-agents invoked as tools (the standard
///   Pydantic AI delegation pattern) run with their own message_history, so each delegated
///   worker mints its OWN conversation id — 3 of the 4 values inside pydantic_ai_agents'
///   orchestrator trace. The orchestrator's own id never propagates down. §3's root-most-
///   anchoring picks the orchestrator's value, which is correct behaviour but still only a per-
///   run UUID7 here. Multi-agent Pydantic AI apps are session-fragmented by construction unless
///   the customer forwards conversation_id into every delegated run.
///
/// * `baggage_is_in_process_only`: The propagation mechanism is OTel BAGGAGE attached inside
///   the agent-run span (capabilities/instrumentation.py:178-181) and read back into each child
///   span's creation attributes. It is in-process context, not W3C baggage headers: nothing is
///   injected into outbound HTTP, so a span produced by a downstream service — or by any
///   library that does not go through Pydantic AI's own instrumentation, including httpx/openai
///   auto-instrumentation nested under `chat` — carries no session key. Conversely, any span
///   opened by CUSTOMER code inside an agent run does NOT get the keys either: only Pydantic
///   AI's own three span types splice the baggage in.
///
/// * `native_error_span_is_real`: Unlike most of the corpus, the ERROR status and the
///   `exception` span event on `execute_tool fetch_transport_data` (pydantic_ai_agents) are
///   NATIVE: the scenario raises the framework's ToolFailed and capabilities/instrumentation.py
///   records the exception and sets StatusCode.ERROR. error.type is NOT emitted — status +
///   event are the only error signal, so a present(error.type) rule finds nothing here.
///
/// * `hitl_is_invisible_to_span_rules`: The native declarative approval gate
///   (@agent.tool_plain(requires_approval=True) + DeferredToolRequests) emits NO span for the
///   proposal and NO span for the denial — Pydantic AI short-circuits before the instrumented
///   tool wrapper. In pydantic_ai_user the 2 approval proposals and the 1 denial are visible
///   only inside the `final_result` / gen_ai.input.messages JSON; only the APPROVED call
///   produces an `execute_tool delete_file` span (1/19). The alternative path —
///   ApprovalRequired raised from inside a tool body — does produce a span carrying
///   pydantic_ai.tool.deferral.name, and at instrumentation version < 5 that span is
///   additionally marked ERROR with an exception event.
///
/// * `logfire_keys_are_not_a_pydantic_ai_signal`: logfire.json_schema on 100% of native spans
///   and logfire.msg on the agent/tool spans are emitted with the Logfire SDK ABSENT — they are
///   a dialect, not a vendor tag. Tempting as a scope-loss fallback (they cover every span,
///   unlike pydantic_ai.*), but they would claim every span of any Logfire-instrumented
///   application. See algebra_violations. PHASE-2 (P2): v2 uses logfire.json_schema only
///   inside a 3-way conjunction with gen_ai.operation.name and a pydantic-unique key —
///   still never alone.
///
/// * `gen_ai_system_is_the_provider`: gen_ai.system and gen_ai.provider.name both hold
///   'openrouter' on `chat` spans — the provider, not the framework and not the model vendor.
///   The actual models are openai/gpt-4o-mini and anthropic/claude-haiku-4.5, readable only
///   from gen_ai.request.model / gen_ai.response.model. There is no gen_ai.system value that
///   identifies Pydantic AI.
///
/// * `a_pipeline_is_several_disconnected_traces`: There is NO framework-level notion of a trace
///   spanning two top-level runs. pydantic_ai_agents' orchestrator run and summary run are two
///   roots, two traces, two conversation ids, two run ids, and nothing joins them span-locally
///   (only the process-level service.instance.id, a decoy). Whatever the customer's mental
///   model, an N-step Pydantic AI pipeline is N traces unless the customer opens their own
///   parent span or threads conversation_id/message_history through every step. This is the
///   corrected fixture: until 2026-08-11 the scenario opened a harness root span
///   (`research_briefing_pipeline`, scope trace-capture.pydantic-ai, briefing.* attrs) that
///   fused the two into one 21-span trace and hid this fact. That span and its attributes are
///   gone; both captures are now 100% native, with zero harness spans and zero harness-mutated
///   spans.
///
/// * `all_values_are_strings_on_the_wire`: Numbers and booleans arrive as OTLP stringValue via
///   the OTel Python SDK's normal typing only where the framework passes strings; note in
///   particular gen_ai.response.finish_reasons is an ARRAY attribute (canonicalized to
///   '["stop"]'), while gen_ai.input.messages / gen_ai.output.messages /
///   pydantic_ai.all_messages / gen_ai.tool.definitions / model_request_parameters /
///   final_result are JSON-encoded STRINGS, not structured OTLP values. final_result is raw
///   text when the output is a str and JSON otherwise — the same key holds two formats.
///
/// Config variants that change the wire shape (`instrumentation-version-2`, `instrumentation-
/// version-2-3-4-deferral-as-error`, `aggregated-usage-off`): recorded in full in the seed's
/// `variants:` block — re-read it before touching this vendor's rules.
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
        // verdict: A. Granularity is VALUE-CONDITIONAL since phase 2 (fix-queue P1,
        // owner ruling DECIDED 2026-08-13): a strict
        // UUIDv7-shaped value resolves at run granularity (state 5), any other value at
        // session granularity (state 6). This is the seed's red flag (1) promoted from
        // prose to code, and a span-local proxy for the blocked trace-level partition
        // test: pydantic mints GraphAgentState.conversation_id = str(uuid7()) fresh PER
        // RUN whenever the customer passes neither conversation_id= nor
        // message_history= (_agent_graph.py:231-255, branch 4), so a UUID7 value is a
        // run id wearing a session key. Wire: pydantic_ai_user's explicit
        // 'pydantic-ai-scenario-a-session' (1 value across 8 traces) stays state 6;
        // pydantic_ai_agents' 5 auto-minted strict-UUIDv7 values (4 inside ONE trace —
        // the partition-identity tell) demote to state 5. Known, accepted misses:
        // message_history=-threaded sessions inherit the first run's UUID7 (labeled
        // run — same outcome as the plan's blunt always-run stance, so the heuristic
        // strictly dominates it) and customers minting their own UUIDv7 session ids
        // (label-only cost: states 5 and 6 both hash the same value, so
        // AiSessionKeyHash and joins are unaffected either way).
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
        // verdict: A. Pydantic's run_id, fresh UUID7 per run, never inherited from
        // message_history (_agent_graph.py:258-290). Hash-stability note for P1: in the
        // demoted case both candidates resolve at state 5 and the tie-break keeps
        // candidate order, so the hash is cityHash64(gen_ai.conversation.id) in every
        // configuration — P1 moves only the state label, never the hash.
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

/// Strict RFC 9562 UUIDv7 shape (phase-2 P1): `xxxxxxxx-xxxx-7xxx-Nxxx-xxxxxxxxxxxx`
/// with hex digits case-insensitive, version nibble exactly `7` and variant nibble in
/// `[89ab]` (also case-insensitive). Deliberately strict: a value that merely CONTAINS
/// a UUID (prefixed/suffixed customer id) is treated as customer-chosen → session,
/// which is the right default. All 5 pydantic_ai_agents wire values match; the
/// pydantic_ai_user explicit id does not.
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
    // Tier 1 — owned_by: library, source: wire.
    // Hardcoded in models/instrumented.py:133-134 (scope_name = 'pydantic-ai';
    // get_tracer(scope_name, __version__)) and used for every span the library emits —
    // agent run, model request, tool execution, embeddings, and the concurrency-limiter
    // span. Library-owned and stable; the scope version IS the pydantic-ai package version,
    // so it doubles as a version signal. Catches 19/19 spans in pydantic_ai_user and 20/20
    // spans in pydantic_ai_agents — after the 2026-08-11 regeneration both captures are
    // 100% native and `pydantic-ai` is the ONLY scope present in either. A pydantic-ai app
    // that adopts Logfire still emits this scope (Logfire only supplies the
    // TracerProvider), so tier 4 below is purely the scope-rewrite fallback.
    s.scope_name() == "pydantic-ai"
        // Tier 2 — source: wire. Vendor-namespaced attr fallback (scope rewritten or
        // dropped): pydantic_ai.all_messages / .new_message_index on invoke_agent spans,
        // 8/19 + 5/20; corpus-unique prefix. Unconditional per X4 — the vendor's own
        // namespace. Also catches the deferral path's pydantic_ai.tool.deferral.name.
        || s.any_attr_prefix("pydantic_ai.")
        // Tier 3 — source: wire. Pydantic-invented usage namespace
        // (models/instrumented.py:126-128, documented non-semconv). Same carrier
        // population as tier 2; kept because each survives a rename of the other.
        // Corpus-unique today; if semconv ever standardizes this exact prefix the
        // at-most-one-vendor CI is the tripwire (seed risk note).
        || s.any_attr_prefix("gen_ai.aggregated_usage.")
        // Tier 4 — phase 2 (fix-queue P2, hardened): the logfire co-signal conjunction,
        // recovering the chat/execute_tool population on scope loss (11/19 + 15/20;
        // tiers 2+3 recover the rest — total scope-loss recall 19/19 + 20/20).
        // Conjunct 1: logfire.json_schema — 19/19 + 20/20, emitted WITHOUT the Logfire
        //   SDK (_instrumentation.py:336 etc.); a cross-vendor dialect stamped on every
        //   span of any Logfire-instrumented app, never safe alone (seed caveat
        //   logfire_keys_are_not_a_pydantic_ai_signal). Zero corpus occurrences outside
        //   the two pydantic captures today (grep over all 56 capture dirs).
        // Conjunct 2: gen_ai.operation.name — 19/19 + 20/20; the unknown tier itself,
        //   never safe alone (openrouter: 4,094 spans carry it).
        // Conjunct 3 (added vs the queue's 2-conjunct form): pydantic-specific
        //   co-evidence guarding against future Logfire-dialect emitters that adopt
        //   gen_ai semconv — the risk is structural, not corpus-visible. Each key is
        //   corpus-unique to pydantic:
        //   - gen_ai.agent.call.id: pydantic's run_id via in-process baggage
        //     (RUN_ID_BAGGAGE_KEY, _instrumentation.py:36); 19/19 + 20/20.
        //   - operation.cost: pydantic extension (_instrumentation.py:403); 9/19 + 9/20
        //     (all chat spans; source-verified on embeddings spans, which carry no
        //     baggage — this disjunct is what reaches them).
        //   - model_request_parameters: legacy duplicate on chat spans, 9/19 + 9/20
        //     (include_model_request_parameters, default on).
        || (s.has_attr("logfire.json_schema")
            && s.has_attr("gen_ai.operation.name")
            && (s.has_attr("gen_ai.agent.call.id")
                || s.has_attr("operation.cost")
                || s.has_attr("model_request_parameters")))
}

/// Seed: frameworks/semantic_kernel/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.agent.id` (wire): THE decoy. Stable across traces and therefore session-shaped on
///   the wire — one value (e97df81c-c307-4e24-99ef-9b490658f3bc) on all 8 invoke_agent spans
///   across all 8 traces of semantic_kernel_user — but it is Agent.id, a
///   default_factory=lambda: str(uuid.uuid4()) field on the Agent MODEL (agents/agent.py:267),
///   i.e. per-agent-OBJECT identity, customer-overridable and constant for the object's whole
///   lifetime. In a long-lived server one agent object serves every user, so joining on it
///   merges all sessions into one; in semantic_kernel_agents it does the opposite, splitting a
///   single logical run across 5 distinct values (one per worker). It also has no relationship
///   to the thread that actually carries conversation state.
///
/// * `gen_ai.response.id` (wire): Provider completion id (gen-1786460114-rK97L7Wm07Nf3VN3cKyX);
///   unique per LLM call, 10 distinct values in 8 user traces.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_… / toolu_…). Correlates a tool
///   call with its assistant message, never sessions. Retries do NOT reuse it: the 7 failing
///   `execute_tool TransportPlugin-fetch_transport_data` spans in semantic_kernel_agents carry
///   7 distinct ids, so it cannot group retry attempts either.
///
/// * `messaging.destination` (wire): Looks like a durable session/actor address and embeds a
///   32-hex GUID (weather_worker_fd657f72c9b14485b2f54f50c2ee41bc.(ConcurrentOrchestration)-A),
///   and it is the ONLY attribute shared across the 10 fragmented traces of
///   semantic_kernel_agents — the single most tempting stitch key in the corpus. But the GUID
///   is the orchestration instance minted per ConcurrentOrchestration.invoke() and the string
///   is an AgentId/TopicId rendering — per-run and per-actor, and absent from every non-runtime
///   span.
///
/// * `service.instance.id` (wire): A uuid4 minted by the OTel-Python SDK per PROCESS
///   (eba7a1b6-8670-4d18-91be-a06eb27e0dab). Constant across all 8 traces of
///   semantic_kernel_user, which makes it the most session-shaped value in the capture — and it
///   is pure process identity that would merge every concurrent user of a server into one
///   'session'. Not SK's; listed because with no real session key present it is the first thing
///   a resolver would reach for.
///
/// * `CHAT_MESSAGE_INDEX` (wire): LOG-record attribute only. An SK-proprietary within-request
///   message ordinal (0,1,2,…) used to restore chat order; not an identifier of anything.
///
/// # Caveats (the seed review's rationale record)
///
/// * `import_order_silent_zero`: The diagnostics env vars must be set BEFORE the first `import
///   semantic_kernel`. MODEL_DIAGNOSTICS_SETTINGS = ModelDiagnosticSettings() is a module-level
///   constant in three modules (model_diagnostics/decorators.py:34,
///   agent_diagnostics/decorators.py:28, model_diagnostics/function_tracer.py:26) and is never
///   re-read. Setting them later produces zero GenAI spans with no warning, no log line and no
///   error — and, because AutoFunctionInvocationLoop and the agent_runtime spans are ungated,
///   the trace is NOT empty, it is just silently GenAI-less. Expect customer reports of 'SK
///   sends telemetry but no LLM data'.
///
/// * `gen_ai_system_is_always_openai`: gen_ai.system is the CONNECTOR class constant, not the
///   provider: OpenAIChatCompletionBase.MODEL_PROVIDER_NAME = "openai"
///   (open_ai_chat_completion_base.py:57) is passed to the decorator, so the anthropic/claude-
///   haiku-4.5 spans in semantic_kernel_agents also report gen_ai.system=openai. 21/21 spans
///   carrying gen_ai.system in the corpus say openai (10 user + 11 agents; the seed's "12/12"
///   counted only the `chat.completions`-named spans, which EXCLUDES the anthropic spans the
///   sentence is about — corrected 2026-08-13). Provider attribution keyed on gen_ai.system is silently
///   wrong; gen_ai.request.model carries the truth. This is also why eq(gen_ai.system,
///   "openai") must NEVER be a semantic_kernel matcher — it would steal every genuine OpenAI-
///   SDK span.
///
/// * `off_semconv_values`: SK's values are not semconv values. gen_ai.operation.name is
///   `chat.completions` / `chat.streaming_completions` (semconv says `chat`);
///   gen_ai.response.finish_reason is a Python enum repr, `FinishReason.STOP` /
///   `FinishReason.TOOL_CALLS` (semconv says `stop` / `tool_calls`), produced by
///   ",".join(str(fr)) at model_diagnostics/decorators.py:417-421 — note it is singular
///   `finish_reason` holding a comma-joined LIST, not the semconv plural array. server.address
///   is a full URL, https://openrouter.ai/api/v1/, not a host, and server.port is never set.
///   Every value arrives as OTLP stringValue except the two token counts and max_tokens, which
///   arrive as intValue.
///
/// * `falsy_attributes_are_dropped`: _get_completion_span filters execution settings with a
///   bare `if attribute:` over extension_data (model_diagnostics/decorators.py:355-358), so any
///   ZERO-valued knob is silently absent: temperature=0 was set in both scenarios and appears
///   on no span, and top_p=0 / seed=0 / frequency_penalty=0 would behave identically.
///   _set_completion_response does the same for usage (`if usage.prompt_tokens:`), so a genuine
///   0-token count is dropped rather than recorded as 0. Absence of gen_ai.request.temperature
///   does NOT mean the caller left it default.
///
/// * `duplicate_exception_events`: Failing tool spans carry the `exception` event TWICE — once
///   from KernelFunction._handle_exception's record_exception (kernel_function.py:403) and once
///   from the span context manager's __exit__ as the exception escapes. Wire- confirmed on all
///   7 `execute_tool TransportPlugin-fetch_transport_data` spans (14 events for 7 exceptions).
///   error.type and the ERROR status are set once each. Any error-event counter must dedupe.
///   Failing tool spans also carry NO gen_ai.tool.call.result at all (2/9 execute_tool spans in
///   semantic_kernel_agents have one), so result presence is not a proxy for tool completion.
///
/// * `error_type_shape_differs_by_path`: SK has three error paths with two different error.type
///   shapes: kernel_function.py:404 and agent_diagnostics/decorators.py:213 use
///   type(e).__name__ (observed: `RuntimeError`), while model_diagnostics/decorators.py:453
///   (_set_completion_error) uses str(type(error)), which would emit the literal `<class
///   'RuntimeError'>`. Only the first shape is exercised in these captures (no chat span
///   errored). A value-keyed error taxonomy must expect both.
///
/// * `tool_errors_do_not_propagate`: Kernel._inner_auto_function_invoke_handler swallows tool
///   exceptions and feeds the model a string, so the `execute_tool` span is ERROR while every
///   ancestor (AutoFunctionInvocationLoop, invoke_agent, and the whole trace) stays UNSET.
///   Trace health computed from the root, or from status alone, reports these traces as clean:
///   7 ERROR spans sit under an UNSET root in the 31-span trace. The model retried
///   fetch_transport_data 7× despite instructions not to (5 LLM round trips).
///
/// * `high_cardinality_span_names`: Every native span name is templated with unbounded data:
///   `invoke_agent <agent name>`, `chat.completions <model>`, `execute_tool
///   <Plugin>-<function>`, and worst, `agent_runtime process <worker>_<32-hex orchestration
///   GUID>.(Orchestration)-A` — the GUID is minted per orchestration run, so the 17 runtime
///   span names in this capture are unique to this run and will never recur. Span-name
///   grouping, dashboards and any eq(span.name, …) rule are unusable for this framework; that
///   is why this seed contains no span.name predicate at all.
///
/// * `runtime_fragments_traces_and_stitches_with_links`: THE headline fixture fact, revealed by
///   the 2026-08-11 §7 regeneration (the previous capture hid it behind a harness root span).
///   SK's InProcessRuntime does NOT continue the caller's trace across the actor message bus:
///   TraceHelper.trace_block computes `context = None` — literally, with a `# TODO(evmattso):
///   we may need to remove other code for using custom context.` beside it
///   (agents/runtime/core/telemetry/tracing.py:82) — and passes it to start_as_current_span.
///   Whenever the enqueue and the handling of a message sit in different asyncio tasks (which
///   is always for send/ack, and for the whole bus once no customer span is ambient), the span
///   starts a BRAND NEW TRACE. Instead of parenting, the runtime attaches LINKS built from the
///   envelope's traceparent (get_telemetry_links, propagation.py). Measured: one
///   ConcurrentOrchestration run = 10 traces, 4 of them a single span, with 13/17 runtime spans
///   carrying exactly one link each. Consequences: (a) a customer's own root span makes this
///   LOOK like one clean trace, so the shape maple sees depends on whether the app wraps the
///   call; (b) trace-level anything (duration, error rollup, cost per request) is wrong for
///   orchestrated SK by construction; (c) any stitching must follow span links, which no
///   predicate in the algebra can express.
///
/// * `hitl_is_invisible_on_the_wire`: The fixture exercises both approval branches and NEITHER
///   is distinguishable in the telemetry. Turn 5 (deny): gpt-4o-mini asks for confirmation in
///   prose, so no tool call is ever emitted and the FUNCTION_INVOCATION filter never runs — the
///   denial exists only in the model's text, which lives in a gen_ai.choice LOG record. Turn 6
///   (approve): the filter runs and the tool executes, producing an ordinary OK-status
///   `execute_tool FileSystemPlugin-delete_file` span identical in shape to any other tool
///   call. A denied-then-executed gate is therefore indistinguishable from a plain tool call,
///   and a gate that blocks is indistinguishable from a model that simply chose not to call the
///   tool. (The 2026-08-06 capture appeared to show a denial only because the harness emitted
///   an approval.decision span for it — a §2 violation now removed.)
///
/// * `no_native_hitl`: SK Python has no tool-approval / interrupt / resume primitive at all —
///   no analogue of LangGraph's interrupt or ADK's LongRunningFunctionTool.
///   AutoFunctionInvocationContext.terminate can stop the loop but offers no pause/resume
///   checkpoint. The idiomatic interception point is a FilterTypes.FUNCTION_INVOCATION filter,
///   which runs INSIDE KernelFunction.invoke — so a filter denial would still produce a full,
///   OK-status execute_tool span whose gen_ai.tool.call.result is the refusal text (unexercised
///   in this capture: the model asks in prose before ever calling the tool, see
///   caveats.hitl_is_invisible_on_the_wire). HITL is invisible to any rule in this algebra, and
///   a denied tool call is indistinguishable from a successful one.
///
/// * `keyword_args_empty_the_input`: gen_ai.agent.invocation_input is [] whenever the caller
///   passes messages by keyword: the decorators do `messages = args[1] if len(args) > 1 else
///   None` (agent_diagnostics/decorators.py:76,111,147), and `agent.get_response(messages=x)`
///   is the form the SK documentation shows. Both scenarios pass positionally on purpose; a
///   real customer following the docs ships empty inputs while the outputs populate normally.
///   Value-quality caveat, not a matcher.
///
/// * `three_scopes_vanish_by_default`: Restating the sharpest operational fact: with the
///   shipped defaults three of the five scopes never emit. A customer who wires an OTLP
///   exporter and no env vars sends semantic_kernel traces consisting solely of
///   AutoFunctionInvocationLoop and agent_runtime spans — vendor-classifiable, GenAI-empty, and
///   with gen_ai.operation.name absent the generic unknown tier catches nothing either.
///
/// * `vendor_but_not_genai_sub_tier` — DEFERRED, 2026-08-13 (fix-queue SK3, integration
///   decision D-6, not a TODO): 22/47 agents spans carry zero GenAI payload — 17
///   `agent_runtime *` spans plus the 5 `AutoFunctionInvocationLoop` spans — and **7** of the
///   10 agents traces contain nothing else (the seed's "6" is a miscount; wire-verified: 1×
///   `create`, 3× `send`→`process CollectionActor` pairs, 3× `ack`; only 3 traces contain any
///   AI span at all, not 4). They are correctly semantic_kernel spans but they inflate any
///   per-vendor operation count by ~47% here, ~77% under `variants.diagnostics_off`. The fix
///   is an output-schema concept (a vendor-but-non-GenAI sub-tier / annotation column) that v1
///   does not have — blocked on the schema, not on predicate power, exactly like langchain's
///   L3. Do not "fix" it by dropping the scope clauses: these spans reach no unknown tier
///   (they carry no gen_ai.* key), so un-classifying them loses them entirely.
///
/// Config variants that change the wire shape (`diagnostics_off`, `diagnostics_non_sensitive`):
/// recorded in full in the seed's `variants:` block — re-read it before touching this vendor's
/// rules.
pub const SEMANTIC_KERNEL: VendorDef = VendorDef {
    id: VendorId::SemanticKernel,
    detect: detect_semantic_kernel,
    keys: &[
        "gen_ai.operation.name",
        // Phase-2 X4: the exact key replaces the two-letter `sk.` prefix.
        "sk.available_functions",
        // Phase-2 clause 5's second conjunct.
        "gen_ai.response.finish_reason",
    ],
    prefixes: &[],
    span_names: &[],
    session_candidates: &[],
    decoy_values: &[],
};

fn detect_semantic_kernel(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // owned_by: library, source: wire (phase-2, fix-queue SK1).
    // The four SK tracers are all `get_tracer(__name__)` calls, so the scope name IS the
    // dotted module path inside the semantic_kernel package — library-owned, vendor-
    // namespaced, unproducible by app code. The v1 rules enumerated the four module paths
    // (agent_diagnostics.decorators — every `invoke_agent <name>` span, 8/28 user + 5/47
    // agents; model_diagnostics.decorators — `chat.completions`/`chat.streaming_completions`
    // <model>, 10/28 + 11/47, plus the untested text.* twins;
    // functions.kernel_function — every `execute_tool <Plugin>-<function>` span, 2/28 +
    // 9/47, the only spans in the corpus with error.type / ERROR status / exception events;
    // connectors.ai.chat_completion_client_base — the `AutoFunctionInvocationLoop` span,
    // 8/28 + 5/47, whose ONLY attribute is sk.available_functions). The seed calls the
    // module-path rename "the highest-probability future breakage in this seed", so the
    // prefix replaces the enumeration: it survives any utils/telemetry/ refactor and any
    // sixth get_tracer(__name__) call site. Corpus sweep: no non-SK span has a scope
    // starting `semantic_kernel.` (the one grep hit inside openrouter is a `git status`
    // listing embedded in a span-attribute VALUE, which no scope test can read).
    if scope.starts_with("semantic_kernel.") {
        return true;
    }

    // owned_by: library, source: wire (phase-2, fix-queue SK2).
    // The pathological scope: a literal SPACE, no vendor namespace. Built at
    // agents/runtime/core/telemetry/tracing.py:38 as
    // f"agent_runtime {instrumentation_builder_config.name}", where the name comes from
    // MessageRuntimeTracingConfig("InProcessRuntime") — a hardcoded literal at
    // in_process_runtime.py:182, NOT the runtime class name. v1 pinned that one value;
    // InProcessRuntime is merely the only CoreRuntime shipped in 1.36.0, so a
    // non-InProcess runtime was a silent-and-total miss: its spans carry only
    // messaging.operation / messaging.destination / messaging.message.type, and a generic
    // messaging.* rule would sweep in every Kafka/RabbitMQ span in a real app. The trailing
    // space is load-bearing. Wire: 17/47 agents, 0/28 user. Corpus sweep: zero non-SK spans
    // under any `agent_runtime ` scope — notably microsoft_agent_framework, SK's successor
    // in the same AutoGen lineage and the most plausible collision, uses the single scope
    // `agent_framework` (53/53 spans). Residual risk unchanged from the seed and accepted:
    // TraceHelper / MessageRuntimeTracingConfig are PUBLIC exports, so a third-party runtime
    // reusing SK's telemetry code is attributed to SK — one-directional, and arguably
    // correct since it IS SK's telemetry code emitting. These spans are SK spans but NOT
    // GenAI spans (see false_positives); they are also the population that fragments the
    // agents capture into 10 traces and the only corpus spans carrying span LINKS (13/17).
    if scope.starts_with("agent_runtime ") {
        return true;
    }

    // ---- scope-loss fallbacks (a collector/bridge rewrote or dropped the scope) ----

    // source: wire (phase-2, fix-queue X4 — deviation from the queue's prescribed shape,
    // adopted per the integration decision).
    // X4 asked for `key_prefix("sk.")` guarded by the semantic_kernel scope family, but
    // that conjunction is dead code: every span carrying an sk.* key sits in the
    // chat_completion_client_base scope (13/13 across both captures), so the scope clause
    // already claims it — and the whole purpose of this tier is scope LOSS, under which a
    // scope-guarded form recovers nothing. The exact key is strictly better: it is the only
    // sk.* key SK emits (model_diagnostics/gen_ai_attributes.py:47, "Kernel specific
    // attributes"; wire-confirmed — the complete key inventory of both captures contains no
    // other), so recall is unchanged, while the FP surface shrinks from "any app key
    // starting with two letters" (Sidekiq, an `sdk` typo, some `some kit`) to "an app
    // minting the literal 26-char sk.available_functions". A future second sk.* key would
    // ride on spans inside a semantic_kernel.* scope and be caught above anyway. This is
    // the ONLY signal on AutoFunctionInvocationLoop spans (8 user + 5 agents), which carry
    // no gen_ai.* key at all.
    if s.has_attr("sk.available_functions") {
        return true;
    }

    // source: wire.
    // SK-invented operation value (model_diagnostics/decorators.py:38); not an OTel semconv
    // value. 9/47 agents (streaming chats under orchestration). Corpus-clean: every other
    // vendor emits "chat".
    if s.attr("gen_ai.operation.name") == Some("chat.streaming_completions") {
        return true;
    }

    // source: wire (phase-2 — the queue missed this one; adopted per the integration
    // decision, which also records that it fingerprints a bug).
    // The non-streaming twin of the clause above, which the seed declined under the old
    // algebra because `chat.completions` alone is "generic enough to collide with other
    // vendors" — true, and exactly what the conjunction fixes. The co-evidence is SK's
    // Python-enum-repr bug: decorators.py:417-421 does `",".join(str(fr))` over
    // FinishReason enum members, so the value arrives as `FinishReason.STOP` /
    // `FinishReason.TOOL_CALLS` instead of a semconv value. Corpus-unique: a full sweep of
    // every *finish_reason* attribute finds `FinishReason.`-prefixed values ONLY in the two
    // SK captures (10 user + 11 agents). The obvious trap is checked — openrouter carries
    // the same singular key `gen_ai.response.finish_reason` on 1,918 spans (2026-08-13
    // re-count; the queue's figure of 1,637 predates a corpus refresh), values
    // stop/tool_calls/length, none `FinishReason.`-prefixed, and its 4,937
    // gen_ai.operation.name values are all "chat", never "chat.completions". Recovers the
    // 12 non-streaming chat spans (10 + 2) on scope loss, symmetric with the streaming
    // fallback the seed already ships. Honest failure mode: if SK ever fixes the enum repr
    // the clause goes quiet and those spans degrade to unknown:genai — today's behavior.
    s.attr("gen_ai.operation.name") == Some("chat.completions")
        && s.attr("gen_ai.response.finish_reason")
            .is_some_and(|value| value.starts_with("FinishReason."))
}

/// Seed: frameworks/smolagents/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `service.instance.id` (wire): Resource attribute auto-detected by the OTel Python SDK 1.44
///   as a random uuid4 per process (sdk/resources/__init__.py:507-528), not by smolagents or
///   OpenInference. Session-shaped and stable across all 6 turns of smolagents_user ONLY
///   because the fixture is one process per scenario; in a server it is one value for thousands
///   of sessions. Process identity, never session identity.
///
/// * `metadata` (wire): The third slot of the SAME using_attributes call that carries
///   session.id, so it is present on 42/42 and 33/33 spans and looks like a first-class
///   correlation field. It is an opaque customer JSON blob — here {"scenario","turn",
///   "capture.id"}, i.e. it CHANGES per turn inside one session. Never join on it.
///
/// * `tag.tags` (wire): Fourth slot of the same context call (42/42, 33/33). A customer-
///   supplied label array — here ["turn-1"] … ["turn-6"] within a single session. Per-call
///   labels, not identity.
///
/// * `llm.output_messages.0.message.tool_calls.0.tool_call.id` (wire): Provider tool-call id
///   (call_…) on LLM spans; also mirrored into the TOOL span's input. Correlates one tool call
///   to its result, changes many times per turn.
///
/// * `openinference.project.name` (source_code): The only OpenInference RESOURCE attribute that
///   exists (semconv/resource/ __init__.py). Set exclusively by `dangerously_using_project`, a
///   notebook helper that patches ReadableSpan.__init__ (_projects.py:10-27), and by Phoenix-
///   style backends. It is a deployment-wide constant — the langsmith.trace.session_name
///   failure mode. Not observed in these captures; never join on it.
///
/// # Caveats (the seed review's rationale record)
///
/// * `no_first_party_telemetry`: smolagents 1.26.0 contains ZERO telemetry code — it imports
///   opentelemetry nowhere, has no tracer/exporter/callback setting, and honours no OTEL_* env
///   var. 100% of smolagents telemetry maple will ever see is authored by openinference-
///   instrumentation-smolagents, a third-party wrapt monkey-patcher. Practical consequences:
///   (a) the framework version is never on the wire — scope.version is the instrumentor's
///   0.1.33, and service.version=1.26.0 here is harness-set [H]; (b) instrumentation is opt-in
///   application code, so the population of smolagents users maple can see is only those who
///   installed the OpenInference package and built an SDK; (c) span shapes track the
///   instrumentor's release cadence, not smolagents'.
///
/// * `model_subclass_discovery_is_by_export`: The instrumentor patches Model subclasses by
///   scanning vars(smolagents) at instrument() time (__init__.py:75-84). A customer's own Model
///   subclass — the normal way to wire a private gateway — is NOT in that dict and is therefore
///   NEVER traced: the trace keeps its AGENT / CHAIN / TOOL spans and silently loses every LLM
///   span, along with all token counts and message content. A smolagents trace with no
///   `<Model>.generate` span is this case, not an error. Also version-fragile: patching happens
///   once at instrument() time, so classes imported later are missed.
///
/// * `agent_identity_only_in_span_name`: No agent.name / agent.id / role attribute exists. The
///   agent is identifiable only by splitting `<name>.run` off the span name, and the fallback
///   when an agent has no name= is the Python CLASS name (_wrappers.py:123). Tool spans are
///   worse: the span name is instance.__class__.__name__ (_wrappers.py:653), so every @tool-
///   decorated function produces a span literally named `SimpleTool` — the fixture declares
///   explicit Tool subclasses purely so the names differ. tool.name carries the real tool name
///   in both styles; span names must never be used as rules. See algebra_violations.
///
/// * `smolagents_task_is_the_previous_turn`: smolagents.task on `<agent>.run` is OFF BY ONE
///   when the agent is reused. The wrapper reads agent.task BEFORE calling the wrapped run()
///   (_wrappers.py:74,124-126), and run() is what assigns it — so on a fresh agent the key is
///   ABSENT and on every subsequent turn it holds the PREVIOUS turn's task. Wire-proven in
///   smolagents_user: turn 1 has no smolagents.task, turn 2 carries turn 1's text, … turn 6
///   carries turn 5's (5/6 spans). Never use smolagents.task as the turn's input — input.value
///   on the same span is correct. In smolagents_agents it is absent from all 5 AGENT spans
///   (every agent is run exactly once).
///
/// * `token_counts_double_and_undercount`: llm.token_count.{prompt,completion,total} appears on
///   BOTH the LLM spans and the `<agent>.run` AGENT span, where the AGENT value is
///   agent.monitor's run total (_wrappers.py:214-219) — i.e. the sum of its own LLM children.
///   Any per-span rollup over a trace double counts. In the other direction, scenario B's
///   orchestrator.run total covers only the orchestrator's own LLM calls, NOT the managed
///   agents' (each worker has its own monitor and its own AGENT span), so the root span is not
///   a trace total either. Dedupe on openinference.span.kind = LLM.
///
/// * `session_context_is_instrumentor_side_not_otel_context`: OpenInference's session
///   propagation is NOT OTel baggage and NOT span-attribute inheritance: using_attributes
///   attaches a plain contextvar that only OITracer reads at span creation. A span created with
///   a stock opentelemetry.trace.Tracer inside the very same `with using_attributes(...)` block
///   gets NOTHING. Wire-proven [H] in the pre-prune backup of smolagents_user: run 1's two
///   `human_approval` spans (plain get_tracer, inside the context) carry no
///   session.id/user.id/metadata/tag.tags at all, while run 2's — after hitl.py added an
///   explicit span.set_attributes(dict(get_attributes_from_context())) — carry all four. Any
///   customer-authored or third-party-auto-instrumented span in a smolagents trace is session-
///   blind unless it opts in the same way.
///
/// * `one_trace_per_run_reset_false_does_not_help`: agent.run(reset=False) preserves MEMORY,
///   not the trace: every run() opens a new root span and therefore a new trace id (six turns
///   of one persistent agent = six unrelated trace ids in smolagents_user). smolagents exposes
///   no run/thread/conversation identifier to the instrumentor either. Cross-turn correlation
///   exists ONLY through the customer-supplied session.id.
///
/// * `error_shape_and_the_unreachable_recovery_event`: A failed tool produces status=ERROR +
///   one `exception` event on the TOOL span, and status=ERROR + TWO `exception` events on the
///   enclosing `Step <n>` span (the wrapper's record_exception at _wrappers.py:325 plus the
///   SDK's own on the way out of start_as_current_span). 0.1.33 also contains a softer path —
///   _record_step_error() emits an `agent.step_recovery` span EVENT and sets status OK for
///   AgentToolCallError/AgentToolExecutionError (_wrappers.py:260-286) — but it is unreachable
///   whenever the error propagates, because _finalize_step_span skips it once the status is
///   already ERROR. Wire-confirmed: zero `agent.step_recovery` events and zero OK-status
///   errored steps in either capture; the transport failure in smolagents_agents is an
///   AgentToolExecutionError and still lands as ERROR + 2 exception events. Error-rate
///   consumers must expect exactly this double-count.
///
/// * `no_native_hitl_or_resume`: smolagents 1.26.0 has no approval/interrupt-and-resume
///   mechanism. MultiStepAgent.interrupt() only flips a flag checked at the top of the next
///   loop iteration and then raises AgentError — it aborts a run, it cannot suspend a pending
///   tool call. There is no needs_approval / checkpointer concept. The fixture's HITL is
///   therefore SIMULATED [H] by subclassing ToolCallingAgent.execute_tool_call (hitl.py): on
///   denial Tool.__call__ is never reached, so NO DeleteFileTool span exists — a real absence,
///   not a dropped span. maple must not expect any native HITL signal from smolagents.
///
/// * `parallel_fan_out_is_real_and_context_safe`: Scenario B's three managed-agent calls
///   genuinely overlap (weather/budget/transport workers start within ~5 ms of each other
///   inside one 33-span trace): ToolCallingAgent.process_tool_calls dispatches through a
///   ThreadPoolExecutor with copy_context().run(...), and the instrumentor additionally swaps
///   smolagents.local_python_executor.ThreadPoolExecutor for a context-preserving one
///   (__init__.py:105-123). Parent/child links survive the thread hop. Fragile in a different
///   way, though: it degrades to sequential whenever the model emits a single tool call per
///   message, so fan-out shape is model-dependent, not framework-guaranteed.
///
/// * `payload_grows_quadratically_within_a_session`: Every `<Model>.generate` span re-
///   serialises the ENTIRE conversation into llm.input_messages.<i>.* (144 message-content
///   triples across 11 LLM spans in smolagents_user) and re-sends every tool's full JSON Schema
///   in llm.tools.<i>. With reset=False the memory grows monotonically, so late turns of a long
///   session cost far more bytes than early ones — the largest single OTLP record here is
///   118,815 B for one 3-turn batch. OPENINFERENCE_HIDE_LLM_TOOLS and
///   OPENINFERENCE_HIDE_INPUT_MESSAGES are the levers; trace-count sampling is not.
///
/// * `pruned_capture_inventory`: Both capture dirs originally held TWO runs of their scenario
///   (the capture server is append-only). They were pruned on 2026-08-06 to the canonical later
///   run (scripts/prune-spec.json: smolagents_user keep 3-5, smolagents_agents keep 5-8) and
///   the seqs renumbered from 0. The pre-prune supersets survive only as
///   records.jsonl.bak-2026-08-06T02-32-20-748Z / …T02-30-45-531Z and are NOT part of the
///   fixture. Two throwaway probe captures — smolagents_probe (2 records / 20 spans / 3 traces)
///   and smolagents_agents_probe (6 / 37 / 1) — are development artefacts and are deliberately
///   excluded from this seed.
///
/// Config variants that change the wire shape (`openinference-genai-semconv`): recorded in full
/// in the seed's `variants:` block — re-read it before touching this vendor's rules.
pub const SMOLAGENTS: VendorDef = VendorDef {
    id: VendorId::Smolagents,
    detect: detect_smolagents,
    keys: &["openinference.span.kind"],
    prefixes: &["smolagents."],
    span_names: &[],
    session_candidates: &[
        // verdict: C.
        SessionCandidateDef {
            key: "session.id",
            authority: |s| s.has_attr("openinference.span.kind"),
            require_non_empty: true,
            reject_decoy_values: false,
            event_key: None,
            granularity: Granularity::Session,
            granularity_of_value: None,
        },
        // verdict: C.
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

// Phase 2 (fix-queue SM1/SM2, 2026-08-13): re-adjudicated, shape CONFIRMED — two
// independent clauses, no shared-key hazards, and the HONEST CEILING is on the record
// per SM1: on scope rewrite/drop, 34/42 + 28/33 spans (every `Step <n>` CHAIN,
// `<Model>.generate` LLM and `<ToolClass>` TOOL span) carry NOTHING
// smolagents-specific — outside `smolagents.*` there is no key in either capture that
// any other OpenInference vendor would not also emit — and they fall to
// unknown:openinference via openinference.span.kind (42/42 + 33/33 coverage). That
// degradation is correct: loss of vendor label only, never silent total loss, and any
// attribute-only rule for those spans would be an invented fingerprint. SM2
// (`suffix(span_name, ".run")` agent identity) stays DEFERRED to the read path: span
// names are customer Python identifiers, and the rule adds zero recall (every `.run`
// span already matches the scope clause; on scope loss the same spans match the
// `smolagents.` clause).
fn detect_smolagents(s: &SpanCtx) -> bool {
    // owned_by: library, source: wire.
    // The scope name is the instrumentor module's own __name__ and the version is its
    // __version__ — openinference/instrumentation/smolagents/__init__.py:51 does
    // trace_api.get_tracer(__name__, __version__, tracer_provider). Library-owned,
    // namespaced, stable, and NOT app-derivable: the customer supplies only a
    // TracerProvider. It is also the ONLY signal that classifies 34/40 (user) and 28/33
    // (agents) native spans — the LLM / TOOL / CHAIN populations carry no smolagents-
    // specific attribute whatsoever (see false_negatives), so gating this scope on attr
    // evidence would leave 85% of this vendor's spans unattributed. Exactly four
    // span-creation sites exist in this scope (MultiStepAgent.run,
    // {Code,ToolCalling}Agent._step_stream, <Model>.generate(_stream), Tool.__call__ —
    // __init__.py:56-130), all agent operations. NOTE the scope version tracks the
    // INSTRUMENTOR (0.1.33), never smolagents (1.26.0): the framework version is not on the
    // wire anywhere. EXACT equality also refuses the harness scope
    // "trace-capture.smolagents" (2 spans in smolagents_user), which CONTAINS the
    // substring "smolagents" — a contains/suffix scope rule would wrongly claim them.
    s.scope_name() == "openinference.instrumentation.smolagents"
        // source: wire. Vendor-owned namespace, scope-loss fallback reaching only the
        // AGENT spans: 6/42 + 5/33 carry smolagents.{max_steps,tools_names,task,
        // managed_agents.<i>.*} — emitted solely by _smolagent_run_attributes() on
        // `<agent>.run` (_wrappers.py:71-104). Unconditional per X4 (own namespace);
        // negative sets: 0 occurrences of the prefix in openrouter (4,097 spans),
        // eve_slack (2,328), eve_slack_no_messages (1,927) or any other
        // non-smolagents capture (grep, 2026-08-13). The harness human_approval spans
        // carry no smolagents.* key, so this clause does not claim them either.
        || s.any_attr_prefix("smolagents.")
}

/// Seed: frameworks/spring_ai/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.response.id` (wire): On every `chat` span; unique per LLM call, never repeats
///   across turns.
///
/// * `spring.ai.tool.call.id` (wire): Per tool invocation (call_AzE6...); correlates tool
///   calls, not sessions.
///
/// Harness-only keys in the fixture captures (not framework signal): `chat.session.id`.
///
/// # Caveats (the seed review's rationale record)
///
/// * The instrumentation scope identifies SPRING BOOT, not Spring AI: scope.name is
///   org.springframework.boot, scope.version is the Boot version. A Boot app with no Spring AI
///   on the classpath emits spans in the identical scope. Strongest argument in the corpus for
///   attribute-based over scope-based classification.
///
/// * gen_ai.system is the CLIENT implementation, not the provider: `chat` spans for
///   anthropic/claude-haiku-4.5 (via OpenRouter through the OpenAI-compatible client) report
///   gen_ai.system=openai. gen_ai.request.model / gen_ai.response.model carry the truth.
///
/// * ALL attribute values arrive as OTLP stringValue, including numbers and booleans
///   (gen_ai.usage.input_tokens="210", spring.ai.chat.client.stream="false") and
///   gen_ai.response.finish_reasons as the string ["STOP"], not an arrayValue. Micrometer
///   KeyValues are String-typed and the bridge does not re-type them.
///
/// * Emitted OTLP is maximally unbatched: ONE resourceSpans block containing ONE scopeSpans
///   block containing ONE span, repeated — the full resource attribute set is duplicated per
///   span.
///
/// * In 1 of the 2 multi-record traces the first record mentioning the trace contains ONLY the
///   POST HTTP span — neither a classifiable span nor the session key — so a first-batch
///   classifier sees that trace as non-AI for one batch.
///
/// * Spring AI produced no ERROR-status span anywhere: the default
///   ToolExecutionExceptionProcessor swallows tool exceptions and feeds the message back to the
///   model, so execute_tool fetch_transport_data ends OK with the 503 text in
///   spring.ai.tool.call.result. The corpus' only ERROR span is harness [H].
///
/// * 28 of 101 native spans are advisor bookkeeping (`call`, `tool _calling `,
///   `message_chat_memory`) with no AI payload beyond spring.ai.advisor.name/order. One has a
///   malformed name — the literal string `tool _calling ` (stray underscore, trailing space;
///   Spring AI name-derivation bug). Span-name rules must not be used.
///
/// * Harness spans [H]: agent.* (8 + 5, AgentSpan.java — hardcodes gen_ai.system=spring_ai,
///   gen_ai.operation.name=invoke_agent, agent.role/parent/ task, workflow.* on the
///   orchestrator, chat.session.id/chat.turn.* on agent.assistant), hitl.approval (3 — Spring
///   AI has NO native HITL mechanism), and transport_api.fetch (1). All emitted via Spring's
///   own ObservationRegistry, so they land in the framework scope and are detectable only by
///   provenance.
pub const SPRING_AI: VendorDef = VendorDef {
    id: VendorId::SpringAi,
    detect: detect_spring_ai,
    keys: &["gen_ai.system", "spring.ai.kind"],
    prefixes: &["spring.ai."],
    span_names: &[],
    session_candidates: &[
        // verdict: B.
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
        // source_code: ChatMemory's documented default conversation id. NOT observed on the
        // wire (the convention omits the key when unset), but an integration passing the
        // literal default into the advisor param would produce a process-wide constant that
        // must never be joined on.
        "default",
    ],
};

fn detect_spring_ai(s: &SpanCtx) -> bool {
    // source: wire.
    // Spring AI's own attribute namespace: spring.ai.kind, spring.ai.advisor.*,
    // spring.ai.tool.*, spring.ai.chat.client.* — and, per the seed, the future
    // embedding/image/vector-store conventions, which also emit spring.ai.kind. Wire:
    // 52/75 spring_ai_user + 27/43 spring_ai_agents spans; zero occurrences in any other
    // capture.
    s.any_attr_prefix("spring.ai.")
        // source: wire.
        // The OTel-semconv-shaped form of the same fact; survives a spring.ai.* rename.
        // Wire: 40 native (user) + 21 native (agents) spans. Known, accepted side effect:
        // the fixture harness's agent.* spans (8 + 5) hardcode this value (AgentSpan.java)
        // and match — pinned as harness_matched in the goldens. A real customer stamping
        // gen_ai.system="spring_ai" on their own Observations is claiming the vendor
        // namespace and gets classified accordingly.
        || s.attr("gen_ai.system") == Some("spring_ai")
        // source: wire (phase-2, fix-queue SP1).
        // Tool-less ChatModel spans carry the full gen_ai.* block and NO spring.ai.* key,
        // because spring.ai.model.request.tool.names is omitted when no tool callbacks are
        // configured — 2 spans in spring_ai_agents (0 in _user, where every chat span
        // configures tools). The seed wanted `NOT scope.starts_with(
        // "io.opentelemetry.instrumentation.") AND gen_ai.system == "openai"`; that
        // negation form is banned by the corpus: openrouter carries 1,477 spans with
        // gen_ai.system="openai" under its own scope (plus langsmith 14 and
        // semantic_kernel 21), and openrouter's asserted FP ceiling is zero vendor claims.
        // The positive conjunct is the safe form. The Boot scope is usable ONLY as a
        // conjunct — it is Spring Boot's GLOBAL Micrometer-tracing scope (version tracks
        // Boot 4.1.0, not Spring AI 2.0.0), so alone it would also claim the 20 plain HTTP
        // CLIENT POST spans in these very captures, and every Spring MVC / RestClient /
        // JDBC / @Observed span in a real app, all of which must stay non-AI. Wire for the
        // positive: all 20 `chat` spans (12 + 8) carry gen_ai.system=="openai" under scope
        // org.springframework.boot — including the 3 anthropic/claude-haiku-4.5 chats,
        // since Spring AI sets the value from the model-client implementation, not the
        // provider. Negative sets, predicate applied: eve_slack 0/2328,
        // eve_slack_no_messages 0/1927, openrouter 0/4097.
        // Seed: frameworks/spring_ai/registry-seed.yaml (algebra_violations[0], resolved).
        || (s.scope_name() == "org.springframework.boot"
            && s.attr("gen_ai.system") == Some("openai"))
}

/// Seed: frameworks/strands/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `event_loop.parent_cycle_id` (wire): Looks like a parent/session pointer and is WRONG
///   under concurrency: event_loop.py:803 writes it into the invocation_state dict, which
///   multiagent/graph.py:833 SHARES across every node running as its own asyncio.create_task.
///   In strands_agents 3 of the 4 spans carrying it name a cycle belonging to a DIFFERENT agent
///   (weather_worker->transport_worker, budget_worker->weather_worker,
///   summary_agent->weather_worker); the 4th is self-consistent only by luck. Correct in the
///   sequential strands_user case (3/3 same agent, same trace). Never join on it, and never use
///   it to reconstruct causality.
///
/// * `event_loop.cycle_id` (wire): Fresh uuid4 per event-loop cycle: 11 distinct values across
///   8 traces in strands_user, 8 within the single strands_agents trace. Sub-run granularity —
///   changes several times inside one turn.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id. Deliberately REPEATS across the
///   interrupted and resumed copies of the same execute_tool span, which makes it look like a
///   correlation key spanning traces; it correlates one tool call, not a session.
///
/// * `service.instance.id` (wire): Added to the resource by the OTel Python SDK, not by
///   strands: a fresh uuid4 per PROCESS, constant across all 33 spans and all 8 traces of
///   strands_user. The most convincing decoy in this framework — in a one-script-one-session
///   fixture it is indistinguishable from a session id, and in a long-lived server it silently
///   merges every user into one 'session'.
///
/// * `gen_ai.agent.name` (wire): Stable per agent (user_assistant;
///   orchestrator/weather_worker/...), so it looks like a conversation key in single-agent
///   captures. It is a role name shared by every session that agent ever serves.
///
/// Harness-only keys in the fixture captures (not framework signal): `scenario`, `capture.id`.
///
/// # Caveats (the seed review's rationale record)
///
/// * `agent_span_tokens_are_cumulative`: gen_ai.usage.* on invoke_agent spans is
///   response.metrics.accumulated_usage — the Agent instance's LIFETIME total, not the turn's
///   (tracer.py:788-812). In strands_user the 8 invoke_agent spans read 248, 595, 1031, 2019,
///   2576, 3190, 3844, 4541 total_tokens, and 4541 is exactly the sum of all 9 `chat` spans.
///   Summing invoke_agent tokens across a session over-counts by ~4x (18044 vs 4541); summing
///   `chat` spans is correct. The gen_ai_use_latest_invocation_tokens opt-in silently inverts
///   which of the two is right, with no attribute to tell them apart.
///
/// * `content_lives_in_span_events`: In the default flavour 100% of prompts and completions are
///   span EVENTS (gen_ai.system.message / user / assistant / tool.message / gen_ai.choice),
///   with the payload in the event attributes `content` / `message` as JSON-serialised Strands
///   content blocks. Any pipeline that keeps spans but drops span events keeps every token
///   count and loses every message. The history is replayed IN FULL on each `chat` span, so
///   events grow quadratically with turn count: the 9 chat spans of the 6-turn strands_user
///   conversation carry 36 gen_ai.user.message + 36 gen_ai.assistant.message events between
///   them; 233 span events ride 33 spans.
///
/// * `parent_cycle_id_is_corrupt_under_concurrency`: event_loop.parent_cycle_id is wrong in 3/4
///   concurrent cases (strands_agents), naming another agent's cycle, because invocation_state
///   is one dict shared by all parallel graph nodes. Recorded as a decoy_key; repeated here
///   because it is the one strands attribute that actively misleads about trace structure
///   rather than merely being useless.
///
/// * `interrupt_and_resume_are_different_traces`: Strands' native interrupt
///   (BeforeToolCallEvent.interrupt) stops the event loop and returns; resuming requires a NEW
///   agent(...) call, which opens a NEW root trace. 6 turns -> 8 traces. The interrupted
///   `execute_tool` span is exported with status OK and NO gen_ai.tool.status, and a second
///   span with the same gen_ai.tool.call.id appears in the resume trace with the real outcome.
///   Denial is a native ERROR span (code 2, message = the cancel_tool string) with
///   gen_ai.tool.status absent on the first copy and the tool body never executed.
///
/// * `gen_ai_system_is_the_framework`: gen_ai.system is the constant 'strands-agents' on every
///   span — never the model vendor. Both captures actually called OpenRouter
///   (openai/gpt-4o-mini, anthropic/claude-haiku-4.5); only gen_ai.request.model carries
///   provider truth, and it holds the OpenRouter id, not a native OpenAI/Anthropic model id.
///   Convenient for classification (it is our attr_matcher), useless for provider attribution.
///
/// * `invoke_graph_is_a_bare_container`: The multi-agent root has 3 attributes, an UNSET
///   status, no gen_ai.event.end_time and span kind CLIENT — the only non-INTERNAL span in
///   either capture, and kind CLIENT for a span that makes no outbound call. It is also the
///   only span type that reads its trace_attributes from the Graph object rather than from an
///   Agent.
///
/// * `no_native_http_span`: Strands emits no span for the actual model HTTP request; `chat`
///   wraps the provider SDK call. Latency attribution below `chat` requires separate
///   HTTP/provider auto-instrumentation, whose spans belong to a different vendor and would sit
///   underneath strands spans in the same trace.
///
/// * `attribute_values_are_properly_typed`: Unlike the JVM frameworks, numeric attributes
///   arrive as OTLP intValue (gen_ai.usage.input_tokens, gen_ai.server.time_to_first_token) and
///   gen_ai.agent.tools arrives as a JSON STRING, not an arrayValue. Nothing in these captures
///   needs string->number coercion.
///
/// * `customer_chosen_session_key` — ST1, adjudicated DO-NOT-FIX 2026-08-13: `session.id` is on
///   the wire only because the fixture passed `Agent(trace_attributes={"session.id": ...})`.
///   The literal string `session.id` occurs nowhere in strands-agents 1.50.2, so a span-local
///   static rule cannot know the customer's chosen key name; the hardcoded candidate is kept
///   because it IS the key AgentCore's ADOT layer injects for free (the one deployment where
///   session identity costs the customer nothing). The real fix is per-org overlay rules, which
///   the plan defers with their own version field. Not a predicate-power problem.
///
/// * `abandoned_tool_duplicates` — ST2, half DO-NOT-FIX / half DEFERRED 2026-08-13: strands_user
///   has 4 `execute_tool delete_file` spans of which exactly 2 lack `gen_ai.tool.status`
///   (interrupted first attempts, exported with OK status), each pair sharing a
///   `gen_ai.tool.call.id`. The call.id JOIN is cross-span and therefore dead under the
///   per-span constraint (DO-NOT-FIX). The span-local half —
///   `gen_ai.operation.name == "execute_tool" && !has_attr("gen_ai.tool.status")` — is trivially
///   writable in v2 but has no v2 output column: it is a rollup-quality annotation ("this
///   tool-call row is an abandoned duplicate; any count or duration rollup double-counts it"),
///   not a classification. DEFERRED to an annotation surface (D-6); classification is
///   unaffected either way, since both copies are strands under every clause above.
///
/// Config variants that change the wire shape (`gen-ai-latest-experimental`, `gen-ai-tool-
/// definitions`, `gen-ai-span-attributes-only`, `gen-ai-use-latest-invocation-tokens`,
/// `bedrock-agentcore-runtime`): recorded in full in the seed's `variants:` block — re-read it
/// before touching this vendor's rules.
pub const STRANDS: VendorDef = VendorDef {
    id: VendorId::Strands,
    detect: detect_strands,
    keys: &[
        "gen_ai.system",
        "gen_ai.provider.name",
        // Phase-2: the guard on the `event_loop.` fallback.
        "gen_ai.operation.name",
    ],
    prefixes: &["event_loop."],
    span_names: &[],
    session_candidates: &[
        // verdict: C.
        SessionCandidateDef {
            key: "session.id",
            // A v1 `AnyOf`, now a plain `||`.
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
    // owned_by: library, source: wire.
    // Library-owned and structurally stable: telemetry/tracer.py:113-116 sets
    // self.service_name = __name__ and calls tracer_provider.get_tracer(
    // self.service_name), so the scope name IS the dotted module path of the tracer module
    // inside the strands package. It cannot be influenced by the app, is namespaced, and
    // catches 33/33 + 25/25 spans — the two captures contain NO span from any other scope
    // at all — including the `invoke_graph` root, which carries only 3 attributes. NOTE:
    // get_tracer() is called with no version argument, so scope.version is EMPTY on the
    // wire — scope.version can never be used to detect the SDK release.
    s.scope_name() == "strands.telemetry.tracer"
        // source: wire / source_code (queue ST3: ONE expression, two semconv flavours).
        // tracer.py:1216-1228's `_get_common_attributes` emits gen_ai.system on the legacy
        // branch and gen_ai.provider.name INSTEAD on the gen_ai_latest_experimental branch —
        // mutually exclusive, one fact. As two separate matchers they could be merged or
        // ranked apart by any future priority pass; as one `||` inside one detect body they
        // cannot. Wire: gen_ai.system=="strands-agents" on 58/58 corpus spans;
        // gen_ai.provider.name has zero wire occurrences and is kept on the source-code
        // citation so the experimental flavour stays classified under scope loss. The value
        // is the FRAMEWORK name, never the model vendor (caveat
        // gen_ai_system_is_the_framework) — exact equality, never substring or prefix, so
        // openrouter's 1,477 gen_ai.system="openai" spans are untouched.
        || s.attr("gen_ai.system") == Some("strands-agents")
        || s.attr("gen_ai.provider.name") == Some("strands-agents")
        // source: wire (phase-2, X4 sweep — the queue's list missed strands).
        // `event_loop.` is NOT a vendor-named namespace, unlike `litellm.*` or `crew_*`:
        // "event loop" is generic async-runtime vocabulary, and an asyncio/uvloop monitoring
        // instrumentation emitting `event_loop.*` keys is entirely plausible. Corpus absence
        // was its only protection — the same disjointness-only posture C2 was written to
        // end. The guard cannot be strands' OWN evidence without collapsing the clause into
        // the two above (which is the whole reason the seed keeps a prefix tier: to survive
        // a gen_ai.* rename), so it is generic-AI evidence instead: on the wire all 19
        // `event_loop.*` spans (11/33 + 8/25, the execute_event_loop_cycle population) carry
        // gen_ai.operation.name, and BOTH semconv flavours emit that key — only the
        // system/provider key name differs between them. Zero corpus recall cost; a
        // hypothetical asyncio-monitor span has no gen_ai.* at all and now falls through.
        || (s.any_attr_prefix("event_loop.") && s.has_attr("gen_ai.operation.name"))
}

/// Seed: frameworks/vercel_ai_sdk/registry-seed.yaml
/// Goldens: human_reviewed.
///
/// Decoy keys — NEVER consult these as session candidates (deliberately not compiled: the rule
/// is "never read", so the detector must not be able to):
///
/// * `gen_ai.response.id` (wire): 9/28 + 9/18 + 9/29 spans, one distinct value per LLM call
///   (gen-<ts>-<rand>); never repeats across turns.
///
/// * `gen_ai.tool.call.id` (wire): Provider tool-call id (call_... / toolu_bdrk_...).
///   Correlates a tool call to its request, not turns to a session.
///
/// * `gen_ai.agent.name` (wire): Set from telemetry.functionId (open-telemetry.ts:274) — agent
///   identity, and a PROCESS-LIFETIME CONSTANT per agent ('user_assistant' on all 8
///   invoke_agent spans in vercel_ai_sdk_user). Session-shaped only because a fixture runs one
///   agent.
///
/// * `ai.telemetry.functionId` (wire): Legacy-dialect twin of gen_ai.agent.name — same
///   constant, 18/18 spans, including ai.toolCall. Same trap.
///
/// * `resource.name` (wire): assemble-operation-name.ts:15 sets it to telemetry.functionId
///   verbatim, so it is the same constant again under a name that reads like an entity id. Note
///   it is a SPAN attribute literally named resource.name, not an OTel Resource attribute.
///
/// * `operation.name` (wire): Legacy dialect: `${operationId} ${functionId}` e.g.
///   'ai.generateText user_assistant'. Constant per (operation, agent) pair for the whole
///   process life.
///
/// Harness-only keys in the fixture captures (not framework signal):
/// `ai.settings.context.sessionId`, `ai.settings.context.scenario`.
///
/// # Caveats (the seed review's rationale record)
///
/// * SILENT ZERO: AI SDK v7 removed the per-call experimental_telemetry: {isEnabled: true}
///   switch. Telemetry now requires installing a separate package (@ai-sdk/otel) and calling
///   registerTelemetry(...) once at startup. Without it the SDK emits no spans, no warning and
///   no error. Every v5/v6 integration guide still in circulation produces a silently empty
///   pipeline on v7. This bounds how much vercel_ai_sdk data maple should expect to see at all.
///
/// * TWO DIALECTS, ONE VENDOR: the same library ships two mutually exclusive span schemas with
///   different span names, different tree shapes and different attribute namespaces. scope.name
///   (gen_ai vs ai) is the ONLY clean discriminator: legacy ai.generateText.doGenerate spans
///   also carry gen_ai.system / gen_ai.request.* / gen_ai.response.* / gen_ai.usage.*, so
///   attribute-presence detection fails, and both integrations can be registered at once into
///   one trace.
///
/// * gen_ai.provider.name is the CLIENT ROUTE, not the model vendor: mapProviderName (gen-ai-
///   format-messages.ts:76-109) maps the AI SDK provider string through a well-known-prefix
///   table and falls through to the raw string, so every span here says 'openrouter' even for
///   anthropic/claude-haiku-4.5. ai.response.providerMetadata (opt-in) reveals the real
///   upstream. The legacy dialect writes gen_ai.system=openrouter for the same reason.
///
/// * Span names embed the MODEL ID, never the agent: `invoke_agent openai/gpt-4o-mini`. Two
///   different agents on one model are indistinguishable by name. Agent identity exists only as
///   gen_ai.agent.name, only on the operation span, and only if the customer set
///   telemetry.functionId — ToolLoopAgent's `id` is never exported. Attribution of a `chat` or
///   `execute_tool` span to an agent requires walking the parent chain.
///
/// * DOCS BUG, verified: ai-sdk.dev/docs/ai-sdk-core/telemetry documents runtime context
///   landing as ai.settings.runtimeContext.*. The source has one implementation for both
///   dialects — getRuntimeContextAttributes at supplemental-attributes.ts:114-121 — and it
///   emits ai.settings.context.${key}. All 34 wire occurrences across the two dialects (and all
///   106 across the two eve_slack captures) use ai.settings.context.*. Anyone building a
///   session rule from the docs joins on a key that does not exist.
///
/// * enrichSpan (open-telemetry.ts:141-156, GenAI dialect only) is a second, undocumented- in-
///   NOTES injection point: it returns arbitrary attributes applied to EVERY AI SDK span type
///   at creation, including `chat` and `execute_tool`, which runtimeContext cannot reach. It is
///   the only way a customer can get a session key onto the token-bearing spans. Its keys are
///   entirely app-chosen, so it is invisible to any closed-key rule.
///
/// * LEGACY DIALECT DROPS THE POST-APPROVAL TOOL SPAN: after a HITL approval resume the tool
///   executes before any step begins; onToolExecutionStart returns early when stepContext is
///   undefined (legacy-open-telemetry.ts:603-604), so vercel_ai_sdk_user_legacy has an
///   ai.toolCall span for get_weather but NONE for the approved delete_file that actually ran.
///   The GenAI integration falls back to stepContext ?? rootContext, so its `execute_tool
///   delete_file` span exists but is parented to `invoke_agent` — which post-§7 is the TRACE
///   ROOT — not to a `step`. A parser assuming tool is a descendant of step gets it wrong. Both
///   behaviours are wire-confirmed here (user: execute_tool get_weather under `step 1`,
///   execute_tool delete_file directly under the root; legacy: ai.toolCall for get_weather
///   only).
///
/// * NATIVE HITL, INVISIBLE TO TELEMETRY: toolApproval: {delete_file: 'user-approval'} is a
///   real v7 gate, but neither dialect emits an approval span, event or attribute. A denied
///   call produces NO execute_tool span at all; the decision survives only inside message
///   payloads ({"denied":true,...} in gen_ai.input.messages, output:{"type":"execution-denied"}
///   in ai.prompt.messages), and approval parts are rendered as bare {"type":"tool-approval-
///   request"} with no approvalId, tool name or approved flag. HITL is unreachable by any
///   predicate in this algebra.
///
/// * SPAN KIND IS PARTLY USEFUL HERE, unusually: the GenAI dialect emits CLIENT for `chat`
///   (9/28 and 9/29 spans) and INTERNAL for everything else. The legacy dialect emits INTERNAL
///   for all 18. Kind alone still cannot classify, but a kind-based LLM-call rollup works in
///   the GenAI dialect and silently returns nothing in the legacy one. Note the trace ROOT is
///   INTERNAL in both dialects — there is no SERVER span anywhere.
///
/// * ERROR MODELLING IS NATIVE AND CORRECT: the failing tool in vercel_ai_sdk_agents produces
///   execute_tool fetch_transport_data with status ERROR ('transport data service unavailable
///   (503)') and one `exception` span event (exception.type/message/stacktrace), written by
///   @ai-sdk/otel's recordErrorOnSpan. The run does not abort — the error becomes a tool-error
///   part fed back to the model. Unlike google_adk, this exception event is framework-emitted,
///   not harness-injected.
///
/// * NO HARNESS SPANS: the §7 fidelity pass (2026-08-11) deleted the fixture's own tracer
///   (`trace-capture.vercel_ai_sdk`), its `chat_turn {n}` / `research_briefing_run` root spans,
///   the `session.id` span attribute, the `tool_approval.decision` span events and the
///   telemetry.dialect / capture.id resource attributes. Native span counts were unchanged by
///   the removal (28 / 18 / 29 before and after), so the earlier goldens' vendor counts carry
///   over; what changed is the TRACE structure, and it changed a lot.
///
/// * ONE TRACE PER generate() CALL — the AI SDK never joins calls into a trace. With the
///   harness root gone there is no trace-level grouping at all: vercel_ai_sdk_user is 8 traces
///   for 6 user turns, not 6, because a HITL approval resume is a SECOND generate() call and
///   therefore a second, separate trace with its own root. Scenario B is 2 traces, not 1: the
///   orchestrator run (26 spans, workers nested under their delegate `execute_tool` spans) and
///   the summary agent run (3 spans) share nothing. Any app-level notion of turn, conversation
///   or workflow must come from a customer span or from the session key — the trace id will not
///   supply it.
///
/// * UNVERIFIED, no capture and no source in this repo: apps deployed on Vercel with OTel Trace
///   Drains are reported to receive vercel.* attributes alongside the ai.*/gen_ai.* ones. If
///   real, vercel.* is a HOSTING signal, not an AI SDK signal, and must not be added as a
///   vendor matcher — a self-hosted AI SDK app emits none of it.
///
/// * Every attribute value arrives as an OTLP typed value here (intValue/doubleValue/ boolValue
///   as well as stringValue), unlike the Micrometer-bridged frameworks;
///   gen_ai.response.finish_reasons is a real arrayValue. Canonical stringification matters for
///   eq() comparisons on this vendor.
///
/// Config variants that change the wire shape (`genai-dialect`, `legacy-dialect`, `genai-
/// supplemental-off`, `custom-tracer`, `both-dialects-registered`): recorded in full in the
/// seed's `variants:` block — re-read it before touching this vendor's rules.
pub const VERCEL_AI_SDK: VendorDef = VendorDef {
    id: VendorId::VercelAiSdk,
    detect: detect_vercel_ai_sdk,
    keys: &["gen_ai.operation.name", "gen_ai.execute_tool.duration"],
    prefixes: &["ai."],
    span_names: &[],
    session_candidates: &[],
    decoy_values: &[],
};

// Phase-2 predicate (fix-queue V1, integration decision on vercel_ai_sdk): the bare
// `ai.` prefix became a scope conjunction, and the two AI-SDK-invented semconv
// markers stay as scope-independent disjuncts for the custom-tracer variant.
//
// OWNER DECISION 2026-08-13 (S11) — a fourth disjunct was removed. Earlier the same day
// this function opened with
//
//     scope == "gen_ai" && s.has_attr("gen_ai.operation.name")
//
// which read as a conjunction but was not one: `gen_ai.operation.name` is REQUIRED on
// every GenAI-semconv span, so the added conjunct carried no vendor evidence and the
// clause reduced to "a tracer named exactly `gen_ai` claims any GenAI span inside it".
// The scope name is customer data — an app that hand-rolls `trace.getTracer('gen_ai')`
// (the natural name, and the reason the SDK hardcoded it) would have had every LLM span
// attributed to this vendor. The corpus cannot see that failure: no capture here names a
// tracer `gen_ai` except the AI SDK itself, so the false-positive ceiling stayed `{}`
// either way, and a rule whose risk is invisible to the gate is a rule the gate cannot
// defend. The owner chose the narrow form.
//
// What that gave up, measured on the vendored fixture: 53 spans revert to
// `unknown:genai` — eve_slack 122 -> 92, eve_slack_no_messages 83 -> 60. All of them are
// `chat {modelId}` spans under the default `new OpenTelemetry()` config, which emits no
// supplemental `ai.*` for (A) below to reach. This vendor is now narrow BY CHOICE: the
// default-config GenAI dialect is a known, accepted false negative (seed
// `false_negatives[0]`), not an oversight.
fn detect_vercel_ai_sdk(s: &SpanCtx) -> bool {
    let scope = s.scope_name();

    // (A) Both dialects: the ai.* attribute namespace, guarded by the SDK's two
    // hardcoded tracer names. owned_by: library, source: wire — `gen_ai` is hardcoded at
    // open-telemetry.ts:117 and the legacy `ai` at legacy-open-telemetry.ts:157 (and
    // again as the fallback in get-tracer.ts:19). Both are bare, unnamespaced,
    // unversioned words (no scope.version, no schemaUrl, no scope attributes on any of
    // them) that any app hand-rolling an AI tracer would plausibly pick, so neither ever
    // stands alone — the vendor's own namespace is the other half. Wire: legacy dialect
    // 18/18 spans carry ai.operationId under scope "ai" (vercel_ai_sdk_user_legacy — the
    // only corpus capture with scope "ai"); GenAI dialect 26/28 + 23/29 spans carry
    // supplemental ai.* keys under "gen_ai". The guard is what un-claims eve_slack's 9
    // ai.eve.turn spans per capture (scope "eve", ai.telemetry.functionId) — the
    // corpus-proven v1 false positive, which now falls through to the unknown tier's
    // `ai.` fingerprint → unknown:other. Seed:
    // frameworks/vercel_ai_sdk/registry-seed.yaml (algebra_violations[0], resolved in
    // phase 2).
    ((scope == "ai" || scope == "gen_ai") && s.any_attr_prefix("ai."))
        // (B) Scope-independent AI-SDK-invented markers, kept for the custom-tracer
        // variant (new OpenTelemetry({tracer}) makes the scope app-chosen; seed
        // variants). source: wire. `agent_step` is NOT a semconv gen_ai.operation.name
        // value (semconv 1.43.0) and `gen_ai.execute_tool.duration` is AI-SDK-invented
        // (a duration stamped as a span attribute). Wire: agent_step on 9+9 fixture /
        // 30+23 eve step spans; execute_tool.duration on 2+6 fixture / 32+14 eve spans;
        // ZERO hits in the other 52 captures incl. all 3,968 openrouter spans (whose
        // gen_ai.operation.name values are all "chat").
        || s.attr("gen_ai.operation.name") == Some("agent_step")
        || s.has_attr("gen_ai.execute_tool.duration")
}

/// The unknown tier (plan §1): fingerprints that classify a span as AI without a
/// vendor match, bucketed into the reserved `unknown:*` vendors. Evaluated only
/// when no vendor matched (the resolution `else`), in this slice's order — v1's
/// internal ordering plus the phase-2 `input.value`/`output.value` rule, whose
/// position is load-bearing (see its comment).
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
    // Phase-2 X1 / integration decision D-4 — the headline omission of v1: the plan
    // always said `input.value`/`output.value` fire ONLY in co-occurrence with an
    // OpenInference attribute, and v1 shipped them nowhere because its algebra had no
    // conjunction (compile-registry.ts even carried a CI rule whose only job was to
    // enforce the omission). Both keys are unnamespaced English — `input.value` on a
    // form-handling span means nothing about AI — so the co-evidence is the whole rule.
    //
    // The co-evidence is the OpenInference attribute FAMILY, both spellings: the marker
    // key `openinference.span.kind` and the `llm.*` namespace that OpenInference's
    // semconv defines alongside it (llm.model_name, llm.input_messages.N.*, …). That is
    // why this rule sits ABOVE the bare `llm.` rule below and not at the end: a span
    // carrying `input.value` + `llm.*` is OpenInference dialect and belongs in
    // `unknown:openinference`, not the `unknown:other` catch-all it would otherwise fall
    // into. Where the co-evidence is `openinference.span.kind` the rule above already
    // reached the same bucket, so this rule only ever *adds* the llm.* re-bucketing —
    // which is exactly the coverage v1 documented and did not ship.
    //
    // Corpus: zero movement (verified 2026-08-13 over all capture dirs). Every span
    // carrying either key sits in an OpenInference instrumentor scope that a VENDOR
    // claims — agno, crewai, dspy, openai_agents_sdk, smolagents, openinference-openai —
    // so the unknown tier never runs on it; the only exceptions are the 2
    // `litellm_semconv_probe` harness spans, which carry neither co-evidence form and
    // stay `unknown:genai` on their `gen_ai.operation.name`.
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
    // Reachable since vercel_ai_sdk's `ai.` prefix evidence turned conjunctive on scope
    // (phase 2, fix-queue V1/X3): an `ai.*`-prefixed span outside the AI SDK's "ai"/
    // "gen_ai" scopes now lands here — wire: the 9 `ai.eve.turn` trace roots per
    // eve_slack capture (scope "eve", ai.telemetry.functionId). Seed:
    // frameworks/vercel_ai_sdk/registry-seed.yaml.
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
