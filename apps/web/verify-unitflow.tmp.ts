/* Headless verification of the unitflow migrations against https://web.localhost */
import { chromium } from "@playwright/test"

const SHOT_DIR = "/private/tmp/claude-501/-Users-makisuo-Documents-GitHub-maple/ec02ed75-aa19-4e2f-ac42-f24232456f9b/scratchpad"

const log = (...args: Array<unknown>) => console.log("[verify]", ...args)

const main = async () => {
	const browser = await chromium.launch({ headless: true, channel: "chrome" })
	const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
	const page = await context.newPage()

	const consoleErrors: Array<string> = []
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text())
	})
	const shapeRequests: Array<string> = []
	page.on("request", (req) => {
		if (req.url().includes("/api/sync/shape")) shapeRequests.push(req.url())
	})

	log("navigating to web.localhost")
	await page.goto("https://web.localhost", { waitUntil: "domcontentloaded", timeout: 30000 })
	await page.waitForTimeout(3000)

	// Clerk dev login if we landed on sign-in
	const emailInput = page.locator('input[name="identifier"], input[type="email"]').first()
	if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
		log("signing in via Clerk test account")
		await emailInput.fill("david+clerk_test@gmail.com")
		await page.keyboard.press("Enter")
		await page.waitForTimeout(2500)
		// Password or email-code path
		const pwInput = page.locator('input[type="password"]').first()
		if (await pwInput.isVisible({ timeout: 3000 }).catch(() => false)) {
			await pwInput.fill("Maple-Dev-Kx92qZ!")
			await page.keyboard.press("Enter")
		} else {
			const codeInput = page.locator('input[name="code"], input[autocomplete="one-time-code"]').first()
			if (await codeInput.isVisible({ timeout: 5000 }).catch(() => false)) {
				await codeInput.fill("424242")
			}
		}
		await page.waitForTimeout(5000)
	}
	log("post-login url:", page.url())

	// SPA-navigate (full reload drops the dev session)
	const spaNav = async (to: string) => {
		await page.evaluate((path) => {
			// @ts-expect-error router global
			return window.__TSR_ROUTER__?.navigate({ to: path })
		}, to)
		await page.waitForTimeout(4000)
	}

	// --- /errors/issues ---
	await spaNav("/errors/issues")
	log("errors url:", page.url())
	await page.screenshot({ path: `${SHOT_DIR}/errors-issues.png` })
	const errorsText = (await page.locator("main, body").first().innerText()).slice(0, 600)
	log("errors page text:\n" + errorsText)

	// --- /dashboards ---
	await spaNav("/dashboards")
	log("dashboards url:", page.url())
	await page.screenshot({ path: `${SHOT_DIR}/dashboards.png` })
	const dashText = (await page.locator("main, body").first().innerText()).slice(0, 600)
	log("dashboards page text:\n" + dashText)

	// --- org-switch sanity: back to errors quickly (model TTL warm render) ---
	await spaNav("/errors/issues")
	await page.screenshot({ path: `${SHOT_DIR}/errors-issues-return.png` })

	const shapes = [...new Set(shapeRequests.map((u) => new URL(u).searchParams.get("shape")))]
	log("shape streams observed:", shapes.join(", ") || "(none)")
	log("console errors:", consoleErrors.length === 0 ? "(none)" : "")
	for (const e of consoleErrors.slice(0, 15)) console.log("  [console.error]", e.slice(0, 300))

	await browser.close()
}

main().catch((e) => {
	console.error("[verify] FAILED", e)
	process.exit(1)
})
