//! Per-span AI classification: vendor, session-key state, session-key hash.
//!
//! Pure functions over decoded OTLP. No I/O, no clock, no cross-span state — the
//! write-side plan's first design constraint is that a span's classification depends
//! on nothing but that span, its scope and its resource, because root spans arrive
//! last in 18/19 multi-batch corpus traces.
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
//! resolve every matcher as far as resource/scope evidence allows, leaving a
//! per-span pass that touches the span's own attributes once.
//!
//! # Evaluation semantics
//!
//! These are the semantics `packages/domain/src/ai-registry/compile-sql.ts` compiles
//! to SQL, and the two are held to it by the differential suites in that directory:
//!
//! * **Canonical stringification** happens before matching, via the row writer's
//!   `any_value_string`.
//! * **Duplicate attribute keys: first occurrence wins**, and only among
//!   registry-referenced keys. The prefilter is what identifies them; keys no rule
//!   consults are never hashed, which is what keeps the budget.
//! * **Lookup is class-directed** (plan §1: matcher classes are per-class
//!   predicates). A matcher's declared class picks the one attribute list its keys
//!   may read — `resource` → the resource attributes, `scope` → the scope
//!   attributes, `attr` → the span's own — and `key_prefix` scans the keys of that
//!   one list. Predicates with no class (unknown-tier fingerprints, session
//!   candidates, authority predicates) are span-local. The four pseudo-keys are
//!   exempt: `scope.name` / `scope.version` / `scope.schema_url` / `span.name` are
//!   columns, not map entries, so they resolve to their column whatever the class
//!   says — `effect_ai`'s attr matchers key on `span.name` and must keep firing.
//!
//!   trace-capture's `scripts/verify-seed.ts` instead falls back
//!   span → scope → resource for every key regardless of class, and unions all three
//!   attribute lists as `key_prefix` evidence. That reference evaluator is now the
//!   outlier and stays that way, in its own repo: it verifies one seed at a time,
//!   where cross-class reads cannot promote another vendor. Here they can, and did
//!   — `langsmith.internal_provider` is langchain's *insufficient* resource key and
//!   also inside langchain's attr-class `key_prefix("langsmith.")`, so under the
//!   fallback a process that set it on its resource had every span, plain HTTP
//!   included, classified `langchain` with the value ignored. That defeats the
//!   sufficiency gate outright. The corpus goldens are insensitive to the
//!   difference: all 10,091 corpus spans classify identically either way.
//! * **Resolution** (plan §1): sufficient resource/scope hits and attr hits are
//!   unconditional; insufficient resource/scope hits are conditional candidates,
//!   promoted only by a same-vendor attr hit on the same span. The winner is the
//!   highest priority among unconditional hits and promoted candidates. Unknown-tier
//!   fingerprints sit in the same table one priority band lower (D4), so "no vendor
//!   hit → unknown tier → non-AI" falls out of the ordering rather than a second pass.
//! * **Session key** (plan §2 step 5): every candidate of the winning vendor is
//!   evaluated; the span's state is the `max` over candidates, and the hash comes
//!   from the candidate that produced the winning state, ties broken by candidate
//!   order.
//!
//! # What this module does not do
//!
//! Nothing here is wired into the ingest request path yet — no `encode_traces`
//! change, no row columns. That is a later stage.

use std::borrow::Cow;

use opentelemetry_proto::tonic::common::v1::{InstrumentationScope, KeyValue};

use crate::ai_registry::{
    canonical_value, registry, AttrTarget, Authority, HitKind, KeyId, LookupKey, Matcher,
    Predicate, PseudoKey, Registry, SessionCandidate, VendorId,
};
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
    /// digests came out of `SpanAttributes` and stays there in the clear on the same
    /// row, so anything that can read `AiSessionKeyHash` can read the source value
    /// beside it. What hashing buys is physical — 8 fixed bytes on a per-span column,
    /// and a numeric input to `uniqCombined` in `service_ai_vendors_hourly`.
    ///
    /// 64 bits is matched to that consumer. At ~1M distinct sessions in an org the
    /// birthday collision probability is ~1e-8, six orders of magnitude under the
    /// ~1.6% standard error of the `uniqCombined(12)` sketch that consumes it.
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
// hoisted contexts
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
/// array. The slot array was O(1) to read but cost a 116-slot zeroing
/// allocation on every span that carried a single registry key — one malloc and
/// ~3.7 KiB of memset for typically three useful entries. Lookups are a linear
/// scan over `len` instead, which for a handful of entries is a cache line, not
/// a branch-predictor problem.
struct AttrView<'a> {
    inline: [Option<(KeyId, Cow<'a, str>)>; INLINE_ATTRS],
    inline_len: usize,
    /// Only allocated by spans carrying more than `INLINE_ATTRS` registry keys.
    spill: Vec<(KeyId, Cow<'a, str>)>,
    /// Which `KeyId`s this view holds. Scope hoisting asks ~one question per
    /// matcher and almost every answer is "absent", so the miss has to cost a
    /// bit test rather than a walk of the entry list.
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
                // First occurrence wins (plan §2), among registry keys only.
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

/// Resolved once per `ResourceSpans`.
pub struct ResourceContext<'a> {
    registry: &'static Registry,
    attrs: AttrView<'a>,
}

impl<'a> ResourceContext<'a> {
    pub fn new(registry: &'static Registry, attributes: &'a [KeyValue]) -> Self {
        Self {
            registry,
            attrs: AttrView::build(registry, attributes),
        }
    }

    /// Resolved once per `ScopeSpans`. `schema_url` is the `ScopeSpans.schema_url`
    /// (falling back to the scope's own, as the reference evaluator does).
    pub fn scope<'r>(
        &'r self,
        scope: Option<&'a InstrumentationScope>,
        schema_url: &'a str,
    ) -> ScopeContext<'a, 'r> {
        let scope_attrs = match scope {
            Some(scope) => AttrView::build(self.registry, &scope.attributes),
            None => AttrView::default(),
        };
        let mut context = ScopeContext {
            registry: self.registry,
            resource: &self.attrs,
            scope_attrs,
            scope_name: scope.map(|s| s.name.as_str()).unwrap_or(""),
            scope_version: scope.map(|s| s.version.as_str()).unwrap_or(""),
            scope_schema_url: schema_url,
            hoisted: Hoisted::default(),
        };
        context.hoist();
        context
    }
}

/// What resource+scope evidence alone already decides, shared by every span in the
/// scope. Recomputing this per span is the cost the plan's hoisting exists to avoid.
///
/// Class-directed lookup makes this a *complete* verdict for every matcher it covers:
/// no span attribute can shadow a resource `eq` hit any more, because a resource-class
/// matcher never reads span attributes.
#[derive(Default)]
struct Hoisted {
    best: Option<(u32, VendorId)>,
    attr_bits: u64,
    conditional_bits: u32,
}

pub struct ScopeContext<'a, 'r> {
    registry: &'static Registry,
    resource: &'r AttrView<'a>,
    scope_attrs: AttrView<'a>,
    scope_name: &'a str,
    scope_version: &'a str,
    scope_schema_url: &'a str,
    hoisted: Hoisted,
}

impl<'a, 'r> ScopeContext<'a, 'r> {
    /// The attribute list a matcher of this class reads. `Span` is never asked of a
    /// scope: a span-class matcher reaches the hoist path only via a pseudo-key.
    fn class_attrs(&self, target: AttrTarget) -> Option<&AttrView<'a>> {
        match target {
            AttrTarget::Resource => Some(self.resource),
            AttrTarget::Scope => Some(&self.scope_attrs),
            AttrTarget::Span => None,
        }
    }

    fn pseudo(&self, key: PseudoKey) -> Option<&'a str> {
        match key {
            PseudoKey::ScopeName => Some(self.scope_name),
            PseudoKey::ScopeVersion => Some(self.scope_version),
            PseudoKey::ScopeSchemaUrl => Some(self.scope_schema_url),
            // Only a span knows its name; resolved per span.
            PseudoKey::SpanName => None,
        }
    }

    /// Evaluate a matcher the scope fully decides — `registry.hoisted_matchers()`, i.e.
    /// every `scope`/`resource`-class matcher plus anything keyed on a `scope.*`
    /// pseudo-key. Nothing here can read a span attribute, so the verdict is final.
    fn matches_hoisted(&self, matcher: &Matcher) -> bool {
        let attrs = self.class_attrs(matcher.target);
        match &matcher.predicate {
            Predicate::Present(LookupKey::Attr(key)) => {
                attrs.is_some_and(|attrs| attrs.holds(*key))
            }
            // Pseudo-keys are columns, not map entries: always present, possibly empty.
            Predicate::Present(LookupKey::Pseudo(pseudo)) => *pseudo != PseudoKey::SpanName,
            Predicate::Eq(LookupKey::Attr(key), value) => {
                attrs.and_then(|attrs| attrs.get(*key)) == Some(&**value)
            }
            Predicate::Eq(LookupKey::Pseudo(pseudo), value) => {
                self.pseudo(*pseudo) == Some(&**value)
            }
            Predicate::KeyPrefix(prefix) => {
                attrs.is_some_and(|attrs| attrs.prefix_bits & (1u64 << prefix) != 0)
            }
            Predicate::ValuePrefix(pseudo, prefix) => self
                .pseudo(*pseudo)
                .is_some_and(|value| value.starts_with(&**prefix)),
        }
    }

    fn hoist(&mut self) {
        let mut hoisted = std::mem::take(&mut self.hoisted);
        for &id in self.registry.hoisted_matchers() {
            let matcher = &self.registry.matchers()[id as usize];
            if self.matches_hoisted(matcher) {
                record_hit(&mut hoisted, matcher);
            }
        }
        self.hoisted = hoisted;
    }

    /// Classify one span. `attributes` is the span's raw attribute list; duplicates
    /// and unordered keys are fine.
    pub fn classify_span(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
    ) -> SpanClassification<'a> {
        let facts = AttrView::build(self.registry, attributes);
        let view = SpanView {
            scope: self,
            span_name,
            facts: &facts,
        };

        let mut best = self.hoisted.best;
        let mut attr_bits = self.hoisted.attr_bits;
        let mut conditional_bits = self.hoisted.conditional_bits;
        let mut hit = |matcher: &Matcher| {
            match matcher.kind {
                HitKind::Unconditional => {
                    if best.is_none_or(|(priority, _)| matcher.priority > priority) {
                        best = Some((matcher.priority, matcher.vendor));
                    }
                    if matcher.promotes {
                        attr_bits |= 1u64 << matcher.vendor.index();
                    }
                }
                HitKind::Conditional => {
                    if let Some(slot) = matcher.conditional_slot {
                        conditional_bits |= 1u32 << slot;
                    }
                }
            };
        };

        // The span's own attributes: exact-key matchers, then the prefix families its
        // keys satisfy. Both tables hold only span-class matchers — a resource/scope
        // matcher's verdict was final at hoist time and cannot be reopened here.
        for (key, value) in facts.entries() {
            for &id in self.registry.key_matchers(key) {
                let matcher = &self.registry.matchers()[id as usize];
                let satisfied = match &matcher.predicate {
                    Predicate::Present(_) => true,
                    Predicate::Eq(_, expected) => value == &**expected,
                    _ => false,
                };
                if satisfied {
                    hit(matcher);
                }
            }
        }
        let mut prefixes = facts.prefix_bits;
        while prefixes != 0 {
            let prefix = prefixes.trailing_zeros() as u8;
            prefixes &= prefixes - 1;
            for &id in self.registry.prefix_matchers(prefix) {
                hit(&self.registry.matchers()[id as usize]);
            }
        }

        // Span-name matchers (`eq` via an index, the rare rest by evaluation).
        for &id in self.registry.span_name_matchers(span_name) {
            hit(&self.registry.matchers()[id as usize]);
        }
        for &id in self.registry.span_name_other() {
            let matcher = &self.registry.matchers()[id as usize];
            if view.eval(&matcher.predicate) {
                hit(matcher);
            }
        }

        // Promotion: an insufficient resource/scope candidate becomes a hit at its
        // own priority only if the same span produced an attr hit for its vendor.
        let mut bits = conditional_bits;
        while bits != 0 {
            let slot = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let matcher = &self.registry.matchers()[self.registry.conditional(slot) as usize];
            if attr_bits & (1u64 << matcher.vendor.index()) == 0 {
                continue;
            }
            if best.is_none_or(|(priority, _)| matcher.priority > priority) {
                best = Some((matcher.priority, matcher.vendor));
            }
        }

        let vendor = best.map(|(_, vendor)| vendor);
        let (session_state, session_key) = match vendor {
            Some(vendor) => self.evaluate_session(vendor, &view),
            None => (session_state::NOT_EXAMINED, None),
        };
        SpanClassification {
            vendor,
            session_state,
            session_key,
            rules_version: self.registry.version(),
        }
    }

    /// Session-key evaluation for a vendor: all candidates, reduced by `max`.
    ///
    /// Public because it is also the per-vendor state the corpus goldens are
    /// expressed in (they report the state of *every* span under one vendor's
    /// candidates, independent of which vendor classified it).
    pub fn evaluate_session_for_vendor(
        &self,
        vendor: VendorId,
        span_name: &'a str,
        attributes: &'a [KeyValue],
    ) -> (u8, Option<Cow<'a, str>>) {
        let facts = AttrView::build(self.registry, attributes);
        let view = SpanView {
            scope: self,
            span_name,
            facts: &facts,
        };
        self.evaluate_session(vendor, &view)
    }

    fn evaluate_session(
        &self,
        vendor: VendorId,
        view: &SpanView<'a, '_, 'r>,
    ) -> (u8, Option<Cow<'a, str>>) {
        let entry = self.registry.vendor(vendor);
        if entry.candidates().is_empty() {
            return (session_state::NO_RULES, None);
        }
        let mut best_state = 0u8;
        let mut best_key: Option<Cow<'a, str>> = None;
        for candidate in entry.candidates() {
            let (state, value) = self.candidate_state(entry, candidate, view);
            // Strictly greater: ties keep the earlier candidate's hash (plan §1).
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

    fn candidate_state(
        &self,
        vendor: &crate::ai_registry::Vendor,
        candidate: &SessionCandidate,
        view: &SpanView<'a, '_, 'r>,
    ) -> (u8, Option<Cow<'a, str>>) {
        let authoritative = match &candidate.authority {
            Authority::Always => true,
            Authority::One(predicate) => view.eval(predicate),
            Authority::AnyOf(predicates) => predicates.iter().any(|p| view.eval(p)),
        };
        if !authoritative {
            return (session_state::NOT_AUTHORITATIVE, None);
        }
        // Presence, not `!= ''`: present-but-empty must stay distinguishable from
        // absent (it is state 4, not state 3).
        let Some(value) = view.lookup_span_local(candidate.key) else {
            return (session_state::KEY_ABSENT, None);
        };
        if candidate.require_non_empty && value.is_empty() {
            return (session_state::KEY_INVALID, None);
        }
        if candidate.reject_decoy_values && vendor.is_decoy_value(&value) {
            return (session_state::KEY_INVALID, None);
        }
        (candidate.granularity.resolved_state(), Some(value))
    }
}

fn record_hit(hoisted: &mut Hoisted, matcher: &Matcher) {
    match matcher.kind {
        HitKind::Unconditional => {
            if hoisted
                .best
                .is_none_or(|(priority, _)| matcher.priority > priority)
            {
                hoisted.best = Some((matcher.priority, matcher.vendor));
            }
            if matcher.promotes {
                hoisted.attr_bits |= 1u64 << matcher.vendor.index();
            }
        }
        HitKind::Conditional => {
            if let Some(slot) = matcher.conditional_slot {
                hoisted.conditional_bits |= 1u32 << slot;
            }
        }
    }
}

/// A span plus the scope/resource it hangs off — the unit every predicate reads.
struct SpanView<'a, 'v, 'r> {
    scope: &'v ScopeContext<'a, 'r>,
    span_name: &'a str,
    facts: &'v AttrView<'a>,
}

impl<'a> SpanView<'a, '_, '_> {
    /// The attribute list a predicate of this class reads — one list, never a chain.
    fn attrs(&self, target: AttrTarget) -> &AttrView<'a> {
        match target {
            AttrTarget::Span => self.facts,
            AttrTarget::Scope => &self.scope.scope_attrs,
            AttrTarget::Resource => self.scope.resource,
        }
    }

    /// Pseudo-key → its column; every other key → `target`'s attribute list alone.
    fn lookup(&self, key: LookupKey, target: AttrTarget) -> Option<Cow<'a, str>> {
        match key {
            LookupKey::Pseudo(PseudoKey::SpanName) => Some(Cow::Borrowed(self.span_name)),
            LookupKey::Pseudo(PseudoKey::ScopeName) => Some(Cow::Borrowed(self.scope.scope_name)),
            LookupKey::Pseudo(PseudoKey::ScopeVersion) => {
                Some(Cow::Borrowed(self.scope.scope_version))
            }
            LookupKey::Pseudo(PseudoKey::ScopeSchemaUrl) => {
                Some(Cow::Borrowed(self.scope.scope_schema_url))
            }
            LookupKey::Attr(key) => self.attrs(target).get_cow(key),
        }
    }

    /// Span-local lookup: session-candidate keys and authority predicates carry no
    /// class and read the span's own attributes, as `compile-sql.ts` compiles them.
    fn lookup_span_local(&self, key: LookupKey) -> Option<Cow<'a, str>> {
        self.lookup(key, AttrTarget::Span)
    }

    /// Direct predicate evaluation against one class's evidence. Used for session
    /// candidates and authority predicates (span-local), and as the reference the
    /// indexed matcher path is checked against.
    fn eval_for(&self, predicate: &Predicate, target: AttrTarget) -> bool {
        match predicate {
            Predicate::Present(key) => self.lookup(*key, target).is_some(),
            Predicate::Eq(key, value) => self.lookup(*key, target).as_deref() == Some(&**value),
            Predicate::KeyPrefix(prefix) => self.attrs(target).prefix_bits & (1u64 << prefix) != 0,
            Predicate::ValuePrefix(pseudo, prefix) => self
                .lookup(LookupKey::Pseudo(*pseudo), target)
                .is_some_and(|value| value.starts_with(&**prefix)),
        }
    }

    fn eval(&self, predicate: &Predicate) -> bool {
        self.eval_for(predicate, AttrTarget::Span)
    }
}

#[cfg(test)]
impl<'a, 'r> ScopeContext<'a, 'r> {
    /// Test-only reference resolver: evaluates **every** matcher directly, with no
    /// hoisting and no dispatch index. Used to prove the fast path agrees.
    pub(crate) fn classify_span_unindexed(
        &self,
        span_name: &'a str,
        attributes: &'a [KeyValue],
    ) -> Option<VendorId> {
        let facts = AttrView::build(self.registry, attributes);
        let view = SpanView {
            scope: self,
            span_name,
            facts: &facts,
        };
        let mut best: Option<(u32, VendorId)> = None;
        let mut attr_bits = 0u64;
        let mut conditional = Vec::new();
        for matcher in self.registry.matchers() {
            if !view.eval_for(&matcher.predicate, matcher.target) {
                continue;
            }
            match matcher.kind {
                HitKind::Unconditional => {
                    if best.is_none_or(|(priority, _)| matcher.priority > priority) {
                        best = Some((matcher.priority, matcher.vendor));
                    }
                    if matcher.promotes {
                        attr_bits |= 1u64 << matcher.vendor.index();
                    }
                }
                HitKind::Conditional => conditional.push(matcher),
            }
        }
        for matcher in conditional {
            if attr_bits & (1u64 << matcher.vendor.index()) == 0 {
                continue;
            }
            if best.is_none_or(|(priority, _)| matcher.priority > priority) {
                best = Some((matcher.priority, matcher.vendor));
            }
        }
        best.map(|(_, vendor)| vendor)
    }
}

#[cfg(test)]
#[path = "ai_classifier_corpus_test.rs"]
mod corpus_test;

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

    // -- plan §2 correctness invariants -------------------------------------

    /// "Spring's plain HTTP POST spans under org.springframework.boot → non-AI."
    /// The scope matcher is insufficient, so it is a candidate nothing promotes.
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
    /// promotes the same-vendor candidate.
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
        // litellm's resource matcher is `present(model_id)`, insufficient.
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

    /// A **sufficient** resource matcher does apply process-wide — that is what
    /// sufficiency means, and mastra's is declared sufficient in the seed *by
    /// construction*: `@mastra/otel-exporter` mints its own resource per exported
    /// span inside Mastra's converter, so a co-loaded instrumentor's spans carry the
    /// NodeSDK resource instead and never reach this branch. Stated as a test
    /// because the write-side plan's §1 prose uses mastra as its example of an
    /// *insufficient* resource matcher; the wire-verified seed overrode that.
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

    // -- class-directed lookup ------------------------------------------------

    /// A matcher reads exactly the attribute list its class names. Every case here
    /// carries a registry key somewhere its matcher does not look, and must classify
    /// non-AI — the same verdict `compile-sql.ts` produces from the written row.
    #[test]
    fn a_registry_key_outside_its_matchers_class_does_not_fire() {
        // mastra's *sufficient* resource matcher, carried as a span attribute.
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
        // agno's attr-class `key_prefix(agno.)` family, carried on the resource.
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
        // spring_ai's attr-class `eq(gen_ai.system,…)`, carried on the scope.
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

    /// The other direction: a resource-class matcher is decided by the resource alone,
    /// so a span attribute of the same name can no longer veto it.
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

    /// Pseudo-keys stay class-free: they are columns, not map entries. effect_ai's
    /// attr matchers key on `span.name` and must keep firing under class-directed
    /// lookup — the one way this change could have silently deleted a vendor.
    #[test]
    fn pseudo_keys_resolve_for_every_matcher_class() {
        let (vendor, _) = classify(&[], "com.example.app", "LanguageModel.generateText", &[]);
        assert_eq!(vendor, "effect_ai");
        // …and the scope pseudo-keys still decide scope-class matchers with no
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

    /// F2, the hazard class-directed lookup exists to close.
    ///
    /// `langsmith.internal_provider` is langchain's **insufficient** resource matcher
    /// key and also lies inside langchain's attr-class `key_prefix("langsmith.")`.
    /// Under a cross-class fallback the resource attribute satisfied that attr matcher
    /// — which is unconditional *and* promotes — so one resource attribute classified
    /// every span in the process as langchain, plain HTTP included and whatever the
    /// value. The insufficient match must contribute nothing on its own.
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
        // `langsmith.*` attribute is an attr hit for langchain.
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

    /// The plan gates `input.value`/`output.value` on co-occurrence with an
    /// OpenInference attribute. registry.json encodes that gate by **omitting** them
    /// from the unknown tier entirely (compile-registry.ts: "input.value/output.value
    /// stay gated/excluded in v1"), so standalone occurrences must classify non-AI
    /// and co-occurring ones must be caught by the OpenInference fingerprint itself.
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
    /// The write-side plan predicted this would be capped at state 5. The seed
    /// overrode that with an explicit, documented trade-off: it labels the key
    /// `session` granularity because a correctly-configured deployment
    /// (`conversation_id=` passed, or `message_history` threaded) produces a genuine
    /// cross-run session, and labelling it `run` would drive those deployments to
    /// state 5 and 8/8 unsessioned traces. The cost — a default-configured app
    /// reports one session per run and maple cannot tell the two apart span-locally
    /// — is recorded in the seed's caveats. This test pins the *registry's* behavior.
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
        // Exactly what `SELECT cityHash64('sess-42')` returns — the SQL leg of the
        // equivalence suite reproduces this with no construction to agree on.
        assert_eq!(
            result.session_key_hash(),
            crate::cityhash102::city_hash64(b"sess-42")
        );
    }

    // -- canonicalization and degradation ------------------------------------

    #[test]
    fn values_are_canonicalized_before_matching() {
        // A bool/int arrives typed on protobuf and as a string over JSON; both must
        // match `eq(langsmith.internal_provider, "true")`.
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

    /// Plan §2: the same logical span delivered as OTLP protobuf and as OTLP/JSON
    /// must classify identically. JSON carries int64s as decimal strings and the
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

    /// The indexed matcher dispatch must agree with direct evaluation of every
    /// matcher in the registry — the optimization's safety net.
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
            let direct = context.classify_span_unindexed(span_name, &attributes);
            assert_eq!(
                indexed.vendor, direct,
                "indexed vs direct for {scope_name}/{span_name}"
            );
        }
    }
}
