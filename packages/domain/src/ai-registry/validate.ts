// Structural invariants of the AI-vendor registry that Effect Schema cannot express.
//
// The schema in `./schema` proves the artifact has the right *shape*. This module proves it has
// the right *semantics* — the properties both the Rust detector and the SQL compiler silently
// assume and neither would notice losing:
//
//   - one global, unique, integer priority ranks every matcher (ties make resolution
//     implementation-defined, so plan §1 makes them a CI failure);
//   - the D4 priority bands hold, so band membership stays readable from the number;
//   - the vendor slug set is closed and `unknown:` stays reserved for the fallback tier;
//   - `value_prefix` never escapes its pseudo-keys (amendment D1);
//   - a sufficient resource matcher — the claim that a whole *process* emits exactly one vendor —
//     carries written justification.
//
// These run as Vitest assertions over the real `registry.json` (`./validate.test.ts`). That test is
// the gate a future registry re-sync has to pass. It reports; it never repairs. A violation means
// the upstream compiler in trace-capture produced a bad artifact and must be fixed there — patching
// the vendored JSON here would diverge it from the wire-verified seeds that justify every matcher.

import { PREDICATE_OPS, PSEUDO_KEYS, aiRegistry } from "./schema"
import type { AiRegistryDocument, Matcher, Predicate } from "./schema"

/** Slug namespace reserved for the unknown tier; no vendor may mint one. */
export const UNKNOWN_VENDOR_PREFIX = "unknown:"

/**
 * Amendment D4's mechanical bands.
 *
 * `vendorConditional` covers attr matchers *and* insufficient resource/scope matchers. That is not
 * a widening of D4: a conditional candidate is only ever promoted by an attr hit for the same
 * vendor, so it has to rank in the same band as the matchers that promote it for the global
 * priority order to mean anything.
 */
export const PRIORITY_BANDS = {
	/** Sufficient scope/resource matchers — unconditional hits. */
	sufficient: { min: 30_000, max: 39_999 },
	/** Vendor attr matchers and insufficient (conditional) resource/scope matchers. */
	vendorConditional: { min: 20_000, max: 29_999 },
	/** Unknown-tier fingerprints — always last. */
	unknownTier: { min: 10_000, max: 19_999 },
} as const

export type RegistryViolationCode =
	| "duplicate_priority"
	| "priority_out_of_band"
	| "band_overlap"
	| "duplicate_vendor_slug"
	| "reserved_vendor_slug"
	| "unknown_bucket_not_reserved"
	| "unsupported_op"
	| "algebra_declaration_mismatch"
	| "value_prefix_not_pseudo_key"
	| "missing_justification"
	| "sufficient_attr_matcher"
	| "sufficient_generic_scope"
	| "unpromotable_candidate"
	| "unimplemented_matcher_class"
	| "unimplemented_signal"
	| "decoy_key_is_candidate"
	| "decoy_validation_without_values"
	| "standalone_io_fingerprint"

export interface RegistryViolation {
	readonly code: RegistryViolationCode
	/** Where in the document: a vendor slug, `unknown_tier`, or `algebra`. */
	readonly where: string
	readonly message: string
}

const describePredicate = (predicate: Predicate): string =>
	predicate.op === "key_prefix"
		? `key_prefix(${predicate.prefix})`
		: predicate.op === "present"
			? `present(${predicate.key})`
			: predicate.op === "eq"
				? `eq(${predicate.key}, ${predicate.value})`
				: `value_prefix(${predicate.key}, ${predicate.prefix})`

const bandOf = (matcher: Matcher): { min: number; max: number } =>
	matcher.sufficient ? PRIORITY_BANDS.sufficient : PRIORITY_BANDS.vendorConditional

/**
 * Generic fingerprints that plan §1 permits only in co-occurrence with an OpenInference attribute.
 * The algebra has no conjunction, so the only correct encoding is to omit them — a standalone rule
 * on either key would fire on ordinary custom instrumentation.
 */
const CO_OCCURRENCE_ONLY_KEYS: ReadonlySet<string> = new Set(["input.value", "output.value"])

/**
 * Every structural check, over any registry document. Returns every violation rather than throwing
 * on the first: a broken re-sync usually breaks several rules at once, and one message per run
 * turns a five-minute fix into five CI rounds.
 */
export const validateRegistry = (
	registry: AiRegistryDocument = aiRegistry,
): ReadonlyArray<RegistryViolation> => {
	const violations: RegistryViolation[] = []
	const report = (code: RegistryViolationCode, where: string, message: string): void => {
		violations.push({ code, where, message })
	}

	// --- algebra declaration matches what this package implements -------------------------------
	const declaredOps = [...registry.algebra.ops].sort()
	if (declaredOps.join(",") !== [...PREDICATE_OPS].sort().join(","))
		report(
			"algebra_declaration_mismatch",
			"algebra",
			`declares ops [${registry.algebra.ops.join(", ")}] but this package implements [${PREDICATE_OPS.join(", ")}]`,
		)
	const declaredPseudo = [...registry.algebra.value_prefix_pseudo_keys].sort()
	if (declaredPseudo.join(",") !== [...PSEUDO_KEYS].sort().join(","))
		report(
			"algebra_declaration_mismatch",
			"algebra",
			`declares value_prefix pseudo-keys [${registry.algebra.value_prefix_pseudo_keys.join(", ")}] but this package implements [${PSEUDO_KEYS.join(", ")}]`,
		)

	// --- predicates -----------------------------------------------------------------------------
	const checkPredicate = (predicate: Predicate, where: string): void => {
		if (!(PREDICATE_OPS as ReadonlyArray<string>).includes(predicate.op))
			report("unsupported_op", where, `op '${predicate.op}' is outside the restricted algebra`)
		// The schema already narrows `value_prefix` to pseudo-keys; re-checked here because this
		// function also runs over registries built in tests, which bypass the decode.
		if (
			predicate.op === "value_prefix" &&
			!(PSEUDO_KEYS as ReadonlyArray<string>).includes(predicate.key)
		)
			report(
				"value_prefix_not_pseudo_key",
				where,
				`value_prefix on '${predicate.key}'; allowed only on ${PSEUDO_KEYS.join(", ")}`,
			)
	}

	// --- priorities: unique, integral, banded ----------------------------------------------------
	const seenPriority = new Map<number, string>()
	const claimPriority = (priority: number, where: string): void => {
		const previous = seenPriority.get(priority)
		if (previous !== undefined)
			report(
				"duplicate_priority",
				where,
				`priority ${priority} is already used by ${previous}; priorities must be globally unique`,
			)
		else seenPriority.set(priority, where)
	}

	const slugs = new Set<string>()

	for (const vendor of registry.vendors) {
		const slug = vendor.vendor
		if (slugs.has(slug)) report("duplicate_vendor_slug", slug, `vendor slug '${slug}' appears twice`)
		slugs.add(slug)
		if (slug.startsWith(UNKNOWN_VENDOR_PREFIX))
			report(
				"reserved_vendor_slug",
				slug,
				`'${UNKNOWN_VENDOR_PREFIX}' is reserved for the unknown tier`,
			)

		const attrMatchers = vendor.matchers.filter((matcher) => matcher.class === "attr")

		for (const matcher of vendor.matchers) {
			const where = `${slug}:${describePredicate(matcher.predicate)}`
			checkPredicate(matcher.predicate, where)
			claimPriority(matcher.priority, where)

			if (matcher.class === "event" || matcher.class === "event_attr")
				report(
					"unimplemented_matcher_class",
					where,
					`matcher class '${matcher.class}' is reserved in the schema but not implemented in v1`,
				)
			if (matcher.signal !== undefined && matcher.signal !== "traces")
				report(
					"unimplemented_signal",
					where,
					`signal '${matcher.signal}' is reserved but only 'traces' is classified in v1`,
				)

			const band = bandOf(matcher)
			if (matcher.priority < band.min || matcher.priority > band.max)
				report(
					"priority_out_of_band",
					where,
					`priority ${matcher.priority} is outside the ${matcher.sufficient ? "sufficient" : "vendor-conditional"} band [${band.min}, ${band.max}]`,
				)

			if (matcher.sufficient) {
				if (matcher.class === "attr")
					report(
						"sufficient_attr_matcher",
						where,
						"sufficiency is a resource/scope concept; an attr matcher is always an unconditional hit at its own priority and must not be flagged sufficient",
					)
				// A sufficient resource matcher claims the whole process emits exactly one vendor —
				// true for a dedicated gateway, false for every application framework. Plan §1 makes
				// the claim require prose.
				if (matcher.class === "resource" && (matcher.justification ?? "").trim() === "")
					report(
						"missing_justification",
						where,
						"a sufficient resource matcher claims the whole process emits exactly one vendor and requires a written justification",
					)
				if (matcher.owned_by === "generic" || matcher.owned_by === "app")
					report(
						"sufficient_generic_scope",
						where,
						`a scope owned_by '${matcher.owned_by}' is app-chosen and can never be sufficient`,
					)
			} else if (matcher.class !== "attr" && attrMatchers.length === 0) {
				// The promotion rule has nothing to promote it with, so the matcher can never
				// contribute a hit — dead weight that reads like coverage.
				report(
					"unpromotable_candidate",
					where,
					`insufficient ${matcher.class} matcher, but '${slug}' declares no attr matcher that could promote it`,
				)
			}
		}

		// --- session candidates -------------------------------------------------------------------
		const decoyKeys = new Set(vendor.decoy_keys.map((decoy) => decoy.key))
		for (const candidate of vendor.session_candidates) {
			const where = `${slug}:candidate(${candidate.key})`
			if (decoyKeys.has(candidate.key))
				report(
					"decoy_key_is_candidate",
					where,
					`'${candidate.key}' is listed both as a session candidate and as a decoy key`,
				)
			if (candidate.validation.includes("not_in_decoy_values") && vendor.decoy_values.length === 0)
				report(
					"decoy_validation_without_values",
					where,
					"validation requires 'not_in_decoy_values' but the vendor declares no decoy_values, so the token is a no-op",
				)
			const authority = candidate.authority_predicate
			if (authority !== null) {
				if ("any_of" in authority)
					for (const predicate of authority.any_of) checkPredicate(predicate, where)
				else checkPredicate(authority, where)
			}
		}
	}

	// --- unknown tier ---------------------------------------------------------------------------
	for (const rule of registry.unknown_tier) {
		const where = `unknown_tier:${rule.bucket}:${describePredicate(rule.predicate)}`
		checkPredicate(rule.predicate, where)
		claimPriority(rule.priority, where)
		if (!rule.bucket.startsWith(UNKNOWN_VENDOR_PREFIX))
			report(
				"unknown_bucket_not_reserved",
				where,
				`unknown-tier bucket '${rule.bucket}' must be namespaced '${UNKNOWN_VENDOR_PREFIX}'`,
			)
		if (rule.priority < PRIORITY_BANDS.unknownTier.min || rule.priority > PRIORITY_BANDS.unknownTier.max)
			report(
				"priority_out_of_band",
				where,
				`priority ${rule.priority} is outside the unknown-tier band [${PRIORITY_BANDS.unknownTier.min}, ${PRIORITY_BANDS.unknownTier.max}]`,
			)
		if (
			(rule.predicate.op === "present" || rule.predicate.op === "eq") &&
			CO_OCCURRENCE_ONLY_KEYS.has(rule.predicate.key)
		)
			report(
				"standalone_io_fingerprint",
				where,
				`'${rule.predicate.key}' may only fire in co-occurrence with an OpenInference attribute; the algebra has no conjunction, so it must be omitted rather than encoded standalone`,
			)
	}

	// --- the bands must not interleave in practice ----------------------------------------------
	const sufficientPriorities = registry.vendors.flatMap((vendor) =>
		vendor.matchers.filter((matcher) => matcher.sufficient).map((matcher) => matcher.priority),
	)
	const conditionalPriorities = registry.vendors.flatMap((vendor) =>
		vendor.matchers.filter((matcher) => !matcher.sufficient).map((matcher) => matcher.priority),
	)
	const unknownPriorities = registry.unknown_tier.map((rule) => rule.priority)
	const strictlyAbove = (lower: ReadonlyArray<number>, upper: ReadonlyArray<number>): boolean =>
		lower.length === 0 || upper.length === 0 || Math.min(...upper) > Math.max(...lower)

	if (!strictlyAbove(conditionalPriorities, sufficientPriorities))
		report(
			"band_overlap",
			"priorities",
			"a sufficient matcher does not outrank every conditional matcher; D4 requires sufficient > vendor-conditional",
		)
	if (!strictlyAbove(unknownPriorities, conditionalPriorities))
		report(
			"band_overlap",
			"priorities",
			"a vendor matcher does not outrank every unknown-tier fingerprint; D4 requires vendor-conditional > unknown tier",
		)

	return violations
}

/** Renders violations for an assertion message. */
export const formatRegistryViolations = (violations: ReadonlyArray<RegistryViolation>): string =>
	violations.map((violation) => `[${violation.code}] ${violation.where}: ${violation.message}`).join("\n")
