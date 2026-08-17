import { expect, test, type Page } from "@playwright/test"

// TanStack Charts pilot. /lab/bench/tanstack renders the three `/` overview
// charts (throughput area, error-rate area, latency lines) off identical rows
// under one of three renderers, so the only variable is the charting library.
//
// The bar: TanStack's Canvas renderer must beat Recharts on hover cost. The SVG
// arm is measured and reported but not gated — it is the control that reproduces
// the 2026-08-05 spike's result.
//
// Recharts ignores pointer events whose offsetX/Y is 0, which is what synthetic
// events carry. Every sweep here uses Playwright's trusted input and asserts the
// arm actually responded before the numbers are trusted — a Recharts arm that
// never opens a tooltip is a broken benchmark, not a win.

type Renderer = "recharts" | "tanstack-svg" | "tanstack-canvas"

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
	const plot =
		renderer === "recharts"
			? page.locator(`${BENCH} .recharts-cartesian-grid`).first()
			: page.locator(`${BENCH} [data-bench-chart]`).first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error(`${renderer} bench chart has no plot bounds`)
	return bounds
}

/** Whether this arm currently shows a tooltip — the "did it respond" check. */
function tooltipCount(page: Page, renderer: Renderer) {
	return renderer === "recharts"
		? page.locator("body [data-chart]:not([data-slot='chart'])")
		: page.locator(".ts-chart-tooltip")
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
	await expect(
		tooltipCount(page, renderer).first(),
		`${renderer} responds to trusted pointer input`,
	).toBeVisible({ timeout: 5_000 })

	await page.mouse.move(bounds.x + 1, midY)
	await page.evaluate(() => window.__tanstackBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, midY, { steps: 180 })
	const metrics = await page.evaluate(() => window.__tanstackBench!.endInteraction())

	console.log(`[perf] tanstack ${renderer}:`, JSON.stringify(metrics))
	return metrics
}

test("TanStack Canvas beats Recharts on overview-chart hover cost", async ({ page }) => {
	const recharts = await measurePointerSweep(page, "recharts")
	const svg = await measurePointerSweep(page, "tanstack-svg")
	const canvas = await measurePointerSweep(page, "tanstack-canvas")

	const table = [
		["renderer", "blockingMs", "reactMs", "commits", "dropped", "longTasks"].join("\t"),
		...(
			[
				["recharts", recharts],
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
	console.log(`[perf] TanStack pilot\n${table}`)

	// Sanity: the Recharts baseline did real work. A zero here means the arm never
	// responded and every comparison below is meaningless.
	expect(recharts.react.totalActualDurationMs, "Recharts baseline render work").toBeGreaterThan(0)

	// The pass bar. Canvas removes per-mark DOM cost, which is the one thing
	// Recharts has no answer for — if it cannot win here it cannot win anywhere.
	expect(canvas.totalBlockingMs, "canvas blocking ms vs Recharts").toBeLessThanOrEqual(
		recharts.totalBlockingMs,
	)
	expect(canvas.react.totalActualDurationMs, "canvas React render work vs Recharts").toBeLessThanOrEqual(
		recharts.react.totalActualDurationMs,
	)
	expect(canvas.droppedFrames, "canvas dropped frames vs Recharts").toBeLessThanOrEqual(
		recharts.droppedFrames,
	)
})

test("focus draws a dashed cursor and a dot on the hovered series", async ({ page }) => {
	// SVG arm only: the canvas arm paints the same marks with no DOM to assert on.
	await openBench(page, "tanstack-svg")
	const bounds = await plotBounds(page, "tanstack-svg")

	// Third chart = latency, the only multi-series one, so "the dot lands on the
	// series nearest the cursor" is actually a claim worth checking.
	const latency = page.locator(`${BENCH} [data-bench-chart]`).nth(2)
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

test("every renderer arm draws all three charts without page errors", async ({ page }) => {
	const pageErrors: string[] = []
	page.on("pageerror", (error) => pageErrors.push(error.message))

	for (const renderer of ["recharts", "tanstack-svg", "tanstack-canvas"] as const) {
		await openBench(page, renderer)
		await expect(page.locator(`${BENCH}[data-bench-renderer='${renderer}']`)).toHaveCount(1)

		const surfaces =
			renderer === "recharts"
				? page.locator(`${BENCH} .recharts-wrapper`)
				: page.locator(`${BENCH} [data-bench-chart]`)
		await expect(surfaces, `${renderer} renders three charts`).toHaveCount(3)
	}

	expect(pageErrors, "renderer arms throw nothing").toEqual([])
})
