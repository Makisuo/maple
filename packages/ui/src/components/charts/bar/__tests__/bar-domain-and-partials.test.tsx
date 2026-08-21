import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { MAX_BAR_SERIES, OTHER_LABEL } from "../../_shared/bucket-series"
import { QueryBuilderBarChart } from "../query-builder-bar-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the bars
// inspectable as real rects.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

const HOUR = 3_600_000

/** Buckets that all closed hours ago, so nothing is in flight. */
function closedRows(count: number, values: (index: number) => Record<string, number>) {
	const start = Math.floor(Date.now() / HOUR) * HOUR - (count + 2) * HOUR
	return Array.from({ length: count }, (_, index) => ({
		bucket: new Date(start + index * HOUR).toISOString(),
		...values(index),
	}))
}

/**
 * The dashboard shape: hourly buckets anchored to wall-clock now, with NO
 * `partial` flag — `query-builder-timeseries` does not send one, so the trailing
 * in-flight bucket is found by comparing each bucket's end against the clock.
 */
function dashboardRows(lastValue: number) {
	const currentBucketStart = Math.floor(Date.now() / HOUR) * HOUR
	return Array.from({ length: 8 }, (_, index) => ({
		bucket: new Date(currentBucketStart - (7 - index) * HOUR).toISOString(),
		"demo-api": index === 7 ? lastValue : 100,
	}))
}

/** Every y-axis tick label, which is what the resolved domain shows up as. */
function axisLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("text")].map((node) => node.textContent ?? "")
}

/** The painted bars: rects carrying a fill, excluding chrome. */
function barRects(container: HTMLElement): SVGRectElement[] {
	return [...container.querySelectorAll("rect")].filter((rect) => {
		const fill = rect.getAttribute("fill")
		return fill != null && fill !== "none" && fill !== "transparent"
	})
}

describe("query-builder bar: stacked vs grouped domain", () => {
	// Two series that peak in different buckets: side by side the axis only has
	// to reach the largest single value (60), stacked it has to reach the largest
	// per-bucket SUM (70). Getting this wrong clips the top of every column, and
	// it is the one thing `stacked` has to change about the axis.
	const rows = closedRows(3, (index) => ({
		alpha: [60, 20, 30][index] ?? 0,
		bravo: [10, 50, 40][index] ?? 0,
	}))

	it("unstacked reaches the largest single value", () => {
		const { container } = render(<QueryBuilderBarChart data={rows} />)
		const labels = axisLabels(container)
		expect(labels).toContain("60")
		expect(labels).not.toContain("70")
	})

	it("unstacked sits the two series side by side", () => {
		const { container } = render(<QueryBuilderBarChart data={rows} />)
		const bars = barRects(container)
		expect(bars.length).toBe(6)
		// Grouped: six distinct x offsets. Without the group layout every series
		// would be centred on the bucket and there would be three.
		const lefts = new Set(bars.map((rect) => Number(rect.getAttribute("x")).toFixed(2)))
		expect(lefts.size).toBe(6)
		// …and all six share the baseline, which is what separates grouping from
		// stacking.
		const bottoms = new Set(
			bars.map((rect) =>
				(Number(rect.getAttribute("y")) + Number(rect.getAttribute("height"))).toFixed(2),
			),
		)
		expect(bottoms.size).toBe(1)
	})

	it("stacked reaches the largest per-bucket sum", () => {
		const { container } = render(<QueryBuilderBarChart data={rows} stacked />)
		expect(axisLabels(container)).toContain("70")
	})

	it("stacks segments rather than overlaying them", () => {
		const { container } = render(<QueryBuilderBarChart data={rows} stacked />)
		// Bucket 0 is alpha=60 on top of bravo=10 (or the reverse): two rects that
		// share an x and do not overlap vertically. Overlaid bars — what a missing
		// stack layout produces — would share a bottom edge instead.
		const bars = barRects(container)
		expect(bars.length).toBe(6)
		const bottoms = bars.map(
			(rect) => Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")),
		)
		expect(new Set(bottoms.map((value) => value.toFixed(2))).size).toBeGreaterThan(1)
	})
})

describe("query-builder bar: the in-flight bucket", () => {
	it("paints the trailing partial bucket at a reduced fill opacity", () => {
		const { container } = render(<QueryBuilderBarChart data={dashboardRows(40)} />)
		const opacities = barRects(container).map((rect) => rect.getAttribute("fill-opacity"))
		// Exactly one bucket is in flight, and it is the only bar that is not
		// painted at the mark's default (unset) opacity.
		const faded = opacities.filter((value) => value != null && Number(value) < 1)
		expect(faded).toHaveLength(1)
		expect(Number(faded[0])).toBeCloseTo(0.45)
	})

	it("paints every bar solid when every bucket has closed", () => {
		const { container } = render(<QueryBuilderBarChart data={closedRows(6, () => ({ api: 10 }))} />)
		const faded = barRects(container)
			.map((rect) => rect.getAttribute("fill-opacity"))
			.filter((value) => value != null && Number(value) < 1)
		expect(faded).toHaveLength(0)
	})

	it("drops a trailing in-flight bucket that reported nothing", () => {
		// A zero-height bar is invisible either way; what makes this matter is that
		// the empty slot still widens the x extent and narrows every other bar.
		const rows = dashboardRows(0)
		const { container } = render(<QueryBuilderBarChart data={rows} />)
		expect(barRects(container)).toHaveLength(rows.length - 1)
	})

	it("collapses the long tail into one Other column, flag intact", () => {
		// Bar-specific: past a dozen series a stacked column is unreadable, so the
		// tail rolls into "Other" BEFORE the shared model discovers series. That
		// rewrite is also where the in-flight flag is easiest to drop, which is why
		// the fade below is asserted on bucketed data rather than plain data.
		const rows = dashboardRows(40).map((row) => ({
			bucket: row.bucket,
			...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`svc-${index}`, 20 - index])),
		}))
		const { container } = render(<QueryBuilderBarChart data={rows} legend="visible" stacked />)
		const text = container.textContent ?? ""
		expect(text).toContain("Other")
		expect(text).not.toContain("svc-19")
		// 11 surviving series + Other, across the 8 buckets.
		expect(barRects(container)).toHaveLength(12 * rows.length)
		const faded = barRects(container).filter((rect) => {
			const opacity = rect.getAttribute("fill-opacity")
			return opacity != null && Number(opacity) < 1
		})
		expect(faded).toHaveLength(12)
	})

	it("keeps `partial` out of the series list", () => {
		// The Recharts chart excluded only `bucket` when discovering series, so a
		// pipeline-flagged row grew a spurious one-unit "partial" column and a
		// "partial" legend entry.
		const rows = closedRows(3, () => ({ api: 10 })).map((row, index) => ({
			...row,
			partial: index === 2,
		}))
		const { container } = render(<QueryBuilderBarChart data={rows} legend="visible" />)
		expect(container.textContent ?? "").not.toContain("partial")
	})
})

describe("query-builder bar: legend", () => {
	/** Enough series to trip the "Other" bucket, plus one that stays named. */
	const manySeriesRows = closedRows(2, () =>
		Object.fromEntries(
			Array.from({ length: MAX_BAR_SERIES + 4 }, (_, index) => [
				`svc-${index}`,
				// Descending, so the small tail is what gets collapsed.
				100 - index,
			]),
		),
	)

	function legendSwatches(container: HTMLElement): Map<string, string> {
		const byLabel = new Map<string, string>()
		for (const button of container.querySelectorAll("button")) {
			const swatch = button.querySelector("span")
			const label = button.textContent ?? ""
			byLabel.set(label, swatch?.getAttribute("style") ?? "")
		}
		return byLabel
	}

	it("paints the Other bucket neutral rather than in an identity hue", () => {
		const { container } = render(<QueryBuilderBarChart data={manySeriesRows} legend="visible" stacked />)
		const swatches = legendSwatches(container)
		// The collapsed tail is a bucket, not an identity: an "Other" wearing a
		// service's hue reads as a service. Everything else keeps the hashed one,
		// so this only holds if the legend is fed the RECOLOURED series list.
		// `--muted-foreground` has no stylesheet behind it in jsdom, so the token's
		// literal fallback (#a1a1aa) is what lands, normalised to rgb().
		expect(swatches.get(OTHER_LABEL)).toContain("rgb(161, 161, 170)")
		expect(swatches.get("svc-0")).not.toBe(swatches.get(OTHER_LABEL))
	})

	it("renders no legend at all when it is hidden", () => {
		const { container } = render(<QueryBuilderBarChart data={manySeriesRows} />)
		expect(container.querySelectorAll("button")).toHaveLength(0)
	})
})

/**
 * The plot rect, read back off the measurement anchor `PlotFrame` positions
 * from `onRender`. It is the only handle on the region inside the axes, and
 * geometry assertions need it: a bar's `x` is meaningless without knowing where
 * the plot starts.
 */
function plotRect(container: HTMLElement): { x: number; width: number } {
	const node = container.querySelector<HTMLElement>("[data-chart-plot]")
	if (!node) throw new Error("no plot anchor")
	const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform)
	return { x: Number(match?.[1] ?? 0), width: Number.parseFloat(node.style.width) }
}

describe("query-builder bar: a log y axis", () => {
	const rows = closedRows(6, (index) => ({ api: [1, 10, 100, 1000, 30, 5][index] ?? 0 }))

	it("paints bars at finite geometry", () => {
		// `barY` with no `y1` baselines every bar at the DATA value 0, and
		// `scaleLog(0)` is NaN — so every rect came out with `y="NaN"
		// height="NaN"` and the chart painted its axes over an empty plot. The
		// finiteness guard inside the mark checks the data value (0 is finite),
		// never the pixel it maps to, so nothing warned.
		const { container } = render(<QueryBuilderBarChart data={rows} logScale />)
		const bars = barRects(container)
		expect(bars).toHaveLength(6)
		for (const bar of bars) {
			expect(Number.isFinite(Number(bar.getAttribute("y")))).toBe(true)
			expect(Number.isFinite(Number(bar.getAttribute("height")))).toBe(true)
			expect(Number(bar.getAttribute("height"))).toBeGreaterThanOrEqual(0)
		}
	})

	it("paints the bottom band of a stacked log chart", () => {
		// Stacked, the bottom series starts at a cumulative 0 — the same NaN, but
		// only for the series sitting on the axis, so the chart looked merely
		// wrong rather than empty.
		const stackedRows = closedRows(4, () => ({ alpha: 40, bravo: 60 }))
		const { container } = render(<QueryBuilderBarChart data={stackedRows} logScale stacked />)
		const bars = barRects(container)
		expect(bars).toHaveLength(8)
		for (const bar of bars) {
			expect(Number.isFinite(Number(bar.getAttribute("y")))).toBe(true)
			expect(Number.isFinite(Number(bar.getAttribute("height")))).toBe(true)
		}
	})

	it("still stacks segments on a log axis", () => {
		const stackedRows = closedRows(3, () => ({ alpha: 40, bravo: 60 }))
		const { container } = render(<QueryBuilderBarChart data={stackedRows} logScale stacked />)
		// Two segments per column that do not share a bottom edge: an overlay
		// (which is what dropping the library's stack layout would produce) puts
		// both on the baseline.
		const bottoms = barRects(container).map((rect) =>
			(Number(rect.getAttribute("y")) + Number(rect.getAttribute("height"))).toFixed(2),
		)
		expect(new Set(bottoms).size).toBe(2)
	})
})

describe("query-builder bar: bars stay inside the plot", () => {
	it("keeps the first and last columns off the axis gutter", () => {
		// `timeseriesXAxis` hands over the bare `scaleTime` FACTORY, so the domain
		// is inferred as exactly [firstBucket, lastBucket] with no padding. A bar
		// is drawn at `center - bandwidth / 2`, and nothing clips — so the first
		// bar hung 24px into the y-axis tick labels and the last one the same
		// distance past the plot's right edge.
		const rows = closedRows(6, () => ({ api: 50 }))
		const { container } = render(<QueryBuilderBarChart data={rows} />)
		const rect = plotRect(container)
		const bars = barRects(container)
		expect(bars).toHaveLength(6)
		const lefts = bars.map((bar) => Number(bar.getAttribute("x")))
		const rights = bars.map((bar) => Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")))
		expect(Math.min(...lefts)).toBeGreaterThanOrEqual(rect.x - 0.5)
		expect(Math.max(...rights)).toBeLessThanOrEqual(rect.x + rect.width + 0.5)
	})

	it("keeps grouped columns inside the plot too", () => {
		// Grouping halves each bar and offsets it, so the overhang is smaller but
		// the outermost edge of the first group is still the leftmost geometry.
		const rows = closedRows(4, () => ({ alpha: 30, bravo: 20 }))
		const { container } = render(<QueryBuilderBarChart data={rows} />)
		const rect = plotRect(container)
		const bars = barRects(container)
		const lefts = bars.map((bar) => Number(bar.getAttribute("x")))
		const rights = bars.map((bar) => Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")))
		expect(Math.min(...lefts)).toBeGreaterThanOrEqual(rect.x - 0.5)
		expect(Math.max(...rights)).toBeLessThanOrEqual(rect.x + rect.width + 0.5)
	})
})
