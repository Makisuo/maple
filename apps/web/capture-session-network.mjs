import { chromium } from "@playwright/test";

const email = process.env.MAPLE_CAPTURE_EMAIL;
const password = process.env.MAPLE_CAPTURE_PASSWORD;
const output = process.env.MAPLE_CAPTURE_OUTPUT;

if (!email || !password || !output) {
	throw new Error("Missing capture credentials or output path");
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1488, height: 900 },
	deviceScaleFactor: 2,
	ignoreHTTPSErrors: true,
	colorScheme: "dark",
});
const page = await context.newPage();

await page.goto("https://web.localhost/", { waitUntil: "domcontentloaded" });
const emailInput = page.getByRole("textbox", { name: "Email address" });
await emailInput.waitFor({ state: "visible" });
await emailInput.fill(email);
await page.getByRole("textbox", { name: "Password" }).fill(password);
await page.getByRole("button", { name: "Continue", exact: true }).click();
await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();

await page.goto(
	"https://web.localhost/replays/25c8819c-337a-4dc7-a3c7-352f003771e1?t=2026-07-24+21%3A46%3A02.498000000",
	{ waitUntil: "domcontentloaded" },
);
await page.getByRole("heading", { name: "Session Replay", exact: true }).waitFor();
await page.locator("figure iframe").waitFor({ state: "visible" });
await page.getByRole("button", { name: "Play", exact: true }).first().click();
await page.waitForTimeout(5000);
await page.getByRole("button", { name: "Pause", exact: true }).first().click();
await page.getByRole("button", { name: "Network 79", exact: true }).click();
await page.getByText("https://superwall.com/api/rpc/getProjects", { exact: true }).waitFor();
await page.getByRole("button", { name: "Toggle Sidebar" }).click();
await page.waitForTimeout(450);
await page.screenshot({ path: output });

await browser.close();
