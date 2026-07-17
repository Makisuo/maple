import { Profiler, useMemo, type ProfilerOnRenderCallback } from "react"

import type { Log } from "@/api/warehouse/logs"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { LogsTableView } from "./logs-table"

interface LogsBenchMetrics {
	frames: number
	frameP95Ms: number
	longTasks: number
	totalBlockingMs: number
	reactCommits: number
	reactDurationMs: number
}

interface LogsBenchHarness {
	ready: boolean
	runScroll: () => Promise<LogsBenchMetrics>
}

declare global {
	interface Window {
		__logsBench?: LogsBenchHarness
	}
}

const ROW_COUNT = 2_000
const ATTRIBUTE_VALUE = "wide-value-".repeat(12)

const LOGS: Log[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
	timestamp: new Date(Date.UTC(2026, 6, 17, 18, 30) - index * 1_000).toISOString(),
	severityText: index % 17 === 0 ? "ERROR" : index % 5 === 0 ? "WARN" : "INFO",
	severityNumber: index % 17 === 0 ? 17 : index % 5 === 0 ? 13 : 9,
	serviceName: `checkout-worker-${index % 24}`,
	body: `Synthetic wide log row ${index}: ${"request processing details ".repeat(10)}`,
	traceId: `${index.toString(16).padStart(32, "0")}` as Log["traceId"],
	spanId: `${index.toString(16).padStart(16, "0")}` as Log["spanId"],
	logAttributes: Object.fromEntries(
		Array.from({ length: 10 }, (_, attributeIndex) => [
			`attribute.${attributeIndex}`,
			`${ATTRIBUTE_VALUE}${index}-${attributeIndex}`,
		]),
	),
	resourceAttributes: {
		"deployment.environment.name": "production",
		"cloud.region": "eu-central-1",
	},
}))

function percentile(values: number[], percentileValue: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.round((percentileValue / 100) * (sorted.length - 1)))
	return sorted[index] ?? 0
}

export function LogsTableBench() {
	const recorder = useMemo(() => {
		let commits = 0
		let duration = 0
		const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
			commits++
			duration += actualDuration
		}
		return {
			onRender,
			reset: () => {
				commits = 0
				duration = 0
			},
			snapshot: () => ({ commits, duration }),
		}
	}, [])

	useMountEffect(() => {
		const harness: LogsBenchHarness = {
			ready: false,
			runScroll: async () => {
				const scroller = document.querySelector<HTMLElement>(
					"[data-logs-bench] [role='log']",
				)?.parentElement
				if (!scroller) throw new Error("Logs benchmark scroller not found")
				recorder.reset()
				const frames: number[] = []
				const longTasks: PerformanceEntry[] = []
				let previous = performance.now()
				let frameHandle = 0
				let running = true
				let observer: PerformanceObserver | undefined
				try {
					observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
					observer.observe({ entryTypes: ["longtask"] })
				} catch {
					// Firefox/WebKit do not expose Long Tasks; frame and React metrics remain valid.
				}
				const sample = (now: number) => {
					frames.push(now - previous)
					previous = now
					if (running) frameHandle = requestAnimationFrame(sample)
				}
				frameHandle = requestAnimationFrame(sample)
				const maxScroll = scroller.scrollHeight - scroller.clientHeight
				for (let step = 0; step <= 120; step++) {
					scroller.scrollTop = maxScroll * (step / 120)
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
				}
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				)
				running = false
				cancelAnimationFrame(frameHandle)
				observer?.disconnect()
				const react = recorder.snapshot()
				return {
					frames: frames.length,
					frameP95Ms: percentile(frames, 95),
					longTasks: longTasks.length,
					totalBlockingMs: longTasks.reduce(
						(sum, entry) => sum + Math.max(0, entry.duration - 50),
						0,
					),
					reactCommits: react.commits,
					reactDurationMs: react.duration,
				}
			},
		}
		window.__logsBench = harness
		requestAnimationFrame(() => {
			harness.ready = Boolean(document.querySelector("[data-logs-bench] [role='log']"))
		})
		return () => {
			if (window.__logsBench === harness) delete window.__logsBench
		}
	})

	return (
		<div data-logs-bench className="flex h-screen flex-col bg-background p-4 text-foreground">
			<Profiler id="logs-table-bench" onRender={recorder.onRender}>
				<LogsTableView
					allData={LOGS}
					isFetchingNextPage={false}
					hasNextPage={false}
					isCapped
					fetchNextPage={() => {}}
					waiting={false}
					wrap={false}
					density="compact"
					pinnedColumns={["deployment.environment.name", "cloud.region"]}
					embedded
					onLogClick={() => {}}
				/>
			</Profiler>
		</div>
	)
}
