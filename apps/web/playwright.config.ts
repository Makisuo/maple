import { defineConfig, devices } from "@playwright/test"

// Dedicated raw-vite dev server on a fixed port, forced into self-hosted auth
// mode so the bench route renders with no Clerk session and no backend
// (resolveSelfHostedRouterAuth returns unauthenticated synchronously). The
// /service-map-bench route is in PUBLIC_PATHS, so beforeLoad lets it through.
const PORT = 4330
const HOST = "127.0.0.1"
const baseURL = `http://${HOST}:${PORT}`

export default defineConfig({
	testDir: "./perf",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	// Frame-timing is inherently noisy; allow a retry so a one-off GC/scheduler
	// spike doesn't fail the gate. Thresholds keep wide margin over the baseline.
	retries: process.env.CI ? 2 : 1,
	reporter: [["list"]],
	timeout: 120_000,
	use: {
		baseURL,
		// Measure the real animated path (don't let CI default to reduced motion).
		reducedMotion: "no-preference",
		trace: "off",
	},
	projects: [
		{
			name: "chromium-performance",
			grepInvert: /@cross-browser/,
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
		{
			name: "chromium-smoke",
			grep: /@cross-browser/,
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
		{
			name: "firefox-smoke",
			grep: /@cross-browser/,
			use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } },
		},
		{
			name: "webkit-smoke",
			grep: /@cross-browser/,
			use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
		},
	],
	webServer: {
		command: "bun run dev:app",
		url: baseURL,
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		env: {
			PORT: String(PORT),
			HOST,
			VITE_MAPLE_AUTH_MODE: "self_hosted",
		},
	},
})
