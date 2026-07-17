import { expect, test, type Page } from "@playwright/test"

// Mirrors service-detail.perf.spec.ts for the infra detail chart grids
// (host metric strips, k8s pod/node charts, infra correlation panel). The
// /infra-bench route renders the real ChartViews with synthetic rows in one
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

async function measurePointerSweep(page: Page, mode: "recharts" | "cursor"): Promise<InteractionMetrics> {
	await page.goto(`/infra-bench?mode=${mode}`)
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator("[data-testid='infra-chart-bench'] .recharts-cartesian-grid").first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Infra benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
	await page.evaluate(() => window.__infraBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 180 })
	const metrics = await page.evaluate(() => window.__infraBench!.endInteraction())

	console.log(`[perf] infra ${mode}:`, JSON.stringify(metrics))
	return metrics
}

test("infra chart grids' linked cursor avoids synchronized chart render work", async ({ page }) => {
	const recharts = await measurePointerSweep(page, "recharts")
	const cursor = await measurePointerSweep(page, "cursor")

	const reduction = 1 - cursor.react.totalActualDurationMs / recharts.react.totalActualDurationMs
	console.log(`[perf] infra React render reduction: ${(reduction * 100).toFixed(1)}%`)

	expect(recharts.react.totalActualDurationMs, "synchronized baseline render work").toBeGreaterThan(0)
	// Measured ratio is ~0.44 (vs ~0.25 on /service-detail-bench): the residual
	// work is the hovered chart's own tooltip ticks, and the infra stacked-area
	// charts pay relatively more per tick than the service-detail charts. 0.55
	// still locks in a ≥45% reduction with margin for CI noise.
	expect(cursor.react.totalActualDurationMs, "linked cursor render work").toBeLessThanOrEqual(
		recharts.react.totalActualDurationMs * 0.55,
	)
	expect(cursor.longTasks, "linked cursor long tasks").toBe(0)
})

test("infra charts default to the linked-cursor sync mode", async ({ page }) => {
	// No ?mode= — the bench omits the prop so this exercises the ChartViews'
	// default. A revert of the "cursor" default (back to recharts syncId storms)
	// removes the overlays and fails here.
	await page.goto("/infra-bench")
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	await expect(page.locator("[data-linked-cursor-overlay]")).toHaveCount(4)
	await expect(page.locator(".recharts-wrapper")).toHaveCount(4)
})

test("infra cursor keeps one tooltip and linked sibling cursors", async ({ page }) => {
	await page.goto("/infra-bench?mode=cursor")
	await page.waitForFunction(() => window.__infraBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator("[data-linked-cursor-chart='host-cpu'] .recharts-cartesian-grid")
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

	const siblingAlignmentErrors = await page.locator("[data-linked-cursor-chart]").evaluateAll((cards) =>
		cards.flatMap((card) => {
			const cursor = card.querySelector<HTMLElement>("[data-linked-cursor-overlay]")
			const line = cursor?.firstElementChild
			const plot = card.querySelector<SVGGraphicsElement>(".recharts-cartesian-grid")
			if (!cursor || cursor.hidden || !line || !plot) return []
			const lineBounds = line.getBoundingClientRect()
			const plotBounds = plot.getBoundingClientRect()
			return [Math.abs(lineBounds.x - (plotBounds.x + plotBounds.width / 2))]
		}),
	)
	expect(siblingAlignmentErrors, "linked cursors align to the hovered time bucket").toHaveLength(3)
	expect(Math.max(...siblingAlignmentErrors), "maximum linked cursor alignment error").toBeLessThan(1)
})
