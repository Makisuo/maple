import { describe, expect, it } from "vitest"
import { defaultRuleForm } from "@/lib/alerts/form-utils"
import { ALERT_TEMPLATES, applyTemplate } from "@/lib/alerts/templates"

const template = (id: string) => {
	const found = ALERT_TEMPLATES.find((t) => t.id === id)
	if (!found) throw new Error(`missing template ${id}`)
	return found
}

describe("throughput_drop template", () => {
	it("zeroes the minimum sample count so the worst drops still evaluate", () => {
		// The evaluator skips windows below the minimum before comparing the
		// threshold; with the blank form's 50, a drop to 0–49 samples — the very
		// outage the preset exists for — would never breach.
		const applied = applyTemplate(template("throughput_drop"), defaultRuleForm())
		expect(applied.minimumSampleCount).toBe("0")
	})
})

describe("high_error_rate template", () => {
	it("groups by service on an unscoped blank form, matching the MCP template", () => {
		const applied = applyTemplate(template("high_error_rate"), defaultRuleForm())
		expect(applied.groupBy).toEqual(["service.name"])
	})

	it("leaves an explicit service scope alone (scope and grouping are exclusive)", () => {
		const applied = applyTemplate(template("high_error_rate"), defaultRuleForm("checkout"))
		expect(applied.serviceNames).toEqual(["checkout"])
		expect(applied.groupBy).toEqual([])
	})

	it("preserves a grouping the user already chose", () => {
		const base = { ...defaultRuleForm(), groupBy: ["http.route"] }
		const applied = applyTemplate(template("high_error_rate"), base)
		expect(applied.groupBy).toEqual(["http.route"])
	})
})
