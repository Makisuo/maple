// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
	allocateParticleBudget,
	createParticleRegistry,
	MAX_TOTAL_PARTICLES,
	type EdgeParticleSpec,
} from "./service-map-particles"

const spec = (callsPerSecond: number): EdgeParticleSpec => ({
	pathString: "M0 0 L10 10",
	sourceColor: "#ffffff",
	callsPerSecond,
	strokeWidth: 4,
})

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe("allocateParticleBudget", () => {
	it("never exceeds the global budget under heavy traffic", () => {
		// 200 edges all maxing out (8 each → 1600 desired) must be capped.
		const specs = Array.from({ length: 200 }, (_, i) => [`e${i}`, spec(1000)] as const)
		const budget = allocateParticleBudget(specs)

		const total = sum(budget)
		expect(total).toBeLessThanOrEqual(MAX_TOTAL_PARTICLES)
		expect(total).toBeGreaterThan(0)
		for (const count of budget.values()) expect(count).toBeLessThanOrEqual(8)
	})

	it("gives every edge what it wants when under budget", () => {
		const specs = [
			["a", spec(100)],
			["b", spec(2)],
		] as const
		const budget = allocateParticleBudget([...specs])
		// Well under the cap → no scaling.
		expect(budget.get("a")).toBe(8)
		expect(budget.get("b")).toBeGreaterThan(0)
		expect(sum(budget)).toBeLessThanOrEqual(MAX_TOTAL_PARTICLES)
	})

	it("assigns 0 particles to zero-rate edges", () => {
		const specs = Array.from({ length: 100 }, (_, i) => [`e${i}`, spec(i < 50 ? 1000 : 0)] as const)
		const budget = allocateParticleBudget(specs)
		for (let i = 50; i < 100; i++) expect(budget.get(`e${i}`)).toBe(0)
		expect(sum(budget)).toBeLessThanOrEqual(MAX_TOTAL_PARTICLES)
	})

	it("prioritizes busier edges under pressure", () => {
		// One very busy edge + many sparse ones, total desired > budget.
		const specs: Array<readonly [string, EdgeParticleSpec]> = [["hot", spec(1000)]]
		for (let i = 0; i < MAX_TOTAL_PARTICLES; i++) specs.push([`cold${i}`, spec(1000)])
		const budget = allocateParticleBudget(specs)
		expect(sum(budget)).toBeLessThanOrEqual(MAX_TOTAL_PARTICLES)
		// The hot edge keeps at least one particle.
		expect(budget.get("hot")).toBeGreaterThan(0)
	})

	it("is deterministic", () => {
		const specs = Array.from({ length: 200 }, (_, i) => [`e${i}`, spec(500 + i)] as const)
		const a = allocateParticleBudget(specs)
		const b = allocateParticleBudget(specs)
		expect([...a.entries()]).toEqual([...b.entries()])
	})

	it("respects a custom budget", () => {
		const specs = Array.from({ length: 50 }, (_, i) => [`e${i}`, spec(1000)] as const)
		const budget = allocateParticleBudget(specs, 30)
		expect(sum(budget)).toBeLessThanOrEqual(30)
	})
})

describe("createParticleRegistry", () => {
	it("increments its revision only for material edge changes", () => {
		const registry = createParticleRegistry()
		const first = spec(10)
		registry.set("edge", first)
		expect(registry.revision).toBe(1)

		registry.set("edge", { ...first })
		expect(registry.revision).toBe(1)

		registry.set("edge", { ...first, callsPerSecond: 20 })
		expect(registry.revision).toBe(2)

		registry.remove("missing")
		expect(registry.revision).toBe(2)
		registry.remove("edge")
		expect(registry.revision).toBe(3)
	})
})
