import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { usePlotScales } from "../../../plot"
import { ApdexAreaChart } from "../../area/apdex-area-chart"
import { ErrorRateAreaChart } from "../../area/error-rate-area-chart"
import { ThroughputAreaChart } from "../../area/throughput-area-chart"
import { LatencyLineChart } from "../../line/latency-line-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context).
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

/**
 * Reads the resolved x domain back out of a live chart.
 *
 * The `overlay` slot is the supported way in: `PlotFrame` mounts it inside its
 * own scale/rect providers, which is exactly what the commit-marker layer uses.
 * Asserting on the domain rather than on path geometry is deliberate — the
 * defect was that the AXIS spanned further than the marks, and the domain is the
 * one value both of them are derived from.
 */
function DomainProbe({ onDomain }: { onDomain: (max: number) => void }) {
	const scales = usePlotScales()
	const domain = scales?.x?.domain
	const last = domain?.[domain.length - 1]
	if (last instanceof Date) onDomain(last.getTime())
	return null
}

function readXDomainMax(renderChart: (probe: React.ReactNode) => React.ReactElement): number | undefined {
	let max: number | undefined
	render(renderChart(<DomainProbe onDomain={(value) => (max = value)} />))
	return max
}

/**
 * The service-detail shape. Buckets are anchored to wall-clock `now` so the
 * in-flight tail is genuinely in flight — seeding a fixed historical window
 * would leave `findFirstPartialIndex` with nothing to find and make every
 * assertion below vacuously true.
 *
 * `reported` buckets carry a non-zero `totalCount`; the rest are the shape the
 * server's gap-fill writes — every metric zeroed, `totalCount: 0`, `partial`
 * raised because their window has not closed.
 */
function serviceRows(options: { reported: number; missing: number }) {
	const currentBucketStart = Math.floor(Date.now() / HOUR) * HOUR
	const total = options.reported + options.missing
	return Array.from({ length: total }, (_, index) => {
		const reported = index < options.reported
		return {
			bucket: new Date(currentBucketStart - (total - 1 - index) * HOUR).toISOString(),
			throughput: reported ? 900 + index : 0,
			tracedThroughput: reported ? 900 + index : 0,
			hasSampling: false,
			samplingWeight: 1,
			errorRate: reported ? 0.02 : 0,
			p50LatencyMs: reported ? 120 : 0,
			p95LatencyMs: reported ? 340 : 0,
			p99LatencyMs: reported ? 800 : 0,
			apdexScore: reported ? 0.95 : 0,
			totalCount: reported ? 5_000 : 0,
			partial: !reported,
		}
	})
}

/**
 * The regression. `whenFocused` spreads the mark it wraps, so a focus dot keeps
 * its channels and feeds scale inference even though it paints nothing until
 * hover. Building the dots over the untrimmed rows while the lines and bands
 * were built over the trimmed slices left the x axis running out to a bucket
 * nothing drew — the series read as cut off short of its own axis.
 */
describe("fixed-metric charts: the x domain ends where the data does", () => {
	const rows = serviceRows({ reported: 12, missing: 4 })
	const lastReportedMs = Date.parse(rows[11].bucket)
	const lastRowMs = Date.parse(rows[15].bucket)

	const charts = [
		["latency", (probe: React.ReactNode) => <LatencyLineChart data={rows} overlay={probe} />],
		["apdex", (probe: React.ReactNode) => <ApdexAreaChart data={rows} overlay={probe} />],
		["error rate", (probe: React.ReactNode) => <ErrorRateAreaChart data={rows} overlay={probe} />],
		["throughput", (probe: React.ReactNode) => <ThroughputAreaChart data={rows} overlay={probe} />],
	] as const

	for (const [name, renderChart] of charts) {
		it(`${name} stops at the last reporting bucket`, () => {
			const max = readXDomainMax(renderChart)
			expect(max).toBe(lastReportedMs)
			expect(max).not.toBe(lastRowMs)
		})
	}

	it("puts every panel's axis on the same bucket", () => {
		// These four share one row array on the service grid. Trimming per series
		// let throughput keep buckets latency dropped — `mergeExactThroughput`
		// overlays exact SpanMetrics throughput that materializes ahead of the
		// percentile path, so a tail bucket can carry throughput with no p95.
		const maxima = charts.map(([, renderChart]) => readXDomainMax(renderChart))
		expect(new Set(maxima).size).toBe(1)
	})
})

describe("fixed-metric charts: a real zero is a reading", () => {
	/**
	 * The bucket is in flight and every plotted column is `0` — but it REPORTED,
	 * so `totalCount` is non-zero. Trimming on the value keys would drop it and
	 * end the series an hour early; only the row-level marker gets this right.
	 */
	const rows = serviceRows({ reported: 12, missing: 0 }).map((row, index, all) =>
		index === all.length - 1
			? {
					...row,
					throughput: 0,
					tracedThroughput: 0,
					errorRate: 0,
					p50LatencyMs: 0,
					p95LatencyMs: 0,
					p99LatencyMs: 0,
					apdexScore: 0,
					totalCount: 4_200,
					partial: true,
				}
			: row,
	)

	it("keeps a quiet in-flight bucket that reported", () => {
		const lastMs = Date.parse(rows[rows.length - 1].bucket)
		const max = readXDomainMax((probe) => <ErrorRateAreaChart data={rows} overlay={probe} />)
		expect(max).toBe(lastMs)
	})
})
