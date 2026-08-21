import { describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { makeIncidentPushBudget, type IncidentPushClaim } from "./alert-push-budget"

const ORG = Schema.decodeUnknownSync(OrgId)("org_budget_test")

const claim = (ruleId: string, kind: IncidentPushClaim["kind"] = "firing"): IncidentPushClaim => ({
	orgId: ORG,
	ruleId,
	ruleName: `Rule ${ruleId}`,
	severity: "critical",
	linkUrl: "https://app.maple.dev/alerts",
	kind,
})

describe("makeIncidentPushBudget", () => {
	it.effect("gives a rule three banners a tick and counts the rest for the digest", () =>
		Effect.gen(function* () {
			const budget = yield* makeIncidentPushBudget
			const allowed = yield* Effect.forEach([1, 2, 3, 4, 5], () => budget.claim(claim("rule-1")))
			expect(allowed).toEqual([true, true, true, false, false])
			expect(yield* budget.suppressed).toEqual([
				{
					orgId: ORG,
					ruleId: "rule-1",
					ruleName: "Rule rule-1",
					severity: "critical",
					suppressed: 2,
					linkUrl: "https://app.maple.dev/alerts",
				},
			])
		}),
	)

	it.effect("shares are per rule, so one storm cannot silence another rule", () =>
		Effect.gen(function* () {
			const budget = yield* makeIncidentPushBudget
			yield* Effect.forEach([1, 2, 3, 4], () => budget.claim(claim("rule-1")))
			expect(yield* budget.claim(claim("rule-2"))).toBe(true)
		}),
	)

	it.effect("never folds a resolve into the digest, and never spends a rule's share on one", () =>
		Effect.gen(function* () {
			const budget = yield* makeIncidentPushBudget
			const resolves = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
				budget.claim(claim("rule-1", "resolve")),
			)
			expect(resolves).toEqual([true, true, true, true, true])
			// The share is untouched, so the firing side still gets all three.
			expect(yield* Effect.forEach([1, 2, 3, 4], () => budget.claim(claim("rule-1")))).toEqual([
				true,
				true,
				true,
				false,
			])
			expect(yield* budget.suppressed).toEqual([
				expect.objectContaining({ ruleId: "rule-1", suppressed: 1 }),
			])
		}),
	)

	it.effect("stops at the tick-wide ceiling however many rules are breaking", () =>
		Effect.gen(function* () {
			const budget = yield* makeIncidentPushBudget
			const rules = Array.from({ length: 12 }, (_, i) => `rule-${i}`)
			const allowed = yield* Effect.forEach(rules, (rule) =>
				Effect.forEach([1, 2, 3], () => budget.claim(claim(rule))),
			)
			expect(allowed.flat().filter(Boolean)).toHaveLength(25)
		}),
	)
})
