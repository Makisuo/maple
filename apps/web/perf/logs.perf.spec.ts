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
	// GitHub's CI runner has no GPU: every scroll frame paints in software
	// (~80ms), so long tasks there are environmental, not a regression signal
	// (observed ~110 long tasks / ~1.2s blocking on a healthy build). The
	// mounted-row and commit-ratio gates carry the virtualization signal on CI;
	// blocking time only rejects order-of-magnitude regressions. Locally the
	// strict zero-long-task gate applies.
	if (process.env.CI) {
		expect(metrics.totalBlockingMs, "scroll blocking ms (CI ceiling)").toBeLessThan(4_000)
	} else {
		expect(metrics.longTasks, "scroll long tasks").toBe(0)
	}
	expect(metrics.reactCommits, "at most one virtual-list commit per frame").toBeLessThanOrEqual(
		metrics.frames * 1.25,
	)
})
