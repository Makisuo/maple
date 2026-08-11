// Typed view of the vendored AI-vendor classification registry, decoded at module load.
//
// `registry.json` next to this file is a GENERATED artifact (see README.md) copied verbatim from
// the trace-capture repo. Nothing in this directory may hand-fix its data. This module's job is the
// opposite: describe the contract that both targets — the Rust detector in `apps/ingest` and the
// SQL compiler in `./compile-sql` — assume, and fail loudly at import time when a re-sync breaks it.
//
// Why Effect Schema rather than a hand-rolled type assertion: the artifact arrives as untrusted
// JSON from another repo, and the failure mode we care about is a *silent* shape drift (a matcher
// class the compiler skips, a granularity token nothing handles). A decode turns that into an
// import-time error, which is the same gate CI runs.
//
// Reserved-but-unused fields are modelled deliberately (`signal`, the `event`/`event_attr` matcher
// classes). Plan §1 reserves them in the schema for v1 and implements neither; leaving them out
// would make the first registry that uses them fail to decode instead of being ignored.

import { Schema } from "effect"
import registryJson from "./registry.json"

/**
 * The four predicate operators of the restricted algebra (plan §1 + amendment D1).
 *
 * Deliberately closed: no negation, no conjunction, no span-event access, no JSON traversal. The
 * restriction is what makes the Rust and SQL evaluators provably alignable (plan §6).
 */
export const PREDICATE_OPS = ["present", "eq", "key_prefix", "value_prefix"] as const

/**
 * `value_prefix` is restricted to these pseudo-keys, which are real columns on `traces` in SQL and
 * plain byte compares in Rust. Allowing it over arbitrary attribute values would make the algebra
 * unindexable (amendment D1).
 */
export const PSEUDO_KEYS = ["scope.name", "span.name", "scope.version", "scope.schema_url"] as const

export type PseudoKey = (typeof PSEUDO_KEYS)[number]

export const PseudoKeySchema = Schema.Literals(PSEUDO_KEYS)

const PredicatePresent = Schema.Struct({
	op: Schema.Literal("present"),
	key: Schema.String,
})

const PredicateEq = Schema.Struct({
	op: Schema.Literal("eq"),
	key: Schema.String,
	value: Schema.String,
})

const PredicateKeyPrefix = Schema.Struct({
	op: Schema.Literal("key_prefix"),
	prefix: Schema.String,
})

const PredicateValuePrefix = Schema.Struct({
	op: Schema.Literal("value_prefix"),
	key: PseudoKeySchema,
	prefix: Schema.String,
})

/** One predicate of the restricted algebra. */
export const Predicate = Schema.Union([
	PredicatePresent,
	PredicateEq,
	PredicateKeyPrefix,
	PredicateValuePrefix,
])
export type Predicate = Schema.Schema.Type<typeof Predicate>

/**
 * Session-candidate authority predicates are the one place `any_of` appears. It is a bounded
 * disjunction over the same algebra — not general conjunction — so both targets can still compile
 * it to a flat OR. `null` means "every span of this vendor is authoritative".
 */
export const AuthorityPredicate = Schema.NullOr(
	Schema.Union([Predicate, Schema.Struct({ any_of: Schema.Array(Predicate) })]),
)
export type AuthorityPredicate = Schema.Schema.Type<typeof AuthorityPredicate>

/**
 * Matcher classes, in plan §1's hoisting order. `event` / `event_attr` are reserved for the
 * semconv migration of content into span events and are not implemented in v1 — the compiler
 * rejects them rather than silently dropping them.
 */
export const MatcherClass = Schema.Literals(["resource", "scope", "attr", "event", "event_attr"])
export type MatcherClass = Schema.Schema.Type<typeof MatcherClass>

/** Reserved on every matcher; only `traces` is produced today (plan §1). */
export const MatcherSignal = Schema.Literals(["traces", "logs", "metrics"])
export type MatcherSignal = Schema.Schema.Type<typeof MatcherSignal>

export const Matcher = Schema.Struct({
	class: MatcherClass,
	predicate: Predicate,
	/**
	 * Unique across every matcher in the document. Sufficiency gates *participation*; this single
	 * global integer ranks the participants (plan §1). Bands are asserted in `./validate`.
	 */
	priority: Schema.Number.check(Schema.isInt()),
	/**
	 * A sufficient match is an unconditional hit. An insufficient resource/scope match is only a
	 * conditional candidate, promoted at its own priority when the same span independently produces
	 * an attr-matcher hit for the same vendor.
	 */
	sufficient: Schema.Boolean,
	source: Schema.Literals(["wire", "source_code"]),
	/** Who owns the instrumentation scope. `generic`/`app` scopes may never be sufficient. */
	owned_by: Schema.optionalKey(Schema.NullOr(Schema.Literals(["library", "generic", "app"]))),
	/** Required prose on sufficient resource matchers — see `./validate`. */
	justification: Schema.optionalKey(Schema.String),
	signal: Schema.optionalKey(MatcherSignal),
})
export type Matcher = Schema.Schema.Type<typeof Matcher>

/** Documented per-vendor choice; only `session` reaches state 6. */
export const SessionGranularity = Schema.Literals(["session", "run", "user", "instance"])
export type SessionGranularity = Schema.Schema.Type<typeof SessionGranularity>

export const ValidationToken = Schema.Literals(["non_empty", "not_in_decoy_values"])
export type ValidationToken = Schema.Schema.Type<typeof ValidationToken>

export const SessionCandidate = Schema.Struct({
	key: Schema.String,
	authority_predicate: AuthorityPredicate,
	validation: Schema.Array(ValidationToken),
	granularity: SessionGranularity,
	/** Seed-review confidence grade (A best). Carried for the education surface, not evaluated. */
	verdict: Schema.Literals(["A", "B", "C", "D"]),
	source: Schema.optionalKey(Schema.Literals(["wire", "source_code"])),
	note: Schema.optionalKey(Schema.String),
})
export type SessionCandidate = Schema.Schema.Type<typeof SessionCandidate>

/** Keys that look identifying but are not. Never consulted as a session key. */
export const DecoyKey = Schema.Struct({
	key: Schema.String,
	source: Schema.Literals(["wire", "source_code"]),
	why: Schema.String,
})
export type DecoyKey = Schema.Schema.Type<typeof DecoyKey>

/** Literal values that fail `not_in_decoy_values` validation (`"default"`, zero-UUIDs, …). */
export const DecoyValue = Schema.Struct({
	value: Schema.String,
	source: Schema.Literals(["wire", "source_code"]),
	why: Schema.String,
})
export type DecoyValue = Schema.Schema.Type<typeof DecoyValue>

export const Caveat = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String, text: Schema.String })])
export type Caveat = Schema.Schema.Type<typeof Caveat>

export const Variant = Schema.Struct({
	name: Schema.String,
	trigger: Schema.String,
	effects: Schema.String,
	exercised_in_captures: Schema.Boolean,
})
export type Variant = Schema.Schema.Type<typeof Variant>

export const Vendor = Schema.Struct({
	/** Closed-set slug. `unknown:` is reserved for the fallback tier. */
	vendor: Schema.String,
	matchers: Schema.Array(Matcher),
	session_candidates: Schema.Array(SessionCandidate),
	decoy_keys: Schema.Array(DecoyKey),
	decoy_values: Schema.Array(DecoyValue),
	caveats: Schema.Array(Caveat),
	/** Path to the wire-verified seed in trace-capture. Absent for synthesized vendors. */
	seed: Schema.optionalKey(Schema.String),
	goldens_status: Schema.optionalKey(Schema.Literals(["generated", "human_reviewed"])),
	harness_keys_fixture_only: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String }))),
	variants: Schema.optionalKey(Schema.Array(Variant)),
	/** Amendment D2: `langchain` carries `renamed_from: "langgraph"`. */
	renamed_from: Schema.optionalKey(Schema.String),
	/** Amendment D3: `openinference-openai` has no seed of its own. */
	synthesized: Schema.optionalKey(Schema.Boolean),
	justification: Schema.optionalKey(Schema.String),
})
export type Vendor = Schema.Schema.Type<typeof Vendor>

/**
 * Fallback fingerprints for spans that are recognisably AI telemetry but match no vendor.
 *
 * Plan §1 restricts `input.value` / `output.value` to firing only in co-occurrence with an
 * OpenInference attribute. The algebra has no conjunction, so the compiler that produced this
 * artifact honoured the restriction by *omitting* those fingerprints entirely — there is no
 * co-occurrence rule to compile, and `./validate` asserts they never appear standalone.
 */
export const UnknownTierRule = Schema.Struct({
	bucket: Schema.String,
	predicate: Predicate,
	priority: Schema.Number.check(Schema.isInt()),
	signal: Schema.optionalKey(MatcherSignal),
})
export type UnknownTierRule = Schema.Schema.Type<typeof UnknownTierRule>

export const Algebra = Schema.Struct({
	ops: Schema.Array(Schema.String),
	value_prefix_pseudo_keys: Schema.Array(Schema.String),
	canonicalization: Schema.String,
})

/**
 * The frozen state ladder. Values are append-only at v1: the discovery MV persists threshold
 * comparisons over them (`state >= 3` is the eligibility contract), so renumbering would rewrite
 * history (plan §2).
 */
export const AI_SESSION_KEY_STATE = {
	/** Not examined, or no vendor. */
	notExamined: 0,
	/** Vendor has no session-key rules (includes every `unknown:*` bucket). */
	noRules: 1,
	/** Span is not session-authoritative. */
	notAuthoritative: 2,
	/** Authoritative, key absent. */
	keyAbsent: 3,
	/** Key present but failed validation (empty or a decoy value). */
	keyInvalid: 4,
	/** Resolved at `run` / `instance` / `user` granularity. */
	subSession: 5,
	/** Resolved at `session` granularity. */
	session: 6,
} as const

export type AiSessionKeyState = (typeof AI_SESSION_KEY_STATE)[keyof typeof AI_SESSION_KEY_STATE]

/** `state >= 3` — frozen, and the only threshold readers may hard-code (plan §2). */
export const AI_SESSION_KEY_STATE_ELIGIBLE = AI_SESSION_KEY_STATE.keyAbsent

const SessionStateEnum = Schema.Struct({
	"1": Schema.String,
	"2": Schema.String,
	"3": Schema.String,
	"4": Schema.String,
	"5": Schema.String,
	"6": Schema.String,
	reduction: Schema.String,
})

export const AiRegistryDocument = Schema.Struct({
	/** Global UInt32, bumped by any registry change; written to `traces.AiRulesVersion`. */
	registry_version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	generated_by: Schema.String,
	compiled_from: Schema.String,
	decisions: Schema.Array(Schema.String),
	algebra: Algebra,
	session_state_enum: SessionStateEnum,
	unknown_tier: Schema.Array(UnknownTierRule),
	vendors: Schema.Array(Vendor),
})
export type AiRegistryDocument = Schema.Schema.Type<typeof AiRegistryDocument>

const decodeRegistry = Schema.decodeUnknownSync(AiRegistryDocument)

/**
 * Recursively frozen so a consumer that mutates the shared document gets a `TypeError` in
 * development instead of poisoning every later compile in the same process. The registry is a
 * process-wide singleton read once per batch (plan §1), never per span.
 */
const deepFreeze = <A>(value: A): A => {
	if (value === null || typeof value !== "object") return value
	if (Object.isFrozen(value)) return value
	Object.freeze(value)
	for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner)
	return value
}

/**
 * The decoded, frozen registry. Decoding happens once at module load, so a shape drift introduced
 * by a re-sync fails the import — and therefore CI — rather than the first classification.
 */
export const aiRegistry: AiRegistryDocument = deepFreeze(decodeRegistry(registryJson))

/** Convenience lookup; vendor slugs are unique (asserted in `./validate`). */
export const aiRegistryVendorsBySlug: ReadonlyMap<string, Vendor> = new Map(
	aiRegistry.vendors.map((vendor) => [vendor.vendor, vendor]),
)
