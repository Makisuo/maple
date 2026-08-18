import { expect, test, type Page } from "@playwright/test"
import { PLOT_SELECTOR } from "./plot-locator"

// Mirrors service-detail.perf.spec.ts for the infra detail chart grids
// (host metric strips, k8s pod/node charts, infra correlation panel). The
// /lab/bench/infra route renders the real ChartViews with synthetic rows in one
// linked-cursor group; ?mode=recharts restores the old syncId event bus as the
// render-storm baseline.

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
		__infraBench?: {
			ready: boolean
			beginInteraction: () => void
			endInteraction: () => Promise<InteractionMetrics>
		}
	}
}

async function measurePointerSweep(page: Page): Promise<InteractionMetrics> {
	await page.goto("/lab/bench/infra")
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator(`[data-testid='infra-chart-bench'] :is(${PLOT_SELECTOR})`).first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Infra benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
	await page.evaluate(() => window.__infraBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 180 })
	const metrics = await page.evaluate(() => window.__infraBench!.endInteraction())

	console.log(`[perf] infra ${mode}:`, JSON.stringify(metrics))
	return metrics
}

/**
 * A sweep is 180 pointer steps over a grid of `CHART_COUNT` charts, so the two
 * outcomes are far apart in commits: a sync storm re-renders EVERY chart on every
 * tick (the Recharts baseline measured 1117-1118, run after run), while the linked
 * cursor costs one chart's own tooltip ticks (247-375 across every run sampled).
 *
 * This used to A/B those two arms directly. It cannot any more — the infra charts
 * moved off Recharts, so there is no storm to measure against, and a ratio with no
 * baseline is not a gate. The ceiling below sits between the two populations: high
 * enough that runner variance on the cursor path cannot reach it, far enough below
 * a storm that a reverted cursor lands well past it.
 *
 * COMMITS, not duration, deliberately. The duration ratio anti-correlated with
 * runner speed — cursor mode has a floor the machine cannot shrink, so a fast,
 * cheap run made the gate LESS likely to pass. Commits are structural.
 */
const CURSOR_COMMIT_CEILING = 600

test("infra chart grids' linked cursor avoids per-chart render storms", async ({ page }) => {
	const cursor = await measurePointerSweep(page)

	console.log(`[perf] infra cursor commits: ${cursor.react.commits}`)

	expect(cursor.react.commits, "linked cursor commits").toBeLessThanOrEqual(CURSOR_COMMIT_CEILING)
	// The long-task COUNT is environmental on GitHub's GPU-less runners, so CI
	// gates on blocking time and local runs on the stricter zero-long-task rule.
	// Same split as logs.perf.spec.ts.
	if (process.env.CI) {
		expect(cursor.totalBlockingMs, "linked cursor blocking ms (CI ceiling)").toBeLessThan(1_000)
	} else {
		expect(cursor.longTasks, "linked cursor long tasks").toBe(0)
	}
})

test("infra charts default to the linked-cursor sync mode", async ({ page }) => {
	// The bench omits the prop, so this exercises the ChartViews' default. A
	// revert of the "cursor" default removes the overlays and fails here.
	await page.goto("/lab/bench/infra")
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	await expect(page.locator("[data-linked-cursor-overlay]")).toHaveCount(4)
	await expect(page.locator("[data-chart-host]")).toHaveCount(4)
})

test("infra cursor keeps one tooltip and linked sibling cursors", async ({ page }) => {
	await page.goto("/lab/bench/infra?mode=cursor")
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator(`[data-linked-cursor-chart='host-cpu'] :is(${PLOT_SELECTOR})`)
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Infra benchmark chart has no plot bounds")

	// Enter the grid first (aligns the overlays), then park mid-plot.
	await page.mouse.move(bounds.x + 5, bounds.y + bounds.height / 2)
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

	await expect(page.locator("[data-linked-cursor-overlay]")).toHaveCount(4)
	await expect(page.locator("[data-linked-cursor-source='']")).toHaveCount(1)

	const visibleLinkedCursors = await page.locator("[data-linked-cursor-overlay]").evaluateAll(
		(cursors) =>
			cursors.filter((cursor) => {
				const style = getComputedStyle(cursor)
				return style.display !== "none" && Number(style.opacity) > 0
			}).length,
	)
	expect(visibleLinkedCursors, "linked cursors shown on sibling charts").toBe(3)

	const siblingAlignmentErrors = await page.locator("[data-linked-cursor-chart]").evaluateAll(
		(cards, plotSelector) =>
			cards.flatMap((card) => {
				const cursor = card.querySelector<HTMLElement>("[data-linked-cursor-overlay]")
				const line = cursor?.firstElementChild
				const plot = card.querySelector<Element>(plotSelector)
				if (!cursor || cursor.hidden || !line || !plot) return []
				const lineBounds = line.getBoundingClientRect()
				const plotBounds = plot.getBoundingClientRect()
				return [Math.abs(lineBounds.x - (plotBounds.x + plotBounds.width / 2))]
			}),
		PLOT_SELECTOR,
	)
	expect(siblingAlignmentErrors, "linked cursors align to the hovered time bucket").toHaveLength(3)
	expect(Math.max(...siblingAlignmentErrors), "maximum linked cursor alignment error").toBeLessThan(1)
})
