import { expect, test, type Page } from "@playwright/test"
import { PLOT_SELECTOR } from "./plot-locator"

// The service-detail chart grid (latency, throughput, apdex, error rate) under a
// 180-step pointer sweep.
//
// There is no recharts-vs-cursor A/B here any more. These four charts are
// TanStack and `MetricsGrid` no longer speaks to Recharts' sync bus at all, so
// the storm baseline has nothing to render — it lives on in infra.perf.spec.ts,
// whose host/k8s charts are still Recharts. What replaces the ratio is an
// absolute COMMIT ceiling, which is the same signal the infra spec relies on:
// a sync storm is "every chart re-renders per pointer tick", and that is a
// commit count, not a duration.

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

const SWEEP_STEPS = 180

/**
 * The sweep's commit ceiling: ONE chart's worth of per-tick work, with slack.
 *
 * Structural, not a stopwatch. The floor is not zero — the hovered chart's
 * tooltip body reads the focus store through `useSyncExternalStore`, so it
 * re-renders once per tooltip update, and a sweep measures ~1 commit per step
 * (180/180 locally, matching the 146/180 the tanstack bench records for three
 * charts). What must never come back is every SIBLING committing too: a sync bus
 * multiplies that by the grid's four charts. Two steps' worth of headroom
 * separates the two regimes with room to spare in either direction.
 */
const COMMIT_CEILING = SWEEP_STEPS * 2

async function openBench(page: Page) {
	await page.goto("/lab/bench/service-detail")
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})
}

test("service detail grid keeps pointer work off React", async ({ page }) => {
	await openBench(page)

	const plot = page.locator(`[data-metrics-grid] :is(${PLOT_SELECTOR})`).first()
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Service detail benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
	await page.evaluate(() => window.__serviceDetailBench!.beginInteraction())
	await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, {
		steps: SWEEP_STEPS,
	})
	const metrics = await page.evaluate(() => window.__serviceDetailBench!.endInteraction())

	console.log("[perf] service-detail cursor:", JSON.stringify(metrics))

	expect(metrics.react.commits, "React commits over the sweep").toBeLessThanOrEqual(COMMIT_CEILING)
	// Same environmental split as infra.perf.spec.ts / logs.perf.spec.ts: the
	// long-task count is runner noise on GPU-less CI, so CI gets a blocking-time
	// ceiling and local runs get the strict gate.
	if (process.env.CI) {
		expect(metrics.totalBlockingMs, "linked cursor blocking ms (CI ceiling)").toBeLessThan(1_000)
	} else {
		expect(metrics.longTasks, "linked cursor long tasks").toBe(0)
	}
})

test("service detail cursor keeps one tooltip and linked sibling cursors", async ({ page }) => {
	await openBench(page)

	const plot = page.locator(`[data-linked-cursor-chart='latency'] :is(${PLOT_SELECTOR})`)
	const bounds = await plot.boundingBox()
	if (!bounds) throw new Error("Service detail benchmark chart has no plot bounds")

	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

	await expect(page.locator("[data-linked-cursor-overlay]")).toHaveCount(4)
	await expect(page.locator("[data-linked-cursor-source='']")).toHaveCount(1)
	// `.ts-chart-tooltip` is the TanStack renderer's own tooltip card, which is
	// what replaced the `[data-chart]` popup the Recharts path portalled. Exactly
	// one, because only the hovered chart tracks the pointer — a sync bus would
	// open four.
	await expect(page.locator(".ts-chart-tooltip")).toHaveCount(1)

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

	// The grid's `yAxisWidth` lock, observed. Left to themselves these four charts
	// solve their own y gutters from their own tick labels ("0.9" against
	// "155.0ms") and land between ~38px and ~65px from the card edge — which would
	// let `layoutMarkerLabels` merge the same commits into different label chips on
	// adjacent cards. Locking the left margin is what makes the plots congruent.
	const plotOffsets = await page.locator("[data-linked-cursor-chart]").evaluateAll((cards) =>
		cards.flatMap((card) => {
			const plot = card.querySelector("[data-chart-plot]")
			if (!plot) return []
			return [Math.round(plot.getBoundingClientRect().left - card.getBoundingClientRect().left)]
		}),
	)
	expect(plotOffsets, "one plot rect per card").toHaveLength(4)
	expect(new Set(plotOffsets).size, "every card's plot starts at the same left edge").toBe(1)

	await page.setViewportSize({ width: 390, height: 844 })
	const firstCardBounds = await page.locator("[data-linked-cursor-chart='latency']").boundingBox()
	const secondCardBounds = await page.locator("[data-linked-cursor-chart='throughput']").boundingBox()
	if (!firstCardBounds || !secondCardBounds) throw new Error("Mobile benchmark cards have no bounds")
	expect(secondCardBounds.y, "mobile charts stack into one column").toBeGreaterThan(
		firstCardBounds.y + firstCardBounds.height - 1,
	)
})
