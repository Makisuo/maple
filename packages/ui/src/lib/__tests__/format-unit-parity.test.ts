import { describe, expect, it } from "vitest"
import { WIDGET_UNITS } from "@maple/domain/http"
import { formatValueByUnit } from "../format"

/**
 * `WIDGET_UNITS` is the vocabulary offered by the web unit picker and by the MCP
 * schema doc; `formatValueByUnit` is what actually renders. Nothing structural
 * ties them together — the schema field is an open string — so this test is the
 * tie.
 *
 * It exists because of the observed bug: `display.unit` accepted anything, the
 * MCP instructions recommended `"GB"`, and a widget carrying it rendered a bare
 * number with no error at any layer.
 */

// The three tokens the picker offers that deliberately have no `Match.when` arm
// and fall through to `formatNumber`. Listed explicitly so that *adding* a
// pass-through is a decision someone writes down, not a silent omission.
const INTENTIONAL_PASS_THROUGHS = new Set(["number", "none", "short"])

describe("WIDGET_UNITS ↔ formatValueByUnit parity", () => {
	for (const unit of WIDGET_UNITS) {
		if (INTENTIONAL_PASS_THROUGHS.has(unit.token)) {
			it(`"${unit.token}" is an intentional pass-through to formatNumber`, () => {
				expect(formatValueByUnit(1234, unit.token)).toBe(formatValueByUnit(1234, undefined))
			})
			continue
		}

		it(`"${unit.token}" has a real formatter arm`, () => {
			// A token with no arm falls through to `formatNumber`, which is exactly
			// what an unrecognised string does — so "differs from the fallback" is
			// the observable difference between handled and unhandled.
			expect(formatValueByUnit(1234, unit.token)).not.toBe(formatValueByUnit(1234, undefined))
		})
	}

	it("percent expects a 0–1 fraction and scales it by 100", () => {
		expect(formatValueByUnit(0.042, "percent")).toBe("4.2%")
	})

	it("percent_100 expects 0–100 and does not scale", () => {
		expect(formatValueByUnit(4.2, "percent_100")).toBe("4.2%")
	})

	it("the two percent tokens are 100x apart on the same input", () => {
		expect(formatValueByUnit(0.5, "percent")).toBe("50.0%")
		expect(formatValueByUnit(0.5, "percent_100")).toBe("0.5%")
	})

	it("an uncatalogued unit renders as a bare number — the failure mode this catalog guards", () => {
		expect(formatValueByUnit(1234, "GB")).toBe(formatValueByUnit(1234, undefined))
	})
})
