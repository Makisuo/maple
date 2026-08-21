import { describe, expect, it } from "vitest"
import { __testables } from "@/hooks/use-widget-data"

describe("use-widget-data hidden series transform", () => {
	it("hides an exact series name", () => {
		const transformed = __testables.applyTransform(
			[{ bucket: "2026-04-12T00:00:00.000Z", A: 10, B: 20 }],
			{ hideSeries: { baseNames: ["A"] } },
		)

		expect(transformed).toEqual([{ bucket: "2026-04-12T00:00:00.000Z", B: 20 }])
	})

	it("hides grouped series that share the hidden base name", () => {
		const transformed = __testables.applyTransform(
			[{ bucket: "2026-04-12T00:00:00.000Z", "A: checkout": 10, "B: checkout": 20 }],
			{ hideSeries: { baseNames: ["A"] } },
		)

		expect(transformed).toEqual([{ bucket: "2026-04-12T00:00:00.000Z", "B: checkout": 20 }])
	})

	it("hides previous-period series for both plain and grouped names", () => {
		const transformed = __testables.applyTransform(
			[
				{
					bucket: "2026-04-12T00:00:00.000Z",
					"A (prev)": 5,
					"A: checkout (prev)": 6,
					"B (prev)": 7,
				},
			],
			{ hideSeries: { baseNames: ["A"] } },
		)

		expect(transformed).toEqual([{ bucket: "2026-04-12T00:00:00.000Z", "B (prev)": 7 }])
	})

	it("keeps visible formulas even when their hidden source query is still present in the payload", () => {
		const transformed = __testables.applyTransform(
			[{ bucket: "2026-04-12T00:00:00.000Z", A: 10, B: 20, F1: 0.5 }],
			{ hideSeries: { baseNames: ["A"] } },
		)

		expect(transformed).toEqual([{ bucket: "2026-04-12T00:00:00.000Z", B: 20, F1: 0.5 }])
	})
})

/**
 * `getQueryBuilderTimeseries` answers an empty window with an empty envelope
 * instead of failing (the failure was billed as an error event per tile per
 * refresh). The tile still has to read as "no data": a `sum` transform over zero
 * rows is `0`, which a stat tile would otherwise render as a real measurement.
 */
describe("use-widget-data empty envelope", () => {
	it("recognizes a successful response that carried no rows", () => {
		expect(__testables.isEmptyDataEnvelope({ data: [] })).toBe(true)
		expect(__testables.isEmptyDataEnvelope({ data: [], diagnostics: { queries: [] } })).toBe(true)
	})

	it("leaves a response with rows, or no envelope at all, alone", () => {
		expect(__testables.isEmptyDataEnvelope({ data: [{ bucket: "x", A: 1 }] })).toBe(false)
		expect(__testables.isEmptyDataEnvelope([])).toBe(false)
		expect(__testables.isEmptyDataEnvelope({ data: { total: 0 } })).toBe(false)
		expect(__testables.isEmptyDataEnvelope(null)).toBe(false)
		expect(__testables.isEmptyDataEnvelope(42)).toBe(false)
	})
})
