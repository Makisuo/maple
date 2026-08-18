import { describe, expect, it } from "vitest"

import { assertResolvedColors } from "../plot-colors-guard"

/** A definition that points at itself — the walk must not loop on it. */
interface CyclicDefinition {
	stroke: string
	self?: CyclicDefinition
}

/** A definition nested well past the walk's depth cap. */
type NestedDefinition = { stroke: string } | { nested: NestedDefinition }

/**
 * The guard exists because `var()` and `currentColor` paint correctly on SVG and
 * resolve to NOTHING on canvas, and both renderers share one definition object.
 * That failure is silent and has shipped before, so it is enforced.
 */
describe("assertResolvedColors", () => {
	it("accepts resolved literals", () => {
		expect(() =>
			assertResolvedColors({ marks: [{ stroke: "#ef4444", fill: "oklch(0.7 0.1 250)" }] }, "chart"),
		).not.toThrow()
	})

	it("rejects a var() token, naming the path", () => {
		expect(() => assertResolvedColors({ marks: [{ stroke: "var(--chart-1)" }] }, "Latency")).toThrow(
			/Latency.*var\(--chart-1\).*definition\.marks\[0\]\.stroke/s,
		)
	})

	it("rejects currentColor regardless of case", () => {
		expect(() => assertResolvedColors({ stroke: "currentColor" }, "c")).toThrow(/currentColor/)
		expect(() => assertResolvedColors({ stroke: "CURRENTCOLOR" }, "c")).toThrow()
	})

	it("does not walk into functions — accessors are not colours", () => {
		expect(() =>
			assertResolvedColors({ marks: [{ y: () => "var(--nope)", stroke: "#fff" }] }, "c"),
		).not.toThrow()
	})

	it("survives a self-referential definition", () => {
		const definition: CyclicDefinition = { stroke: "#fff" }
		definition.self = definition
		expect(() => assertResolvedColors(definition, "c")).not.toThrow()
	})

	it("stops at the depth cap rather than walking a deep object forever", () => {
		// Nested well past MAX_WALK_DEPTH (6): the guard is a cheap dev tripwire,
		// not an exhaustive validator.
		let deep: NestedDefinition = { stroke: "var(--too-deep)" }
		for (let i = 0; i < 12; i += 1) deep = { nested: deep }
		expect(() => assertResolvedColors(deep, "c")).not.toThrow()
	})
})
