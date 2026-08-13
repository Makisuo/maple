//! The compiled AI vendor registry: key interning, the generated prefilter and
//! the per-key/per-prefix candidate dispatch over the vendor tables in
//! [`crate::ai_vendors`].
//!
//! The vendor knowledge itself — the `detect` predicates, session candidates and
//! decoy values — lives in `ai_vendors.rs` as plain Rust. Predicates are opaque
//! functions, so the fast-path machinery is built from each vendor's **declared
//! prefilter hints** (`keys`, `prefixes`, `span_names`) rather than derived from
//! matcher data: this module interns the declared keys and prefixes, generates
//! the byte/length screens, and builds the key/prefix/span-name →
//! candidate-detector masks the classifier uses for its fast exit.
//!
//! What this module guarantees, structurally rather than by convention:
//!
//! * **Vendor slugs are a closed set.** A classification result is a
//!   [`VendorId`] — a Rust enum. There is no constructor that takes a string, so
//!   minting an unlisted slug (unbounded `LowCardinality` values, cross-tenant
//!   amplification) is not expressible.
//! * **The prefilter is generated from the declared hints**, never
//!   hand-maintained: it is the union of every exact key and key prefix any
//!   vendor or unknown-tier rule declares, plus every session-candidate key
//!   (candidate keys are data, so they are collected automatically).
//!
//! **Hint drift is the one failure the build cannot catch**: a `detect` or
//! authority function consulting a key its vendor did not declare evaluates
//! against a prefiltered view that never stored that key, so the indexed fast
//! path silently sees "absent". The defense is the indexed-vs-direct
//! differential (`ai_classification_fixture_test.rs` and the classifier's unit
//! suite): the direct reference path evaluates every vendor over the **raw,
//! unprefiltered** attribute lists, so a wrong hint surfaces as a divergence
//! over the fixture/corpus rather than staying invisible.
//!
//! Everything else is checked in [`Registry::validate`], which panics. That is
//! the right failure mode: the tables are boot configuration compiled into the
//! binary, so a violation is a table bug that must not reach production traffic,
//! and the process has no traffic to lose at that point.

use std::borrow::Cow;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::LazyLock;

use crate::ai_classifier::SpanCtx;
use crate::ai_vendors::{
    SessionCandidateDef, UnknownRuleDef, VendorDef, RULES_VERSION, UNKNOWN_BUCKETS, UNKNOWN_TIER,
    VENDORS,
};

pub use crate::ai_vendors::{Granularity, VendorId};

/// The exact-key map, keyed by a **non-cryptographic** hasher.
///
/// SipHash (std's default) cost ~12 ns per probed key, and a fat AI span probes
/// dozens — it was the single largest line in the per-span budget. Dropping DoS
/// resistance here is bounded and deliberate: the key *set* is the compiled
/// vendor tables, fixed at build and never influenced by traffic, so an attacker
/// can only choose lookup keys, not the buckets they collide into. The worst
/// case a crafted attribute name can buy is a short bucket walk over a
/// small fixed map that it still misses — no unbounded chain, no insertion, no
/// eviction. Every other map in this module keeps the std hasher; only this one
/// is hot.
type KeyIdMap = HashMap<&'static str, KeyId, BuildHasherDefault<FxHasher>>;

/// The prefix map shares the hasher and the rationale: candidate predicates
/// probe it on every `any_attr_prefix` call.
type PrefixIdMap = HashMap<&'static str, PrefixId, BuildHasherDefault<FxHasher>>;

/// The span-name dispatch map shares the hasher and the rationale, and is the
/// hottest of the three: it is probed **unconditionally, once per span**, before
/// the non-AI fast exit — so on the overwhelming-majority path it is the only
/// map probe there is. The key set is again the compiled tables.
type SpanNameDetectorMap = HashMap<&'static str, u64, BuildHasherDefault<FxHasher>>;

/// FxHash (rustc's own string hasher), inlined rather than pulled in as a
/// dependency — it is eleven lines and this is its only use.
#[derive(Default)]
struct FxHasher {
    hash: u64,
}

impl FxHasher {
    const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

    #[inline]
    fn add(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(Self::SEED);
    }
}

impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while rest.len() >= 8 {
            let (head, tail) = rest.split_at(8);
            self.add(u64::from_le_bytes(head.try_into().expect("8 bytes")));
            rest = tail;
        }
        if !rest.is_empty() {
            let mut buf = [0u8; 8];
            buf[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(buf));
        }
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }
}

/// The `key_len_screen` bit for a key of this byte length, clamped so keys
/// longer than 63 bytes all share the top bucket.
#[inline]
fn length_bit(len: usize) -> u64 {
    1u64 << len.min(63)
}

/// Detector masks are a `u64`: bits `0..VendorId::COUNT` are vendors (by
/// [`VendorId::index`]; the `unknown:*` bucket bits are never set — buckets are
/// verdicts, not detectors), and bits `UNKNOWN_RULE_BASE..` are the unknown-tier
/// rules by their position in [`UNKNOWN_TIER`].
const MAX_VENDORS: usize = UNKNOWN_RULE_BASE as usize;
/// First detector-mask bit used by the unknown-tier rules.
const UNKNOWN_RULE_BASE: u32 = 32;
/// Prefix hits are tracked in a `u64` bitmask.
const MAX_PREFIXES: usize = 64;
/// The classifier's per-attribute-list key-presence bitset is a fixed
/// `[u64; MAX_KEYS / 64]`. A multiple of 64; grow it (and nothing else) when the
/// vendor tables outgrow it.
pub(crate) const MAX_KEYS: usize = 256;

/// The detector-mask bit for an unknown-tier rule at this [`UNKNOWN_TIER`]
/// position.
#[inline]
pub(crate) fn unknown_rule_bit(index: usize) -> u64 {
    1u64 << (UNKNOWN_RULE_BASE + index as u32)
}

// ---------------------------------------------------------------------------
// compiled shapes
// ---------------------------------------------------------------------------

/// Index into the interned exact-key table.
pub type KeyId = u16;
/// Index into the interned key-prefix table.
pub type PrefixId = u8;

/// One compiled session-key candidate. `key` stays in string form for the direct
/// (unprefiltered) reference path; `key_id` is the interned form the indexed fast
/// path reads.
pub struct SessionCandidate {
    pub key: &'static str,
    pub(crate) key_id: KeyId,
    /// Span-local predicate selecting session-authoritative spans;
    /// `|_| true` = every span of the vendor is authoritative.
    pub authority: fn(&SpanCtx) -> bool,
    pub require_non_empty: bool,
    pub reject_decoy_values: bool,
    /// Span-EVENT attribute key read as the value source when `key` is absent
    /// from the span's own attributes (see [`crate::ai_vendors::SessionCandidateDef`]).
    pub event_key: Option<&'static str>,
    pub granularity: Granularity,
    /// Value-conditional granularity override (see
    /// [`crate::ai_vendors::SessionCandidateDef::granularity_of_value`]).
    pub granularity_of_value: Option<fn(&str) -> Granularity>,
}

pub struct Vendor {
    slug: &'static str,
    /// `unknown:*` buckets are verdicts for resolution purposes but carry no
    /// session-key rules and are reserved: no vendor rule may mint one.
    unknown_bucket: bool,
    candidates: Vec<SessionCandidate>,
    decoy_values: &'static [&'static str],
}

impl Vendor {
    pub fn slug(&self) -> &'static str {
        self.slug
    }
    pub fn is_unknown_bucket(&self) -> bool {
        self.unknown_bucket
    }
    pub fn candidates(&self) -> &[SessionCandidate] {
        &self.candidates
    }
    pub fn is_decoy_value(&self, value: &str) -> bool {
        self.decoy_values.contains(&value)
    }
}

/// A rule-referenced key seen on a span: its interned id (when the key is
/// referenced exactly) and the prefixes it satisfies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyProbe {
    pub key_id: Option<KeyId>,
    pub prefix_bits: u64,
}

impl KeyProbe {
    pub fn is_empty(&self) -> bool {
        self.key_id.is_none() && self.prefix_bits == 0
    }
}

pub struct Registry {
    version: u32,
    /// Indexed by [`VendorId::index`], buckets included.
    vendors: Vec<Vendor>,
    vendor_ids: HashMap<&'static str, VendorId>,

    keys: Vec<&'static str>,
    key_ids: KeyIdMap,
    prefixes: Vec<&'static str>,
    prefix_ids: PrefixIdMap,

    /// Bit 0: some exact key starts with this byte. Bit 1: some prefix does.
    byte_screen: [u8; 256],
    /// Second screen dimension: for each first byte, the set of *lengths* the
    /// tables' exact keys of that byte have (length clamped to 63, so anything
    /// longer than the longest rule key shares one bucket). A filler key that
    /// happens to share a first byte with a rule key —
    /// `gen_ai.request.parameter_7` against `gen_ai.system` — is rejected here
    /// instead of paying a map lookup.
    key_len_screen: [u64; 256],
    prefixes_by_first_byte: Vec<Vec<PrefixId>>,

    // candidate dispatch — a span's surviving evidence names the detectors
    // (vendors + unknown-tier rules) whose declared hints it touches, so the
    // classifier evaluates the (typically 1–3) candidate predicates instead of
    // all of them, and fast-exits when the mask is empty.
    detectors_by_key: Vec<u64>,
    detectors_by_prefix: Vec<u64>,
    detectors_by_span_name: SpanNameDetectorMap,
}

/// The process-wide registry. Compiled and validated on first use from the
/// static tables in [`crate::ai_vendors`].
pub fn registry() -> &'static Registry {
    static REGISTRY: LazyLock<Registry> =
        LazyLock::new(|| Registry::compile().expect("the static ai_vendors tables are malformed"));
    &REGISTRY
}

impl Registry {
    pub fn version(&self) -> u32 {
        self.version
    }
    pub fn vendors(&self) -> &[Vendor] {
        &self.vendors
    }
    pub fn vendor(&self, id: VendorId) -> &Vendor {
        &self.vendors[id.index()]
    }
    pub fn vendor_slug(&self, id: VendorId) -> &'static str {
        self.vendors[id.index()].slug()
    }
    pub fn vendor_id(&self, slug: &str) -> Option<VendorId> {
        self.vendor_ids.get(slug).copied()
    }
    pub fn keys(&self) -> &[&'static str] {
        &self.keys
    }
    pub fn prefixes(&self) -> &[&'static str] {
        &self.prefixes
    }
    #[inline]
    pub fn key_id(&self, key: &str) -> Option<KeyId> {
        self.key_ids.get(key).copied()
    }
    #[inline]
    pub(crate) fn prefix_id(&self, prefix: &str) -> Option<PrefixId> {
        self.prefix_ids.get(prefix).copied()
    }

    #[inline]
    pub(crate) fn detectors_by_key(&self, key: KeyId) -> u64 {
        self.detectors_by_key[key as usize]
    }
    #[inline]
    pub(crate) fn detectors_by_prefix(&self, prefix: PrefixId) -> u64 {
        self.detectors_by_prefix[prefix as usize]
    }
    pub(crate) fn detectors_by_span_name(&self, name: &str) -> u64 {
        self.detectors_by_span_name.get(name).copied().unwrap_or(0)
    }

    /// The generated prefilter. `true` iff some rule can consult this key.
    ///
    /// Cheap by construction: a 256-entry byte screen rejects almost every
    /// attribute key on a non-AI span before any hashing happens.
    pub fn references_key(&self, key: &str) -> bool {
        !self.probe(key).is_empty()
    }

    /// Prefilter + interning in one pass: the hot-path entry point.
    #[inline]
    pub fn probe(&self, key: &str) -> KeyProbe {
        let bytes = key.as_bytes();
        let Some(&first) = bytes.first() else {
            return KeyProbe::default();
        };
        let screen = self.byte_screen[first as usize];
        if screen == 0 {
            return KeyProbe::default();
        }
        let mut probe = KeyProbe::default();
        if screen & 1 != 0 && self.key_len_screen[first as usize] & length_bit(bytes.len()) != 0 {
            probe.key_id = self.key_ids.get(key).copied();
        }
        if screen & 2 != 0 {
            for &pid in &self.prefixes_by_first_byte[first as usize] {
                if key.starts_with(self.prefixes[pid as usize]) {
                    probe.prefix_bits |= 1u64 << pid;
                }
            }
        }
        probe
    }

    // -----------------------------------------------------------------------
    // compile
    // -----------------------------------------------------------------------

    fn compile() -> Result<Self, String> {
        let mut builder = Builder::default();
        let registry = builder.build(RULES_VERSION, VENDORS, UNKNOWN_TIER)?;
        registry.validate()?;
        Ok(registry)
    }

    /// Build-time validation over the static tables. Every violation here is a
    /// table bug that must fail the process before it takes traffic.
    fn validate(&self) -> Result<(), String> {
        if self.version == 0 {
            return Err("RULES_VERSION 0 is reserved for pre-rollout rows".into());
        }
        if VendorId::COUNT > MAX_VENDORS {
            return Err(format!(
                "{} vendors exceeds the {MAX_VENDORS}-bit vendor set",
                VendorId::COUNT
            ));
        }
        if UNKNOWN_TIER.len() > (64 - UNKNOWN_RULE_BASE) as usize {
            return Err("too many unknown-tier rules for the detector mask".into());
        }
        if self.prefixes.len() > MAX_PREFIXES {
            return Err(format!(
                "{} key prefixes exceeds the {MAX_PREFIXES}-bit prefix set",
                self.prefixes.len()
            ));
        }
        if self.keys.len() > MAX_KEYS {
            return Err(format!(
                "{} exact keys exceeds the {MAX_KEYS}-bit key-presence set",
                self.keys.len()
            ));
        }

        // `unknown:` is reserved for the fingerprint tier; the slug table and the
        // bucket flag must agree.
        for vendor in &self.vendors {
            if vendor.slug().starts_with("unknown:") != vendor.unknown_bucket {
                return Err(format!(
                    "vendor slug {:?} misuses the reserved `unknown:` prefix",
                    vendor.slug()
                ));
            }
            if vendor.unknown_bucket && !vendor.candidates.is_empty() {
                return Err("unknown-tier buckets carry no session-key rules".into());
            }
        }

        // The prefilter must survive every key and prefix the tables declare.
        for key in &self.keys {
            if !self.references_key(key) {
                return Err(format!("prefilter drops rule key {key:?}"));
            }
        }
        for prefix in &self.prefixes {
            if !self.references_key(prefix) || !self.references_key(&format!("{prefix}x")) {
                return Err(format!("prefilter drops rule prefix {prefix:?}"));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Builder {
    keys: Vec<&'static str>,
    key_ids: KeyIdMap,
    prefixes: Vec<&'static str>,
    prefix_ids: PrefixIdMap,
}

impl Builder {
    fn intern_key(&mut self, key: &'static str) -> Result<KeyId, String> {
        if key.is_empty() {
            return Err("empty rule key".into());
        }
        if let Some(&id) = self.key_ids.get(key) {
            return Ok(id);
        }
        let id = u16::try_from(self.keys.len()).map_err(|_| "too many rule keys".to_string())?;
        self.keys.push(key);
        self.key_ids.insert(key, id);
        Ok(id)
    }

    fn intern_prefix(&mut self, prefix: &'static str) -> Result<PrefixId, String> {
        if prefix.is_empty() {
            return Err("empty key_prefix would match every attribute".into());
        }
        if let Some(&id) = self.prefix_ids.get(prefix) {
            return Ok(id);
        }
        let id = u8::try_from(self.prefixes.len())
            .ok()
            .filter(|id| (*id as usize) < MAX_PREFIXES)
            .ok_or_else(|| "too many key prefixes".to_string())?;
        self.prefixes.push(prefix);
        self.prefix_ids.insert(prefix, id);
        Ok(id)
    }

    fn build(
        &mut self,
        version: u32,
        vendor_defs: &[VendorDef],
        unknown_tier: &[UnknownRuleDef],
    ) -> Result<Registry, String> {
        // The vendors table is indexed by `VendorId::index()`. `VENDORS` is in
        // *resolution* order — a permutation of the non-bucket variants — so the
        // slots are filled by id and the coverage is checked afterwards.
        let mut vendors: Vec<Option<Vendor>> = (0..VendorId::COUNT).map(|_| None).collect();
        let mut vendor_ids: HashMap<&'static str, VendorId> = HashMap::new();
        let mut detectors_by_key: HashMap<KeyId, u64> = HashMap::new();
        let mut detectors_by_prefix: HashMap<PrefixId, u64> = HashMap::new();
        let mut detectors_by_span_name = SpanNameDetectorMap::default();

        for def in vendor_defs {
            if def.id.is_unknown_bucket() {
                return Err(format!("VENDORS must not list the bucket {:?}", def.id));
            }
            let bit = 1u64 << def.id.index();

            // Declared prefilter hints → interning + candidate dispatch. A key
            // consulted by `detect` (or an authority predicate) but not declared
            // here is invisible to the indexed path — see the module docs for
            // the differential that catches it.
            for key in def.keys {
                let id = self.intern_key(key)?;
                *detectors_by_key.entry(id).or_default() |= bit;
            }
            for prefix in def.prefixes {
                let id = self.intern_prefix(prefix)?;
                *detectors_by_prefix.entry(id).or_default() |= bit;
            }
            for name in def.span_names {
                if name.is_empty() {
                    return Err("empty span-name hint".into());
                }
                *detectors_by_span_name.entry(name).or_default() |= bit;
            }

            let mut candidates = Vec::with_capacity(def.session_candidates.len());
            for candidate in def.session_candidates {
                let SessionCandidateDef {
                    key,
                    authority,
                    require_non_empty,
                    reject_decoy_values,
                    event_key,
                    granularity,
                    granularity_of_value,
                } = *candidate;
                // Candidate keys are data, so they are interned automatically —
                // no detector bit: a session key is read after resolution and
                // must never make its vendor a detection candidate.
                candidates.push(SessionCandidate {
                    key,
                    key_id: self.intern_key(key)?,
                    authority,
                    require_non_empty,
                    reject_decoy_values,
                    event_key,
                    granularity,
                    granularity_of_value,
                });
            }

            let vendor = Vendor {
                slug: def.id.slug(),
                unknown_bucket: false,
                candidates,
                // Decoy KEYS are deliberately not compiled: the rule is "never
                // consult", so the detector must not be able to read one. They
                // live as doc comments on the vendor blocks.
                decoy_values: def.decoy_values,
            };
            if vendor_ids.insert(vendor.slug, def.id).is_some() {
                return Err(format!("vendor {:?} appears twice in VENDORS", vendor.slug));
            }
            vendors[def.id.index()] = Some(vendor);
        }

        // The reserved buckets occupy the table slots after the vendors, in
        // discriminant order.
        for (position, &bucket) in UNKNOWN_BUCKETS.iter().enumerate() {
            if bucket.index() != vendor_defs.len() + position || !bucket.is_unknown_bucket() {
                return Err(format!(
                    "UNKNOWN_BUCKETS order does not match VendorId discriminants at {bucket:?}"
                ));
            }
            let vendor = Vendor {
                slug: bucket.slug(),
                unknown_bucket: true,
                candidates: Vec::new(),
                decoy_values: &[],
            };
            if vendor_ids.insert(vendor.slug, bucket).is_some() {
                return Err(format!("duplicate vendor slug {:?}", vendor.slug));
            }
            vendors[bucket.index()] = Some(vendor);
        }
        let vendors: Vec<Vendor> = vendors
            .into_iter()
            .enumerate()
            .map(|(index, slot)| {
                slot.ok_or_else(|| format!("no VENDORS entry for VendorId index {index}"))
            })
            .collect::<Result<_, _>>()?;

        // Unknown-tier rules join the candidate dispatch under their own bits;
        // the classifier consults them only in the no-vendor `else`.
        for (index, rule) in unknown_tier.iter().enumerate() {
            if !rule.bucket.is_unknown_bucket() {
                return Err(format!(
                    "unknown-tier rule targets non-bucket vendor {:?}",
                    rule.bucket
                ));
            }
            let bit = unknown_rule_bit(index);
            for key in rule.keys {
                let id = self.intern_key(key)?;
                *detectors_by_key.entry(id).or_default() |= bit;
            }
            for prefix in rule.prefixes {
                let id = self.intern_prefix(prefix)?;
                *detectors_by_prefix.entry(id).or_default() |= bit;
            }
        }

        let mut byte_screen = [0u8; 256];
        let mut key_len_screen = [0u64; 256];
        let mut prefixes_by_first_byte = vec![Vec::new(); 256];
        for key in &self.keys {
            if let Some(&first) = key.as_bytes().first() {
                byte_screen[first as usize] |= 1;
                key_len_screen[first as usize] |= length_bit(key.len());
            }
        }
        for (index, prefix) in self.prefixes.iter().enumerate() {
            if let Some(&first) = prefix.as_bytes().first() {
                byte_screen[first as usize] |= 2;
                prefixes_by_first_byte[first as usize].push(index as PrefixId);
            }
        }

        let key_count = self.keys.len();
        let prefix_count = self.prefixes.len();
        Ok(Registry {
            version,
            vendors,
            vendor_ids,
            keys: std::mem::take(&mut self.keys),
            key_ids: std::mem::take(&mut self.key_ids),
            prefixes: std::mem::take(&mut self.prefixes),
            prefix_ids: std::mem::take(&mut self.prefix_ids),
            byte_screen,
            key_len_screen,
            prefixes_by_first_byte,
            detectors_by_key: (0..key_count)
                .map(|id| detectors_by_key.get(&(id as KeyId)).copied().unwrap_or(0))
                .collect(),
            detectors_by_prefix: (0..prefix_count)
                .map(|id| {
                    detectors_by_prefix
                        .get(&(id as PrefixId))
                        .copied()
                        .unwrap_or(0)
                })
                .collect(),
            detectors_by_span_name,
        })
    }
}

/// Canonical `AnyValue → String` for a *rule-referenced* value, borrowing when
/// the value is already a string (the overwhelmingly common case).
///
/// Delegates to the row writer's `any_value_string` for every other type — one
/// shared canonicalization, so the same logical span delivered as OTLP protobuf
/// (typed values) and OTLP/JSON (int64s as decimal strings, bools typed vs
/// `"true"`) classifies identically.
pub fn canonical_value(
    value: Option<&opentelemetry_proto::tonic::common::v1::AnyValue>,
) -> Cow<'_, str> {
    use opentelemetry_proto::tonic::common::v1::any_value;
    match value.and_then(|v| v.value.as_ref()) {
        Some(any_value::Value::StringValue(s)) => Cow::Borrowed(s.as_str()),
        Some(_) => Cow::Owned(crate::telemetry::any_value_string(value.expect("checked"))),
        None => Cow::Borrowed(""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_static_tables_compile_and_validate() {
        let registry = registry();
        assert_eq!(registry.version(), 1);
        assert_eq!(
            registry.vendors().len(),
            21 + 3,
            "21 vendors + 3 unknown buckets"
        );
        assert_eq!(
            registry
                .vendors()
                .iter()
                .map(|v| v.candidates().len())
                .sum::<usize>(),
            29
        );
        // Every declared key and prefix dispatches at least one detector or is a
        // session-candidate key.
        for (index, key) in registry.keys().iter().enumerate() {
            let dispatched = registry.detectors_by_key(index as KeyId) != 0;
            let candidate = registry
                .vendors()
                .iter()
                .any(|v| v.candidates().iter().any(|c| c.key == *key));
            assert!(dispatched || candidate, "key {key} is dead in the tables");
        }
        for (index, prefix) in registry.prefixes().iter().enumerate() {
            assert_ne!(
                registry.detectors_by_prefix(index as PrefixId),
                0,
                "prefix {prefix} dispatches nothing"
            );
        }
    }

    #[test]
    fn vendor_slugs_are_the_closed_set() {
        let registry = registry();
        for slug in [
            "agno",
            "claude_agent_sdk",
            "crewai",
            "dspy",
            "effect_ai",
            "flue",
            "google_adk",
            "haystack",
            "langchain",
            "litellm",
            "llamaindex",
            "mastra",
            "microsoft_agent_framework",
            "openai_agents_sdk",
            "openinference-openai",
            "pydantic_ai",
            "semantic_kernel",
            "smolagents",
            "spring_ai",
            "strands",
            "vercel_ai_sdk",
        ] {
            let id = registry.vendor_id(slug).expect("known slug");
            assert_eq!(registry.vendor_slug(id), slug);
            assert_eq!(id.slug(), slug);
            assert!(!registry.vendor(id).is_unknown_bucket());
        }
        // `langgraph` is folded into `langchain`, so its slug is not producible.
        assert!(registry.vendor_id("langgraph").is_none());
        for bucket in ["unknown:genai", "unknown:openinference", "unknown:other"] {
            let id = registry.vendor_id(bucket).expect("bucket");
            assert!(registry.vendor(id).is_unknown_bucket());
            assert!(registry.vendor(id).candidates().is_empty());
        }
    }

    /// Every rule key and prefix must survive the generated prefilter. `validate`
    /// enforces it at build; this states it as a test in its own right and adds the
    /// negative direction.
    #[test]
    fn prefilter_is_self_consistent() {
        let registry = registry();
        for key in registry.keys() {
            assert!(registry.references_key(key), "prefilter dropped {key}");
            assert_eq!(registry.probe(key).key_id, registry.key_id(key));
        }
        for (index, prefix) in registry.prefixes().iter().enumerate() {
            let probed = registry.probe(&format!("{prefix}suffix"));
            assert!(
                probed.prefix_bits & (1 << index) != 0,
                "prefilter dropped prefix {prefix}"
            );
        }
        for key in ["http.request.method", "db.system", "", "x", "service.port"] {
            assert!(!registry.references_key(key), "{key} should not survive");
        }
    }

    /// `VENDORS` is the resolution order: it must cover every non-bucket
    /// variant exactly once (the build panics otherwise; stated here as a test
    /// in its own right), and the unknown tier keeps its internal order.
    #[test]
    fn resolution_order_covers_the_vendor_set() {
        let mut seen: Vec<VendorId> = VENDORS.iter().map(|def| def.id).collect();
        assert_eq!(seen.len(), 21);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 21, "every vendor appears exactly once");
        assert!(seen.iter().all(|id| !id.is_unknown_bucket()));
        // The unknown tier's internal order. The `input.value`/`output.value`
        // rule's slot is load-bearing — it must sit between the
        // `openinference.span.kind` rule and the bare `llm.` rule, so an
        // OpenInference-dialect span keeps the openinference bucket instead of
        // falling into the `unknown:other` catch-all (see the rule's comment and
        // `input_output_values_with_llm_namespace_bucket_as_openinference`).
        let buckets: Vec<VendorId> = UNKNOWN_TIER.iter().map(|rule| rule.bucket).collect();
        assert_eq!(
            buckets,
            [
                VendorId::UnknownGenai,
                VendorId::UnknownOpeninference,
                VendorId::UnknownOpeninference,
                VendorId::UnknownOther,
                VendorId::UnknownOther,
                VendorId::UnknownOther,
            ]
        );
    }
}
