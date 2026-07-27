import { describe, expect, it } from "vitest"
import type { AuditCheckResult } from "@maple/domain/setup-audit"
import { byUrgency, formatAffected } from "../audit-setup"

const check = (overrides: Partial<AuditCheckResult> = {}): AuditCheckResult => ({
	id: "CFG-ALERT-01",
	category: "alerting",
	title: "At least one notification destination is enabled",
	severity: "warn",
	status: "fail",
	detail: null,
	affected: [],
	affectedCount: 0,
	fixHint: "Add a destination.",
	...overrides,
})

describe("byUrgency", () => {
	it("puts findings first, then skipped, then passing", () => {
		const ordered = [
			check({ id: "a", status: "pass" }),
			check({ id: "b", status: "skip" }),
			check({ id: "c", status: "fail" }),
		]
			.sort(byUrgency)
			.map((row) => row.id)
		expect(ordered).toEqual(["c", "b", "a"])
	})

	it("orders findings critical before warn before info", () => {
		const ordered = [
			check({ id: "info", severity: "info" }),
			check({ id: "critical", severity: "critical" }),
			check({ id: "warn", severity: "warn" }),
		]
			.sort(byUrgency)
			.map((row) => row.id)
		expect(ordered).toEqual(["critical", "warn", "info"])
	})

	it("falls back to the check id so the table is stable across runs", () => {
		const ordered = [check({ id: "CFG-B" }), check({ id: "CFG-A" })].sort(byUrgency).map((r) => r.id)
		expect(ordered).toEqual(["CFG-A", "CFG-B"])
	})
})

describe("formatAffected", () => {
	it("renders an em dash when nothing is named", () => {
		expect(formatAffected(check())).toBe("—")
	})

	it("pairs each entity with its evidence", () => {
		const result = formatAffected(
			check({
				affected: [{ kind: "alert_rule", name: "API error rate", note: "no destinations selected" }],
				affectedCount: 1,
			}),
		)
		expect(result).toBe("API error rate (no destinations selected)")
	})

	it("shows at most three entities and counts the rest from the true total", () => {
		const affected = Array.from({ length: 3 }, (_, index) => ({
			kind: "alert_rule" as const,
			name: `rule-${index}`,
		}))
		// affectedCount exceeds affected.length because the registry caps the list at 20.
		const result = formatAffected(check({ affected, affectedCount: 25 }))
		expect(result).toBe("rule-0; rule-1; rule-2; +22 more")
	})

	it("truncates a pathologically long entity list", () => {
		const affected = Array.from({ length: 3 }, (_, index) => ({
			kind: "service" as const,
			name: `service-${index}`,
			note: "x".repeat(200),
		}))
		expect(formatAffected(check({ affected, affectedCount: 3 }))).toHaveLength(160)
	})
})
