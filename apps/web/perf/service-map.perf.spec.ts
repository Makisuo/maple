import { test, expect } from "@playwright/test"
import { writeFile } from "node:fs/promises"

/**
 * Service-map rendering perf gate.
 *
 * Loads the synthetic /lab/bench/service-map route (120 services / 400 edges at high
 * traffic), asserts the costly SVG constructs are gone, then runs the in-page
 * `window.__smBench` harness to measure frame timing while idle and while
 * panning. Thresholds are locked well below the measured post-fix numbers (and
 * far above the pre-fix baseline of ~23 fps idle / ~17 fps pan, p95 ~125ms) so
 * this fails if the SVG-filter/SMIL regression ever returns.
 */

const BENCH_URL = "/lab/bench/service-map?services=120&edges=400&rps=high&seed=1"

interface Metrics {
	fps: number
	frameP50: number
	frameP95: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	frames: number
	react: ReactRenderMetrics
}

interface ReactRenderMetrics {
	commits: number
	mountCommits: number
	updateCommits: number
	nestedUpdateCommits: number
	totalActualDurationMs: number
	actualDurationP50Ms: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
	lastBaseDurationMs: number
}

interface ReactRenderReport {
	initial: ReactRenderMetrics
	metricRefresh: ReactRenderMetrics
	topologyChange: ReactRenderMetrics
	viewportPan: ReactRenderMetrics
	viewportPanFrames: number
	viewportPanDurationMs: number
	viewportPanCommitsPerFrame: number
	viewportPanActualDurationPerFrameMs: number
	metricRefreshes: number
	topologyChanges: number
}

interface LayoutStabilityReport {
	settled: boolean
	sampled: number
	moved: number
	meanDisplacement: number
	maxDisplacement: number
	viewportDelta: number
	zoomDelta: number
}

interface LayoutStabilityReportSet {
	metricRefresh: LayoutStabilityReport
	topologyChange: LayoutStabilityReport
}

declare global {
	interface Window {
		__smBench?: {
			ready: boolean
			readyMs: number | null
			run: (opts?: { durationMs?: number; pan?: boolean }) => Promise<Metrics>
			runReact: (opts?: {
				metricRefreshes?: number
				topologyChanges?: number
			}) => Promise<ReactRenderReport>
			runStability: (opts?: { settleMs?: number }) => Promise<LayoutStabilityReportSet>
		}
	}
}

test("React render work stays measurable during refresh and topology updates", async ({ page }, testInfo) => {
	await page.goto(BENCH_URL)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })

	const scenarios = await page.evaluate(() =>
		window.__smBench!.runReact({ metricRefreshes: 12, topologyChanges: 2 }),
	)
	const report = {
		label: process.env.MAPLE_PERF_LABEL ?? "working-tree",
		url: BENCH_URL,
		strictMode: true,
		capturedAt: new Date().toISOString(),
		...scenarios,
	}
	const json = `${JSON.stringify(report, null, 2)}\n`
	const artifactPath = testInfo.outputPath("service-map-react-render-report.json")
	await writeFile(artifactPath, json)
	await testInfo.attach("service-map-react-render-report", {
		path: artifactPath,
		contentType: "application/json",
	})
	if (process.env.MAPLE_PERF_REPORT) await writeFile(process.env.MAPLE_PERF_REPORT, json)

	console.log("[perf] react:", JSON.stringify(report))

	// These are deliberately broad regression rails. The JSON report and A/B
	// comparator carry the useful before/after signal; CI only rejects render
	// cascades large enough to be unambiguously unhealthy on any runner.
	expect(report.initial.commits, "initial React commits").toBeGreaterThan(0)
	expect(report.metricRefresh.commits, "metric-refresh React commits").toBeGreaterThan(0)
	expect(report.metricRefresh.commits, "metric-refresh render cascade").toBeLessThan(80)
	expect(report.topologyChange.commits, "topology-change React commits").toBeGreaterThan(0)
	expect(report.topologyChange.commits, "topology-change render cascade").toBeLessThan(80)
	// The viewport, particles, minimap, controls, and background all update
	// imperatively during an active gesture, so zero React commits is ideal.
	expect(report.viewportPan.commits, "viewport-pan render cascade").toBeLessThan(800)
	expect(report.viewportPanCommitsPerFrame, "viewport-pan commits per frame").toBeLessThan(4)
})

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
	// thresholds below are tuned for a real GPU: locally the imperative render
	// path hits ~120 fps both idle and panning. GitHub's CI runner has NO GPU — idle is
	// vsync-capped at ~60 and pan rendering is software-bound at ~14 fps
	// regardless of code quality (below even the pre-fix SVG baseline), so the
	// strict pan numbers are physically unreachable there. Under CI we keep the
	// discriminating idle gate (post-fix ~60 fps / p95 ~17ms vs the pre-fix
	// SVG-filter cost of ~23 fps / p95 ~50ms) plus a "pan isn't frozen" floor.
	const ci = !!process.env.CI

	// Idle captures the continuous SVG-filter/SMIL cost this change removes — but
	// gate it on frame PACING, not fps. On a GPU-less shared runner the same code
	// measured p50 16.7ms / p95 33.4ms, identical to the decimal, across three
	// consecutive attempts while fps drifted 44.7 -> 43.6 -> 41.7 and red-failed a
	// 45 floor on a branch that touches no web code. fps is frames divided by
	// wall-clock, so it counts time the CI host descheduled the browser entirely;
	// p50/p95 measure how the frames that DID run were paced. 16.7ms is exactly
	// vsync and 33.4ms is exactly one dropped frame — the rendering was perfect on
	// the run that "failed".
	//
	// Pacing still separates the regression this test exists to catch by a wide
	// margin: the pre-fix per-edge blur + SMIL cost ~23 fps with p50/p95 far above
	// vsync (~50ms p95), against 16.7/33.4 here. fps keeps a not-frozen floor
	// only, exactly as pan already does below.
	expect(idle.frameP50, "idle p50 frame time (ms)").toBeLessThan(ci ? 25 : 20)
	expect(idle.frameP95, "idle p95 frame time (ms)").toBeLessThan(ci ? 40 : 20)
	expect(idle.fps, "idle fps (not frozen)").toBeGreaterThan(ci ? 20 : 55)

	if (ci) {
		// GPU-less runner: pan fps can't discriminate impl quality, only catch a
		// fully-frozen animation loop.
		expect(pan.fps, "pan fps (CI floor)").toBeGreaterThan(5)
	} else {
		// Stay in the display's native performance class: 120-class on a high-refresh
		// display, or a locked 60-class cadence on a conventional display.
		const highRefresh = idle.fps > 90
		expect(pan.fps, "pan fps").toBeGreaterThan(highRefresh ? 100 : 55)
		expect(pan.frameP95, "pan p95 frame time (ms)").toBeLessThan(highRefresh ? 20 : 25)
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

test("the graph holds still across refreshes and stays anchored across topology changes", async ({
	page,
}, testInfo) => {
	await page.goto(BENCH_URL)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 60_000 })

	// The harness waits for positions to go quiet rather than for a fixed delay:
	// ELK's cost swings by more than an order of magnitude across machines (a
	// two-node graph took 19s to lay out on one container here), and a fixed delay
	// silently samples the intermediate layout and calls it settled.
	const stability = await page.evaluate(() => window.__smBench!.runStability({ settleMs: 45_000 }))
	console.log("[perf] stability:", JSON.stringify(stability))
	testInfo.annotations.push({ type: "perf-stability", description: JSON.stringify(stability) })

	// Guard the measurement itself: an empty or still-moving sample would pass
	// every assertion below without testing anything.
	expect(stability.metricRefresh.sampled, "nodes sampled across a metric refresh").toBeGreaterThan(50)
	expect(stability.topologyChange.sampled, "nodes surviving a topology change").toBeGreaterThan(50)
	expect(stability.metricRefresh.settled, "layout settled after a metric refresh").toBe(true)
	expect(stability.topologyChange.settled, "layout settled after a topology change").toBe(true)

	// A metric refresh changes node DATA only — same services, same edges. It has
	// no business moving anything, so this is an exact-zero gate, not a threshold.
	// This is the assertion the harness was missing: every frame-timing metric
	// stayed green through the regressions that made the map visibly jump.
	expect(stability.metricRefresh.moved, "nodes moved by a metric refresh").toBe(0)
	expect(stability.metricRefresh.viewportDelta, "camera moved by a metric refresh").toBeLessThan(1)
	expect(stability.metricRefresh.zoomDelta, "camera zoomed by a metric refresh").toBeLessThan(0.01)

	// A topology change earns a fresh layout, but surviving nodes should land near
	// where they were rather than being re-scattered.
	//
	// Read these as regression rails, not a target. The bench's topology change
	// REGENERATES the graph at 121 services / 401 edges from the seeded RNG rather
	// than adding one edge to the existing one, so nearly every edge is redrawn —
	// a deliberate worst case, well beyond the single-edge delta a sliding time
	// window produces in the product. Measured on this graph: mean 1615 / max 5108
	// before layout anchoring, mean 928 / max 2784 after. The rails sit above the
	// anchored numbers and well below the unanchored ones, so losing the anchor
	// fails here even though every frame-timing metric would stay green.
	expect(stability.topologyChange.meanDisplacement, "mean node displacement").toBeLessThan(1200)
	expect(stability.topologyChange.maxDisplacement, "max node displacement").toBeLessThan(3500)
})
