import { Profiler, useMemo } from "react"

import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lib/bench/interaction-bench"

export type ServiceDetailBenchSyncMode = "recharts" | "cursor"

declare global {
	interface Window {
		__serviceDetailBench?: InteractionBenchHarness
	}
}

const BUCKET_COUNT = 145
const BUCKET_MS = 5 * 60 * 1000
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)

const SERVICE_DETAIL_POINTS: Record<string, unknown>[] = Array.from({ length: BUCKET_COUNT }, (_, index) => {
	const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
	const traffic = 1_250 + Math.sin(phase) * 410 + Math.cos(phase * 0.37) * 190
	const errorRate = 0.18 + Math.max(0, Math.sin(phase * 0.73)) * 0.42
	const p50LatencyMs = 320 + Math.sin(phase * 0.63) * 85
	const bucket = new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString()

	return {
		bucket,
		p50LatencyMs,
		p95LatencyMs: p50LatencyMs * 1.8,
		p99LatencyMs: p50LatencyMs * 2.75,
		throughput: traffic * (BUCKET_MS / 1000),
		tracedThroughput: traffic * 0.14 * (BUCKET_MS / 1000),
		hasSampling: true,
		errorRate,
		apdexScore: Math.max(0.72, 0.97 - errorRate * 0.12 - Math.sin(phase * 0.41) * 0.025),
	}
})

const SERVICE_DETAIL_ITEMS = [
	{
		id: "latency",
		chartId: "latency-line",
		title: "Latency",
		layout: { x: 0, y: 0, w: 6, h: 4 },
		data: SERVICE_DETAIL_POINTS,
		legend: "visible" as const,
		tooltip: "visible" as const,
	},
	{
		id: "throughput",
		chartId: "throughput-area",
		title: "Throughput",
		layout: { x: 6, y: 0, w: 6, h: 4 },
		data: SERVICE_DETAIL_POINTS,
		tooltip: "visible" as const,
		rateMode: "per_second" as const,
	},
	{
		id: "apdex",
		chartId: "apdex-area",
		title: "Apdex",
		layout: { x: 0, y: 4, w: 6, h: 4 },
		data: SERVICE_DETAIL_POINTS,
		tooltip: "visible" as const,
	},
	{
		id: "error-rate",
		chartId: "error-rate-area",
		title: "Error Rate",
		layout: { x: 6, y: 4, w: 6, h: 4 },
		data: SERVICE_DETAIL_POINTS,
		tooltip: "visible" as const,
	},
]

export function ServiceDetailChartBench({ syncMode }: { syncMode?: ServiceDetailBenchSyncMode }) {
	const recorder = useMemo(() => createReactRecorder(), [])

	useMountEffect(() => {
		const bench = startInteractionBench({
			recorder,
			isReady: () =>
				document.querySelectorAll("[data-testid='service-detail-chart-bench'] .recharts-wrapper")
					.length === SERVICE_DETAIL_ITEMS.length,
		})
		window.__serviceDetailBench = bench.harness

		return () => {
			bench.dispose()
			if (window.__serviceDetailBench === bench.harness) delete window.__serviceDetailBench
		}
	})

	return (
		<div
			data-testid="service-detail-chart-bench"
			className="min-h-screen bg-background p-6 text-foreground"
		>
			<Profiler id={`service-detail-${syncMode ?? "default"}`} onRender={recorder.onRender}>
				<MetricsGrid
					items={SERVICE_DETAIL_ITEMS}
					syncMode={syncMode}
					syncId="service-detail-bench"
					yAxisWidth={72}
				/>
			</Profiler>
		</div>
	)
}
