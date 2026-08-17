import { expect, test, type Page } from "@playwright/test"

// Benchmarks the /lab/charts gallery, one chart at a time.
//
// Separate from tanstack.perf.spec.ts because the comparison is different in
// kind: that spec pits three RENDERERS against each other over the same
// timeseries charts, while this one pits bespoke hand-rolled implementations
// against their TanStack replacements, and measures the charts Maple has no
// existing implementation of at all.
//
// Sweep shape is per chart. A pie has no x axis — dragging across a donut
// crosses two slices and spends most of the trip over the hole — so it gets an
// angular sweep. Everything else gets the horizontal sweep.

type Arm =
	| "pie-production"
	| "pie-tanstack"
	| "histogram-production"
	| "histogram-tanstack"
	| "heatmap-production"
	| "heatmap-tanstack"
	| "line-production"
	| "line-tanstack"
	| "area-production"
	| "area-tanstack"
	| "stacked-bar-production"
	| "stacked-bar-tanstack"
	| "line-incomplete-production"
	| "line-incomplete-tanstack"
	| "area-incomplete-production"
	| "area-incomplete-tanstack"
	| "stacked-bar-incomplete-tanstack"
	| "box-plot"
	| "trace-scatter"
	| "sankey"
	| "treemap"
	| "line-legend-tanstack"
	| "area-legend-tanstack"
	| "stacked-bar-legend-tanstack"
	| "stacked-bar-legend-scene-tanstack"
	| "pie-legend-tanstack"
	| "treemap-legend"
	| "sankey-legend"

interface ReactRenderMetrics {
	commits: number
	totalActualDurationMs: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
}

interface InteractionMetrics {
	frames: number
	frameP95Ms: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	react: ReactRenderMetrics
}

declare global {
	interface Window {
		__chartsLabBench?: {
			ready: boolean
			beginInteraction: () => void
			endInteraction: () => Promise<InteractionMetrics>
		}
	}
}

const SWEEP_STEPS = 180
/** Fraction of the figure's half-height to trace on a radial sweep. */
const RING_RATIO = 0.34

/** Comparison pairs: the same data through two implementations. */
const PAIRS: ReadonlyArray<readonly [production: Arm, tanstack: Arm]> = [
	["pie-production", "pie-tanstack"],
	["histogram-production", "histogram-tanstack"],
	["heatmap-production", "heatmap-tanstack"],
	["line-production", "line-tanstack"],
	["area-production", "area-tanstack"],
	["stacked-bar-production", "stacked-bar-tanstack"],
	["line-incomplete-production", "line-incomplete-tanstack"],
	["area-incomplete-production", "area-incomplete-tanstack"],
]

/** Charts with no production counterpart — recorded, not compared. */
const NEW_CHARTS: readonly Arm[] = [
	"box-plot",
	"trace-scatter",
	"sankey",
	"treemap",
	// Recharts bars have no incomplete-bucket rendering at all, so there is
	// nothing to pair this against.
	"stacked-bar-incomplete-tanstack",
]

async function measure(page: Page, arm: Arm): Promise<InteractionMetrics> {
	await page.goto(`/lab/charts?arm=${arm}&renderer=tanstack-canvas`)
	await page.waitForFunction(() => window.__chartsLabBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const host = page.locator("[data-chart-arm]").first()

	// Resolve the drawn figure in order of specificity, because the card box is
	// not the chart box:
	//  - the production pie sits left of its legend, so the card centre misses it;
	//  - the production heatmap is a CSS grid of DIVS with no <svg>/<canvas> at
	//    all, occupying the top-left of a 320px card. Locating unconditionally on
	//    `svg, canvas` hangs until the test times out, and sweeping the card's
	//    centre line crosses empty space and records 0 commits — which reads as
	//    "fast" but means "never responded".
	const svgOrCanvas = host.locator("svg, canvas").first()
	const gridBox = host.locator("[style*='grid-template-columns']").first()
	const figure =
		(await svgOrCanvas.count()) > 0 ? svgOrCanvas : (await gridBox.count()) > 0 ? gridBox : host
	const box = await figure.boundingBox()
	if (!box) throw new Error(`${arm} has no figure bounds`)

	const cx = box.x + box.width / 2
	const cy = box.y + box.height / 2

	// Confirm the arm responds to trusted input before measuring — an inert arm
	// otherwise reports a flattering zero.
	await page.mouse.move(cx, cy)
	await page.mouse.move(cx + box.width * 0.2, cy)

	await page.evaluate(() => window.__chartsLabBench!.beginInteraction())
	if (arm.startsWith("pie-")) {
		const radius = Math.min(box.width, box.height) * RING_RATIO
		for (let step = 0; step <= SWEEP_STEPS; step++) {
			const angle = (step / SWEEP_STEPS) * Math.PI * 2
			await page.mouse.move(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
		}
	} else {
		await page.mouse.move(box.x + 2, cy)
		await page.mouse.move(box.x + box.width - 2, cy, { steps: SWEEP_STEPS })
	}
	const metrics = await page.evaluate(() => window.__chartsLabBench!.endInteraction())

	console.log(`[perf] charts-lab ${arm}:`, JSON.stringify(metrics))
	return metrics
}

function row(name: string, m: InteractionMetrics): string {
	return [
		name,
		m.react.totalActualDurationMs.toFixed(1),
		m.react.commits,
		m.droppedFrames,
		m.longTasks,
	].join("\t")
}

test("charts lab: every chart is measured, pairs are compared", async ({ page }) => {
	const results = new Map<Arm, InteractionMetrics>()

	for (const [production, tanstack] of PAIRS) {
		results.set(production, await measure(page, production))
		results.set(tanstack, await measure(page, tanstack))
	}
	for (const arm of NEW_CHARTS) {
		results.set(arm, await measure(page, arm))
	}

	console.log(
		`[perf] charts lab\n${[
			["chart", "reactMs", "commits", "dropped", "longTasks"].join("\t"),
			...[...results].map(([arm, m]) => row(arm, m)),
		].join("\n")}`,
	)

	// Every arm must have done real work — a zero means the chart never responded
	// and its number is meaningless rather than good.
	for (const [arm, metrics] of results) {
		expect(metrics.react.commits, `${arm} responded to the sweep`).toBeGreaterThan(0)
	}

	// Pairs are NOT gated on the TanStack arm winning. The bespoke implementations
	// are hand-rolled SVG/CSS with no per-tick React tooltip store, so several are
	// already cheap; see FINDINGS.md for the numbers. This gate catches the one
	// regression that would matter — an arm re-rendering React on every pointer
	// move — and nothing else.
	for (const [production, tanstack] of PAIRS) {
		const before = results.get(production)!
		const after = results.get(tanstack)!
		expect(after.react.commits, `${tanstack} does not re-render per pointer tick`).toBeLessThanOrEqual(
			Math.max(before.react.commits * 4, 200),
		)
	}

	// No chart may drop frames on a plain hover sweep, whatever its React cost.
	for (const [arm, metrics] of results) {
		expect(metrics.droppedFrames, `${arm} dropped frames`).toBeLessThanOrEqual(2)
	}
})

/**
 * The two legends, priced against each other.
 *
 * Its own test rather than more entries in PAIRS above, for two reasons. The
 * comparison is different in kind — same chart, same data, same renderer, one
 * variable — and the main gate's arm list is what FINDINGS.md's table is keyed
 * on, so growing it would silently change what those numbers mean.
 *
 * The other five legend arms are deliberately NOT measured. A DOM legend costs
 * the same regardless of which mark it sits under, and this pair isolates it; the
 * rest would be five more sweeps confirming the same number. What they exist for
 * is the visual diff, which no gate reads.
 */
test("charts lab: DOM legend versus the package's in-scene legend", async ({ page }) => {
	const dom = await measure(page, "stacked-bar-legend-tanstack")
	const scene = await measure(page, "stacked-bar-legend-scene-tanstack")

	console.log(
		`[perf] legend cost\n${[
			["legend", "reactMs", "commits", "dropped", "longTasks"].join("\t"),
			row("dom", dom),
			row("scene", scene),
		].join("\n")}`,
	)

	// Not gated on either winning — the hover sweep never touches a legend item, so
	// what this records is the standing cost of having one, not the cost of using
	// it. Both must still respond and neither may drop frames.
	for (const [name, metrics] of [
		["dom", dom],
		["scene", scene],
	] as const) {
		expect(metrics.react.commits, `${name} legend arm responded to the sweep`).toBeGreaterThan(0)
		expect(metrics.droppedFrames, `${name} legend arm dropped frames`).toBeLessThanOrEqual(2)
	}
})
