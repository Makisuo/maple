//! The compiled AI vendor rule registry, embedded and validated at first use.
//!
//! Source of truth: `packages/domain/src/ai-registry/registry.json`, vendored from
//! trace-capture's `scripts/compile-registry.ts` (20 framework seeds + 1 synthesized
//! vendor). It is `include_str!`'d — the detector must never depend on a file being
//! present at runtime, and a batch must carry exactly one `rules_version`.
//!
//! What this module guarantees, structurally rather than by convention:
//!
//! * **Vendor slugs are a closed set.** A classification result is a [`VendorId`],
//!   an index into an interned table built from the registry. There is no
//!   constructor that takes a string, so minting an unlisted slug — the
//!   LowCardinality-cardinality and tenant-amplification bug the plan calls out —
//!   is not expressible.
//! * **The predicate algebra is exactly four operators.** `op` is a serde tag, so a
//!   fifth operator is a parse error, not a silently-ignored rule.
//! * **The prefilter is generated from the registry**, never hand-maintained: it is
//!   the union of every exact key and every key-prefix any matcher, unknown-tier
//!   fingerprint, session candidate or authority predicate references.
//!
//! Everything else is checked in [`Registry::validate`], which panics. That is the
//! right failure mode: the registry is boot configuration compiled into the binary,
//! so a violation is a build artifact bug that must not reach production traffic,
//! and the process has no traffic to lose at that point.

use std::borrow::Cow;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::LazyLock;

use serde::Deserialize;

/// The vendored registry artifact. Path is relative to this source file.
const REGISTRY_JSON: &str = include_str!("../../../packages/domain/src/ai-registry/registry.json");

/// The exact-key map, keyed by a **non-cryptographic** hasher.
///
/// SipHash (std's default) cost ~12 ns per probed key, and a fat AI span probes
/// dozens — it was the single largest line in the per-span budget. Dropping DoS
/// resistance here is bounded and deliberate: the key *set* is the compiled
/// registry, fixed at load and never influenced by traffic, so an attacker can
/// only choose lookup keys, not the buckets they collide into. The worst case a
/// crafted attribute name can buy is a short bucket walk over a ~116-entry map
/// that it still misses — no unbounded chain, no insertion, no eviction. Every
/// other map in this module keeps the std hasher; only this one is hot.
type KeyIdMap = HashMap<Box<str>, KeyId, BuildHasherDefault<FxHasher>>;

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

/// Priority bands (write-side plan D4). Sufficient scope/resource matchers outrank
/// vendor attr matchers, which outrank unknown-tier fingerprints.
const BAND_SUFFICIENT: std::ops::RangeInclusive<u32> = 30_000..=39_999;
const BAND_VENDOR: std::ops::RangeInclusive<u32> = 20_000..=29_999;
const BAND_UNKNOWN: std::ops::RangeInclusive<u32> = 10_000..=19_999;

/// `VendorBits` is a `u64`; more vendors than that needs a wider set, not a silent
/// truncation.
const MAX_VENDORS: usize = 64;
/// Prefix hits are tracked in a `u64` bitmask for the same reason.
const MAX_PREFIXES: usize = 64;
/// Conditional-candidate hits are tracked in a `u32` bitmask per span.
const MAX_CONDITIONAL: usize = 32;
/// The classifier's per-attribute-list key-presence bitset is a fixed
/// `[u64; MAX_KEYS / 64]`. A multiple of 64; grow it (and nothing else) when the
/// registry outgrows it — 116 keys today.
pub(crate) const MAX_KEYS: usize = 256;

// ---------------------------------------------------------------------------
// raw (serde) shapes — mirror registry.json exactly
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawRegistry {
    registry_version: u32,
    algebra: RawAlgebra,
    unknown_tier: Vec<RawUnknown>,
    vendors: Vec<RawVendor>,
}

#[derive(Deserialize)]
struct RawAlgebra {
    ops: Vec<String>,
    value_prefix_pseudo_keys: Vec<String>,
}

#[derive(Deserialize)]
struct RawUnknown {
    bucket: String,
    predicate: RawPredicate,
    priority: u32,
}

#[derive(Deserialize)]
struct RawVendor {
    vendor: String,
    matchers: Vec<RawMatcher>,
    session_candidates: Vec<RawCandidate>,
    #[serde(default)]
    decoy_values: Vec<RawDecoy>,
}

#[derive(Deserialize)]
struct RawMatcher {
    class: RawClass,
    sufficient: bool,
    predicate: RawPredicate,
    priority: u32,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
enum RawClass {
    Resource,
    Scope,
    Attr,
}

/// The restricted algebra. An unknown `op` fails deserialization.
#[derive(Deserialize, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
enum RawPredicate {
    Present { key: String },
    Eq { key: String, value: String },
    KeyPrefix { prefix: String },
    ValuePrefix { key: String, prefix: String },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawAuthority {
    AnyOf { any_of: Vec<RawPredicate> },
    One(RawPredicate),
}

#[derive(Deserialize)]
struct RawCandidate {
    key: String,
    authority_predicate: Option<RawAuthority>,
    #[serde(default)]
    validation: Vec<String>,
    granularity: RawGranularity,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
enum RawGranularity {
    Session,
    Run,
    User,
    Instance,
}

#[derive(Deserialize)]
struct RawDecoy {
    value: String,
}

// ---------------------------------------------------------------------------
// compiled shapes
// ---------------------------------------------------------------------------

/// Index into the registry's interned vendor table. The only way to name a vendor.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct VendorId(u16);

impl VendorId {
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// Index into the interned exact-key table.
pub type KeyId = u16;
/// Index into the interned key-prefix table.
pub type PrefixId = u8;
/// Index into [`Registry::matchers`].
pub type MatcherId = u16;

/// The four pseudo-keys: real columns on both targets, resolved before attributes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PseudoKey {
    ScopeName,
    SpanName,
    ScopeVersion,
    ScopeSchemaUrl,
}

impl PseudoKey {
    fn parse(key: &str) -> Option<Self> {
        match key {
            "scope.name" => Some(Self::ScopeName),
            "span.name" => Some(Self::SpanName),
            "scope.version" => Some(Self::ScopeVersion),
            "scope.schema_url" => Some(Self::ScopeSchemaUrl),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScopeName => "scope.name",
            Self::SpanName => "span.name",
            Self::ScopeVersion => "scope.version",
            Self::ScopeSchemaUrl => "scope.schema_url",
        }
    }
}

/// A key in a predicate: either a pseudo-key or an interned attribute key.
///
/// The distinction is load-bearing twice over: pseudo-keys resolve to a *column*, so a
/// span attribute literally named `scope.name` is shadowed and must never reach a
/// pseudo-key matcher — and a pseudo-key ignores [`AttrTarget`] entirely, because a
/// column belongs to no attribute map (`pseudoKeyColumn` wins over `targetForClass` in
/// `compile-sql.ts` for the same reason).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LookupKey {
    Pseudo(PseudoKey),
    Attr(KeyId),
}

#[derive(Clone, Debug)]
pub enum Predicate {
    Present(LookupKey),
    Eq(LookupKey, Box<str>),
    KeyPrefix(PrefixId),
    ValuePrefix(PseudoKey, Box<str>),
}

/// Which attribute list a matcher's *attribute* keys resolve against — the matcher's
/// declared class, compiled (plan §1: matcher classes are per-class predicates).
///
/// `resource` → the ResourceSpans attributes, `scope` → the InstrumentationScope
/// attributes, `attr` → the span's own attributes. Unknown-tier fingerprints, session
/// candidates and authority predicates carry no class and are span-local, matching
/// `targetForClass` / the `"span"` target in `packages/domain/src/ai-registry/compile-sql.ts`.
///
/// Pseudo-keys are exempt: they are real columns, not map entries, so `span.name` and
/// `scope.*` resolve to their column whatever the matcher's class says.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AttrTarget {
    Span,
    Scope,
    Resource,
}

/// How a matcher participates in resolution (write-side plan §1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HitKind {
    /// A hit on its own: attr matchers, sufficient resource/scope matchers, and
    /// unknown-tier fingerprints.
    Unconditional,
    /// An insufficient resource/scope match. Contributes nothing alone; promoted to
    /// a hit at its own priority only by a same-vendor attr hit on the same span.
    Conditional,
}

#[derive(Clone, Debug)]
pub struct Matcher {
    pub vendor: VendorId,
    pub priority: u32,
    pub kind: HitKind,
    /// The one attribute list this matcher's attribute keys may read.
    pub target: AttrTarget,
    /// Attr-class matchers promote their vendor's conditional candidates. Sufficient
    /// scope/resource matchers and unknown-tier fingerprints do not.
    pub promotes: bool,
    /// Slot in [`Registry::conditional`], so a span can track which conditional
    /// candidates it hit in a `u32` bitmask instead of a heap list.
    pub conditional_slot: Option<u8>,
    pub predicate: Predicate,
}

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

#[derive(Clone, Debug)]
pub enum Authority {
    /// No authority predicate — every span of the vendor is authoritative.
    Always,
    One(Predicate),
    AnyOf(Vec<Predicate>),
}

#[derive(Clone, Debug)]
pub struct SessionCandidate {
    pub key: LookupKey,
    pub authority: Authority,
    pub require_non_empty: bool,
    pub reject_decoy_values: bool,
    pub granularity: Granularity,
}

#[derive(Debug)]
pub struct Vendor {
    slug: Box<str>,
    /// `unknown:*` buckets are vendors for resolution purposes but carry no
    /// session-key rules and are reserved: no seed may mint one.
    unknown_bucket: bool,
    candidates: Vec<SessionCandidate>,
    decoy_values: Vec<Box<str>>,
}

impl Vendor {
    pub fn slug(&self) -> &str {
        &self.slug
    }
    pub fn is_unknown_bucket(&self) -> bool {
        self.unknown_bucket
    }
    pub fn candidates(&self) -> &[SessionCandidate] {
        &self.candidates
    }
    pub fn is_decoy_value(&self, value: &str) -> bool {
        self.decoy_values.iter().any(|d| &**d == value)
    }
}

/// A registry-referenced key seen on a span: its interned id (when the key is
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

#[derive(Debug)]
pub struct Registry {
    version: u32,
    vendors: Vec<Vendor>,
    vendor_ids: HashMap<Box<str>, VendorId>,
    matchers: Vec<Matcher>,

    keys: Vec<Box<str>>,
    key_ids: KeyIdMap,
    prefixes: Vec<Box<str>>,

    /// Bit 0: some exact key starts with this byte. Bit 1: some prefix does.
    byte_screen: [u8; 256],
    /// Second screen dimension: for each first byte, the set of *lengths* the
    /// registry's exact keys of that byte have (length clamped to 63, so
    /// anything longer than the longest registry key shares one bucket). A
    /// filler key that happens to share a first byte with a registry key —
    /// `gen_ai.request.parameter_7` against `gen_ai.system` — is rejected here
    /// instead of paying a map lookup.
    key_len_screen: [u64; 256],
    prefixes_by_first_byte: Vec<Vec<PrefixId>>,

    // dispatch tables — a span's evidence names the matchers it can possibly hit
    /// Matchers a `ScopeSpans` fully decides: every `scope`/`resource`-class matcher,
    /// plus any matcher keyed on a `scope.*` pseudo-key. Resolved once per scope.
    hoisted_matchers: Vec<MatcherId>,
    key_matchers: Vec<Vec<MatcherId>>,
    prefix_matchers: Vec<Vec<MatcherId>>,
    span_name_eq: HashMap<Box<str>, Vec<MatcherId>>,
    /// `present`/`value_prefix` on `span.name` — evaluated per span, no index.
    span_name_other: Vec<MatcherId>,
    /// Conditional (insufficient resource/scope) matchers, in slot order.
    conditional: Vec<MatcherId>,
}

/// The process-wide registry. Parsed and validated on first use.
pub fn registry() -> &'static Registry {
    static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
        Registry::parse(REGISTRY_JSON).expect("vendored ai-registry/registry.json is malformed")
    });
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
    pub fn vendor_slug(&self, id: VendorId) -> &str {
        self.vendors[id.index()].slug()
    }
    pub fn vendor_id(&self, slug: &str) -> Option<VendorId> {
        self.vendor_ids.get(slug).copied()
    }
    pub fn matchers(&self) -> &[Matcher] {
        &self.matchers
    }
    pub fn keys(&self) -> &[Box<str>] {
        &self.keys
    }
    pub fn prefixes(&self) -> &[Box<str>] {
        &self.prefixes
    }
    pub fn key_id(&self, key: &str) -> Option<KeyId> {
        self.key_ids.get(key).copied()
    }

    pub(crate) fn hoisted_matchers(&self) -> &[MatcherId] {
        &self.hoisted_matchers
    }
    pub(crate) fn key_matchers(&self, key: KeyId) -> &[MatcherId] {
        &self.key_matchers[key as usize]
    }
    pub(crate) fn prefix_matchers(&self, prefix: PrefixId) -> &[MatcherId] {
        &self.prefix_matchers[prefix as usize]
    }
    pub(crate) fn span_name_matchers(&self, name: &str) -> &[MatcherId] {
        self.span_name_eq
            .get(name)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
    pub(crate) fn span_name_other(&self) -> &[MatcherId] {
        &self.span_name_other
    }
    pub(crate) fn conditional(&self, slot: usize) -> MatcherId {
        self.conditional[slot]
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
                if key.starts_with(&*self.prefixes[pid as usize]) {
                    probe.prefix_bits |= 1u64 << pid;
                }
            }
        }
        probe
    }

    // -----------------------------------------------------------------------
    // load
    // -----------------------------------------------------------------------

    fn parse(json: &str) -> Result<Self, String> {
        let raw: RawRegistry = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut builder = Builder::default();
        let registry = builder.build(raw)?;
        registry.validate()?;
        Ok(registry)
    }

    /// Load-time validation. Every violation here is a compile-artifact bug.
    fn validate(&self) -> Result<(), String> {
        if self.version == 0 {
            return Err("registry_version 0 is reserved for pre-rollout rows".into());
        }
        if self.vendors.len() > MAX_VENDORS {
            return Err(format!(
                "{} vendors exceeds the {MAX_VENDORS}-bit vendor set",
                self.vendors.len()
            ));
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

        // Unique priorities across ALL matcher classes and the unknown tier.
        let mut seen = HashMap::new();
        for (index, matcher) in self.matchers.iter().enumerate() {
            if let Some(other) = seen.insert(matcher.priority, index) {
                return Err(format!(
                    "duplicate priority {}: matchers {other} and {index}",
                    matcher.priority
                ));
            }
        }

        for matcher in &self.matchers {
            let vendor = &self.vendors[matcher.vendor.index()];
            let band = if vendor.unknown_bucket {
                &BAND_UNKNOWN
            } else if matcher.kind == HitKind::Unconditional && !matcher.promotes {
                &BAND_SUFFICIENT
            } else {
                &BAND_VENDOR
            };
            if !band.contains(&matcher.priority) {
                return Err(format!(
                    "priority {} for {} is outside its band {band:?}",
                    matcher.priority,
                    vendor.slug()
                ));
            }
            if matcher.promotes && matcher.kind != HitKind::Unconditional {
                return Err("attr matchers are unconditional hits".into());
            }
            if let Predicate::ValuePrefix(_, _) = matcher.predicate {
                // enforced at build time (pseudo-key restriction); re-stated here so
                // the invariant is visible where the rest of them live.
            }
        }

        // `unknown:` is reserved for the fingerprint tier.
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

        // Every matcher is dispatched exactly once — either the scope decides it or a
        // span does. A matcher in no table would silently never fire.
        let dispatched = self.hoisted_matchers.len()
            + self.key_matchers.iter().map(Vec::len).sum::<usize>()
            + self.prefix_matchers.iter().map(Vec::len).sum::<usize>()
            + self.span_name_eq.values().map(Vec::len).sum::<usize>()
            + self.span_name_other.len();
        if dispatched != self.matchers.len() {
            return Err(format!(
                "{dispatched} dispatched matchers for {} in the registry",
                self.matchers.len()
            ));
        }

        // The prefilter must survive every key and prefix the registry references.
        for key in &self.keys {
            if !self.references_key(key) {
                return Err(format!("prefilter drops registry key {key:?}"));
            }
        }
        for prefix in &self.prefixes {
            if !self.references_key(prefix) || !self.references_key(&format!("{prefix}x")) {
                return Err(format!("prefilter drops registry prefix {prefix:?}"));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Builder {
    keys: Vec<Box<str>>,
    key_ids: KeyIdMap,
    prefixes: Vec<Box<str>>,
    prefix_ids: HashMap<Box<str>, PrefixId>,
}

impl Builder {
    fn intern_key(&mut self, key: &str) -> Result<KeyId, String> {
        if let Some(&id) = self.key_ids.get(key) {
            return Ok(id);
        }
        let id =
            u16::try_from(self.keys.len()).map_err(|_| "too many registry keys".to_string())?;
        self.keys.push(key.into());
        self.key_ids.insert(key.into(), id);
        Ok(id)
    }

    fn intern_prefix(&mut self, prefix: &str) -> Result<PrefixId, String> {
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
        self.prefixes.push(prefix.into());
        self.prefix_ids.insert(prefix.into(), id);
        Ok(id)
    }

    fn lookup_key(&mut self, key: &str) -> Result<LookupKey, String> {
        Ok(match PseudoKey::parse(key) {
            Some(pseudo) => LookupKey::Pseudo(pseudo),
            None => LookupKey::Attr(self.intern_key(key)?),
        })
    }

    fn predicate(&mut self, raw: &RawPredicate) -> Result<Predicate, String> {
        Ok(match raw {
            RawPredicate::Present { key } => Predicate::Present(self.lookup_key(key)?),
            RawPredicate::Eq { key, value } => {
                Predicate::Eq(self.lookup_key(key)?, value.as_str().into())
            }
            RawPredicate::KeyPrefix { prefix } => Predicate::KeyPrefix(self.intern_prefix(prefix)?),
            RawPredicate::ValuePrefix { key, prefix } => {
                // D1: value_prefix is restricted to the four pseudo-keys, which are
                // real columns in both targets (`startsWith` in SQL).
                let pseudo = PseudoKey::parse(key).ok_or_else(|| {
                    format!("value_prefix on {key:?} — restricted to pseudo-keys")
                })?;
                Predicate::ValuePrefix(pseudo, prefix.as_str().into())
            }
        })
    }

    fn build(&mut self, raw: RawRegistry) -> Result<Registry, String> {
        const OPS: [&str; 4] = ["present", "eq", "key_prefix", "value_prefix"];
        if raw.algebra.ops.len() != OPS.len()
            || !OPS.iter().all(|op| raw.algebra.ops.iter().any(|o| o == op))
        {
            return Err(format!("unexpected algebra ops: {:?}", raw.algebra.ops));
        }
        for key in &raw.algebra.value_prefix_pseudo_keys {
            if PseudoKey::parse(key).is_none() {
                return Err(format!("unknown value_prefix pseudo-key {key:?}"));
            }
        }

        let mut vendors: Vec<Vendor> = Vec::new();
        let mut vendor_ids: HashMap<Box<str>, VendorId> = HashMap::new();
        let mut matchers: Vec<Matcher> = Vec::new();

        let push_vendor = |vendors: &mut Vec<Vendor>,
                           vendor_ids: &mut HashMap<Box<str>, VendorId>,
                           vendor: Vendor|
         -> Result<VendorId, String> {
            let id = u16::try_from(vendors.len()).map_err(|_| "too many vendors".to_string())?;
            if vendor_ids
                .insert(vendor.slug.clone(), VendorId(id))
                .is_some()
            {
                return Err(format!("duplicate vendor slug {:?}", vendor.slug));
            }
            vendors.push(vendor);
            Ok(VendorId(id))
        };

        for raw_vendor in &raw.vendors {
            let mut candidates = Vec::with_capacity(raw_vendor.session_candidates.len());
            for raw_candidate in &raw_vendor.session_candidates {
                let authority = match &raw_candidate.authority_predicate {
                    None => Authority::Always,
                    Some(RawAuthority::One(p)) => Authority::One(self.predicate(p)?),
                    Some(RawAuthority::AnyOf { any_of }) => Authority::AnyOf(
                        any_of
                            .iter()
                            .map(|p| self.predicate(p))
                            .collect::<Result<_, _>>()?,
                    ),
                };
                for token in &raw_candidate.validation {
                    if token != "non_empty" && token != "not_in_decoy_values" {
                        return Err(format!("unknown validation token {token:?}"));
                    }
                }
                candidates.push(SessionCandidate {
                    key: self.lookup_key(&raw_candidate.key)?,
                    authority,
                    require_non_empty: raw_candidate.validation.iter().any(|v| v == "non_empty"),
                    reject_decoy_values: raw_candidate
                        .validation
                        .iter()
                        .any(|v| v == "not_in_decoy_values"),
                    granularity: match raw_candidate.granularity {
                        RawGranularity::Session => Granularity::Session,
                        RawGranularity::Run => Granularity::Run,
                        RawGranularity::User => Granularity::User,
                        RawGranularity::Instance => Granularity::Instance,
                    },
                });
            }

            let vendor = Vendor {
                slug: raw_vendor.vendor.as_str().into(),
                unknown_bucket: false,
                candidates,
                // `decoy_keys` are deliberately not compiled: the rule is "never
                // consult", so the detector must not be able to read one.
                decoy_values: raw_vendor
                    .decoy_values
                    .iter()
                    .map(|d| d.value.as_str().into())
                    .collect(),
            };
            let vendor_id = push_vendor(&mut vendors, &mut vendor_ids, vendor)?;

            for raw_matcher in &raw_vendor.matchers {
                let predicate = self.predicate(&raw_matcher.predicate)?;
                let is_attr = raw_matcher.class == RawClass::Attr;
                if is_attr && raw_matcher.sufficient {
                    return Err("attr matchers must not declare sufficiency".into());
                }
                matchers.push(Matcher {
                    vendor: vendor_id,
                    priority: raw_matcher.priority,
                    kind: if is_attr || raw_matcher.sufficient {
                        HitKind::Unconditional
                    } else {
                        HitKind::Conditional
                    },
                    target: match raw_matcher.class {
                        RawClass::Resource => AttrTarget::Resource,
                        RawClass::Scope => AttrTarget::Scope,
                        RawClass::Attr => AttrTarget::Span,
                    },
                    promotes: is_attr,
                    conditional_slot: None,
                    predicate,
                });
            }
        }

        // Unknown-tier fingerprints join the same table as pseudo-vendors: the
        // priority bands (D4) are what keeps them below every vendor hit, so
        // resolution stays one comparison rather than a second pass.
        for raw_unknown in &raw.unknown_tier {
            if !raw_unknown.bucket.starts_with("unknown:") {
                return Err(format!(
                    "unknown-tier bucket {:?} must use the reserved prefix",
                    raw_unknown.bucket
                ));
            }
            let vendor_id = match vendor_ids.get(raw_unknown.bucket.as_str()) {
                Some(&id) => id,
                None => push_vendor(
                    &mut vendors,
                    &mut vendor_ids,
                    Vendor {
                        slug: raw_unknown.bucket.as_str().into(),
                        unknown_bucket: true,
                        candidates: Vec::new(),
                        decoy_values: Vec::new(),
                    },
                )?,
            };
            let predicate = self.predicate(&raw_unknown.predicate)?;
            matchers.push(Matcher {
                vendor: vendor_id,
                priority: raw_unknown.priority,
                kind: HitKind::Unconditional,
                // Unknown-tier fingerprints carry no class and are span-local, exactly
                // as `collectVendorBranches` compiles them (`"span"` target).
                target: AttrTarget::Span,
                promotes: false,
                conditional_slot: None,
                predicate,
            });
        }

        if matchers.len() > u16::MAX as usize {
            return Err("too many matchers".into());
        }

        let mut conditional = Vec::new();
        for (index, matcher) in matchers.iter_mut().enumerate() {
            if matcher.kind != HitKind::Conditional {
                continue;
            }
            let slot = conditional.len();
            if slot >= MAX_CONDITIONAL {
                return Err(format!(
                    "more than {MAX_CONDITIONAL} conditional matchers needs a wider bitmask"
                ));
            }
            matcher.conditional_slot = Some(slot as u8);
            conditional.push(index as MatcherId);
        }

        // Dispatch tables. A matcher lands in exactly one of them, decided by whether a
        // `ResourceSpans`/`ScopeSpans` already holds everything it reads:
        //
        //  * a `scope`/`resource`-class matcher reads only that list → hoisted;
        //  * any matcher on a `scope.*` pseudo-key reads a scope column → hoisted;
        //  * everything else (attr-class attributes and prefixes, plus any `span.name`
        //    matcher, whatever its class — pseudo-keys ignore class) → per span.
        let mut hoisted_matchers = Vec::new();
        let mut key_matchers = vec![Vec::new(); self.keys.len()];
        let mut prefix_matchers = vec![Vec::new(); self.prefixes.len()];
        let mut span_name_eq: HashMap<Box<str>, Vec<MatcherId>> = HashMap::new();
        let mut span_name_other = Vec::new();
        for (index, matcher) in matchers.iter().enumerate() {
            let id = index as MatcherId;
            match &matcher.predicate {
                Predicate::Eq(LookupKey::Pseudo(PseudoKey::SpanName), value) => {
                    span_name_eq.entry(value.clone()).or_default().push(id)
                }
                Predicate::Present(LookupKey::Pseudo(PseudoKey::SpanName))
                | Predicate::ValuePrefix(PseudoKey::SpanName, _) => span_name_other.push(id),
                _ if matcher.target != AttrTarget::Span => hoisted_matchers.push(id),
                Predicate::Present(LookupKey::Attr(key))
                | Predicate::Eq(LookupKey::Attr(key), _) => key_matchers[*key as usize].push(id),
                Predicate::KeyPrefix(prefix) => prefix_matchers[*prefix as usize].push(id),
                // A span-class matcher on a scope pseudo-key: a column the scope knows.
                Predicate::Present(LookupKey::Pseudo(_))
                | Predicate::Eq(LookupKey::Pseudo(_), _)
                | Predicate::ValuePrefix(_, _) => hoisted_matchers.push(id),
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

        Ok(Registry {
            version: raw.registry_version,
            vendors,
            vendor_ids,
            matchers,
            keys: std::mem::take(&mut self.keys),
            key_ids: std::mem::take(&mut self.key_ids),
            prefixes: std::mem::take(&mut self.prefixes),
            byte_screen,
            key_len_screen,
            prefixes_by_first_byte,
            hoisted_matchers,
            key_matchers,
            prefix_matchers,
            span_name_eq,
            span_name_other,
            conditional,
        })
    }
}

/// Canonical `AnyValue → String` for a *registry-referenced* value, borrowing when
/// the value is already a string (the overwhelmingly common case).
///
/// Delegates to the row writer's `any_value_string` for every other type, so the
/// matcher and the written row see the same bytes — the premise of the §6
/// Rust/SQL alignment contract.
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
    fn the_vendored_registry_loads_and_validates() {
        let registry = registry();
        assert_eq!(registry.version(), 1);
        assert_eq!(
            registry.matchers().len(),
            88 + 5,
            "88 matchers + unknown tier"
        );
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
            assert!(!registry.vendor(id).is_unknown_bucket());
        }
        // D2 applied at compile time: the seed's slug is not producible.
        assert!(registry.vendor_id("langgraph").is_none());
        for bucket in ["unknown:genai", "unknown:openinference", "unknown:other"] {
            let id = registry.vendor_id(bucket).expect("bucket");
            assert!(registry.vendor(id).is_unknown_bucket());
            assert!(registry.vendor(id).candidates().is_empty());
        }
    }

    /// Plan §7: "every registry key/prefix survives the generated prefilter".
    /// `validate` enforces it at load; this states it as a test in its own right and
    /// adds the negative direction.
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

    #[test]
    fn priorities_are_unique_and_banded() {
        let registry = registry();
        let mut priorities: Vec<u32> = registry.matchers().iter().map(|m| m.priority).collect();
        let total = priorities.len();
        priorities.sort_unstable();
        priorities.dedup();
        assert_eq!(priorities.len(), total, "priorities must be unique");

        for matcher in registry.matchers() {
            let vendor = registry.vendor(matcher.vendor);
            if vendor.is_unknown_bucket() {
                assert!(BAND_UNKNOWN.contains(&matcher.priority));
            } else if matcher.kind == HitKind::Unconditional && !matcher.promotes {
                assert!(BAND_SUFFICIENT.contains(&matcher.priority));
            } else {
                assert!(BAND_VENDOR.contains(&matcher.priority));
            }
        }
        // Every unknown-tier fingerprint loses to every vendor matcher.
        let worst_vendor = registry
            .matchers()
            .iter()
            .filter(|m| !registry.vendor(m.vendor).is_unknown_bucket())
            .map(|m| m.priority)
            .min()
            .expect("vendor matchers");
        let best_unknown = registry
            .matchers()
            .iter()
            .filter(|m| registry.vendor(m.vendor).is_unknown_bucket())
            .map(|m| m.priority)
            .max()
            .expect("unknown tier");
        assert!(best_unknown < worst_vendor);
    }

    #[test]
    fn a_fifth_operator_is_a_load_error() {
        let json = r#"{"registry_version":1,
          "algebra":{"ops":["present","eq","key_prefix","value_prefix"],"value_prefix_pseudo_keys":["scope.name"]},
          "unknown_tier":[],
          "vendors":[{"vendor":"x","matchers":[{"class":"attr","sufficient":false,
            "predicate":{"op":"regex","key":"a","value":"b"},"priority":29999}],
            "session_candidates":[],"decoy_values":[]}]}"#;
        assert!(Registry::parse(json).is_err());
    }

    #[test]
    fn value_prefix_outside_the_pseudo_keys_is_a_load_error() {
        let json = r#"{"registry_version":1,
          "algebra":{"ops":["present","eq","key_prefix","value_prefix"],"value_prefix_pseudo_keys":["scope.name"]},
          "unknown_tier":[],
          "vendors":[{"vendor":"x","matchers":[{"class":"attr","sufficient":false,
            "predicate":{"op":"value_prefix","key":"gen_ai.system","prefix":"a"},"priority":29999}],
            "session_candidates":[],"decoy_values":[]}]}"#;
        let error = Registry::parse(json).expect_err("must reject");
        assert!(error.contains("pseudo-keys"), "{error}");
    }

    #[test]
    fn duplicate_priorities_are_a_load_error() {
        let json = r#"{"registry_version":1,
          "algebra":{"ops":["present","eq","key_prefix","value_prefix"],"value_prefix_pseudo_keys":["scope.name"]},
          "unknown_tier":[],
          "vendors":[{"vendor":"x","matchers":[
            {"class":"attr","sufficient":false,"predicate":{"op":"present","key":"a"},"priority":29999},
            {"class":"attr","sufficient":false,"predicate":{"op":"present","key":"b"},"priority":29999}],
            "session_candidates":[],"decoy_values":[]}]}"#;
        let error = Registry::parse(json).expect_err("must reject");
        assert!(error.contains("duplicate priority"), "{error}");
    }

    #[test]
    fn the_unknown_prefix_is_reserved_for_the_fingerprint_tier() {
        let json = r#"{"registry_version":1,
          "algebra":{"ops":["present","eq","key_prefix","value_prefix"],"value_prefix_pseudo_keys":["scope.name"]},
          "unknown_tier":[],
          "vendors":[{"vendor":"unknown:mine","matchers":[],"session_candidates":[],"decoy_values":[]}]}"#;
        let error = Registry::parse(json).expect_err("must reject");
        assert!(error.contains("reserved"), "{error}");
    }

    #[test]
    fn priorities_outside_their_band_are_a_load_error() {
        let json = r#"{"registry_version":1,
          "algebra":{"ops":["present","eq","key_prefix","value_prefix"],"value_prefix_pseudo_keys":["scope.name"]},
          "unknown_tier":[],
          "vendors":[{"vendor":"x","matchers":[
            {"class":"scope","sufficient":true,"predicate":{"op":"eq","key":"scope.name","value":"x"},"priority":29999}],
            "session_candidates":[],"decoy_values":[]}]}"#;
        let error = Registry::parse(json).expect_err("must reject");
        assert!(error.contains("band"), "{error}");
    }
}
