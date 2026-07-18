import { Effect } from "effect"
import { onCLS, onINP, onLCP, type Metric } from "web-vitals"

import { runtime } from "./services/common/runtime"

/**
 * Production RUM for the dashboard itself. Emits Core Web Vitals and a periodic
 * main-thread-health summary as structured logs through the existing
 * `mapleOtelLayer` pipeline (the client SDK carries traces + logs only — no
 * metrics — so logs are the encoding; the alerting worker queries them from the
 * warehouse). Attribute keys use the `maple.*` vendor namespace.
 *
 * Overhead budget: two PerformanceObservers, one 30s timer, and a handful of
 * log rows per session. Everything here must stay off the interaction path —
 * this module exists to *see* jank, never to cause it.
 */

const SUMMARY_INTERVAL_MS = 30_000
// Long-task blocking threshold per the Long Tasks spec / TBT definition.
const BLOCKING_THRESHOLD_MS = 50

// The synthetic bench routes generate long tasks on purpose.
const BENCH_PATHS = ["/service-map-bench", "/service-detail-bench", "/logs-bench", "/overview-bench"]

interface LongAnimationFrameEntry extends PerformanceEntry {
	blockingDuration?: number
}

interface MemoryInfo {
	usedJSHeapSize: number
	jsHeapSizeLimit: number
}

function readHeap(): MemoryInfo | undefined {
	// Chrome-only, non-standard; absent elsewhere.
	const memory = (performance as Performance & { memory?: MemoryInfo }).memory
	if (!memory || typeof memory.usedJSHeapSize !== "number") return undefined
	return memory
}

function logRow(message: string, attributes: Record<string, string | number | boolean>): void {
	runtime.runFork(Effect.logInfo(message).pipe(Effect.annotateLogs(attributes)))
}

function reportVital(metric: Metric): void {
	logRow("maple.web_vitals", {
		"maple.vital.name": metric.name,
		"maple.vital.value": metric.value,
		"maple.vital.rating": metric.rating,
		"maple.vital.navigation_type": metric.navigationType,
		"maple.route.path": window.location.pathname,
	})
}

let initialized = false

export function initPerfVitals(): void {
	if (initialized) return
	initialized = true

	if (import.meta.env.DEV) return
	if (BENCH_PATHS.includes(window.location.pathname)) return

	// Web Vitals report at their spec-defined moments (INP/CLS finalize on
	// visibility-hidden, which pairs with MapleFlush's pagehide drain).
	onINP(reportVital)
	onLCP(reportVital)
	onCLS(reportVital)

	// Main-thread health: aggregate long-frame counters and emit one summary row
	// per interval instead of a row per event.
	let longFrames = 0
	let totalBlockingMs = 0
	let maxBlockingMs = 0
	let windowStartedAt = performance.now()

	const emitSummary = () => {
		if (longFrames === 0) return
		const heap = readHeap()
		logRow("maple.web_perf_summary", {
			"maple.perf.long_frames": longFrames,
			"maple.perf.total_blocking_ms": Math.round(totalBlockingMs),
			"maple.perf.max_blocking_ms": Math.round(maxBlockingMs),
			"maple.perf.window_ms": Math.round(performance.now() - windowStartedAt),
			"maple.route.path": window.location.pathname,
			...(heap
				? {
						"maple.perf.js_heap_used_bytes": heap.usedJSHeapSize,
						"maple.perf.js_heap_limit_bytes": heap.jsHeapSizeLimit,
					}
				: {}),
		})
		longFrames = 0
		totalBlockingMs = 0
		maxBlockingMs = 0
		windowStartedAt = performance.now()
	}

	try {
		// Prefer Long Animation Frames (Chrome 123+): `blockingDuration` already
		// subtracts the 50ms allowance. Fall back to Long Tasks elsewhere.
		const supported = PerformanceObserver.supportedEntryTypes
		const entryType = supported.includes("long-animation-frame") ? "long-animation-frame" : "longtask"
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				const blocking =
					entryType === "long-animation-frame"
						? ((entry as LongAnimationFrameEntry).blockingDuration ?? 0)
						: Math.max(0, entry.duration - BLOCKING_THRESHOLD_MS)
				if (blocking <= 0) continue
				longFrames++
				totalBlockingMs += blocking
				maxBlockingMs = Math.max(maxBlockingMs, blocking)
			}
		})
		observer.observe({ type: entryType, buffered: true })
	} catch {
		// No long-task support (e.g. Safari) — vitals still report.
	}

	// The periodic emit yields to idle time so the summary itself never lands
	// inside an interaction; the final emit on hide catches the tail.
	setInterval(() => {
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(emitSummary, { timeout: 5_000 })
		} else {
			emitSummary()
		}
	}, SUMMARY_INTERVAL_MS)

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") emitSummary()
	})
}
