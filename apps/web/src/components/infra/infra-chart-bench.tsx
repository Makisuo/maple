import { Profiler, useMemo } from "react"

import { HostMetricChartView } from "@/components/infra/host-detail-chart"
import { K8sMetricChartView } from "@/components/infra/k8s-detail-chart"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lib/bench/interaction-bench"

export type InfraBenchSyncMode = "recharts" | "cursor"

declare global {
	interface Window {
		__infraBench?: InteractionBenchHarness
	}
}

const BUCKET_COUNT = 145
const BUCKET_MS = 60 * 1000
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)
const CHART_COUNT = 4

interface InfraRow {
	bucket: string
	attributeValue: string
	value: number
}

function makeRows(seriesNames: string[], scale: number, offset: number): InfraRow[] {
	const rows: InfraRow[] = []
	for (let index = 0; index < BUCKET_COUNT; index++) {
		const bucket = new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString()
		const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
		for (let s = 0; s < seriesNames.length; s++) {
			rows.push({
				bucket,
				attributeValue: seriesNames[s],
				value: Math.max(0, (0.25 + 0.2 * Math.sin(phase + s * 1.3 + offset)) * scale),
			})
		}
	}
	return rows
}

const HOST_CPU_ROWS = makeRows(["user", "system", "iowait"], 1, 0)
const HOST_LOAD_ROWS = makeRows(["value"], 8, 1.1)
const POD_CPU_ROWS = makeRows(["api", "worker", "ingest"], 1, 2.2)
const POD_LIMIT_ROWS = makeRows(["value"], 1, 3.3)

/**
 * Synthetic /infra-bench page: the infra detail ChartViews (host + k8s) in one
 * linked-cursor group, mirroring the host-detail and infra-correlation grids.
 * `?mode=recharts` restores Recharts' syncId event bus as the storm baseline
 * the perf spec compares against.
 */
export function InfraChartBench({ syncMode }: { syncMode?: InfraBenchSyncMode }) {
	const recorder = useMemo(() => createReactRecorder(), [])
	// Omitting syncMode exercises the ChartViews' real default ("cursor") — the
	// container hook is a no-op storm-wise, so enabling it unconditionally except
	// for the explicit recharts baseline keeps the default path honest.
	const linkedCursorEnabled = syncMode !== "recharts"
	const { containerProps } = useLinkedCursor(linkedCursorEnabled)

	useMountEffect(() => {
		const bench = startInteractionBench({
			recorder,
			isReady: () =>
				document.querySelectorAll("[data-testid='infra-chart-bench'] .recharts-wrapper").length ===
				CHART_COUNT,
		})
		window.__infraBench = bench.harness

		return () => {
			bench.dispose()
			if (window.__infraBench === bench.harness) delete window.__infraBench
		}
	})

	return (
		<div data-testid="infra-chart-bench" className="min-h-screen bg-background p-6 text-foreground">
			<Profiler id={`infra-bench-${syncMode ?? "default"}`} onRender={recorder.onRender}>
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2" {...containerProps}>
					<HostMetricChartView
						rows={HOST_CPU_ROWS}
						unit="percent"
						metric="cpu"
						seriesLabel="CPU"
						waiting={false}
						syncId="infra-bench"
						syncMode={syncMode}
					/>
					<HostMetricChartView
						rows={HOST_LOAD_ROWS}
						unit="load"
						metric="load15"
						seriesLabel="Load (15m)"
						waiting={false}
						syncId="infra-bench"
						syncMode={syncMode}
					/>
					<K8sMetricChartView
						rows={POD_CPU_ROWS}
						unit="cores"
						seriesLabel="CPU usage"
						isStacked
						waiting={false}
						syncId="infra-bench"
						syncMode={syncMode}
						chartId="pod-cpu_usage"
					/>
					<K8sMetricChartView
						rows={POD_LIMIT_ROWS}
						unit="percent"
						seriesLabel="CPU / limit"
						showThreshold
						waiting={false}
						syncId="infra-bench"
						syncMode={syncMode}
						chartId="pod-cpu_limit"
					/>
				</div>
			</Profiler>
		</div>
	)
}
