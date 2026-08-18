import { expect, test, type Page } from "@playwright/test"

// /lab/bench/tanstack renders the three `/` overview charts (throughput area,
// error-rate area, latency lines) off identical rows under one of the two
// TanStack renderers, so the only variable is how the marks are painted.
//
// The `recharts` arm is gone. It rendered the production overview charts as the
// baseline, and those are TanStack now — the arm had become its own opposition.
// The pilot's verdict (canvas ~3.3x less React render work than Recharts) is
// recorded in `apps/web/src/lab/bench/tanstack/FINDINGS.md` §1; what this spec
// still gates is the standing choice between the two renderers, since
// `PlotFrame` defaults to canvas and SVG is what a chart opts into for a CSS
// animation or `motion()`.
//
// Every sweep uses Playwright's TRUSTED input and asserts the arm actually
// responded before the numbers are trusted — an arm that never opens a tooltip
// is a broken benchmark, not a win.

type Renderer = "tanstack-svg" | "tanstack-canvas"

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
		__tanstackBench?: {
			ready: boolean
			beginInteraction: () => void
			endInteraction: () => Promise<InteractionMetrics>
		}
	}
}

const BENCH = "[data-testid='tanstack-chart-bench']"

async function openBench(page: Page, renderer: Renderer) {
	await page.goto(`/lab/bench/tanstack?renderer=${renderer}`)
	await page.waitForFunction(() => window.__tanstackBench?.ready === true, undefined, {
		timeout: 30_000,
	})
}

/** The first chart's plot rect, however the arm happens to draw it. */
async function plotBounds(page: Page, renderer: Renderer) {
	// `[data-chart-plot]` is `PlotFrame`'s own plot-rect handle — the region
	// inside the axes, not the whole card. The bench used to emit a
	// `[data-bench-chart]` wrapper of its own, but that lived in
	// `tanstack-chart.tsx`, which was deleted when the foundation was promoted
	// into `packages/ui`; the selector outlived the element and every arm
	// silently matched nothing.
	const plot = page.locator(`${BENCH} [data-chart-plot]`).first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error(`${renderer} bench chart has no plot bounds`)
	return bounds
}

/** Whether the bench currently shows a tooltip — the "did it respond" check. */
function tooltipCount(page: Page) {
	return page.locator(".ts-chart-tooltip")
}

async function measurePointerSweep(page: Page, renderer: Renderer): Promise<InteractionMetrics> {
	await openBench(page, renderer)
	const bounds = await plotBounds(page, renderer)
	const midY = bounds.y + bounds.height / 2

	// Enter the plot and confirm the arm is actually tracking the pointer before
	// any measurement starts. Without this a silently-inert arm reports a
	// flattering zero.
	await page.mouse.move(bounds.x + 8, midY)
	await page.mouse.move(bounds.x + bounds.width / 2, midY)
	await expect(tooltipCount(page).first(), `${renderer} responds to trusted pointer input`).toBeVisible({
		timeout: 5_000,
	})

	await page.mouse.move(bounds.x + 1, midY)
	await page.evaluate(() => window.__tanstackBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, midY, { steps: 180 })
	const metrics = await page.evaluate(() => window.__tanstackBench!.endInteraction())

	console.log(`[perf] tanstack ${renderer}:`, JSON.stringify(metrics))
	return metrics
}

test("canvas stays at or under the SVG renderer's hover cost", async ({ page }) => {
	const svg = await measurePointerSweep(page, "tanstack-svg")
	const canvas = await measurePointerSweep(page, "tanstack-canvas")

	const table = [
		["renderer", "blockingMs", "reactMs", "commits", "dropped", "longTasks"].join("\t"),
		...(
			[
				["tanstack-svg", svg],
				["tanstack-canvas", canvas],
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
	].join("\n")
	console.log(`[perf] TanStack renderers\n${table}`)

	// Sanity: the SVG control did real work. A zero means the arm never responded
	// and every comparison below is meaningless.
	expect(svg.react.totalActualDurationMs, "SVG control render work").toBeGreaterThan(0)

	// Both arms drive React identically — the definition and the hooks are the
	// same object — so commits should MATCH rather than merely not regress. A
	// divergence means one renderer started scheduling React work of its own.
	expect(canvas.react.commits, "canvas React commits vs SVG").toBeLessThanOrEqual(svg.react.commits)
	// Canvas removes per-mark DOM, which is where the difference actually lands.
	// A small slack: at these sizes both arms are near the floor, and gating on an
	// exact win would fail a quiet runner for being quiet.
	expect(canvas.totalBlockingMs, "canvas blocking ms vs SVG").toBeLessThanOrEqual(
		Math.max(svg.totalBlockingMs, 50),
	)
	expect(canvas.droppedFrames, "canvas dropped frames vs SVG").toBeLessThanOrEqual(svg.droppedFrames + 1)
})

test("focus draws a dashed cursor and a dot on the hovered series", async ({ page }) => {
	// SVG arm only: the canvas arm paints the same marks with no DOM to assert on.
	await openBench(page, "tanstack-svg")
	const bounds = await plotBounds(page, "tanstack-svg")

	// Third chart = latency, the only multi-series one, so "the dot lands on the
	// series nearest the cursor" is actually a claim worth checking.
	const latency = page.locator(`${BENCH} [data-chart-host]`).nth(2)
	const latencyBox = await latency.boundingBox()
	if (!latencyBox) throw new Error("latency bench chart has no bounds")

	await page.mouse.move(bounds.x + 8, latencyBox.y + latencyBox.height / 2)
	await page.mouse.move(latencyBox.x + latencyBox.width / 2, latencyBox.y + latencyBox.height * 0.4)
	await expect(page.locator(".ts-chart-tooltip")).toBeVisible({ timeout: 5_000 })

	const rule = latency.locator(".ts-chart__crosshair line").first()
	await expect(rule, "dashed focus cursor is drawn").toHaveAttribute("stroke-dasharray", "3 3")
	// The library default is 0.35, which is invisible over Maple's dark `--border`.
	await expect(rule, "cursor is drawn at full strength").toHaveAttribute("stroke-opacity", "1")

	// One dot per series at the hovered bucket. The dot layer resolves focus per
	// mark even though the tooltip's `points` does not (bug 2) — focus grouping
	// works for painting but not for reading.
	const dots = latency.locator("circle:visible")
	await expect(dots, "a focus dot on each series").toHaveCount(3)

	const dotFill = await dots.first().getAttribute("fill")
	expect(dotFill, "dot is coloured, not the unresolvable Canvas default").not.toBe(null)
	expect(dotFill, "dot carries a real colour").not.toContain("Canvas")

	const boldRow = page.locator(".ts-chart-tooltip [class*='font-semibold']").first()
	await expect(boldRow, "the nearest series' row is emphasised").toBeVisible()

	// Bug 3, pinned so a fix upstream is noticed: `whenFocused` emits a circle per
	// datum and zero-sizes the unfocused ones, so 435 nodes exist to show 3. The
	// canvas arm pays none of this.
	await expect(latency.locator("circle"), "whenFocused still emits a node per datum").toHaveCount(435)
})

test("both renderer arms draw all three charts without page errors", async ({ page }) => {
	const pageErrors: string[] = []
	page.on("pageerror", (error) => pageErrors.push(error.message))

	for (const renderer of ["tanstack-svg", "tanstack-canvas"] as const) {
		await openBench(page, renderer)
		await expect(page.locator(`${BENCH}[data-bench-renderer='${renderer}']`)).toHaveCount(1)

		// `[data-chart-host]` is the per-chart wrapper `PlotFrame` emits, so it
		// counts charts however the arm paints them.
		const surfaces = page.locator(`${BENCH} [data-chart-host]`)
		await expect(surfaces, `${renderer} renders three charts`).toHaveCount(3)
	}

	expect(pageErrors, "renderer arms throw nothing").toEqual([])
})
