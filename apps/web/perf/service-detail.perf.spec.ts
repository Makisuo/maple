import { expect, test, type Page } from "@playwright/test"

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
		__serviceDetailBench?: {
			ready: boolean
			beginInteraction: () => void
			endInteraction: () => Promise<InteractionMetrics>
		}
	}
}

async function measurePointerSweep(page: Page, mode: "recharts" | "cursor"): Promise<InteractionMetrics> {
	await page.goto(`/service-detail-bench?mode=${mode}`)
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator("[data-metrics-grid-sync-mode] .recharts-cartesian-grid").first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Service detail benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
	await page.evaluate(() => window.__serviceDetailBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 180 })
	const metrics = await page.evaluate(() => window.__serviceDetailBench!.endInteraction())

	console.log(`[perf] service-detail ${mode}:`, JSON.stringify(metrics))
	return metrics
}

test("service detail linked cursor avoids synchronized chart render work", async ({ page }) => {
	const recharts = await measurePointerSweep(page, "recharts")
	const cursor = await measurePointerSweep(page, "cursor")

	const reduction = 1 - cursor.react.totalActualDurationMs / recharts.react.totalActualDurationMs
	console.log(`[perf] service-detail React render reduction: ${(reduction * 100).toFixed(1)}%`)

	expect(recharts.react.totalActualDurationMs, "synchronized baseline render work").toBeGreaterThan(0)
	expect(cursor.react.totalActualDurationMs, "linked cursor render work").toBeLessThanOrEqual(
		recharts.react.totalActualDurationMs * 0.4,
	)
	expect(cursor.longTasks, "linked cursor long tasks").toBe(0)
})

test("metrics grid defaults to the linked-cursor sync mode", async ({ page }) => {
	// No ?mode= — the bench omits the prop so this exercises MetricsGrid's default.
	// A revert of the "cursor" default (back to recharts syncId storms) fails here.
	await page.goto("/service-detail-bench")
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	await expect(page.locator("[data-metrics-grid-sync-mode]")).toHaveAttribute(
		"data-metrics-grid-sync-mode",
		"cursor",
	)
})

test("service detail cursor keeps one tooltip and linked sibling cursors", async ({ page }) => {
	await page.goto("/service-detail-bench?mode=cursor")
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})

	const plot = page.locator("[data-linked-cursor-chart='latency'] .recharts-cartesian-grid")
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Service detail benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

	await expect(page.locator("[data-linked-cursor-overlay]")).toHaveCount(4)
	await expect(page.locator("[data-linked-cursor-source='']")).toHaveCount(1)
	await expect(page.locator("body [data-chart]:not([data-slot='chart'])")).toHaveCount(1)

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

	await page.setViewportSize({ width: 390, height: 844 })
	const firstCardBounds = await page.locator("[data-linked-cursor-chart='latency']").boundingBox()
	const secondCardBounds = await page.locator("[data-linked-cursor-chart='throughput']").boundingBox()
	if (!firstCardBounds || !secondCardBounds) throw new Error("Mobile benchmark cards have no bounds")
	expect(secondCardBounds.y, "mobile charts stack into one column").toBeGreaterThan(
		firstCardBounds.y + firstCardBounds.height - 1,
	)
})
