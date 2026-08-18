import { describe, expect, it } from "vitest"
import {
	downsample,
	formatValue,
	niceTicks,
	PLOT_HEIGHT,
	renderPlotSvg,
	sparkline,
	type ChartPoint,
} from "./static-chart"

const at = (minutesAgo: number): number => Date.UTC(2026, 7, 18, 14, 32) - minutesAgo * 60_000

const series = (values: ReadonlyArray<number>): ReadonlyArray<ChartPoint> =>
	values.map((v, i) => [at(values.length - 1 - i), v] as ChartPoint)

describe("formatValue", () => {
	it("scales duration by magnitude", () => {
		expect(formatValue(420, "duration_ms")).toBe("420 ms")
		expect(formatValue(1500, "duration_ms")).toBe("1.5 s")
		expect(formatValue(90_000, "duration_ms")).toBe("1.5 min")
	})

	it("keeps two decimals on sub-1% rates, where the difference is the alert", () => {
		expect(formatValue(0.42, "percent")).toBe("0.42%")
		expect(formatValue(4.2, "percent")).toBe("4.2%")
	})
})

describe("niceTicks", () => {
	it("spans zero to above the max", () => {
		const ticks = niceTicks(0.4, 3.9)
		expect(ticks[0]).toBe(0)
		expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(3.9)
	})

	it("does not collapse when every value is identical", () => {
		expect(niceTicks(5, 5).length).toBeGreaterThan(1)
	})
})

describe("downsample", () => {
	const spike = series([1, 1, 1, 9, 1, 1, 1, 1, 1, 1, 1, 1])

	it("keeps the spike that an average would erase", () => {
		const kept = downsample(spike, 5, "above")
		expect(kept.map((p) => p[1])).toContain(9)
		expect(kept.length).toBeLessThanOrEqual(5)
	})

	it("keeps the trough instead when the rule breaches downward", () => {
		const dip = series([9, 9, 9, 1, 9, 9, 9, 9, 9, 9, 9, 9])
		expect(downsample(dip, 5, "below").map((p) => p[1])).toContain(1)
	})

	it("always keeps the first and last point, so the range ends stay true", () => {
		const kept = downsample(spike, 5, "above")
		expect(kept[0]).toEqual(spike[0])
		expect(kept[kept.length - 1]).toEqual(spike[spike.length - 1])
	})

	it("passes a series that already fits through untouched", () => {
		const short = series([1, 2, 3])
		expect(downsample(short, 10, "above")).toBe(short)
	})
})

describe("renderPlotSvg", () => {
	const spec = {
		title: "checkout-api error rate",
		kind: "area",
		unit: "percent",
		points: series([0.8, 1.2, 2.4, 3.9]),
		threshold: 2,
		breachSide: "above",
	} as const

	it("draws no text, because usvg renders none", () => {
		expect(renderPlotSvg(spec).svg).not.toContain("<text")
	})

	it("returns the labels the caller has to draw instead", () => {
		const render = renderPlotSvg(spec)
		expect(render.title).toBe("checkout-api error rate")
		expect(render.latest).toBe("3.9%")
		expect(render.threshold?.text).toBe("2%")
		expect(render.end).toContain("UTC")
	})

	it("places the threshold label on the rule it labels", () => {
		const render = renderPlotSvg(spec)
		const fraction = render.threshold?.yFraction ?? -1
		expect(fraction).toBeGreaterThan(0)
		expect(fraction).toBeLessThan(1)
	})

	it("keeps the threshold on the canvas when every observed value is below it", () => {
		// The rule that matters most is the one nothing has reached yet; drawing
		// it off the top edge is how a chart lies about how close a breach is.
		const render = renderPlotSvg({ ...spec, points: series([0.1, 0.2, 0.15]), threshold: 90 })
		const fraction = render.threshold?.yFraction ?? -1
		expect(fraction).toBeGreaterThanOrEqual(0)
		expect(fraction).toBeLessThanOrEqual(1)
	})

	it("shades the breaching side, and only when a side is meaningful", () => {
		expect(renderPlotSvg(spec).svg).toContain('fill-opacity="0.06"')
		expect(renderPlotSvg({ ...spec, breachSide: "none" }).svg).not.toContain('fill-opacity="0.06"')
	})

	it("omits the rule entirely when the spec has no threshold", () => {
		const render = renderPlotSvg({ ...spec, threshold: null })
		expect(render.threshold).toBeNull()
		expect(render.svg).not.toContain("stroke-dasharray")
	})

	it("sorts unordered points rather than drawing a zigzag", () => {
		const shuffled: ReadonlyArray<ChartPoint> = [
			[at(0), 3],
			[at(30), 1],
			[at(15), 2],
		]
		const render = renderPlotSvg({ ...spec, kind: "line", points: shuffled })
		expect(render.latest).toBe("3%")
		expect(render.svg).toContain(`viewBox="0 0 720 ${PLOT_HEIGHT}"`)
	})

	it("refuses an empty series instead of shipping an empty card", () => {
		expect(() => renderPlotSvg({ ...spec, points: [] })).toThrow(/at least one/)
	})
})

describe("sparkline", () => {
	it("renders one glyph per bucket, rising with the values", () => {
		const spark = sparkline([1, 2, 3, 4, 5, 6, 7, 8])
		expect(spark).toHaveLength(8)
		expect(spark.at(0)).toBe("▁")
		expect(spark.at(-1)).toBe("█")
	})

	it("stays flat rather than dividing by zero on a constant series", () => {
		expect(sparkline([5, 5, 5])).toBe("▄▄▄")
	})

	it("is empty for no data, so callers can test it for truthiness", () => {
		expect(sparkline([])).toBe("")
	})

	it("downsamples to the bucket cap", () => {
		expect(
			sparkline(
				Array.from({ length: 500 }, (_, i) => i),
				24,
			).length,
		).toBeLessThanOrEqual(24)
	})
})
