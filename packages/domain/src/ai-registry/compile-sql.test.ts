// Compiler unit tests.
//
// These assert on SQL *text*, which is not a contract ClickHouse honours — that is what
// `./compile-sql.clickhouse.e2e.test.ts` is for. What text assertions are good at is pinning the
// algebra decisions that are easy to regress and impossible to see in a passing analyzer run: that
// presence never degrades to `!= ''`, that an insufficient scope match is AND-gated by its
// vendor's attr matchers, and that the branch order is global priority order.

import { describe, expect, it } from "vitest"
import {
	DEFAULT_AI_REGISTRY_SQL_COLUMNS,
	compileAiRegistrySql,
	compilePredicateSql,
	renderAiRegistrySelect,
} from "./compile-sql"
import { aiRegistry } from "./schema"
import { testMatcher, testRegistry, testVendor, valuePrefixVendor } from "./registry-fixtures"

const compiled = compileAiRegistrySql()

describe("predicate algebra", () => {
	it("compiles present to mapContains, never to a non-empty test", () => {
		expect(compilePredicateSql({ op: "present", key: "gen_ai.operation.name" }, "span")).toBe(
			"mapContains(SpanAttributes, 'gen_ai.operation.name')",
		)
	})

	it("keeps mapContains on eq so eq(key, '') stays distinguishable from an absent key", () => {
		expect(compilePredicateSql({ op: "eq", key: "gen_ai.system", value: "" }, "span")).toBe(
			"(SpanAttributes['gen_ai.system'] = '' AND mapContains(SpanAttributes, 'gen_ai.system'))",
		)
	})

	it("compiles key_prefix over the map's keys", () => {
		expect(compilePredicateSql({ op: "key_prefix", prefix: "spring.ai." }, "span")).toBe(
			"arrayExists(k -> startsWith(k, 'spring.ai.'), mapKeys(SpanAttributes))",
		)
	})

	it("resolves value_prefix pseudo-keys to real columns", () => {
		expect(
			compilePredicateSql({ op: "value_prefix", key: "scope.name", prefix: "openinference." }, "scope"),
		).toBe("startsWith(ScopeName, 'openinference.')")
		expect(compilePredicateSql({ op: "value_prefix", key: "span.name", prefix: "Chat." }, "span")).toBe(
			"startsWith(SpanName, 'Chat.')",
		)
	})

	it("targets the map named by the matcher class", () => {
		const predicate = { op: "eq", key: "telemetry.sdk.name", value: "@mastra/otel-exporter" } as const
		expect(compilePredicateSql(predicate, "resource")).toContain("ResourceAttributes[")
		expect(compilePredicateSql(predicate, "scope")).toContain("ScopeAttributes[")
		expect(compilePredicateSql(predicate, "span")).toContain("SpanAttributes[")
	})

	it("resolves pseudo-keys to columns regardless of the matcher class", () => {
		// effect_ai's ATTR matchers key on span.name; class-only targeting would never fire.
		expect(compilePredicateSql({ op: "eq", key: "span.name", value: "Chat.export" }, "span")).toBe(
			"SpanName = 'Chat.export'",
		)
	})

	it("escapes quotes and backslashes in literals", () => {
		expect(compilePredicateSql({ op: "eq", key: "k", value: "it's\\here" }, "span")).toContain(
			"'it\\'s\\\\here'",
		)
	})

	it("honours column-name overrides", () => {
		const shadow = compileAiRegistrySql(aiRegistry, {
			columns: { spanAttributes: "Attrs", scopeName: "Scope" },
		})
		expect(shadow.vendorExpr).toContain("mapKeys(Attrs)")
		expect(shadow.vendorExpr).toContain("Scope = 'litellm'")
		expect(shadow.vendorExpr).not.toContain("SpanAttributes")
	})
})

describe("vendor resolution", () => {
	it("emits a standalone branch for a sufficient scope matcher", () => {
		expect(compiled.vendorExpr).toContain("\tScopeName = 'openinference.instrumentation.agno', 'agno'")
	})

	it("AND-gates an insufficient scope matcher with its own vendor's attr matchers", () => {
		// spring_ai is the canonical promotion case: `org.springframework.boot` is Spring's global
		// Micrometer scope, so a plain HTTP POST under it must stay non-AI.
		expect(compiled.vendorExpr).toContain(
			"\t(ScopeName = 'org.springframework.boot' AND (arrayExists(k -> startsWith(k, 'spring.ai.'), mapKeys(SpanAttributes)) OR (SpanAttributes['gen_ai.system'] = 'spring_ai' AND mapContains(SpanAttributes, 'gen_ai.system')))), 'spring_ai'",
		)
	})

	it("never emits a bare insufficient scope/resource condition", () => {
		for (const vendor of aiRegistry.vendors)
			for (const matcher of vendor.matchers) {
				if (matcher.sufficient || matcher.class === "attr") continue
				const bare = compilePredicateSql(
					matcher.predicate,
					matcher.class === "resource" ? "resource" : "scope",
					DEFAULT_AI_REGISTRY_SQL_COLUMNS,
				)
				expect(compiled.vendorExpr).not.toContain(`\t${bare}, '${vendor.vendor}'`)
			}
	})

	it("drops a conditional candidate no attr matcher could promote", () => {
		const registry = testRegistry([
			testVendor({
				vendor: "orphan",
				matchers: [
					testMatcher({
						class: "scope",
						sufficient: false,
						priority: 29_000,
						predicate: { op: "eq", key: "scope.name", value: "generic" },
					}),
				],
			}),
		])
		expect(compileAiRegistrySql(registry).vendorExpr).toBe("''")
	})

	it("emits attr matchers as standalone branches at their own priority", () => {
		expect(compiled.vendorExpr).toContain(
			"\tarrayExists(k -> startsWith(k, 'spring.ai.'), mapKeys(SpanAttributes)), 'spring_ai'",
		)
	})

	it("compiles value_prefix vendors", () => {
		const sql = compileAiRegistrySql(testRegistry([valuePrefixVendor])).vendorExpr
		expect(sql).toContain("startsWith(ScopeName, 'openinference.instrumentation.'), 'prefixed_vendor'")
	})

	it("orders every branch by descending global priority", () => {
		const order = [
			...aiRegistry.vendors.flatMap((vendor) =>
				vendor.matchers.map((matcher) => ({ priority: matcher.priority, slug: vendor.vendor })),
			),
			...aiRegistry.unknown_tier.map((rule) => ({ priority: rule.priority, slug: rule.bucket })),
		]
			.sort((left, right) => right.priority - left.priority)
			.map((entry) => entry.slug)

		const emitted = compiled.vendorExpr
			.split("\n")
			.map((line) => /, '([^']*)'$/.exec(line.trim().replace(/,$/, "")))
			.flatMap((match) => (match?.[1] === undefined ? [] : [match[1]]))

		// Every emitted slug appears in priority order; dropped branches (unpromotable candidates)
		// are absent from the emitted list but never reorder what remains.
		let cursor = -1
		for (const slug of emitted) {
			const next = order.indexOf(slug, cursor + 1)
			expect(next).toBeGreaterThan(cursor)
			cursor = next
		}
	})

	it("ranks the unknown tier below every vendor branch", () => {
		const lines = compiled.vendorExpr.split("\n")
		const firstUnknown = lines.findIndex((line) => line.includes("'unknown:"))
		const lastVendor = lines.reduce(
			(last, line, index) =>
				/, '(?!unknown:)[a-z]/.test(line) && !line.includes("'unknown:") ? index : last,
			-1,
		)
		expect(firstUnknown).toBeGreaterThan(lastVendor)
	})

	it("falls back to '' — the definitive non-AI answer", () => {
		expect(compiled.vendorExpr.trimEnd().endsWith("\t''\n)")).toBe(true)
	})

	it("never uses !=  '' for presence anywhere in vendor resolution", () => {
		expect(compiled.vendorExpr).not.toContain("!= ''")
	})

	it("never uses lowerUTF8/upperUTF8 (chdb lint ban)", () => {
		const all = compiled.vendorExpr + compiled.sessionStateExpr + compiled.sessionKeyValueExpr
		expect(all).not.toMatch(/lowerUTF8|upperUTF8/)
	})
})

describe("session state", () => {
	it("compiles a single-candidate vendor to the full ladder", () => {
		expect(compiled.sessionStateExpr).toContain(
			[
				"\tAiVendorComputed = 'spring_ai', multiIf(",
				"\t\tNOT ((SpanAttributes['spring.ai.kind'] = 'chat_client' AND mapContains(SpanAttributes, 'spring.ai.kind'))), 2,",
				"\t\tNOT mapContains(SpanAttributes, 'spring.ai.chat.client.conversation.id'), 3,",
				"\t\t(SpanAttributes['spring.ai.chat.client.conversation.id'] = '' OR SpanAttributes['spring.ai.chat.client.conversation.id'] IN ('default')), 4,",
				"\t\t6",
				"\t)",
			].join("\n"),
		)
	})

	it("reduces multiple candidates with greatest()", () => {
		expect(compiled.sessionStateExpr).toContain("AiVendorComputed = 'agno', greatest(")
		// agno: session.id at session granularity (6) and agno.run.id at run granularity (5).
		expect(compiled.sessionStateExpr).toContain("mapContains(SpanAttributes, 'agno.run.id')")
	})

	it("omits the authority branch when every span is authoritative", () => {
		const registry = testRegistry([
			testVendor({
				vendor: "a",
				matchers: [testMatcher({ priority: 29_000, predicate: { op: "present", key: "a.x" } })],
				session_candidates: [
					{
						key: "session.id",
						authority_predicate: null,
						validation: ["non_empty"],
						granularity: "session",
						verdict: "A",
					},
				],
			}),
		])
		const state = compileAiRegistrySql(registry).sessionStateExpr
		expect(state).not.toContain(", 2,")
		expect(state).toContain("NOT mapContains(SpanAttributes, 'session.id'), 3,")
	})

	it("resolves sub-session granularity to 5 and session to 6", () => {
		const build = (granularity: "session" | "run") =>
			compileAiRegistrySql(
				testRegistry([
					testVendor({
						vendor: "a",
						matchers: [
							testMatcher({ priority: 29_000, predicate: { op: "present", key: "a.x" } }),
						],
						session_candidates: [
							{
								key: "k",
								authority_predicate: null,
								validation: [],
								granularity,
								verdict: "A",
							},
						],
					}),
				]),
			).sessionStateExpr
		expect(build("session")).toContain("\t\t6\n")
		expect(build("run")).toContain("\t\t5\n")
	})

	it("falls back to 0 with no vendor and 1 for a vendor without session rules", () => {
		expect(compiled.sessionStateExpr).toContain("if(AiVendorComputed = '', 0, 1)")
	})

	it("gives every unknown:* bucket state 1 by falling through", () => {
		for (const rule of aiRegistry.unknown_tier)
			expect(compiled.sessionStateExpr).not.toContain(`AiVendorComputed = '${rule.bucket}'`)
	})
})

describe("session key value", () => {
	it("selects the first candidate whose state equals the reduced state", () => {
		expect(compiled.sessionKeyValueExpr).toContain("if(AiSessionKeyStateComputed >= 5, multiIf(")
		expect(compiled.sessionKeyValueExpr).toContain(
			"= AiSessionKeyStateComputed, SpanAttributes['session.id']",
		)
	})

	it("yields the raw value, leaving the hash to the caller", () => {
		expect(compiled.sessionKeyValueExpr).not.toMatch(/cityHash64/)
		expect(compiled.vendorExpr).not.toMatch(/cityHash64/)
	})
})

describe("output shape", () => {
	it("carries the registry version", () => {
		expect(compiled.rulesVersion).toBe(aiRegistry.registry_version)
		expect(compiled.rulesVersionExpr).toBe(`toUInt32(${aiRegistry.registry_version})`)
	})

	it("references the vendor and state aliases from the session expressions", () => {
		expect(compiled.sessionStateExpr).toContain(compiled.vendorAlias)
		expect(compiled.sessionKeyValueExpr).toContain(compiled.sessionStateAlias)
	})

	it("is deterministic: compiling twice yields byte-identical SQL", () => {
		const again = compileAiRegistrySql()
		expect(again.vendorExpr).toBe(compiled.vendorExpr)
		expect(again.sessionStateExpr).toBe(compiled.sessionStateExpr)
		expect(again.sessionKeyValueExpr).toBe(compiled.sessionKeyValueExpr)
		expect(renderAiRegistrySelect(again, "traces")).toBe(renderAiRegistrySelect(compiled, "traces"))
	})

	it("layers the three expressions in nested subqueries, each built exactly once", () => {
		// The regression guard for `Query tree is too big`: ClickHouse inlines a SELECT alias at
		// every reference, so a flat select list expands sessionStateExpr once per candidate. A
		// subquery boundary makes each alias a real output column instead.
		const sql = renderAiRegistrySelect(compiled, "traces", { passthrough: ["OrgId", "TraceId"] })
		const occurrences = (needle: string): number => sql.split(needle).length - 1

		expect(occurrences(`AS ${compiled.vendorAlias}`)).toBe(1)
		expect(occurrences(`AS ${compiled.sessionStateAlias}`)).toBe(1)
		expect(occurrences("AS AiSessionKeyValueComputed")).toBe(1)
		// Three projections: outer, state, vendor.
		expect(occurrences("SELECT")).toBe(3)
		expect(sql).toContain("FROM traces")
		expect(sql.indexOf("OrgId")).toBeLessThan(sql.indexOf(`AS ${compiled.sessionStateAlias}`))
	})

	it("balances its parentheses", () => {
		for (const sql of [compiled.vendorExpr, compiled.sessionStateExpr, compiled.sessionKeyValueExpr]) {
			const opens = (sql.match(/\(/g) ?? []).length
			const closes = (sql.match(/\)/g) ?? []).length
			expect(opens).toBe(closes)
		}
	})
})
