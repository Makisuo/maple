import { expect, test, type Page } from "@playwright/test"

// Benchmarks the /lab/charts gallery, one implementation at a time.
//
// Separate from tanstack.perf.spec.ts because the comparison is different in
// kind: that spec pits three RENDERERS against each other over the same
// timeseries charts, while this one pits a bespoke hand-rolled implementation
// against its TanStack replacement.
//
// The sweep is angular, not horizontal. A pie has no x axis — dragging left to
// right across a donut crosses at most two slices and spends most of the sweep
// over the hole. Tracing the ring visits every slice, which is the interaction a
// user actually performs.

type Arm = "production" | "tanstack"

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
/** Fraction of the arm's half-height to trace — lands on the ring, not the hole. */
const RING_RATIO = 0.34

async function measureRingSweep(page: Page, arm: Arm): Promise<InteractionMetrics> {
	await page.goto(`/lab/charts?arm=${arm}&renderer=tanstack-canvas`)
	await page.waitForFunction(() => window.__chartsLabBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const host = page.locator("[data-chart-arm]").first()
	const box = await host.boundingBox()
	if (!box) throw new Error(`${arm} arm has no bounds`)

	// The production pie sits left of its legend, so centre on the drawn figure
	// rather than the card: take the first <svg>/<canvas>, not the wrapper.
	const figure = host.locator("svg, canvas").first()
	const figureBox = await figure.boundingBox()
	if (!figureBox) throw new Error(`${arm} arm has no figure`)

	const cx = figureBox.x + figureBox.width / 2
	const cy = figureBox.y + figureBox.height / 2
	const radius = Math.min(figureBox.width, figureBox.height) * RING_RATIO

	// Confirm the arm actually responds before measuring — an inert arm otherwise
	// reports a flattering zero.
	await page.mouse.move(cx, cy)
	await page.mouse.move(cx + radius, cy)
	await expect(
		page.locator(".ts-chart-tooltip, [data-slot='chart-tooltip']").first(),
		`${arm} responds to trusted pointer input`,
	).toBeVisible({ timeout: 5_000 })

	await page.evaluate(() => window.__chartsLabBench!.beginInteraction())
	for (let step = 0; step <= SWEEP_STEPS; step++) {
		const angle = (step / SWEEP_STEPS) * Math.PI * 2
		await page.mouse.move(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
	}
	const metrics = await page.evaluate(() => window.__chartsLabBench!.endInteraction())

	console.log(`[perf] charts-lab pie ${arm}:`, JSON.stringify(metrics))
	return metrics
}

test("pie: TanStack vs the hand-rolled production implementation", async ({ page }) => {
	const production = await measureRingSweep(page, "production")
	const tanstack = await measureRingSweep(page, "tanstack")

	console.log(
		`[perf] pie\n${[
			["arm", "blockingMs", "reactMs", "commits", "dropped", "longTasks"].join("\t"),
			...(
				[
					["production", production],
					["tanstack", tanstack],
				] as const
			).map(([name, m]) =>
				[
					name,
					m.totalBlockingMs.toFixed(1),
					m.react.totalActualDurationMs.toFixed(1),
					m.react.commits,
					m.droppedFrames,
					m.longTasks,
				].join("\t"),
			),
		].join("\n")}`,
	)

	// Sanity: the production arm did real work, so the comparison means something.
	expect(production.react.totalActualDurationMs, "production baseline render work").toBeGreaterThan(0)

	// Not gated on beating production. The production pie is hand-rolled SVG with
	// no React-per-pointer-tick tooltip store, so it is already cheap — this
	// records the number rather than asserting a win, and fails only on an
	// order-of-magnitude regression that would mean the TanStack arm re-renders
	// React on every pointer move.
	expect(tanstack.react.commits, "tanstack commits within an order of magnitude").toBeLessThanOrEqual(
		Math.max(production.react.commits * 4, 200),
	)
	expect(tanstack.droppedFrames, "tanstack dropped frames").toBeLessThanOrEqual(
		production.droppedFrames + 2,
	)
})
