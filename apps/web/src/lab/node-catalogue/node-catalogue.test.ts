import { describe, expect, it } from "vitest"

import { ACTION_GLYPH } from "@/components/investigations/flow/flow-nodes"
import { buildNodeCatalogue } from "./node-catalogue"

const catalogue = buildNodeCatalogue()

/**
 * One narrowing helper per type we assert over. Three explicit predicates rather
 * than one generic `dataOf(type)` — the generic version infers its element type
 * before `T` is bound and hands back the whole data union, which is exactly the
 * narrowing these assertions exist to have.
 */
const spines = catalogue.nodes.flatMap((node) => (node.type === "spine" ? [node.data] : []))
const lenses = catalogue.nodes.flatMap((node) => (node.type === "lens" ? [node.data] : []))
const actions = catalogue.nodes.flatMap((node) => (node.type === "action" ? [node.data] : []))

/**
 * The studio is only worth having if it is exhaustive, and "exhaustive" is not a
 * property anyone re-checks by eye after adding a state. These assertions are the
 * thing that fails when a new glyph, lens state or action kind lands without a
 * cell — the gallery cannot silently stop covering the surface it documents.
 */
describe("node catalogue", () => {
	it("covers every node type the canvas registers", () => {
		const types = new Set(catalogue.nodes.map((node) => node.type))
		expect(types).toEqual(
			new Set(["spine", "lens", "lensOverflow", "pendingVerdict", "action", "actionGhost", "heading"]),
		)
	})

	it("covers every spine glyph", () => {
		const glyphs = new Set(spines.map((data) => data.glyph))
		expect(glyphs).toEqual(new Set(["issue", "check", "incident", "investigation", "verdict"]))
	})

	it("covers current, lifted and live spine emphasis", () => {
		expect(spines.some((data) => data.current === true)).toBe(true)
		expect(spines.some((data) => data.lifted === true)).toBe(true)
		expect(spines.some((data) => data.live === true && data.phase)).toBe(true)
	})

	it("covers every lens icon and every lens badge word", () => {
		const states = lenses.map((data) => data.state)
		expect(new Set(states.map((state) => state.icon))).toEqual(
			new Set(["queued", "running", "reported", "confirmed", "ruledOut", "deadline", "failed"]),
		)
		expect(new Set(states.map((state) => state.word))).toEqual(
			new Set([
				"PENDING",
				"RUNNING",
				"DEADLINE HIT",
				"NO FINDING",
				"REPORTED",
				"CONFIRMED",
				"MERGED",
				"RULED OUT",
			]),
		)
	})

	it("shows a running lens both with and without a progress note", () => {
		const running = lenses.filter((data) => data.state.icon === "running")
		expect(running.some((data) => data.progressNote !== null)).toBe(true)
		expect(running.some((data) => data.progressNote === null)).toBe(true)
	})

	it("covers every action kind", () => {
		const kinds = new Set(actions.map((data) => data.kind))
		expect(kinds).toEqual(new Set(Object.keys(ACTION_GLYPH)))
	})

	it("shows an action with and without a target, and both roadmap promises", () => {
		expect(actions.some((data) => data.target === null)).toBe(true)
		expect(actions.some((data) => data.target !== null)).toBe(true)
		expect(new Set(actions.map((data) => data.promise))).toEqual(
			new Set(["AUTOFIX · SOON", "PULL REQ · SOON"]),
		)
	})

	it("covers every edge kind, live and settled", () => {
		expect(new Set(catalogue.edges.map((edge) => edge.kind))).toEqual(
			new Set(["causal", "fan", "roadmap"]),
		)
		expect(catalogue.edges.some((edge) => edge.live === true)).toBe(true)
		expect(catalogue.edges.some((edge) => edge.live === undefined)).toBe(true)
		expect(catalogue.edges.some((edge) => edge.label)).toBe(true)
	})

	it("gives every edge two real anchors", () => {
		const ids = new Set(catalogue.nodes.map((node) => node.id))
		for (const edge of catalogue.edges) {
			expect(ids.has(edge.source)).toBe(true)
			expect(ids.has(edge.target)).toBe(true)
		}
	})

	it("emits unique ids and non-overlapping cells", () => {
		const ids = catalogue.nodes.map((node) => node.id)
		expect(new Set(ids).size).toBe(ids.length)
		// Every node has to sit inside the bounds the canvas sizes itself from,
		// or fitView frames a graph with cells hanging outside it.
		for (const node of catalogue.nodes) {
			expect(node.position.x).toBeGreaterThanOrEqual(0)
			expect(node.position.x + node.width).toBeLessThanOrEqual(catalogue.width)
			expect(node.position.y + node.height).toBeLessThanOrEqual(catalogue.height)
		}
	})
})
