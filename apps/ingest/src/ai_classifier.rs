//! Per-span AI classification: vendor, session-key state, session-key hash.
//!
//! Pure functions over decoded OTLP. No I/O, no clock, no cross-span state: a
//! span's classification depends on nothing but that span, its scope and its
//! resource, because root spans arrive last in almost every multi-batch trace.
//!
//! # Shape
//!
//! ```text
//! ResourceContext::new(registry, resource.attributes)   // once per ResourceSpans
//!   └─ .scope(scope, schema_url)                        // once per ScopeSpans
//!        └─ .classify_span(span.name, span.attributes)  // per span
//! ```
//!
//! The two hoisted levels do all the work that is constant across a scope: they
//! build the resource/scope attribute views once and evaluate every vendor's
//! `detect` against the scope-level evidence alone, leaving a per-span pass that
//! touches the span's own attributes once.
//!
//! # Evaluation semantics
//!
//! The rules are plain Rust predicates in [`crate::ai_vendors`]: each vendor is a
//! `detect: fn(&SpanCtx) -> bool` plus session-key candidates whose `authority` is
//! likewise a function. Resolution is **ordered first-match**: vendors are evaluated
//! in [`crate::ai_vendors::VENDORS`] slice order, the first match wins, and the
//! unknown tier ([`crate::ai_vendors::UNKNOWN_TIER`], its own internal order) is
//! evaluated only when no vendor matched. "A generic scope alone must not classify"
//! lives inside each vendor's own predicate as a conjunction, and the fixture replay
//! in `ai_classification_fixture_test.rs` is the acceptance gate.
//!
//! Invariants the [`SpanCtx`] accessors carry by construction:
//!
//! * **Canonical stringification** happens before matching, via the row writer's
//!   `any_value_string` — [`SpanCtx::attr`] and friends return the canonical string,
//!   so protobuf and OTLP/JSON transports classify identically.
//! * **Duplicate attribute keys: first occurrence wins**, and on the fast path only
//!   among registry-declared keys. The prefilter is what identifies them; keys no
//!   rule consults are never hashed, which is what keeps the budget.
//! * **Lookup is list-directed.** A predicate says *where* it reads by which
//!   accessor it calls — [`SpanCtx::attr`] reads the span's own attributes,
//!   [`SpanCtx::resource`] the resource's, [`SpanCtx::scope_attr`] the scope's, and
//!   [`SpanCtx::scope_name`]/[`SpanCtx::span_name`] the columns. There is no
//!   fallback chain, no class table and no pseudo-key exemption list, so a resource
//!   attribute can never satisfy a span-attribute prefix family (the
//!   `langsmith.internal_provider` hazard) — see the test of the same name.
//!
//! # The fast path, and its safety net
//!
//! Per scope, [`ScopeContext`] evaluates every `detect` once against the
//! resource+scope evidence with an **empty span** — vendors that already match are
//! `decided` for every span under the scope. Per span, one pass over the attributes
//! through the generated prefilter yields the set of *candidate* detectors whose
//! declared hints the span touches (plus a span-name lookup for the vendors that
//! declare span names). **Fast exit**: no candidates and nothing scope-decided →
//! non-AI — the overwhelming majority of production spans, a single branch.
//! Otherwise the few candidate predicates run in slice order.
//!
//! Two structural requirements make this sound, and both are documented on
//! [`crate::ai_vendors::VendorDef`]:
//!
//! * `detect` must be **monotone in span evidence** (true on scope evidence alone ⇒
//!   true for every span). Every predicate is: they are ORs of positive tests, and
//!   conjunctions only narrow a disjunct. The two negations that exist are safe by
//!   construction — crewai negates SCOPE evidence (constant across the hoist) and
//!   flue negates a span attribute inside a session-candidate `authority`, which is
//!   never hoisted. A `detect` negating *span* evidence would need a per-vendor
//!   opt-out from the shortcut, which does not exist (see
//!   [`crate::ai_vendors::VendorDef`]).
//! * The declared `keys`/`prefixes` hints must cover everything the predicates
//!   consult. A predicate reading an undeclared key sees "absent" on the fast path;
//!   the **indexed-vs-direct differential** (this module's tests and the fixture
//!   replay) evaluates every vendor over the raw, unprefiltered attribute lists and
//!   turns exactly that drift into a test failure over real data.
//!
//! The row writer (`telemetry::encode_traces`) calls this per span and stamps the
//! outputs onto the `Ai*` columns.

use std::borrow::Cow;

use opentelemetry_proto::tonic::common::v1::{InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::trace::v1::span::Event;

use crate::ai_registry::{
    canonical_value, registry, unknown_rule_bit, KeyId, Registry, SessionCandidate, VendorId,
};
use crate::ai_vendors::{UNKNOWN_TIER, VENDORS};
use crate::cityhash102::city_hash64;

/// `AiSessionKeyState`. Values are frozen at v1 and append-only: the rollup MV
/// persists threshold comparisons over them (`state >= 3` is the eligibility
/// contract), so renumbering would silently rewrite history.
pub mod session_state {
    /// Not examined, or examined and not AI.
    pub const NOT_EXAMINED: u8 = 0;
    /// Vendor has no session-key rules (includes every `unknown:*` bucket).
    pub const NO_RULES: u8 = 1;
    /// Span is not session-authoritative.
    pub const NOT_AUTHORITATIVE: u8 = 2;
    /// Authoritative, key absent.
    pub const KEY_ABSENT: u8 = 3;
    /// Key present but failed validation (empty or a decoy value).
    pub const KEY_INVALID: u8 = 4;
    /// Resolved at `run`/`instance`/`user` granularity.
    pub const SUB_SESSION: u8 = 5;
    /// Resolved at `session` granularity.
    pub const SESSION: u8 = 6;
}

/// The per-span output. `rules_version` is stamped on **every** examined span,
/// including non-AI ones: `AiRulesVersion != 0 AND AiVendor = ''` is what makes
/// "definitively classified non-AI" distinguishable from "pre-rollout row".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpanClassification<'a> {
    pub vendor: Option<VendorId>,
    pub session_state: u8,
    /// The raw winning session-key value, for states 5 and 6 only. Never stored —
    /// hash it with [`SpanClassification::session_key_hash`].
    pub session_key: Option<Cow<'a, str>>,
    pub rules_version: u32,
}

impl SpanClassification<'_> {
    /// `cityHash64(value)`, or 0 when no key resolved.
    ///
    /// The hash is a storage format, not a confidentiality boundary: the value it
    /// digests stays in `SpanAttributes` in the clear on the same row. What it buys
    /// is 8 fixed bytes on a per-span column and a numeric input to `uniqCombined`
    /// in `service_ai_vendors_hourly`. 64 bits is matched to that consumer — at ~1M
    /// distinct sessions per org the birthday collision probability is ~1e-8, six
    /// orders of magnitude under the sketch's own ~1.6% standard error.
    pub fn session_key_hash(&self) -> u64 {
        match &self.session_key {
            Some(value) => city_hash64(value.as_bytes()),
            None => 0,
        }
    }

    /// Vendor slug for the row column: `''` for non-AI. `'static` because the
    /// registry is: the slug set is closed and outlives every span.
    pub fn vendor_slug(&self) -> &'static str {
        match self.vendor {
            Some(id) => registry().vendor_slug(id),
            None => "",
        }
    }
}

// ---------------------------------------------------------------------------
// attribute views
// ---------------------------------------------------------------------------

/// How many registry-referenced attributes one attribute list holds before the
/// view spills to the heap. The corpus p99 is 3; the fattest hand-built AI span
/// in the bench carries 6.
const INLINE_ATTRS: usize = 8;

/// 64-bit words backing [`AttrView::key_bits`]. Sized from
/// [`crate::ai_registry::MAX_KEYS`], which the registry validates at load.
const KEY_BITS_WORDS: usize = crate::ai_registry::MAX_KEYS / 64;

/// Registry-referenced attribute values of one attribute list, first-occurrence-wins,
/// plus which registry key-prefixes its keys satisfy.
///
/// A flat `(KeyId, value)` list, **not** a `registry.keys().len()`-wide slot
/// array: the slot array is O(1) to read but costs a zeroing allocation on every
/// span carrying a single registry key. Lookups scan `len` instead, which for a
/// handful of entries is a cache line, not a branch-predictor problem.
struct AttrView<'a> {
    inline: [Option<(KeyId, Cow<'a, str>)>; INLINE_ATTRS],
    inline_len: usize,
    /// Only allocated by spans carrying more than `INLINE_ATTRS` registry keys.
    spill: Vec<(KeyId, Cow<'a, str>)>,
    /// Which `KeyId`s this view holds. Detection asks ~one question per
    /// candidate predicate and almost every answer is "absent", so the miss has
    /// to cost a bit test rather than a walk of the entry list.
    key_bits: [u64; KEY_BITS_WORDS],
    prefix_bits: u64,
}

impl Default for AttrView<'_> {
    fn default() -> Self {
        Self {
            inline: [const { None }; INLINE_ATTRS],
            inline_len: 0,
            spill: Vec::new(),
            key_bits: [0; KEY_BITS_WORDS],
            prefix_bits: 0,
        }
    }
}

impl<'a> AttrView<'a> {
    fn build(registry: &Registry, attributes: &'a [KeyValue]) -> Self {
        let mut view = AttrView::default();
        for attribute in attributes {
            let probe = registry.probe(&attribute.key);
            view.prefix_bits |= probe.prefix_bits;
            if let Some(key) = probe.key_id {
                // First occurrence wins, among registry keys only.
                if view.get(key).is_some() {
                    continue;
                }
                view.push(key, canonical_value(attribute.value.as_ref()));
            }
        }
        view
    }

    fn push(&mut self, key: KeyId, value: Cow<'a, str>) {
        self.key_bits[key as usize / 64] |= 1u64 << (key % 64);
        if self.inline_len < INLINE_ATTRS {
            self.inline[self.inline_len] = Some((key, value));
            self.inline_len += 1;
        } else {
            self.spill.push((key, value));
        }
    }

    /// No entries at all — lets predicate probes skip even the key-interning
    /// hash (the common case: empty span/scope views during hoisting, and
    /// scope attribute lists, which are almost always empty).
    #[inline]
    fn is_empty(&self) -> bool {
        self.inline_len == 0
    }

    #[inline]
    fn holds(&self, key: KeyId) -> bool {
        self.key_bits[key as usize / 64] & (1u64 << (key % 64)) != 0
    }

    fn get(&self, key: KeyId) -> Option<&str> {
        self.slot(key).map(|(_, value)| &**value)
    }

    /// Like [`AttrView::get`], but keeps the attribute list's lifetime rather
    /// than the view's — session-key values outlive the borrow of the view.
    fn get_cow(&self, key: KeyId) -> Option<Cow<'a, str>> {
        self.slot(key).map(|(_, value)| value.clone())
    }

    fn slot(&self, key: KeyId) -> Option<&(KeyId, Cow<'a, str>)> {
        if !self.holds(key) {
            return None;
        }
        self.slots().find(|(id, _)| *id == key)
    }

    fn slots(&self) -> impl Iterator<Item = &(KeyId, Cow<'a, str>)> + '_ {
        self.inline[..self.inline_len]
            .iter()
            .flatten()
            .chain(self.spill.iter())
    }

    /// The view's entries in insertion order.
    fn entries(&self) -> impl Iterator<Item = (KeyId, &str)> + '_ {
        self.slots().map(|(key, value)| (*key, &**value))
    }
}

/// The reference view: every attribute of one list, canonicalized, in wire order,
/// with **no prefilter**. Lookups scan for the first occurrence, so
/// first-occurrence-wins holds for every key, declared or not.
///
/// Test-only: this is what makes the indexed-vs-direct differential a real safety
/// net for hint drift — a predicate consulting an undeclared key finds it here and
/// not in the [`AttrView`], and the divergence fails the test.
#[cfg(test)]
struct DirectAttrs<'a> {
    entries: Vec<(&'a str, Cow<'a, str>)>,
}

#[cfg(test)]
impl<'a> DirectAttrs<'a> {
    fn build(attributes: &'a [KeyValue]) -> Self {
        Self {
            entries: attributes
                .iter()
                .map(|attribute| {
                    (
                        attribute.key.as_str(),
                        canonical_value(attribute.value.as_ref()),
                    )
                })
                .collect(),
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(entry, _)| *entry == key)
            .map(|(_, value)| &**value)
    }

    fn get_cow(&self, key: &str) -> Option<Cow<'a, str>> {
        self.entries
            .iter()
            .find(|(entry, _)| *entry == key)
            .map(|(_, value)| value.clone())
    }

    fn any_prefix(&self, prefix: &str) -> bool {
        self.entries.iter().any(|(key, _)| key.starts_with(prefix))
    }
}

/// One attribute list as a predicate reads it: the indexed fast path or the
/// unprefiltered reference path.
enum Attrs<'a, 'v> {
    Indexed(&'v AttrView<'a>),
    #[cfg(test)]
    Direct(&'v DirectAttrs<'a>),
}

impl<'a> Attrs<'a, '_> {
    // The `is_empty()` short circuits skip the key/prefix interning hash when
    // the list holds nothing a rule could read — the common shape for scope
    // attribute lists and for the empty span the hoist evaluates against.

    #[inline]
    fn get(&self, registry: &Registry, key: &str) -> Option<&str> {
        match self {
            Attrs::Indexed(view) => {
                if view.is_empty() {
                    return None;
                }
                registry.key_id(key).and_then(|id| view.get(id))
            }
            #[cfg(test)]
            Attrs::Direct(direct) => direct.get(key),
        }
    }

    #[inline]
    fn holds(&self, registry: &Registry, key: &str) -> bool {
        match self {
            Attrs::Indexed(view) => {
                !view.is_empty() && registry.key_id(key).is_some_and(|id| view.holds(id))
            }
            #[cfg(test)]
            Attrs::Direct(direct) => direct.get(key).is_some(),
        }
    }

    #[inline]
    fn any_prefix(&self, registry: &Registry, prefix: &str) -> bool {
        match self {
            Attrs::Indexed(view) => {
                view.prefix_bits != 0
                    && registry
                        .prefix_id(prefix)
                        .is_some_and(|id| view.prefix_bits & (1u64 << id) != 0)
            }
            #[cfg(test)]
            Attrs::Direct(direct) => direct.any_prefix(prefix),
        }
    }

    #[inline]
    fn candidate_value(&self, candidate: &SessionCandidate) -> Option<Cow<'a, str>> {
        match self {
            Attrs::Indexed(view) => view.get_cow(candidate.key_id),
            #[cfg(test)]
            Attrs::Direct(direct) => direct.get_cow(candidate.key),
        }
    }
}

// ---------------------------------------------------------------------------
// SpanCtx — what a predicate reads
// ---------------------------------------------------------------------------

/// A span plus the scope/resource it hangs off — the unit every predicate reads.
///
/// The rule-author API: a vendor's `detect` and its session candidates'
/// `authority` functions receive a `&SpanCtx` and say *where* they read by which
/// accessor they call. Values are canonical-stringified, duplicate keys are
/// first-occurrence-wins, and there is no fallback between the three lists.
///
/// On the fast path, `attr`/`resource`/`scope_attr` see only keys the vendor
/// tables **declare**; the direct reference path behind the differential tests
/// sees every key. A predicate consulting an undeclared key therefore diverges
/// between the two — the designed failure mode for hint drift.
pub struct SpanCtx<'a, 'v> {
    registry: &'static Registry,
    scope_name: &'a str,
    scope_version: &'a str,
    scope_schema_url: &'a str,
    span_name: &'a str,
    resource: Attrs<'a, 'v>,
    scope_attrs: Attrs<'a, 'v>,
    span_attrs: Attrs<'a, 'v>,
    events: &'a [Event],
}

impl<'a> SpanCtx<'a, '_> {
    /// The instrumentation scope name (`""` when the scope is absent).
    #[inline]
    pub fn scope_name(&self) -> &'a str {
        self.scope_name
    }

    /// The instrumentation scope version (`""` when absent).
    #[inline]
    pub fn scope_version(&self) -> &'a str {
        self.scope_version
    }

    /// The `ScopeSpans.schema_url`, falling back to the resource's.
    #[inline]
    pub fn scope_schema_url(&self) -> &'a str {
        self.scope_schema_url
    }

    /// The span's name.
    #[inline]
    pub fn span_name(&self) -> &'a str {
        self.span_name
    }

    /// The span's own attribute value for `key`, canonical-stringified,
    /// first-occurrence-wins. Never falls back to the scope or the resource.
    #[inline]
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.span_attrs.get(self.registry, key)
    }

    /// Whether the span's own attributes carry `key` (present-but-empty counts).
    #[inline]
    pub fn has_attr(&self, key: &str) -> bool {
        self.span_attrs.holds(self.registry, key)
    }

    /// Whether any of the span's own attribute keys starts with `prefix`.
    #[inline]
    pub fn any_attr_prefix(&self, prefix: &str) -> bool {
        self.span_attrs.any_prefix(self.registry, prefix)
    }

    /// The resource attribute value for `key`, canonical-stringified,
    /// first-occurrence-wins.
    #[inline]
    pub fn resource(&self, key: &str) -> Option<&str> {
        self.resource.get(self.registry, key)
    }

    /// Whether the resource attributes carry `key`.
    #[inline]
    pub fn has_resource(&self, key: &str) -> bool {
        self.resource.holds(self.registry, key)
    }

    /// Whether any resource attribute key starts with `prefix`.
    #[inline]
    pub fn any_resource_prefix(&self, prefix: &str) -> bool {
        self.resource.any_prefix(self.registry, prefix)
    }

    /// The instrumentation-scope attribute value for `key`,
    /// canonical-stringified, first-occurrence-wins.
    #[inline]
    pub fn scope_attr(&self, key: &str) -> Option<&str> {
        self.scope_attrs.get(self.registry, key)
    }

    /// The span's events: name plus a canonical-stringified attribute accessor.
    ///
    /// Event attribute keys feed the candidate dispatch through the same declared
    /// `keys`/`prefixes` hints as span attributes (see
    /// [`ScopeContext::classify_span_full`]), so an event-reading predicate
    /// survives the fast exit on spans whose only evidence is an event. Events
    /// themselves are never prefiltered — both paths read the raw wire list.
    pub fn events(&self) -> impl Iterator<Item = EventCtx<'a>> + '_ {
        self.events.iter().map(|event| EventCtx { event })
    }

    fn candidate_value(&self, candidate: &SessionCandidate) -> Option<Cow<'a, str>> {
        self.span_attrs.candidate_value(candidate)
    }
}

/// One span event, as a predicate reads it.
pub struct EventCtx<'a> {
    event: &'a Event,
}

impl<'a> EventCtx<'a> {
    /// The event's attribute value for `key`, canonical-stringified,
    /// first-occurrence-wins.
    pub fn attr(&self, key: &str) -> Option<Cow<'a, str>> {
        self.event
            .attributes
            .iter()
            .find(|attribute| attribute.key == key)
            .map(|attribute| canonical_value(attribute.value.as_ref()))
    }

    /// Whether any of the event's attribute keys starts with `prefix`. Events
    /// are never prefiltered — both the indexed and the direct path scan the
    /// raw wire list — so this is a plain scan; the *candidate dispatch* is
    /// what needs the prefix declared in the vendor's `prefixes` hints (see
    /// [`ScopeContext::classify_span_full`]).
    pub fn any_attr_prefix(&self, prefix: &str) -> bool {
        self.event
            .attributes
            .iter()
            .any(|attribute| attribute.key.starts_with(prefix))
    }
}

// ---------------------------------------------------------------------------
// hoisted contexts
// ---------------------------------------------------------------------------

/// Resolved once per `ResourceSpans`.
pub struct ResourceContext<'a> {
    registry: &'static Registry,
    attrs: AttrView<'a>,
    raw: &'a [KeyValue],
}

impl<'a> ResourceContext<'a> {
    pub fn new(registry: &'static Registry, attributes: &'a [KeyValue]) -> Self {
        Self {
            registry,
            attrs: AttrView::build(registry, attributes),
            raw: attributes,
        }
    }

    /// Resolved once per `ScopeSpans`. `schema_url` is the `ScopeSpans.schema_url`
    /// (falling back to the resource's, as the reference evaluator does).
    pub fn scope<'r>(
        &'r self,
        scope: Option<&'a InstrumentationScope>,
        schema_url: &'a str,
    ) -> ScopeContext<'a, 'r> {
        let scope_raw: &'a [KeyValue] = scope.map(|s| s.attributes.as_slice()).unwrap_or(&[]);
        let mut context = ScopeContext {
            registry: self.registry,
            resource: &self.attrs,
            resource_raw: self.raw,
            scope_attrs: AttrView::build(self.registry, scope_raw),
            scope_raw,
            scope_name: scope.map(|s| s.name.as_str()).unwrap_or(""),
            scope_version: scope.map(|s| s.version.as_str()).unwrap_or(""),
            scope_schema_url: schema_url,
            decided: 0,
        };
        context.hoist();
        context
    }
}

pub struct ScopeContext<'a, 'r> {
    registry: &'static Registry,
    resource: &'r AttrView<'a>,
    /// The raw wire list — read only by the direct (test-only) reference path.
    #[cfg_attr(not(test), allow(dead_code))]
    resource_raw: &'a [KeyValue],
    scope_attrs: AttrView<'a>,
    /// The raw wire list — read only by the direct (test-only) reference path.
    #[cfg_attr(not(test), allow(dead_code))]
    scope_raw: &'a [KeyValue],
    scope_name: &'a str,
    scope_version: &'a str,
    scope_schema_url: &'a str,
    /// Vendors whose `detect` already holds on resource+scope evidence alone
    /// (evaluated once, against an empty span). Because detect is monotone in
    /// span evidence (see the module docs), a decided vendor matches every span
    /// of the scope — recomputing that per span is the cost hoisting avoids.
    decided: u64,
}

impl<'a, 'r> ScopeContext<'a, 'r> {
    /// An indexed [`SpanCtx`] over this scope for one span's data.
    fn span_ctx<'v>(
        &'v self,
        span_name: &'a str,
        facts: &'v AttrView<'a>,
        events: &'a [Event],
    ) -> SpanCtx<'a, 'v> {
        SpanCtx {
            registry: self.registry,
            scope_name: self.scope_name,
            scope_version: self.scope_version,
            scope_schema_url: self.scope_schema_url,
            span_name,
            resource: Attrs::Indexed(self.resource),
            scope_attrs: Attrs::Indexed(&self.scope_attrs),
            span_attrs: Attrs::Indexed(facts),
            events,
        }
    }

    /// Evaluate every vendor once against the scope-level evidence alone.
    fn hoist(&mut self) {
        let empty = AttrView::default();
        let ctx = self.span_ctx("", &empty, &[]);
        let mut decided = 0u64;
        for def in VENDORS {
            if (def.detect)(&ctx) {
                decided |= 1u64 << def.id.index();
            }
        }
        self.decided = decided;
    }

    /// Classify one span. `attributes` is the span's raw attribute list; duplicates
    /// and unordered keys are fine. Use [`ScopeContext::classify_span_full`] where
    /// the span's events are at hand — some rules read them.
    pub fn classify_span(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
    ) -> SpanClassification<'a> {
        self.classify_span_full(span_name, attributes, &[])
    }

    /// [`ScopeContext::classify_span`] with the span's events.
    pub fn classify_span_full(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
        events: &'a [Event],
    ) -> SpanClassification<'a> {
        // One pass over the span's attributes through the prefilter: canonical
        // values for declared keys, prefix bits, and (via the dispatch tables)
        // the set of detectors this span's evidence could possibly satisfy.
        let facts = AttrView::build(self.registry, attributes);
        let mut candidates = self.decided;
        for (key, _) in facts.entries() {
            candidates |= self.registry.detectors_by_key(key);
        }
        let mut prefixes = facts.prefix_bits;
        while prefixes != 0 {
            let prefix = prefixes.trailing_zeros() as u8;
            prefixes &= prefixes - 1;
            candidates |= self.registry.detectors_by_prefix(prefix);
        }
        candidates |= self.registry.detectors_by_span_name(span_name);
        // Event-attribute keys feed the same dispatch: a predicate reading span
        // events via a declared key/prefix — llamaindex's `tags.llamaindex.`
        // clause — must survive the fast exit on spans whose ONLY evidence is an
        // event. Runs only when the span carries events at all.
        for event in events {
            for attribute in &event.attributes {
                let probe = self.registry.probe(&attribute.key);
                if let Some(key) = probe.key_id {
                    candidates |= self.registry.detectors_by_key(key);
                }
                let mut event_prefixes = probe.prefix_bits;
                while event_prefixes != 0 {
                    let prefix = event_prefixes.trailing_zeros() as u8;
                    event_prefixes &= event_prefixes - 1;
                    candidates |= self.registry.detectors_by_prefix(prefix);
                }
            }
        }

        // Fast exit: no surviving evidence and nothing the scope decided → non-AI,
        // one branch.
        if candidates == 0 {
            return SpanClassification {
                vendor: None,
                session_state: session_state::NOT_EXAMINED,
                session_key: None,
                rules_version: self.registry.version(),
            };
        }

        let ctx = self.span_ctx(span_name, &facts, events);

        // Ordered first-match over the vendors; the unknown tier only in the
        // `else`. A scope-decided vendor needs no re-evaluation.
        let mut vendor = None;
        for def in VENDORS {
            let bit = 1u64 << def.id.index();
            if candidates & bit == 0 {
                continue;
            }
            if self.decided & bit != 0 || (def.detect)(&ctx) {
                vendor = Some(def.id);
                break;
            }
        }
        if vendor.is_none() {
            for (index, rule) in UNKNOWN_TIER.iter().enumerate() {
                if candidates & unknown_rule_bit(index) == 0 {
                    continue;
                }
                if (rule.detect)(&ctx) {
                    vendor = Some(rule.bucket);
                    break;
                }
            }
        }

        let (session_state, session_key) = match vendor {
            Some(vendor) => self.evaluate_session(vendor, &ctx),
            None => (session_state::NOT_EXAMINED, None),
        };
        SpanClassification {
            vendor,
            session_state,
            session_key,
            rules_version: self.registry.version(),
        }
    }

    fn evaluate_session(
        &self,
        vendor: VendorId,
        ctx: &SpanCtx<'a, '_>,
    ) -> (u8, Option<Cow<'a, str>>) {
        let entry = self.registry.vendor(vendor);
        if entry.candidates().is_empty() {
            return (session_state::NO_RULES, None);
        }
        let mut best_state = 0u8;
        let mut best_key: Option<Cow<'a, str>> = None;
        for candidate in entry.candidates() {
            let (state, value) = candidate_state(entry, candidate, ctx);
            // Strictly greater: ties keep the earlier candidate's hash.
            if state > best_state {
                best_state = state;
                best_key = if state >= session_state::SUB_SESSION {
                    value
                } else {
                    None
                };
            }
        }
        (best_state, best_key)
    }
}

fn candidate_state<'a>(
    vendor: &crate::ai_registry::Vendor,
    candidate: &SessionCandidate,
    ctx: &SpanCtx<'a, '_>,
) -> (u8, Option<Cow<'a, str>>) {
    if !(candidate.authority)(ctx) {
        return (session_state::NOT_AUTHORITATIVE, None);
    }
    // Presence, not `!= ''`: present-but-empty must stay distinguishable from
    // absent (it is state 4, not state 3). Candidate keys are span-local; a
    // candidate with an `event_key` falls back to the span's OWN events when
    // the attribute is absent — attr first, then the first event carrying the
    // exact key (first-occurrence-wins, mirroring the duplicate-key rule).
    // Validations below apply to either source identically.
    let value = ctx.candidate_value(candidate).or_else(|| {
        candidate
            .event_key
            .and_then(|key| ctx.events().find_map(|event| event.attr(key)))
    });
    let Some(value) = value else {
        return (session_state::KEY_ABSENT, None);
    };
    if candidate.require_non_empty && value.is_empty() {
        return (session_state::KEY_INVALID, None);
    }
    if candidate.reject_decoy_values && vendor.is_decoy_value(&value) {
        return (session_state::KEY_INVALID, None);
    }
    // Value-conditional granularity runs over the VALIDATED value only — states
    // 3/4 are decided above, so the override moves a resolved span between 5 and 6,
    // never in or out of resolution.
    let granularity = match candidate.granularity_of_value {
        Some(granularity_of_value) => granularity_of_value(&value),
        None => candidate.granularity,
    };
    (granularity.resolved_state(), Some(value))
}

// ---------------------------------------------------------------------------
// the direct reference path (tests only)
// ---------------------------------------------------------------------------

#[cfg(test)]
impl<'a, 'r> ScopeContext<'a, 'r> {
    /// A direct [`SpanCtx`]: every attribute list raw and unprefiltered, every
    /// vendor evaluated with no hoisting, no candidate dispatch and no fast
    /// exit. The reference the indexed path is checked against — and the net
    /// that catches declared-hint drift (see the module docs).
    fn with_direct_ctx<T>(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
        events: &'a [Event],
        run: impl FnOnce(&SpanCtx<'a, '_>) -> T,
    ) -> T {
        let resource = DirectAttrs::build(self.resource_raw);
        let scope_attrs = DirectAttrs::build(self.scope_raw);
        let span_attrs = DirectAttrs::build(attributes);
        let ctx = SpanCtx {
            registry: self.registry,
            scope_name: self.scope_name,
            scope_version: self.scope_version,
            scope_schema_url: self.scope_schema_url,
            span_name,
            resource: Attrs::Direct(&resource),
            scope_attrs: Attrs::Direct(&scope_attrs),
            span_attrs: Attrs::Direct(&span_attrs),
            events,
        };
        run(&ctx)
    }

    /// Test-only reference resolver: evaluates **every** vendor's `detect`
    /// directly over the raw attribute lists. Used to prove the fast path
    /// agrees.
    pub(crate) fn classify_span_unindexed(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
        events: &'a [Event],
    ) -> Option<VendorId> {
        self.with_direct_ctx(span_name, attributes, events, |ctx| {
            for def in VENDORS {
                if (def.detect)(ctx) {
                    return Some(def.id);
                }
            }
            for rule in UNKNOWN_TIER {
                if (rule.detect)(ctx) {
                    return Some(rule.bucket);
                }
            }
            None
        })
    }

    /// Test-only reference session evaluation, over the raw attribute lists.
    pub(crate) fn evaluate_session_for_vendor_unindexed(
        &self,
        vendor: VendorId,
        span_name: &'a str,
        attributes: &'a [KeyValue],
        events: &'a [Event],
    ) -> u8 {
        self.with_direct_ctx(span_name, attributes, events, |ctx| {
            let entry = self.registry.vendor(vendor);
            if entry.candidates().is_empty() {
                return session_state::NO_RULES;
            }
            entry
                .candidates()
                .iter()
                .map(|candidate| candidate_state(entry, candidate, ctx).0)
                .max()
                .unwrap_or(0)
        })
    }

    /// Every vendor whose `detect` fires on this span, in resolution order —
    /// the at-most-one-vendor invariant's measurement.
    pub(crate) fn firing_vendors(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
        events: &'a [Event],
    ) -> Vec<&'static str> {
        self.with_direct_ctx(span_name, attributes, events, |ctx| {
            VENDORS
                .iter()
                .filter(|def| (def.detect)(ctx))
                .map(|def| def.id.slug())
                .collect()
        })
    }
}

#[cfg(test)]
#[path = "ai_classification_fixture_test.rs"]
mod fixture_test;

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue};

    pub(crate) fn kv(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue {
                value: Some(any_value::Value::StringValue(value.to_string())),
            }),
        }
    }

    fn int_kv(key: &str, value: i64) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue {
                value: Some(any_value::Value::IntValue(value)),
            }),
        }
    }

    fn scope(name: &str) -> InstrumentationScope {
        InstrumentationScope {
            name: name.to_string(),
            ..Default::default()
        }
    }

    /// Classify one span standalone. Returns the vendor slug (`""` for non-AI) and
    /// the session state.
    fn classify(
        resource: &[KeyValue],
        scope_name: &str,
        span_name: &str,
        attributes: &[KeyValue],
    ) -> (String, u8) {
        let registry = registry();
        let resource_context = ResourceContext::new(registry, resource);
        let scope = scope(scope_name);
        let scope_context = resource_context.scope(Some(&scope), "");
        let result = scope_context.classify_span(span_name, attributes);
        (
            result
                .vendor
                .map(|v| registry.vendor_slug(v).to_string())
                .unwrap_or_default(),
            result.session_state,
        )
    }

    // -- correctness invariants ---------------------------------------------

    /// "Spring's plain HTTP POST spans under org.springframework.boot → non-AI."
    /// The Boot scope is generic evidence: spring_ai's predicate gates it on the
    /// vendor's own attr evidence, so the scope alone contributes nothing.
    #[test]
    fn insufficient_scope_alone_is_not_ai() {
        let (vendor, state) = classify(
            &[kv("service.name", "spring-ai-trace-capture")],
            "org.springframework.boot",
            "POST",
            &[
                kv("method", "POST"),
                kv("uri", "/v1/chat/completions"),
                kv("status", "200"),
                kv("outcome", "SUCCESS"),
            ],
        );
        assert_eq!(vendor, "");
        assert_eq!(state, session_state::NOT_EXAMINED);
    }

    /// "…its spring_ai chat_client spans → spring_ai." The `spring.ai.*` attr hit
    /// is the same-vendor evidence that makes the Boot scope count.
    #[test]
    fn a_same_vendor_attr_hit_promotes_the_candidate() {
        let (vendor, _) = classify(
            &[kv("service.name", "spring-ai-trace-capture")],
            "org.springframework.boot",
            "chat_client",
            &[
                kv("spring.ai.kind", "chat_client"),
                kv("gen_ai.operation.name", "framework"),
            ],
        );
        assert_eq!(vendor, "spring_ai");
    }

    /// The negative direction of the promotion rule, stated on its own: an
    /// insufficient *resource* match plus another vendor's attr hit must not make
    /// the resource vendor win.
    #[test]
    fn an_insufficient_resource_candidate_does_not_swallow_another_instrumentor() {
        // litellm's resource evidence is `present(model_id)`, gated on its own
        // attr evidence inside its predicate.
        let (vendor, _) = classify(
            &[kv("service.name", "gateway"), kv("model_id", "gpt-4o-mini")],
            "openinference.instrumentation.openai",
            "ChatCompletion",
            &[kv("openinference.span.kind", "LLM")],
        );
        assert_eq!(vendor, "openinference-openai");
    }

    /// Mixed-vendor **process**: the corpus' crewai captures run the OpenInference
    /// OpenAI instrumentor alongside crewai's own, and the two must resolve per span
    /// (crewai_user is 12 crewai + 13 openinference-openai spans).
    #[test]
    fn mixed_vendor_process_yields_per_span_vendors() {
        let registry = registry();
        let resource = [kv("service.name", "crewai-trace-capture")];
        let resource_context = ResourceContext::new(registry, &resource);

        let crewai_scope = scope("openinference.instrumentation.crewai");
        let crewai = resource_context.scope(Some(&crewai_scope), "");
        let task_attributes = [kv("task_key", "research")];
        let task = crewai.classify_span("Task._execute_core", &task_attributes);
        assert_eq!(task.vendor_slug(), "crewai");

        let openai_scope = scope("openinference.instrumentation.openai");
        let openai = resource_context.scope(Some(&openai_scope), "");
        let llm_attributes = [kv("openinference.span.kind", "LLM")];
        let llm = openai.classify_span("ChatCompletion", &llm_attributes);
        assert_eq!(llm.vendor_slug(), "openinference-openai");
    }

    /// A **process-wide** resource fingerprint does apply to every span of the
    /// process — mastra's is standalone evidence in its predicate *by
    /// construction*: `@mastra/otel-exporter` mints its own resource per exported
    /// span inside Mastra's converter, so a co-loaded instrumentor's spans carry the
    /// NodeSDK resource instead and never reach this branch.
    #[test]
    fn a_sufficient_resource_matcher_applies_process_wide() {
        let registry = registry();
        let resource = [
            kv("service.name", "mastra-app"),
            kv("telemetry.sdk.name", "@mastra/otel-exporter"),
        ];
        let resource_context = ResourceContext::new(registry, &resource);
        let mastra_scope = scope("@mastra/otel-exporter");
        let mastra = resource_context.scope(Some(&mastra_scope), "");
        let attributes = [kv("mastra.span.type", "agent_run")];
        assert_eq!(
            mastra
                .classify_span("agent.generate", &attributes)
                .vendor_slug(),
            "mastra"
        );
    }

    /// Classify one span with attributes on all three levels.
    fn classify_layered(
        resource: &[KeyValue],
        scope_name: &str,
        scope_attributes: Vec<KeyValue>,
        span_name: &str,
        attributes: &[KeyValue],
    ) -> (String, u8) {
        let registry = registry();
        let resource_context = ResourceContext::new(registry, resource);
        let scope = InstrumentationScope {
            name: scope_name.to_string(),
            attributes: scope_attributes,
            ..Default::default()
        };
        let scope_context = resource_context.scope(Some(&scope), "");
        let result = scope_context.classify_span(span_name, attributes);
        (
            result
                .vendor
                .map(|v| registry.vendor_slug(v).to_string())
                .unwrap_or_default(),
            result.session_state,
        )
    }

    // -- list-directed lookup ------------------------------------------------

    /// A predicate reads exactly the attribute list its accessor names. Every case
    /// here carries a rule key somewhere its predicate does not look, and must
    /// classify non-AI.
    #[test]
    fn a_registry_key_outside_its_matchers_class_does_not_fire() {
        // mastra's resource fingerprint, carried as a span attribute.
        assert_eq!(
            classify_layered(
                &[kv("service.name", "app")],
                "com.example.app",
                vec![],
                "agent.generate",
                &[kv("telemetry.sdk.name", "@mastra/otel-exporter")],
            )
            .0,
            ""
        );
        // agno's span-attr `agno.` family, carried on the resource.
        assert_eq!(
            classify_layered(
                &[kv("service.name", "app"), kv("agno.run.id", "r-1")],
                "com.example.app",
                vec![],
                "op",
                &[kv("http.route", "/x")],
            )
            .0,
            ""
        );
        // spring_ai's span-attr `gen_ai.system` equality, carried on the scope.
        assert_eq!(
            classify_layered(
                &[],
                "com.example.app",
                vec![kv("gen_ai.system", "spring_ai")],
                "op",
                &[kv("http.route", "/x")],
            )
            .0,
            ""
        );
        // Unknown-tier fingerprints are span-local too, on either other list.
        assert_eq!(
            classify_layered(
                &[kv("gen_ai.operation.name", "chat")],
                "com.example.app",
                vec![],
                "op",
                &[kv("http.route", "/x")],
            )
            .0,
            ""
        );
        assert_eq!(
            classify_layered(
                &[],
                "com.example.app",
                vec![kv("openinference.span.kind", "LLM")],
                "op",
                &[kv("http.route", "/x")],
            )
            .0,
            ""
        );
    }

    /// The other direction: a resource-read predicate is decided by the resource
    /// alone, so a span attribute of the same name can no longer veto it.
    #[test]
    fn a_span_attribute_cannot_veto_a_resource_class_match() {
        let (vendor, _) = classify_layered(
            &[
                kv("service.name", "app"),
                kv("telemetry.sdk.name", "@mastra/otel-exporter"),
            ],
            "com.example.app",
            vec![],
            "agent.generate",
            &[kv("telemetry.sdk.name", "@opentelemetry/sdk-node")],
        );
        assert_eq!(vendor, "mastra");
    }

    /// llamaindex's scope-rewritten degradation shape: a span with ZERO attributes
    /// under a foreign scope whose only evidence is a `workflow.output` event
    /// carrying `tags.llamaindex.run_id`. The event-attribute candidate dispatch
    /// must carry it past the fast exit to the vendor predicate, and the session
    /// candidate must resolve state 5 from the event-borne value. No corpus capture
    /// exercises a rewritten scope, so this test is the only guard.
    #[test]
    fn an_event_only_span_classifies_and_session_keys_through_event_dispatch() {
        let registry = registry();
        let resource = [kv("service.name", "app")];
        let resource_context = ResourceContext::new(registry, &resource);
        let rewritten = scope("some.collector.rewritten.scope");
        let scope_context = resource_context.scope(Some(&rewritten), "");
        let events = [Event {
            name: "workflow.output".to_string(),
            attributes: vec![kv("tags.llamaindex.run_id", "TDQDONF2TE")],
            ..Default::default()
        }];
        let classified = scope_context.classify_span_full("FunctionAgent.run", &[], &events);
        assert_eq!(classified.vendor_slug(), "llamaindex");
        assert_eq!(classified.session_state, session_state::SUB_SESSION);
        assert_eq!(classified.session_key.as_deref(), Some("TDQDONF2TE"));

        // The span attribute wins over the event value when both are present.
        let attributes = [kv("llamaindex.run_id", "ATTRFIRST1")];
        let both = scope_context.classify_span_full("FunctionAgent.run", &attributes, &events);
        assert_eq!(both.session_key.as_deref(), Some("ATTRFIRST1"));
    }

    /// haystack's content-off population: a span with ZERO attributes under an
    /// app-chosen scope, carrying only a library-constant name. The span-name
    /// candidate dispatch must carry it past the fast exit to the vendor predicate.
    /// No corpus capture exercises this shape, so this test is the only guard.
    #[test]
    fn a_zero_attribute_span_classifies_through_span_name_dispatch() {
        let (vendor, state) = classify(
            &[kv("service.name", "app")],
            "trace-capture.haystack",
            "haystack.agent.step.llm",
            &[],
        );
        assert_eq!(vendor, "haystack");
        assert_eq!(state, session_state::NO_RULES);
    }

    /// Column accessors stay list-free: `span_name()`/`scope_name()` read the
    /// columns, never an attribute map entry. effect_ai's predicate keys on the
    /// span name and must keep firing — the one way a lookup regression could
    /// silently delete a vendor.
    #[test]
    fn pseudo_keys_resolve_for_every_matcher_class() {
        let (vendor, _) = classify(&[], "com.example.app", "LanguageModel.generateText", &[]);
        assert_eq!(vendor, "effect_ai");
        // …and the scope-name column still decides scope predicates with no
        // scope attributes present at all.
        let (scoped, _) = classify(&[], "gcp.vertex.agent", "invocation", &[]);
        assert_eq!(scoped, "google_adk");
    }

    /// Session candidates and their authority predicates are span-local: the key must
    /// be on the span, not inherited from the scope or the resource.
    #[test]
    fn session_candidates_read_only_the_spans_own_attributes() {
        // The key on the resource: authoritative, but the key is absent (state 3).
        let (vendor, resource_key) = classify_layered(
            &[kv("service.name", "app"), kv("session.id", "sess-res")],
            "com.anthropic.claude_code",
            vec![],
            "claude_code.interaction",
            &[kv("span.type", "interaction")],
        );
        assert_eq!(vendor, "claude_agent_sdk");
        assert_eq!(resource_key, session_state::KEY_ABSENT);

        // The key on the scope: same.
        let (_, scope_key) = classify_layered(
            &[],
            "com.anthropic.claude_code",
            vec![kv("session.id", "sess-scope")],
            "claude_code.interaction",
            &[kv("span.type", "interaction")],
        );
        assert_eq!(scope_key, session_state::KEY_ABSENT);

        // The *authority* predicate's key on the resource: the span is not
        // authoritative, even though its own session key resolves.
        let (_, authority) = classify_layered(
            &[kv("span.type", "interaction")],
            "com.anthropic.claude_code",
            vec![],
            "claude_code.interaction",
            &[kv("session.id", "sess-auth")],
        );
        assert_eq!(authority, session_state::NOT_AUTHORITATIVE);

        // All three on the span: resolved.
        let (_, span_local) = classify(
            &[],
            "com.anthropic.claude_code",
            "claude_code.interaction",
            &[kv("span.type", "interaction"), kv("session.id", "sess-1")],
        );
        assert_eq!(span_local, session_state::SESSION);
    }

    /// The hazard list-directed lookup exists to close: `langsmith.internal_provider`
    /// is a resource key that also lies inside langchain's span-attribute
    /// `langsmith.` prefix family. Under a cross-list fallback one resource
    /// attribute would classify every span in the process as langchain, plain HTTP
    /// included and whatever the value.
    #[test]
    fn an_insufficient_resource_key_does_not_promote_itself_through_its_vendors_prefix_family() {
        for value in ["false", "true"] {
            let (vendor, state) = classify_layered(
                &[
                    kv("service.name", "lc"),
                    kv("langsmith.internal_provider", value),
                ],
                "@opentelemetry/instrumentation-http",
                vec![],
                "POST /v1/chat",
                &[
                    kv("http.request.method", "POST"),
                    kv("url.path", "/v1/chat"),
                ],
            );
            assert_eq!(vendor, "", "resource langsmith.internal_provider={value}");
            assert_eq!(state, session_state::NOT_EXAMINED);
        }

        // Promotion still works through the proper channel: a genuine span-level
        // `langsmith.*` attribute is langchain's own evidence.
        let (promoted, _) = classify_layered(
            &[
                kv("service.name", "lc"),
                kv("langsmith.internal_provider", "true"),
            ],
            "@opentelemetry/instrumentation-http",
            vec![],
            "chain",
            &[kv("langsmith.trace.name", "agent")],
        );
        assert_eq!(promoted, "langchain");
    }

    #[test]
    fn duplicate_attribute_keys_take_the_first_occurrence() {
        // `gen_ai.system` is claimed by several vendors with different values; the
        // first occurrence must decide, and the second must be invisible.
        let (first, _) = classify(
            &[],
            "app.tracer",
            "chat",
            &[
                kv("gen_ai.system", "spring_ai"),
                kv("gen_ai.system", "strands-agents"),
            ],
        );
        let (second, _) = classify(
            &[],
            "app.tracer",
            "chat",
            &[
                kv("gen_ai.system", "strands-agents"),
                kv("gen_ai.system", "spring_ai"),
            ],
        );
        assert_eq!(first, "spring_ai");
        assert_eq!(second, "strands");
    }

    #[test]
    fn unknown_tier_buckets_unmatched_fingerprints() {
        for (attributes, expected) in [
            (vec![kv("gen_ai.operation.name", "chat")], "unknown:genai"),
            (
                vec![kv("openinference.span.kind", "LLM")],
                "unknown:openinference",
            ),
            (vec![kv("llm.model_name", "gpt-4o")], "unknown:other"),
            (vec![kv("traceloop.workflow.name", "w")], "unknown:other"),
        ] {
            let (vendor, state) = classify(&[], "com.example.app", "call", &attributes);
            assert_eq!(vendor, expected, "for {attributes:?}");
            assert_eq!(state, session_state::NO_RULES);
        }
    }

    /// `input.value`/`output.value` are gated on co-occurrence with an
    /// OpenInference attribute (see [`crate::ai_vendors::UNKNOWN_TIER`]): both keys
    /// are unnamespaced English, so a span carrying only them is not AI.
    #[test]
    fn generic_input_output_values_do_not_fire_on_their_own() {
        let (standalone, _) = classify(
            &[],
            "com.example.app",
            "handler",
            &[kv("input.value", "{}"), kv("output.value", "{}")],
        );
        assert_eq!(standalone, "");

        let (co_occurring, _) = classify(
            &[],
            "com.example.app",
            "handler",
            &[
                kv("input.value", "{}"),
                kv("openinference.span.kind", "CHAIN"),
            ],
        );
        assert_eq!(co_occurring, "unknown:openinference");
    }

    /// With the *other* OpenInference spelling as co-evidence — the `llm.*`
    /// namespace its semconv defines — an `input.value`/`output.value` span is
    /// OpenInference dialect and must land in `unknown:openinference`, not the
    /// `unknown:other` catch-all the bare `llm.` rule would give it. Ordering inside
    /// the tier is what buys this, so this test is also the guard on that ordering.
    #[test]
    fn input_output_values_with_llm_namespace_bucket_as_openinference() {
        let (with_llm, state) = classify(
            &[],
            "com.example.app",
            "handler",
            &[
                kv("output.value", "{\"text\":\"hi\"}"),
                kv("llm.model_name", "gpt-4o"),
            ],
        );
        assert_eq!(with_llm, "unknown:openinference");
        assert_eq!(state, session_state::NO_RULES);

        // Without the generic-value key the same `llm.*` span stays `unknown:other`:
        // the new rule must not swallow the bare namespace fingerprint.
        let (llm_alone, _) = classify(
            &[],
            "com.example.app",
            "handler",
            &[kv("llm.model_name", "gpt-4o")],
        );
        assert_eq!(llm_alone, "unknown:other");
    }

    /// `unknown:other` reachability: because vercel_ai_sdk's `ai.` prefix evidence
    /// is scope-gated, an `ai.*`-carrying span under a scope no vendor claims has to
    /// reach the bucket — on the wire, eve_slack's `ai.eve.turn` trace roots.
    #[test]
    fn an_unclaimed_ai_prefixed_span_reaches_unknown_other() {
        let (vendor, state) = classify(
            &[],
            "eve",
            "ai.eve.turn",
            &[kv("ai.telemetry.functionId", "eve.turn")],
        );
        assert_eq!(vendor, "unknown:other");
        assert_eq!(state, session_state::NO_RULES);

        // The same attribute under one of the AI SDK's own tracer scopes is the
        // vendor's, not the bucket's — the conjunction, not the bucket, is the gate.
        let (claimed, _) = classify(
            &[],
            "ai",
            "ai.generateText",
            &[kv("ai.telemetry.functionId", "eve.turn")],
        );
        assert_eq!(claimed, "vercel_ai_sdk");
    }

    /// pydantic_ai's scope-loss fallback is a 3-way logfire conjunction. The
    /// 2-conjunct form (`logfire.json_schema` && `gen_ai.operation.name`) must NOT
    /// fire on its own: `logfire.*` is the Logfire SDK's cross-vendor dialect, so a
    /// future Logfire first-party instrumentation adopting gen_ai semconv would
    /// otherwise be claimed for pydantic.
    #[test]
    fn pydantic_ai_logfire_fallback_requires_pydantic_unique_co_evidence() {
        // Scope rewritten, full conjunction → pydantic_ai.
        let (vendor, _) = classify(
            &[],
            "com.example.app",
            "chat openai/gpt-4o-mini",
            &[
                kv("logfire.json_schema", "{\"type\":\"object\"}"),
                kv("gen_ai.operation.name", "chat"),
                kv("operation.cost", "0.00013"),
            ],
        );
        assert_eq!(vendor, "pydantic_ai");

        // The 2-conjunct form alone degrades to the unknown tier instead.
        let (two_conjunct, _) = classify(
            &[],
            "com.example.app",
            "chat",
            &[
                kv("logfire.json_schema", "{\"type\":\"object\"}"),
                kv("gen_ai.operation.name", "chat"),
            ],
        );
        assert_eq!(two_conjunct, "unknown:genai");
    }

    #[test]
    fn a_vendor_hit_always_outranks_the_unknown_tier() {
        // vercel's `ai.` attr family overlaps the `ai.*` unknown fingerprint.
        let (vendor, _) = classify(
            &[],
            "ai",
            "ai.generateText",
            &[kv("ai.operationId", "ai.generateText")],
        );
        assert_eq!(vendor, "vercel_ai_sdk");
    }

    // -- session-key states --------------------------------------------------

    /// google_adk's two candidate populations are disjoint; `max` unions them
    /// instead of letting the absent one cancel the present one.
    #[test]
    fn disjoint_candidate_populations_union_via_max() {
        // Candidate 1 (gen_ai.conversation.id) is authoritative only on
        // invoke_agent/generate_content spans; candidate 2
        // (gcp.vertex.agent.session_id) only where gen_ai.system says so. This span
        // satisfies only the second: candidate 1 scores 2, candidate 2 scores 6, and
        // `max` unions them instead of letting the unauthoritative one cancel.
        let (vendor, state) = classify(
            &[],
            "gcp.vertex.agent",
            "invocation",
            &[
                kv("gen_ai.system", "gcp.vertex.agent"),
                kv("gcp.vertex.agent.session_id", "s-1"),
            ],
        );
        assert_eq!(vendor, "google_adk");
        assert_eq!(state, session_state::SESSION);

        // The mirror image: only candidate 1 is authoritative here.
        let (_, other_population) = classify(
            &[],
            "gcp.vertex.agent",
            "invoke_agent weather",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv("gen_ai.conversation.id", "c-9"),
            ],
        );
        assert_eq!(other_population, session_state::SESSION);
    }

    /// flue: a non-authoritative span still resolves at instance granularity
    /// (state 5) rather than being reported unauthoritative.
    #[test]
    fn a_non_authoritative_span_still_resolves_at_instance_granularity() {
        let (vendor, state) = classify(
            &[],
            "@flue/opentelemetry",
            "flue.tool",
            &[
                kv("flue.operation.kind", "tool"),
                kv("flue.instance.id", "inst-7"),
            ],
        );
        assert_eq!(vendor, "flue");
        assert_eq!(state, session_state::SUB_SESSION);

        let (_, authoritative) = classify(
            &[],
            "@flue/opentelemetry",
            "flue.prompt",
            &[
                kv("flue.operation.kind", "prompt"),
                kv("gen_ai.conversation.id", "conv-3"),
                kv("flue.instance.id", "inst-7"),
            ],
        );
        assert_eq!(authoritative, session_state::SESSION);
    }

    /// pydantic_ai's `gen_ai.conversation.id` is always present and often per-run.
    ///
    /// The key is labelled `session` granularity because a correctly-configured
    /// deployment (`conversation_id=` passed, or `message_history` threaded)
    /// produces a genuine cross-run session, and labelling it `run` outright would
    /// drive those deployments to state 5 and leave every trace unsessioned.
    #[test]
    fn pydantic_ai_conversation_id_resolves_at_session_granularity() {
        let (vendor, state) = classify(
            &[],
            "pydantic-ai",
            "agent run",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv("gen_ai.conversation.id", "run-1"),
                kv("pydantic_ai.all_messages", "[]"),
            ],
        );
        assert_eq!(vendor, "pydantic_ai");
        assert_eq!(state, session_state::SESSION);

        // Its run-granularity sibling on its own tops out at 5.
        let (_, run_only) = classify(
            &[],
            "pydantic-ai",
            "agent run",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv("gen_ai.agent.call.id", "call-1"),
            ],
        );
        assert_eq!(run_only, session_state::SUB_SESSION);
    }

    /// A strict-UUIDv7-shaped `gen_ai.conversation.id` is pydantic's own
    /// auto-minted per-run default (`str(uuid7())`) wearing a session key, so it
    /// resolves at run granularity (state 5). The hash still comes from the
    /// conversation id — the demoted candidate ties with the run-id candidate at 5
    /// and candidate order keeps the earlier one — so joins are unaffected.
    #[test]
    fn pydantic_ai_uuidv7_conversation_id_demotes_to_run_granularity() {
        let uuid7 = "01890a5d-ac96-774b-bcce-b302099a8057";
        let attrs = [
            kv("gen_ai.operation.name", "invoke_agent"),
            kv("gen_ai.conversation.id", uuid7),
            kv("gen_ai.agent.call.id", "call-1"),
        ];
        let registry = registry();
        let resource_context = ResourceContext::new(registry, &[]);
        let scope = scope("pydantic-ai");
        let scope_context = resource_context.scope(Some(&scope), "");
        let result = scope_context.classify_span("agent run", &attrs);
        assert_eq!(result.vendor_slug(), "pydantic_ai");
        assert_eq!(result.session_state, session_state::SUB_SESSION);
        assert_eq!(result.session_key.as_deref(), Some(uuid7));

        // Case-insensitivity: uppercase hex is still the same UUID.
        let (_, upper) = classify(
            &[],
            "pydantic-ai",
            "agent run",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv("gen_ai.conversation.id", "01890A5D-AC96-774B-BCCE-B302099A8057"),
            ],
        );
        assert_eq!(upper, session_state::SUB_SESSION);

        // Strictness: a UUIDv4 (version nibble 4) is customer-chosen shape, not
        // pydantic's uuid7 default — stays session. So does a value that merely
        // CONTAINS a UUID7.
        let (_, uuid4) = classify(
            &[],
            "pydantic-ai",
            "agent run",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv("gen_ai.conversation.id", "01890a5d-ac96-474b-bcce-b302099a8057"),
            ],
        );
        assert_eq!(uuid4, session_state::SESSION);
        let (_, embedded) = classify(
            &[],
            "pydantic-ai",
            "agent run",
            &[
                kv("gen_ai.operation.name", "invoke_agent"),
                kv(
                    "gen_ai.conversation.id",
                    "conv-01890a5d-ac96-774b-bcce-b302099a8057",
                ),
            ],
        );
        assert_eq!(embedded, session_state::SESSION);
    }

    #[test]
    fn present_but_empty_is_not_absent() {
        // claude_agent_sdk validates `session.id` as non-empty.
        // Its candidates are authoritative wherever `span.type` is present.
        let (_, empty) = classify(
            &[],
            "com.anthropic.claude_code",
            "claude_code.interaction",
            &[kv("span.type", "interaction"), kv("session.id", "")],
        );
        assert_eq!(empty, session_state::KEY_INVALID);

        let (_, absent) = classify(
            &[],
            "com.anthropic.claude_code",
            "claude_code.interaction",
            &[kv("span.type", "interaction")],
        );
        assert_eq!(absent, session_state::KEY_ABSENT);

        let (_, present) = classify(
            &[],
            "com.anthropic.claude_code",
            "claude_code.interaction",
            &[kv("span.type", "interaction"), kv("session.id", "abc")],
        );
        assert_eq!(present, session_state::SESSION);
    }

    #[test]
    fn decoy_values_fail_validation() {
        // litellm's candidate rejects the decoy value; effect_ai's `undefined`
        // decoy is the wire-observed one.
        let registry = registry();
        let litellm = registry.vendor_id("litellm").expect("vendor");
        assert!(!registry.vendor(litellm).candidates().is_empty());
        let candidate = &registry.vendor(litellm).candidates()[0];
        assert!(candidate.reject_decoy_values || candidate.require_non_empty);
    }

    #[test]
    fn non_ai_spans_still_carry_the_rules_version() {
        let registry = registry();
        let resource_context = ResourceContext::new(registry, &[]);
        let scope = scope("io.opentelemetry.http");
        let context = resource_context.scope(Some(&scope), "");
        let attributes = [kv("http.request.method", "GET")];
        let result = context.classify_span("GET /health", &attributes);
        assert_eq!(result.vendor, None);
        assert_eq!(result.vendor_slug(), "");
        assert_ne!(result.rules_version, 0);
        assert_eq!(result.session_key_hash(), 0);
    }

    #[test]
    fn resolved_keys_hash_the_bare_value() {
        let registry = registry();
        let resource_context = ResourceContext::new(registry, &[]);
        let scope = scope("com.anthropic.claude_code");
        let context = resource_context.scope(Some(&scope), "");
        let attributes = [kv("span.type", "interaction"), kv("session.id", "sess-42")];
        let result = context.classify_span("claude_code.interaction", &attributes);
        assert_eq!(result.session_state, session_state::SESSION);
        // Exactly what `SELECT cityHash64('sess-42')` returns — single argument,
        // no salt, no concat construction.
        assert_eq!(
            result.session_key_hash(),
            crate::cityhash102::city_hash64(b"sess-42")
        );
    }

    // -- canonicalization and degradation ------------------------------------

    #[test]
    fn values_are_canonicalized_before_matching() {
        // A bool/int arrives typed on protobuf and as a string over JSON; both must
        // match langchain's `resource(langsmith.internal_provider) == "true"`.
        let registry = registry();
        for value in [
            KeyValue {
                key: "langsmith.internal_provider".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::BoolValue(true)),
                }),
            },
            kv("langsmith.internal_provider", "true"),
        ] {
            let resource = [value];
            let resource_context = ResourceContext::new(registry, &resource);
            let scope = scope("app");
            let context = resource_context.scope(Some(&scope), "");
            let attributes = [kv("langsmith.trace.name", "x")];
            let result = context.classify_span("chain", &attributes);
            assert_eq!(result.vendor_slug(), "langchain");
        }
    }

    /// The same logical span delivered as OTLP protobuf and as OTLP/JSON must
    /// classify identically. JSON carries int64s as decimal strings and the
    /// span/trace ids as hex, and the crate's leniency pass normalizes both — the
    /// classifier must not be able to tell which transport it came from.
    #[test]
    fn transports_agree() {
        use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
        use opentelemetry_proto::tonic::resource::v1::Resource;
        use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};

        let protobuf = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![kv("service.name", "adk-app")],
                    ..Default::default()
                }),
                scope_spans: vec![ScopeSpans {
                    scope: Some(scope("gcp.vertex.agent")),
                    spans: vec![Span {
                        name: "invocation".to_string(),
                        start_time_unix_nano: 1_700_000_000_000_000_000,
                        end_time_unix_nano: 1_700_000_000_500_000_000,
                        attributes: vec![
                            kv("gen_ai.system", "gcp.vertex.agent"),
                            kv("gcp.vertex.agent.session_id", "s-1"),
                            int_kv("gen_ai.usage.input_tokens", 4_294_967_296),
                        ],
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };

        // The OTLP/JSON form of exactly that span, as an exporter would send it.
        let json = r#"{"resourceSpans":[{"resource":{"attributes":[
            {"key":"service.name","value":{"stringValue":"adk-app"}}]},
          "scopeSpans":[{"scope":{"name":"gcp.vertex.agent"},"spans":[{
            "name":"invocation",
            "traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174",
            "startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000500000000",
            "attributes":[
              {"key":"gen_ai.system","value":{"stringValue":"gcp.vertex.agent"}},
              {"key":"gcp.vertex.agent.session_id","value":{"stringValue":"s-1"}},
              {"key":"gen_ai.usage.input_tokens","value":{"intValue":"4294967296"}}]}]}]}]}"#;
        let mut value: serde_json::Value = serde_json::from_str(json).expect("json");
        crate::otlp_json::normalize(&mut value, "resourceSpans");
        let decoded: ExportTraceServiceRequest =
            serde_json::from_value(value).expect("OTLP/JSON decodes");

        let classify_request = |request: &ExportTraceServiceRequest| {
            let registry = registry();
            let resource_spans = &request.resource_spans[0];
            let attributes = &resource_spans
                .resource
                .as_ref()
                .expect("resource")
                .attributes;
            let context = ResourceContext::new(registry, attributes);
            let scope_spans = &resource_spans.scope_spans[0];
            let scope = context.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
            let span = &scope_spans.spans[0];
            let classified = scope.classify_span(&span.name, &span.attributes);
            (
                classified.vendor_slug(),
                classified.session_state,
                classified.session_key_hash(),
            )
        };

        let from_protobuf = classify_request(&protobuf);
        assert_eq!(from_protobuf, classify_request(&decoded));
        assert_eq!(from_protobuf.0, "google_adk");
        assert_eq!(from_protobuf.1, session_state::SESSION);
        assert_ne!(from_protobuf.2, 0);
    }

    #[test]
    fn garbage_attributes_do_not_panic() {
        let huge = "x".repeat(1 << 20);
        let attributes = vec![
            kv("", ""),
            kv("\u{0}\u{1}\u{2}", "\u{0}"),
            kv("🌍.emoji.key", "🙂"),
            kv("gen_ai.operation.name", &huge),
            kv(&huge, "v"),
            int_kv("llm.token_count.total", i64::MIN),
            KeyValue {
                key: "spring.ai.kind".into(),
                value: None,
            },
            KeyValue {
                key: "session.id".into(),
                value: Some(AnyValue { value: None }),
            },
        ];
        let (vendor, _) = classify(&[], "org.springframework.boot", &huge, &attributes);
        assert_eq!(vendor, "spring_ai");
    }

    #[test]
    fn attribute_order_does_not_change_the_outcome() {
        let noise: Vec<KeyValue> = (0..40)
            .map(|i| kv(&format!("http.header.x_{i}"), "v"))
            .collect();
        let signal = vec![
            kv("spring.ai.kind", "chat_client"),
            kv("gen_ai.operation.name", "framework"),
        ];
        let mut forward = signal.clone();
        forward.extend(noise.iter().cloned());
        let mut backward = noise;
        backward.reverse();
        backward.extend(signal);

        let a = classify(&[], "org.springframework.boot", "chat_client", &forward);
        let b = classify(&[], "org.springframework.boot", "chat_client", &backward);
        assert_eq!(a, b);
        assert_eq!(a.0, "spring_ai");
    }

    /// The prefilter/candidate fast path must agree with direct evaluation of every
    /// vendor over the raw attribute lists — the optimization's safety net, and the
    /// declared-hint drift detector.
    #[test]
    fn the_indexed_path_agrees_with_direct_evaluation() {
        let registry = registry();
        let cases: Vec<(Vec<KeyValue>, &str, &str, Vec<KeyValue>)> = vec![
            (
                vec![],
                "org.springframework.boot",
                "POST",
                vec![kv("method", "POST")],
            ),
            (
                vec![kv("telemetry.sdk.name", "@mastra/otel-exporter")],
                "@mastra/otel-exporter",
                "agent.run",
                vec![kv("mastra.agent.id", "a")],
            ),
            (
                vec![kv("model_id", "x")],
                "litellm",
                "litellm_request",
                vec![kv("litellm.call_id", "c")],
            ),
            (
                vec![],
                "app",
                "LanguageModel.generateText",
                vec![kv("gen_ai.system", "x")],
            ),
            (
                vec![],
                "gen_ai",
                "step",
                vec![kv("gen_ai.execute_tool.duration", "1")],
            ),
            (
                vec![],
                "app",
                "x",
                vec![kv("openinference.span.kind", "LLM")],
            ),
        ];
        for (resource, scope_name, span_name, attributes) in cases {
            let resource_context = ResourceContext::new(registry, &resource);
            let scope_value = scope(scope_name);
            let context = resource_context.scope(Some(&scope_value), "");
            let indexed = context.classify_span(span_name, &attributes);
            let direct = context.classify_span_unindexed(span_name, &attributes, &[]);
            assert_eq!(
                indexed.vendor, direct,
                "indexed vs direct for {scope_name}/{span_name}"
            );
        }
    }
}
