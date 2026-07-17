import { describe, expect, it } from "vitest"

import { computeServiceShares } from "../service-spectrum-bar"

const T0 = "2026-07-17T00:00:00.000Z"

function span(serviceName: string, offsetMs: number, durationMs: number) {
	return {
		serviceName,
		startTime: new Date(Date.parse(T0) + offsetMs).toISOString(),
		durationMs,
	}
}

describe("computeServiceShares", () => {
	it("does not double-count a child nested inside its parent in the same service", () => {
		const shares = computeServiceShares([
			span("api", 0, 100),
			span("api", 20, 30), // fully inside the parent
		])
		expect(shares).toHaveLength(1)
		expect(shares[0]).toMatchObject({ serviceName: "api", durationMs: 100, percent: 100 })
	})

	it("merges partially overlapping intervals", () => {
		const shares = computeServiceShares([span("api", 0, 60), span("api", 40, 60)])
		expect(shares[0].durationMs).toBe(100)
	})

	it("sums disjoint intervals", () => {
		const shares = computeServiceShares([span("worker", 0, 10), span("worker", 50, 10)])
		expect(shares[0].durationMs).toBe(20)
	})

	it("orders services by share, descending, with percents of the summed union", () => {
		const shares = computeServiceShares([span("small", 0, 25), span("big", 0, 75)])
		expect(shares.map((s) => s.serviceName)).toEqual(["big", "small"])
		expect(shares[0].percent).toBeCloseTo(75)
		expect(shares[1].percent).toBeCloseTo(25)
	})

	it("guards a zero-duration trace with equal shares", () => {
		const shares = computeServiceShares([span("a", 0, 0), span("b", 0, 0)])
		expect(shares).toHaveLength(2)
		expect(shares[0].percent).toBeCloseTo(50)
		expect(shares[1].percent).toBeCloseTo(50)
	})

	it("returns empty for no spans", () => {
		expect(computeServiceShares([])).toEqual([])
	})

	it("ignores spans with unparseable start times", () => {
		const shares = computeServiceShares([span("api", 0, 100), { serviceName: "bad", startTime: "nope", durationMs: 50 }])
		expect(shares).toHaveLength(1)
		expect(shares[0].serviceName).toBe("api")
	})
})
