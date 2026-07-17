import { test, expect } from "@playwright/test"

/**
 * Service-map rendering perf gate.
 *
 * Loads the synthetic /service-map-bench route (120 services / 400 edges at high
 * traffic), asserts the costly SVG constructs are gone, then runs the in-page
 * `window.__smBench` harness to measure frame timing while idle and while
 * panning. Thresholds are locked well below the measured post-fix numbers (and
 * far above the pre-fix baseline of ~23 fps idle / ~17 fps pan, p95 ~125ms) so
 * this fails if the SVG-filter/SMIL regression ever returns.
 */

const BENCH_URL = "/service-map-bench?services=120&edges=400&rps=high&seed=1"

interface Metrics {
	fps: number
	frameP50: number
	frameP95: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	frames: number
}

declare global {
	interface Window {
		__smBench?: {
			ready: boolean
			readyMs: number | null
			run: (opts?: { durationMs?: number; pan?: boolean }) => Promise<Metrics>
		}
	}
}

test("service map renders filter/SMIL-free and animates smoothly under heavy traffic", async ({ page }) => {
	await page.goto(BENCH_URL)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })

	// Structural: the per-edge Gaussian-blur filters + SMIL animations are gone,
	// the single particle canvas is present, and edges actually rendered.
	const dom = await page.evaluate(() => ({
		feGaussian: document.querySelectorAll("feGaussianBlur").length,
		animateMotion: document.querySelectorAll("animateMotion").length,
		filters: document.querySelectorAll("filter").length,
		edges: document.querySelectorAll(".react-flow__edge").length,
		canvas: Boolean(document.querySelector('[data-testid="service-map-bench"] canvas')),
	}))
	expect(dom.feGaussian, "no SVG blur filters on edges").toBe(0)
	expect(dom.animateMotion, "no SMIL animations on edges").toBe(0)
	expect(dom.canvas, "particle canvas present").toBe(true)
	expect(dom.edges, "edges rendered").toBeGreaterThan(0)

	// The particle canvas is actually drawing (non-transparent pixels) — guards
	// against a silently-broken animation loop. Poll a few frames to avoid
	// reading on a just-cleared frame.
	const drawnPixels = await page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				const canvas = document.querySelector<HTMLCanvasElement>(
					'[data-testid="service-map-bench"] canvas',
				)
				const ctx = canvas?.getContext("2d")
				if (!canvas || !ctx) return resolve(0)
				let best = 0
				let frames = 0
				const sample = () => {
					const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
					let n = 0
					for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++
					best = Math.max(best, n)
					if (best > 0 || frames++ > 20) return resolve(best)
					requestAnimationFrame(sample)
				}
				requestAnimationFrame(sample)
			}),
	)
	expect(drawnPixels, "particles drawn on canvas").toBeGreaterThan(0)

	await page.screenshot({ path: "test-results/service-map-after.png" })

	const idle = await page.evaluate(() => window.__smBench!.run({ durationMs: 4000, pan: false }))
	const pan = await page.evaluate(() => window.__smBench!.run({ durationMs: 4000, pan: true }))

	// Time-to-ready includes the async worker-ELK layout pass — tracked (not
	// gated: CI runners are too noisy) so layout-cost regressions are visible.
	const readyMs = await page.evaluate(() => window.__smBench!.readyMs)
	console.log("[perf] readyMs:", readyMs)
	test.info().annotations.push({ type: "perf-ready-ms", description: String(readyMs) })

	// Surfaced in CI output + attached to the report for before/after tracking.
	console.log("[perf] idle:", JSON.stringify(idle))
	console.log("[perf] pan: ", JSON.stringify(pan))
	test.info().annotations.push({ type: "perf-idle", description: JSON.stringify(idle) })
	test.info().annotations.push({ type: "perf-pan", description: JSON.stringify(pan) })

	// The structural assertions above (no feGaussianBlur / animateMotion, canvas
	// drawn) are the environment-independent regression guard. The frame-timing
	// thresholds below are tuned for a real GPU: locally the canvas impl hits
	// ~125 fps idle / ~70 fps pan. GitHub's CI runner has NO GPU — idle is
	// vsync-capped at ~60 and pan rendering is software-bound at ~14 fps
	// regardless of code quality (below even the pre-fix SVG baseline), so the
	// strict pan numbers are physically unreachable there. Under CI we keep the
	// discriminating idle gate (post-fix ~60 fps / p95 ~17ms vs the pre-fix
	// SVG-filter cost of ~23 fps / p95 ~50ms) plus a "pan isn't frozen" floor.
	const ci = !!process.env.CI

	// Idle is the headline, rock-stable metric — it captures the continuous
	// SVG-filter/SMIL cost that this change removes.
	expect(idle.fps, "idle fps").toBeGreaterThan(ci ? 45 : 55)
	expect(idle.frameP95, "idle p95 frame time (ms)").toBeLessThan(ci ? 40 : 20)

	if (ci) {
		// GPU-less runner: pan fps can't discriminate impl quality, only catch a
		// fully-frozen animation loop.
		expect(pan.fps, "pan fps (CI floor)").toBeGreaterThan(5)
	} else {
		// Pan drives setViewport every frame (noisier); guard gross regressions only.
		// Pre-fix baseline: ~17 fps / p95 ~125ms; post-fix: ~70 fps / p95 ~32ms.
		expect(pan.fps, "pan fps").toBeGreaterThan(35)
		expect(pan.frameP95, "pan p95 frame time (ms)").toBeLessThan(70)
	}
})

test("low-traffic filter actually removes edges from the DOM", async ({ page }) => {
	await page.goto(BENCH_URL)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })
	const baselineEdges = await page.evaluate(() => document.querySelectorAll(".react-flow__edge").length)

	// The bench generator draws edge rates uniformly from [50, 500] rps, so a
	// realistic 1–5% threshold filters nothing — use 50% of peak to cut ~half.
	await page.goto(`${BENCH_URL}&minTraffic=50`)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })
	const filteredEdges = await page.evaluate(() => document.querySelectorAll(".react-flow__edge").length)

	expect(filteredEdges, "filtered graph has fewer edges").toBeLessThan(baselineEdges)
	expect(filteredEdges, "filtered graph still has edges").toBeGreaterThan(0)
})
