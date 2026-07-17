import type { ProfilerOnRenderCallback } from "react"

/**
 * Shared instrumentation for the synthetic chart-interaction perf benches
 * (/service-detail-bench, /infra-bench). A bench page mounts a React Profiler
 * feeding a recorder, installs a harness on `window`, and the Playwright perf
 * specs drive `beginInteraction()` / pointer sweep / `endInteraction()`.
 */

export interface ReactRenderMetrics {
	commits: number
	totalActualDurationMs: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
}

export interface InteractionMetrics {
	frames: number
	frameP95Ms: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	react: ReactRenderMetrics
}

export interface ReactRecorder {
	onRender: ProfilerOnRenderCallback
	reset: () => void
	snapshot: () => ReactRenderMetrics
}

export interface InteractionBenchHarness {
	ready: boolean
	beginInteraction: () => void
	endInteraction: () => Promise<InteractionMetrics>
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
	return sorted[index]
}

export function createReactRecorder(): ReactRecorder {
	let durations: number[] = []
	return {
		onRender: (_id, _phase, actualDuration) => {
			durations.push(actualDuration)
		},
		reset: () => {
			durations = []
		},
		snapshot: () => {
			const sorted = [...durations].sort((a, b) => a - b)
			return {
				commits: sorted.length,
				totalActualDurationMs: sorted.reduce((sum, duration) => sum + duration, 0),
				actualDurationP95Ms: percentile(sorted, 95),
				maxActualDurationMs: sorted.at(-1) ?? 0,
			}
		},
	}
}

const nextPaint = () =>
	new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
	})

/**
 * Creates the harness plus the readiness poll. Call from a mount effect and
 * invoke the returned `dispose` on unmount. `isReady` is polled every frame
 * until it returns true (or the timeout elapses, so a broken bench still lets
 * the spec fail on assertions instead of hanging).
 */
export function startInteractionBench(options: {
	recorder: ReactRecorder
	isReady: () => boolean
	readyTimeoutMs?: number
}): { harness: InteractionBenchHarness; dispose: () => void } {
	const { recorder, isReady, readyTimeoutMs = 8_000 } = options

	let animationFrame = 0
	let readyFrame = 0
	let frameDeltas: number[] = []
	let previousFrame = 0
	let running = false
	let longTasks: PerformanceEntry[] = []
	let longTaskObserver: PerformanceObserver | undefined

	const harness: InteractionBenchHarness = {
		ready: false,
		beginInteraction: () => {
			recorder.reset()
			frameDeltas = []
			longTasks = []
			previousFrame = performance.now()
			running = true

			try {
				longTaskObserver = new PerformanceObserver((list) => {
					longTasks.push(...list.getEntries())
				})
				longTaskObserver.observe({ entryTypes: ["longtask"] })
			} catch {
				// Browsers without Long Tasks support still report React and frame metrics.
			}

			const recordFrame = (now: number) => {
				frameDeltas.push(now - previousFrame)
				previousFrame = now
				if (running) animationFrame = requestAnimationFrame(recordFrame)
			}
			animationFrame = requestAnimationFrame(recordFrame)
		},
		endInteraction: async () => {
			await nextPaint()
			running = false
			cancelAnimationFrame(animationFrame)
			longTaskObserver?.disconnect()

			const sortedFrames = [...frameDeltas].sort((a, b) => a - b)
			return {
				frames: sortedFrames.length,
				frameP95Ms: percentile(sortedFrames, 95),
				droppedFrames: sortedFrames.filter((duration) => duration > (1000 / 60) * 1.5).length,
				longTasks: longTasks.length,
				totalBlockingMs: longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
				react: recorder.snapshot(),
			}
		},
	}

	const readyStartedAt = performance.now()
	const markReady = () => {
		if (isReady() || performance.now() - readyStartedAt > readyTimeoutMs) {
			harness.ready = true
			return
		}
		readyFrame = requestAnimationFrame(markReady)
	}
	readyFrame = requestAnimationFrame(markReady)

	return {
		harness,
		dispose: () => {
			running = false
			cancelAnimationFrame(animationFrame)
			cancelAnimationFrame(readyFrame)
			longTaskObserver?.disconnect()
		},
	}
}
