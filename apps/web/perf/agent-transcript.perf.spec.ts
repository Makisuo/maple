import { expect, test, type Page } from "@playwright/test"

// The agent-session Transcript view over a big session (see
// src/lab/bench/agent-transcript-bench.tsx). The list virtualizes, so the
// gates here are about what one ROW costs: how much DOM a mounted row holds
// when its body is a 300KB tool result clamped to fourteen lines, and whether
// scrolling — which mounts rows again and again — stays inside a frame.

async function openBench(page: Page) {
	await page.goto("/lab/bench/agent-transcript?turns=40")
	await page.waitForFunction(() => window.__transcriptBench?.ready === true, undefined, {
		timeout: 60_000,
	})
}

async function sweep(page: Page, label: string) {
	const before = await page.evaluate(() => window.__transcriptBench!.countDom())
	const metrics = await page.evaluate(() => window.__transcriptBench!.runScroll(160))
	console.log(`[perf] transcript scroll (${label}):`, JSON.stringify({ before, ...metrics }))

	// Virtualization: the rows on the page are the viewport's plus overscan.
	expect(before.mountedRows, "initial mounted rows").toBeLessThan(80)
	expect(metrics.mountedRows, "mounted rows after full scroll").toBeLessThan(80)
	expect(metrics.frames, "sampled scroll frames").toBeGreaterThan(100)
	// GitHub's CI runner has no GPU and paints every frame in software, so long
	// tasks there are environmental (see logs.perf.spec.ts); the DOM gates carry
	// the signal on CI and blocking time only rejects order-of-magnitude
	// regressions. Locally the strict gate applies.
	if (process.env.CI) {
		expect(metrics.totalBlockingMs, "scroll blocking ms (CI ceiling)").toBeLessThan(4_000)
	} else {
		expect(metrics.totalBlockingMs, "scroll blocking ms").toBeLessThan(100)
	}
	// The list re-renders when the mounted range moves, not on every measurement.
	expect(metrics.reactCommits, "list commits per frame").toBeLessThanOrEqual(metrics.frames * 2.5)
	return metrics
}

test("Transcript scroll stays inside a frame on a large session", async ({ page }) => {
	await openBench(page)
	const metrics = await sweep(page, "payloads collapsed")
	// A tool card shut is a header; a reply is its markdown, laid out plain.
	expect(metrics.maxRowNodes, "elements in the heaviest row").toBeLessThan(1_500)
})

test("Transcript scroll stays inside a frame with every tool payload open", async ({ page }) => {
	await openBench(page)
	await page.getByRole("button", { name: "Display options" }).click()
	await page.getByRole("switch", { name: "Expand tool payloads" }).click()
	await page.keyboard.press("Escape")
	await page.waitForTimeout(500)

	const metrics = await sweep(page, "payloads expanded")
	// A clamped body mounts a bounded preview, so a row is bounded however
	// big its payload: a 1,200-row JSON result highlighted whole is ~30,000
	// elements, its preview under a thousand per half.
	expect(metrics.maxRowNodes, "elements in the heaviest row").toBeLessThan(2_500)
})
