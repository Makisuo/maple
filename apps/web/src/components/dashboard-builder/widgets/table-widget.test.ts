import { describe, expect, it } from "vitest"
import { formatValueByUnit } from "@maple/ui/format"

import { formatCellValue } from "./table-widget"

describe("formatCellValue", () => {
	it("formats percent cells from the canonical 0–1 ratio (matching formatValueByUnit)", () => {
		// Warehouse errorRate columns are 0–1 ratios; a 2.1% error rate arrives
		// as 0.021 and must render as "2.1%", not "0.0%".
		expect(formatCellValue(0.021, "percent")).toBe("2.1%")
		expect(formatCellValue(1, "percent")).toBe("100.0%")
		expect(formatCellValue(0, "percent")).toBe("0.0%")
	})

	it("leaves non-numeric and unitless values untouched", () => {
		expect(formatCellValue("checkout", "percent")).toBe("checkout")
		expect(formatCellValue(null, "percent")).toBe("-")
		expect(formatCellValue("raw", undefined)).toBe("raw")
	})

	// A unitless numeric column is an id, a commit sha or a small count — the
	// reader needs the digits, not "1.2K".
	it("keeps unitless numbers unabbreviated", () => {
		expect(formatCellValue(1234, undefined)).toBe("1234")
	})

	// Regression: this switch used to be a parallel copy of formatValueByUnit
	// that had no `bytes` case at all, so byte columns fell through to the raw
	// number while the same value in a chart read "314.6 MB".
	it("formats byte columns the way charts and stat tiles do", () => {
		expect(formatCellValue(314_572_800, "bytes")).toBe(formatValueByUnit(314_572_800, "bytes"))
		expect(formatCellValue(314_572_800, "bytes")).not.toBe("314572800")
	})

	// The delegation is the point: every unit @maple/ui knows must render
	// identically in a table, so the two can never drift apart again.
	it("matches formatValueByUnit for every shared unit", () => {
		for (const unit of ["bytes", "number", "percent", "duration_ms", "duration_s", "requests_per_sec"]) {
			expect(formatCellValue(1536, unit), unit).toBe(formatValueByUnit(1536, unit))
		}
	})
})
