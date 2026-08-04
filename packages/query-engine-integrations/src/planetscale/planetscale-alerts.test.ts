import { describe, expect, it } from "vitest"

import { PLANETSCALE_STORAGE_RUNWAY_SQL, PLANETSCALE_STORAGE_USED_SQL } from "./planetscale-alerts"

// These strings bypass the typed builder, so the alert runtime's contract is
// only enforced here. Without this test a missing macro surfaces as a rule that
// validates on creation and fails on its first evaluation, hours later.
const STATEMENTS = {
	"storage used": PLANETSCALE_STORAGE_USED_SQL,
	"storage runway": PLANETSCALE_STORAGE_RUNWAY_SQL,
}

const DENIED = [
	"INSERT",
	"UPDATE",
	"DELETE",
	"DROP",
	"ALTER",
	"TRUNCATE",
	"RENAME",
	"ATTACH",
	"DETACH",
	"CREATE",
	"GRANT",
	"REVOKE",
	"OPTIMIZE",
	"SYSTEM",
	"KILL",
]

// A plain loop, not describe.each: the generic instantiation describe.each
// produces has OOM'd tsc in this repo before.
for (const [name, sql] of Object.entries(STATEMENTS)) {
	describe(`${name} alert SQL`, () => {
		it("carries both alert-runtime macros", () => {
			expect(sql).toContain("$__orgFilter")
			expect(sql).toMatch(/\$__timeFilter\([A-Za-z_][A-Za-z0-9_.]*\)/)
		})

		it("selects a value column", () => {
			expect(sql).toMatch(/\bAS value\b/)
		})

		it("reports a group so the rule evaluates per branch", () => {
			expect(sql).toMatch(/AS `group`/)
		})

		it("reports a sample count so a thin series can be gated", () => {
			expect(sql).toMatch(/\bsamples\b/)
		})

		it("contains no denied keyword", () => {
			for (const keyword of DENIED) {
				expect(sql).not.toMatch(new RegExp(`\\b${keyword}\\b`, "i"))
			}
		})
	})
}

describe("storage runway", () => {
	it("keeps a non-shrinking volume far from any lt threshold", () => {
		// Without the sentinel a healthy disk produces no runway and a `lt`
		// comparator reads the absence as a breach.
		expect(PLANETSCALE_STORAGE_RUNWAY_SQL).toContain("3650")
	})

	it("refuses to forecast off a handful of datapoints", () => {
		expect(PLANETSCALE_STORAGE_RUNWAY_SQL).toMatch(/HAVING samples >= 60/)
	})
})

describe("storage used", () => {
	it("phrases the percentage as free-space subtracted from the whole", () => {
		// The builder's arithmetic helpers don't parenthesize; this ordering is
		// the one validated in planetscale-map.ts and must not be "simplified".
		expect(PLANETSCALE_STORAGE_USED_SQL).toContain("100 - minIf(")
	})

	it("guards the divisor so a missing capacity series can't divide by zero", () => {
		expect(PLANETSCALE_STORAGE_USED_SQL).toContain("nullIf(")
	})
})
