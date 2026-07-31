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
	// COMMITS are the regression signal, not duration. A sync storm is "every chart
	// re-renders per pointer tick", which is a commit count: the baseline sits at
	// 1118 commits run after run while cursor mode stays at 257-375 (ratio
	// 0.23-0.34). That spread is stable because it is structural.
	//
	// The duration ratio is not. It ranged 0.36-0.60 over the same runs, and it
	// worsens when the runner is FAST: cursor mode has a floor — the hovered
	// chart's own tooltip ticks — that does not shrink with the machine, so a
	// cheap baseline shrinks the numerator's lead. Every observed failure had a
	// baseline under ~1350ms (its fastest measurements) with commits and dropped
	// frames at their best. Gating on it fails a quiet runner for being quiet.
	expect(cursor.react.commits, "linked cursor commits").toBeLessThanOrEqual(
		recharts.react.commits * 0.45,
	)
	// Duration stays as a loose sanity ceiling: it rejects an order-of-magnitude
	// per-commit regression that a commit count alone would miss.
	expect(cursor.react.totalActualDurationMs, "linked cursor render work").toBeLessThanOrEqual(
		recharts.react.totalActualDurationMs * 0.75,
	)
	// The long-task COUNT is environmental on GitHub's GPU-less runners, not a
	// regression signal: the synchronized baseline swings 2→12 tasks run to run
	// while the cursor mode's blocking time stays at or below it (15/26/124ms vs
	// the baseline's 23/63/133ms). The render-work ratio above is what actually
	// detects a sync-storm regression; blocking time only rejects
	// order-of-magnitude ones. Locally the strict zero-long-task gate applies.
	// Same split as logs.perf.spec.ts.
	if (process.env.CI) {
		expect(cursor.totalBlockingMs, "linked cursor blocking ms (CI ceiling)").toBeLessThan(1_000)
	} else {
		expect(cursor.longTasks, "linked cursor long tasks").toBe(0)
	}
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
