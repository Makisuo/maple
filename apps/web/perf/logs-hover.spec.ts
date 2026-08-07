import { expect, test } from "@playwright/test"

// The attribute-chip hover card can only be verified for real in a browser.
// The original defect was a *missed* `pointerleave`: arming a chip swapped the
// bare <button> for a Base UI trigger, and a node inserted under a cursor that
// has already moved on never receives `pointerenter`, so the browser never sends
// it the matching `pointerleave` and the card was stranded open. jsdom cannot
// reproduce that — it happily dispatches a synthesized leave to any node — so
// these assertions live here rather than in the unit suite.
//
// /logs-bench renders the real LogsTableView over 2 000 rows × 12 chips with no
// auth and no backend. Rows are `max-content` wide and scroll horizontally, so
// only the leading chip of each row is reliably on screen; the sweep therefore
// runs down that column, which is also how a cursor actually crosses the table.

const CARD = '[data-slot="hover-card-content"]'

/** Centres of every attribute chip currently inside the viewport, top to bottom. */
async function visibleChipCentres(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const chips = Array.from(document.querySelectorAll('[role="log"] button[aria-label^="Copy "]'))
		return chips
			.map((chip) => {
				const r = chip.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			.filter((p) => p.x > 0 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight)
			.sort((a, b) => a.y - b.y)
	})
}

async function openBench(page: import("@playwright/test").Page) {
	await page.goto("/logs-bench")
	await page.waitForFunction(() => window.__logsBench?.ready === true, undefined, {
		timeout: 30_000,
	})
	await expect(page.locator('[role="log"] button[aria-label^="Copy "]').first()).toBeVisible()
}

test("sweeping across chips opens nothing and strands nothing", async ({ page }) => {
	await openBench(page)

	const centres = await visibleChipCentres(page)
	expect(centres.length, "chips visible in the bench viewport").toBeGreaterThan(5)

	// A continuous sweep down the chip column. Each stop is well under the
	// rest-to-reveal delay, so nothing should ever open.
	for (const point of centres) {
		await page.mouse.move(point.x, point.y)
	}
	// Park clear of every chip and let any delay that did start elapse.
	await page.mouse.move(20, 20)
	await page.waitForTimeout(1_200)

	expect(await page.locator(CARD).count(), "cards left open after a sweep").toBe(0)
})

test("resting reveals exactly one card and leaving dismisses it", async ({ page }) => {
	await openBench(page)

	const centres = await visibleChipCentres(page)
	const first = centres[0]!
	const second = centres[3] ?? centres[1]!

	await page.mouse.move(first.x, first.y)
	await expect(page.locator(CARD), "resting on a chip reveals its card").toHaveCount(1, {
		timeout: 5_000,
	})

	// Moving to another chip and resting must hand the card over, not add one.
	await page.mouse.move(second.x, second.y)
	await page.waitForTimeout(1_200)
	expect(await page.locator(CARD).count(), "cards open after moving to a second chip").toBe(1)

	// The assertion that fails on the old code: the card must go away.
	await page.mouse.move(20, 20)
	await expect(page.locator(CARD), "card dismissed on leave").toHaveCount(0, { timeout: 5_000 })
})

test("scrolling under an open card retargets it instead of stranding one", async ({ page }) => {
	await openBench(page)

	const centres = await visibleChipCentres(page)
	const target = centres[0]!

	await page.mouse.move(target.x, target.y)
	await expect(page.locator(CARD)).toHaveCount(1, { timeout: 5_000 })

	// Rows are keyed by virtual index and chips by attribute name, so scrolling
	// recycles a different log into the very same chip instance rather than
	// unmounting it. The cursor still rests on a chip afterwards, so one card
	// staying up is correct — what must never happen is a second card, or a card
	// still describing the log that scrolled away.
	await page.mouse.wheel(0, 4_000)
	await page.waitForTimeout(1_200)

	expect(await page.locator(CARD).count(), "cards open after scrolling").toBeLessThanOrEqual(1)

	// Row heights don't divide the scroll distance evenly, so the cursor may end
	// up between rows. Only assert the pairing when it did land on a chip.
	const verdict = await page.evaluate((point) => {
		const card = document.querySelector('[data-slot="hover-card-content"]')
		const chip = document.elementFromPoint(point.x, point.y)?.closest("button")
		const label = chip?.getAttribute("aria-label")
		if (!card || !label?.startsWith("Copy ")) return "unpaired"
		const [, value] = label.replace(/^Copy /, "").split(/=(.*)/s)
		return value && card.textContent?.includes(value) ? "matches" : "stale"
	}, target)
	expect(verdict, "any open card describes the chip now under the cursor").not.toBe("stale")

	// And it still goes away when the pointer finally leaves.
	await page.mouse.move(20, 20)
	await expect(page.locator(CARD)).toHaveCount(0, { timeout: 5_000 })
})
