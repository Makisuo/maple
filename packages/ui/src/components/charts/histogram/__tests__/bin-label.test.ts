import { describe, expect, it } from "vitest"

import { binLowerBoundLabel } from "../query-builder-histogram-chart"

/**
 * An axis tick has room for one number, so a pre-bucketed bin shows its lower
 * bound and the tooltip keeps the full range.
 *
 * The Recharts implementation did this with
 * `String(value).split("-")[0] || String(value)`, which breaks on any negative
 * lower bound: "-50--20" splits to an empty first element, the `||` fallback
 * fires, and the entire unsplit range prints on a tick sized for one number.
 * Latency histograms are non-negative, which is why it survived.
 */
describe("binLowerBoundLabel", () => {
	it("takes the lower bound of an ordinary range", () => {
		expect(binLowerBoundLabel("150-200")).toBe("150")
	})

	it("keeps the sign on a NEGATIVE lower bound — the bug this replaces", () => {
		expect(binLowerBoundLabel("-50--20")).toBe("-50")
		expect(binLowerBoundLabel("-1.5-2.5")).toBe("-1.5")
	})

	it("handles decimals, thousands separators and exponents", () => {
		expect(binLowerBoundLabel("1.25-2.5")).toBe("1.25")
		expect(binLowerBoundLabel("1,000-2,000")).toBe("1,000")
		expect(binLowerBoundLabel("1e3-2e3")).toBe("1e3")
		expect(binLowerBoundLabel("1.5e-3-2e-3")).toBe("1.5e-3")
	})

	it("KEEPS the unit suffix — dropping it would read as a 1000x error", () => {
		// Extracting the leading NUMBER instead of splitting turns 1.0K into 1.0.
		expect(binLowerBoundLabel("1.0K-2.0K")).toBe("1.0K")
		expect(binLowerBoundLabel("250ms-500ms")).toBe("250ms")
		expect(binLowerBoundLabel("1.5µs-3µs")).toBe("1.5µs")
	})

	it("falls back to the whole label when there is no leading number", () => {
		// An open interval has no upper bound to split on, and a categorical name
		// has no number at all. Both must print as themselves.
		expect(binLowerBoundLabel("400+")).toBe("400+")
		expect(binLowerBoundLabel("unknown")).toBe("unknown")
		expect(binLowerBoundLabel("—")).toBe("—")
	})
})
