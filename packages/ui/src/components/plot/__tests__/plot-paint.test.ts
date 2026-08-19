import { describe, expect, it } from "vitest"

import { roundCapDasharray, verticalGradient } from "../plot-paint"

describe("roundCapDasharray", () => {
	/**
	 * `lineY` hard-codes `lineCap: "round"`, adding a semicircular cap of radius
	 * strokeWidth/2 to BOTH ends of every dash. A literal "4 4" at a 2.5px stroke
	 * paints 6.5 on / 1.5 off and reads as a wobbly solid line.
	 */
	it("moves the cap out of the dash and into the gap", () => {
		expect(roundCapDasharray(4, 4, 2.5)).toBe("1.5 6.5")
		// Ink drawn stays `on`: 1.5 of dash + 2 * (2.5/2) of cap = 4.
		// Gap seen stays `off`: 6.5 of gap - 2 * (2.5/2) of cap = 4.
	})

	it("is a no-op at zero stroke width", () => {
		expect(roundCapDasharray(4, 4, 0)).toBe("4 4")
	})

	it("keeps a paintable dot rather than collapsing when the cap exceeds the dash", () => {
		// A zero-length dash under a round cap still paints a dot; collapsing to 0
		// would erase the line entirely.
		expect(roundCapDasharray(2, 4, 6)).toBe("0.01 10")
	})
})

describe("verticalGradient", () => {
	it("runs top-to-bottom with the opaque stop at the top", () => {
		const gradient = verticalGradient("g1", "#f00")
		expect(gradient).toMatchObject({ id: "g1", x1: 0, y1: 0, x2: 0, y2: 1 })
		expect(gradient.stops[0].opacity).toBeGreaterThan(gradient.stops[1].opacity)
		expect(gradient.stops.every((stop) => stop.color === "#f00")).toBe(true)
	})
})
