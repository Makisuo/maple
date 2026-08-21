import { expect, test } from "@playwright/test"
import { PLOT_SELECTOR } from "./plot-locator"

test("@cross-browser sustained dashboard interactions stay responsive without replay capture", async ({
	page,
}) => {
	const pageErrors: string[] = []
	const replayCaptureRequests: string[] = []
	page.on("pageerror", (error) => pageErrors.push(error.message))
	page.on("request", (request) => {
		const url = request.url()
		if (url.includes("/v1/sessionReplays/blob") || url.includes("/v1/sessionEvents")) {
			replayCaptureRequests.push(url)
		}
	})

	await page.goto("/lab/bench/overview")
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	const overviewPlot = page.locator(`[data-linked-cursor-chart] :is(${PLOT_SELECTOR})`).first()
	const overviewBounds = await overviewPlot.boundingBox()
	if (!overviewBounds) throw new Error("Overview plot did not become interactive")
	await page.mouse.move(
		overviewBounds.x + overviewBounds.width / 2,
		overviewBounds.y + overviewBounds.height / 2,
	)

	await page.goto("/lab/bench/service-detail?mode=cursor")
	await page.waitForFunction(() => window.__serviceDetailBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	const detailPlot = page.locator(`[data-linked-cursor-chart] :is(${PLOT_SELECTOR})`).first()
	const detailBounds = await detailPlot.boundingBox()
	if (!detailBounds) throw new Error("Service detail plot did not become interactive")
	await page.mouse.move(detailBounds.x + 2, detailBounds.y + detailBounds.height / 2)
	await page.mouse.move(detailBounds.x + detailBounds.width - 2, detailBounds.y + detailBounds.height / 2, {
		steps: 80,
	})

	await page.goto("/lab/bench/logs")
	await page.waitForFunction(() => window.__logsBench?.ready === true, undefined, { timeout: 30_000 })
	const logs = await page.evaluate(() => window.__logsBench!.runScroll())
	expect(logs.frames, "Logs stayed responsive").toBeGreaterThan(100)

	// Headless WebKit on CI rasterizes the canvas map in software at ~1-2 rAF
	// ticks per second under this load, while the logs segment on the same runner
	// still hits 100+ frames. Only liveness — any frame at all — is meaningful
	// there, and `frames` drops the first sample, so a 1.2s window bottoms the
	// measurement out at 0-or-1: it asks whether the runner managed two rAF ticks,
	// not whether the map is alive. Give WebKit a window wide enough for the
	// answer to be about the map. Chromium and Firefox keep 1.2s and the >5 floor.
	const webkitOnCi = !!process.env.CI && test.info().project.name.includes("webkit")
	const mapDurationMs = webkitOnCi ? 6_000 : 1_200

	await page.goto("/lab/bench/service-map?services=40&edges=100&rps=high&seed=7")
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })
	const map = await page.evaluate(
		(durationMs) => window.__smBench!.run({ durationMs, pan: true }),
		mapDurationMs,
	)
	expect(map.frames, "service map kept producing frames").toBeGreaterThan(webkitOnCi ? 0 : 5)

	expect(pageErrors, "uncaught page errors").toEqual([])
	expect(replayCaptureRequests, "dashboard replay event/blob uploads").toEqual([])
})
