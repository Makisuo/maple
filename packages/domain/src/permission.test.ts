import { describe, expect, it } from "vitest"
import { evaluatePermission, isToolVisible, PermissionRule, type PermissionRuleset } from "./permission"

const rules = (...pairs: ReadonlyArray<[string, "allow" | "ask" | "deny"]>): PermissionRuleset =>
	pairs.map(([tool, action]) => new PermissionRule({ tool, action }))

describe("evaluatePermission", () => {
	it("lets the last matching rule win, so a ruleset reads as base plus exceptions", () => {
		const ruleset = rules(["*", "allow"], ["create_*", "deny"], ["create_dashboard", "allow"])

		expect(evaluatePermission(ruleset, "create_dashboard")).toBe("allow")
		expect(evaluatePermission(ruleset, "create_alert_rule")).toBe("deny")
		expect(evaluatePermission(ruleset, "list_dashboards")).toBe("allow")
	})

	it("fails closed on a tool no rule mentions", () => {
		// A ruleset that forgot a newly-added mutating tool must stop and ask, not run it.
		expect(evaluatePermission(rules(["list_*", "allow"]), "delete_everything")).toBe("ask")
		expect(evaluatePermission([], "anything")).toBe("ask")
	})

	it("treats an empty pattern as matching nothing", () => {
		// Inherited from `matchesGlob`, but load-bearing here: an empty `tool` in a stored ruleset
		// must not become a silent wildcard.
		expect(evaluatePermission(rules(["*", "allow"], ["", "deny"]), "list_services")).toBe("allow")
	})

	it("supports single-character wildcards, like the rest of Maple's globs", () => {
		expect(evaluatePermission(rules(["get_?", "allow"]), "get_a")).toBe("allow")
		expect(evaluatePermission(rules(["get_?", "allow"]), "get_ab")).toBe("ask")
	})
})

describe("isToolVisible", () => {
	it("hides only denied tools — an approval-gated one is still offered to the model", () => {
		const ruleset = rules(["*", "allow"], ["create_alert_rule", "ask"], ["run_sql", "deny"])

		expect(isToolVisible(ruleset, "create_alert_rule")).toBe(true)
		expect(isToolVisible(ruleset, "run_sql")).toBe(false)
	})
})
