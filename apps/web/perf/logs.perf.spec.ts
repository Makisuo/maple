import { expect, test } from "@playwright/test"

test("Logs scroll stays virtualized without long tasks or render cascades", async ({ page }) => {
	await page.goto("/logs-bench")
	await page.waitForFunction(() => window.__logsBench?.ready === true, undefined, { timeout: 30_000 })

	const mountedBefore = await page.locator("[data-logs-bench] [data-index]").count()
	const metrics = await page.evaluate(() => window.__logsBench!.runScroll())
	const mountedAfter = await page.locator("[data-logs-bench] [data-index]").count()

	console.log("[perf] logs scroll:", JSON.stringify({ ...metrics, mountedBefore, mountedAfter }))
	expect(mountedBefore, "initial mounted log rows").toBeLessThan(80)
	expect(mountedAfter, "mounted log rows after full scroll").toBeLessThan(80)
	expect(metrics.frames, "sampled scroll frames").toBeGreaterThan(100)
	expect(metrics.longTasks, "scroll long tasks").toBe(0)
	expect(metrics.reactCommits, "at most one virtual-list commit per frame").toBeLessThanOrEqual(
		metrics.frames * 1.25,
	)
})
