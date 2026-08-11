// Minimal hand-built registry documents for the validation and compiler tests.
//
// Built from scratch rather than cloned-and-mutated from `registry.json`: a negative test has to
// say out loud which single property it breaks, and a 280 KB clone with one field poked buries
// that. These fixtures are also the only place `value_prefix` appears at all — the real registry
// declares the operator (amendment D1) but no seed has yet needed it, so without a synthetic
// vendor that branch of the compiler would be untested.

import type { AiRegistryDocument, Matcher, SessionCandidate, UnknownTierRule, Vendor } from "./schema"

export const testMatcher = (overrides: Partial<Matcher> & Pick<Matcher, "predicate">): Matcher => ({
	class: "attr",
	sufficient: false,
	source: "wire",
	priority: 29_000,
	...overrides,
})

export const testCandidate = (
	overrides: Partial<SessionCandidate> & Pick<SessionCandidate, "key">,
): SessionCandidate => ({
	authority_predicate: null,
	validation: ["non_empty"],
	granularity: "session",
	verdict: "A",
	...overrides,
})

export const testVendor = (overrides: Partial<Vendor> & Pick<Vendor, "vendor">): Vendor => ({
	matchers: [],
	session_candidates: [],
	decoy_keys: [],
	decoy_values: [],
	caveats: [],
	...overrides,
})

export const testRegistry = (
	vendors: ReadonlyArray<Vendor>,
	unknownTier: ReadonlyArray<UnknownTierRule> = [],
): AiRegistryDocument => ({
	registry_version: 1,
	generated_by: "test",
	compiled_from: "test",
	decisions: [],
	algebra: {
		ops: ["present", "eq", "key_prefix", "value_prefix"],
		value_prefix_pseudo_keys: ["scope.name", "span.name", "scope.version", "scope.schema_url"],
		canonicalization: "test",
	},
	session_state_enum: {
		"1": "vendor has no session-key rules",
		"2": "span not session-authoritative",
		"3": "authoritative, key absent",
		"4": "key present, failed validation",
		"5": "resolved at run/instance/user granularity",
		"6": "resolved at session granularity",
		reduction: "max over candidates",
	},
	unknown_tier: unknownTier,
	vendors,
})

/**
 * A vendor exercising `value_prefix`, which the shipped registry declares but never uses. Models a
 * hierarchical instrumentation-scope family: everything under `openinference.instrumentation.` is
 * the same dialect, so the rule keys on the scope-name prefix rather than 20 exact names.
 */
export const valuePrefixVendor: Vendor = testVendor({
	vendor: "prefixed_vendor",
	matchers: [
		testMatcher({
			class: "scope",
			sufficient: true,
			priority: 39_000,
			owned_by: "library",
			justification: "test fixture",
			predicate: { op: "value_prefix", key: "scope.name", prefix: "openinference.instrumentation." },
		}),
	],
})
