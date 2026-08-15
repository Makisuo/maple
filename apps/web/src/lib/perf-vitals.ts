import { Effect, Metric } from "effect"
import { onCLS, onINP, onLCP, type Metric as WebVitalMetric } from "web-vitals"

import { isLabPath } from "@/lab/registry"
import { runtime } from "./services/common/runtime"

/**
 * Production RUM for the dashboard itself. Emits Core Web Vitals and a periodic
 * main-thread-health summary as Effect metrics and structured logs through the
 * existing `mapleOtelLayer` pipeline. Logs remain for the alerting worker's
 * existing warehouse queries; metrics power native dashboards. Attribute keys
 * use the `maple.*` vendor namespace.
 *
 * Overhead budget: two PerformanceObservers, one 30s timer, and a handful of
 * log rows per session. Everything here must stay off the interaction path —
 * this module exists to *see* jank, never to cause it.
 */

const SUMMARY_INTERVAL_MS = 30_000
// Long-task blocking threshold per the Long Tasks spec / TBT definition.
const BLOCKING_THRESHOLD_MS = 50

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

const clsMetric = Metric.histogram("web.vitals.cls", {
	description: "Cumulative Layout Shift",
	boundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
})
const inpMetric = Metric.histogram("web.vitals.inp_ms", {
	description: "Interaction to Next Paint in milliseconds",
	boundaries: [50, 100, 200, 300, 500, 800, 1_200, 2_000],
})
const lcpMetric = Metric.histogram("web.vitals.lcp_ms", {
	description: "Largest Contentful Paint in milliseconds",
	boundaries: [500, 1_000, 1_500, 2_500, 4_000, 6_000, 10_000],
})
const vitalRatings = Metric.frequency("web.vitals.ratings_total", {
	description: "Web Vital ratings by metric and rating",
})
const longFramesMetric = Metric.histogram("web.performance.long_frames", {
	description: "Long frames observed per reporting window",
	boundaries: [1, 2, 5, 10, 20, 50, 100],
})
const totalBlockingMetric = Metric.histogram("web.performance.total_blocking_ms", {
	description: "Total main-thread blocking time per reporting window",
	boundaries: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
})
const maxBlockingMetric = Metric.histogram("web.performance.max_blocking_ms", {
	description: "Maximum main-thread blocking time per reporting window",
	boundaries: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
})
const heapUsedMetric = Metric.gauge("web.performance.js_heap_used_bytes")

function reportVital(metric: WebVitalMetric): void {
	const valueMetric = metric.name === "CLS" ? clsMetric : metric.name === "INP" ? inpMetric : lcpMetric
	runtime.runFork(
		Effect.all([
			Metric.update(valueMetric, metric.value),
			Metric.update(vitalRatings, `${metric.name.toLowerCase()}:${metric.rating}`),
		]),
	)
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
	// The synthetic lab/bench routes generate long tasks on purpose.
	if (isLabPath(window.location.pathname)) return

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
		runtime.runFork(
			Effect.all([
				Metric.update(longFramesMetric, longFrames),
				Metric.update(totalBlockingMetric, totalBlockingMs),
				Metric.update(maxBlockingMetric, maxBlockingMs),
				...(heap ? [Metric.update(heapUsedMetric, heap.usedJSHeapSize)] : []),
			]),
		)
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
				: undefined),
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
