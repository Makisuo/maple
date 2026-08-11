// The registry gate.
//
// The first block runs every structural invariant against the real, vendored `registry.json`. It is
// what a future re-sync from trace-capture has to pass, and it is the reason the artifact can be
// treated as trusted input everywhere else in this package.
//
// The second block proves each rule actually fires. A validator that returns `[]` for everything
// also returns `[]` for a healthy registry, and that failure mode is invisible from the first block
// alone.

import { describe, expect, it } from "vitest"
import {
	PRIORITY_BANDS,
	UNKNOWN_VENDOR_PREFIX,
	formatRegistryViolations,
	validateRegistry,
	type RegistryViolationCode,
} from "./validate"
import { aiRegistry, type Predicate } from "./schema"
import { testCandidate, testMatcher, testRegistry, testVendor } from "./registry-fixtures"

const codes = (violations: ReadonlyArray<{ code: RegistryViolationCode }>): Array<string> =>
	violations.map((violation) => violation.code)

describe("the vendored registry.json", () => {
	it("decodes and satisfies every structural invariant", () => {
		const violations = validateRegistry()
		expect(formatRegistryViolations(violations)).toBe("")
		expect(violations).toHaveLength(0)
	})

	it("has content, so a truncated re-sync cannot pass by being empty", () => {
		expect(aiRegistry.vendors.length).toBeGreaterThan(15)
		expect(aiRegistry.unknown_tier.length).toBeGreaterThan(0)
		expect(aiRegistry.vendors.flatMap((vendor) => vendor.matchers).length).toBeGreaterThan(50)
	})

	it("gives every matcher a unique priority across the whole document", () => {
		const priorities = [
			...aiRegistry.vendors.flatMap((vendor) => vendor.matchers.map((m) => m.priority)),
			...aiRegistry.unknown_tier.map((rule) => rule.priority),
		]
		expect(new Set(priorities).size).toBe(priorities.length)
	})

	it("keeps the D4 bands separated: sufficient > vendor-conditional > unknown tier", () => {
		const sufficient = aiRegistry.vendors.flatMap((vendor) =>
			vendor.matchers.filter((m) => m.sufficient).map((m) => m.priority),
		)
		const conditional = aiRegistry.vendors.flatMap((vendor) =>
			vendor.matchers.filter((m) => !m.sufficient).map((m) => m.priority),
		)
		const unknown = aiRegistry.unknown_tier.map((rule) => rule.priority)

		expect(Math.min(...sufficient)).toBeGreaterThanOrEqual(PRIORITY_BANDS.sufficient.min)
		expect(Math.min(...sufficient)).toBeGreaterThan(Math.max(...conditional))
		expect(Math.min(...conditional)).toBeGreaterThanOrEqual(PRIORITY_BANDS.vendorConditional.min)
		expect(Math.min(...conditional)).toBeGreaterThan(Math.max(...unknown))
		expect(Math.min(...unknown)).toBeGreaterThanOrEqual(PRIORITY_BANDS.unknownTier.min)
		expect(Math.max(...unknown)).toBeLessThanOrEqual(PRIORITY_BANDS.unknownTier.max)
	})

	it("reserves the unknown: namespace for the fallback tier only", () => {
		for (const vendor of aiRegistry.vendors)
			expect(vendor.vendor.startsWith(UNKNOWN_VENDOR_PREFIX)).toBe(false)
		for (const rule of aiRegistry.unknown_tier)
			expect(rule.bucket.startsWith(UNKNOWN_VENDOR_PREFIX)).toBe(true)
	})

	it("uses only the four algebra operators", () => {
		const ops = new Set(
			[
				...aiRegistry.vendors.flatMap((vendor) => vendor.matchers.map((m) => m.predicate.op)),
				...aiRegistry.unknown_tier.map((rule) => rule.predicate.op),
			].map(String),
		)
		expect([...ops].sort()).toEqual(["eq", "key_prefix", "present"])
	})

	it("justifies every sufficient resource matcher", () => {
		const sufficientResource = aiRegistry.vendors.flatMap((vendor) =>
			vendor.matchers.filter((m) => m.class === "resource" && m.sufficient),
		)
		expect(sufficientResource.length).toBeGreaterThan(0)
		for (const matcher of sufficientResource)
			expect((matcher.justification ?? "").trim().length).toBeGreaterThan(0)
	})

	it("is byte-identical to the sha256 UPSTREAM.json pins", async () => {
		// README.md says the artifact is generated and must never be hand-edited. This is that rule
		// with teeth: a classification bug patched here instead of in trace-capture would silently
		// diverge from the wire-verified seeds, and the next re-sync would drop the fix.
		const { createHash } = await import("node:crypto")
		const { readFile } = await import("node:fs/promises")
		const here = new URL(".", import.meta.url)
		const bytes = await readFile(new URL("registry.json", here))
		const upstream = JSON.parse(await readFile(new URL("UPSTREAM.json", here), "utf8")) as {
			sha256: string
		}
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(upstream.sha256)
	})

	it("never encodes input.value / output.value as standalone unknown-tier fingerprints", () => {
		for (const rule of aiRegistry.unknown_tier) {
			const key = "key" in rule.predicate ? rule.predicate.key : ""
			expect(["input.value", "output.value"]).not.toContain(key)
		}
	})
})

describe("validateRegistry rejects", () => {
	it("duplicate priorities", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [testMatcher({ priority: 29_001, predicate: { op: "present", key: "a.x" } })],
				}),
				testVendor({
					vendor: "b",
					matchers: [testMatcher({ priority: 29_001, predicate: { op: "present", key: "b.x" } })],
				}),
			]),
		)
		expect(codes(violations)).toContain("duplicate_priority")
	})

	it("a vendor slug in the reserved unknown: namespace", () => {
		const violations = validateRegistry(testRegistry([testVendor({ vendor: "unknown:mine" })]))
		expect(codes(violations)).toContain("reserved_vendor_slug")
	})

	it("an unknown-tier bucket outside the reserved namespace", () => {
		const violations = validateRegistry(
			testRegistry(
				[],
				[{ bucket: "genai", predicate: { op: "present", key: "gen_ai.x" }, priority: 19_000 }],
			),
		)
		expect(codes(violations)).toContain("unknown_bucket_not_reserved")
	})

	it("a sufficient matcher priced in the conditional band", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [
						testMatcher({
							class: "scope",
							sufficient: true,
							priority: 21_000,
							justification: "j",
							predicate: { op: "eq", key: "scope.name", value: "a" },
						}),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("priority_out_of_band")
	})

	it("a sufficient resource matcher with no justification", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [
						testMatcher({
							class: "resource",
							sufficient: true,
							priority: 39_000,
							predicate: { op: "eq", key: "telemetry.sdk.name", value: "x" },
						}),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("missing_justification")
	})

	it("a sufficient scope matcher over an app-chosen scope", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [
						testMatcher({
							class: "scope",
							sufficient: true,
							priority: 39_000,
							owned_by: "generic",
							justification: "j",
							predicate: { op: "eq", key: "scope.name", value: "ai" },
						}),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("sufficient_generic_scope")
	})

	it("an insufficient scope matcher no attr matcher can promote", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [
						testMatcher({
							class: "scope",
							sufficient: false,
							priority: 29_000,
							owned_by: "generic",
							justification: "j",
							predicate: { op: "eq", key: "scope.name", value: "org.springframework.boot" },
						}),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("unpromotable_candidate")
	})

	it("value_prefix on a key that is not a pseudo-key", () => {
		// The schema already makes this unrepresentable in TypeScript — hence the cast. The runtime
		// check still has to exist: `validateRegistry` also runs over documents that reached it as
		// plain JSON, which is the case a re-sync produces.
		const badPredicate = { op: "value_prefix", key: "gen_ai.system", prefix: "x" } as unknown as Predicate
		const violations = validateRegistry(
			testRegistry([testVendor({ vendor: "a", matchers: [testMatcher({ predicate: badPredicate })] })]),
		)
		expect(codes(violations)).toContain("value_prefix_not_pseudo_key")
	})

	it("a not_in_decoy_values token with no decoy values behind it", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					session_candidates: [
						testCandidate({
							key: "session.id",
							validation: ["non_empty", "not_in_decoy_values"],
						}),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("decoy_validation_without_values")
	})

	it("a key that is both a session candidate and a decoy key", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					session_candidates: [testCandidate({ key: "session.id" })],
					decoy_keys: [{ key: "session.id", source: "wire", why: "why" }],
				}),
			]),
		)
		expect(codes(violations)).toContain("decoy_key_is_candidate")
	})

	it("a reserved-but-unimplemented matcher class", () => {
		const violations = validateRegistry(
			testRegistry([
				testVendor({
					vendor: "a",
					matchers: [
						testMatcher({ class: "event", predicate: { op: "present", key: "gen_ai.choice" } }),
					],
				}),
			]),
		)
		expect(codes(violations)).toContain("unimplemented_matcher_class")
	})

	it("a standalone input.value fingerprint in the unknown tier", () => {
		const violations = validateRegistry(
			testRegistry(
				[],
				[
					{
						bucket: "unknown:other",
						predicate: { op: "present", key: "input.value" },
						priority: 19_000,
					},
				],
			),
		)
		expect(codes(violations)).toContain("standalone_io_fingerprint")
	})
})
