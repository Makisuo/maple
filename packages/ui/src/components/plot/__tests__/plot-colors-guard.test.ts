import { areaY, defineChart, lineY } from "@tanstack/charts"
import { afterEach, describe, expect, it, vi } from "vitest"

import { verticalGradient } from "../plot-paint"
import { warnUnresolvedColors } from "../plot-colors-guard"

/** A definition that points at itself — the walk must not loop on it. */
interface CyclicDefinition {
	stroke: string
	self?: CyclicDefinition
}

/** A definition nested well past the walk's depth cap. */
type NestedDefinition = { stroke: string } | { nested: NestedDefinition }

interface Row {
	date: Date
	value: number
}

const rows: Row[] = [
	{ date: new Date(0), value: 1 },
	{ date: new Date(1000), value: 2 },
]

/** Silences the guard's own output while asserting on it. */
function captureErrors() {
	return vi.spyOn(console, "error").mockImplementation(() => {})
}

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * The guard catches ONE thing: a bare `--token` where a colour belongs, which
 * the canvas paint resolver throws on rather than mispaints. The tests below are
 * built from real `defineChart` output so they measure what the guard can
 * actually reach — the definition's plain structure — instead of the invented
 * `{ marks: [{ stroke }] }` shape the library has never produced, which is how
 * the previous suite passed while the guard was blind.
 */
describe("warnUnresolvedColors", () => {
	it("catches a bare token in a real chart's gradients", () => {
		const errors = captureErrors()
		const definition = defineChart({
			marks: [
				areaY(rows, {
					x: (row: Row) => row.date,
					y: (row: Row) => row.value,
					fill: "url(#band)",
				}),
			],
			gradients: [verticalGradient("band", "--chart-p95")],
		})

		warnUnresolvedColors(definition, "Latency")

		expect(errors).toHaveBeenCalledTimes(2) // one per gradient stop
		expect(errors.mock.calls[0]?.[0]).toMatch(/Latency.*--chart-p95.*definition\.gradients\[0\]/s)
	})

	it("passes a real chart whose gradient colours are resolved literals", () => {
		const errors = captureErrors()
		const definition = defineChart({
			marks: [areaY(rows, { x: (row: Row) => row.date, y: (row: Row) => row.value })],
			gradients: [verticalGradient("band", "oklch(0.7 0.1 250)")],
		})

		warnUnresolvedColors(definition, "Latency")

		expect(errors).not.toHaveBeenCalled()
	})

	it("cannot see mark colours at all — a mark is a closure, not data", () => {
		// Not an endorsement: `lineY` captures `stroke` inside `createMark`, so this
		// broken token is invisible from here. The guard covers the definition's
		// plain structure and nothing else, and this test exists so that stays
		// documented rather than assumed.
		const errors = captureErrors()
		const definition = defineChart({
			marks: [
				lineY(rows, {
					x: (row: Row) => row.date,
					y: (row: Row) => row.value,
					stroke: "--chart-p99",
				}),
			],
		})

		warnUnresolvedColors(definition, "Latency")

		expect(errors).not.toHaveBeenCalled()
	})

	it("leaves var() and currentColor alone — canvas resolves both", () => {
		// The canvas paint resolver assigns each paint to a probe span and reads the
		// computed colour back, so both are valid input; the library's own theme
		// defaults are built from them.
		const errors = captureErrors()

		warnUnresolvedColors({ theme: { foreground: "currentColor", palette: ["var(--chart-1)"] } }, "chart")

		expect(errors).not.toHaveBeenCalled()
	})

	it("never throws, whatever it finds", () => {
		captureErrors()
		expect(() => warnUnresolvedColors({ gradients: [{ stops: [{ color: "--x" }] }] }, "c")).not.toThrow()
	})

	it("survives a self-referential definition", () => {
		const errors = captureErrors()
		const definition: CyclicDefinition = { stroke: "#fff" }
		definition.self = definition

		expect(() => warnUnresolvedColors(definition, "c")).not.toThrow()
		expect(errors).not.toHaveBeenCalled()
	})

	it("stops at the depth cap rather than walking a deep object forever", () => {
		// Nested well past MAX_WALK_DEPTH (6): the guard is a cheap dev tripwire,
		// not an exhaustive validator.
		const errors = captureErrors()
		let deep: NestedDefinition = { stroke: "--too-deep" }
		for (let i = 0; i < 12; i += 1) deep = { nested: deep }

		warnUnresolvedColors(deep, "c")

		expect(errors).not.toHaveBeenCalled()
	})
})
