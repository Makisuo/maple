import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { deriveHostStatus, severityLevel } from "./format"
import { formatPercent } from "@maple/ui/format"
import { formatRelativeTime } from "@maple/ui/time-format"
import {
	HoneycombSection,
	type HoneycombCell,
	type HoneycombLegendItem,
	type HoneycombTone,
} from "./honeycomb"
import type { PodRow } from "./pod-table"

interface PodHoneycombProps {
	pods: ReadonlyArray<PodRow>
	referenceTime?: string
}

function toneOf(pod: PodRow, referenceTime?: string): HoneycombTone {
	if (deriveHostStatus(pod.lastSeen, referenceTime) !== "active") return "stale"
	return severityLevel(Math.max(pod.cpuLimitPct ?? 0, pod.memoryLimitPct ?? 0))
}

function toCell(pod: PodRow, referenceTime?: string): HoneycombCell {
	const tone = toneOf(pod, referenceTime)
	const worst = Math.max(pod.cpuLimitPct ?? 0, pod.memoryLimitPct ?? 0)
	return {
		key: `${pod.namespace}/${pod.podName}`,
		glyph: pod.podName.charAt(0).toUpperCase() || "·",
		tone,
		link: (
			<Link
				to="/infra/kubernetes/pods/$podName"
				params={{ podName: pod.podName }}
				search={pod.namespace ? { namespace: pod.namespace } : {}}
				aria-label={`${pod.podName} — worst limit ${formatPercent(worst)}`}
			/>
		),
		tooltip: (
			<>
				<div className="font-mono font-medium">{pod.podName}</div>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
					<span className="text-muted-foreground">CPU req</span>
					<span>{formatPercent(pod.cpuRequestPct)}</span>
					<span className="text-muted-foreground">CPU limit</span>
					<span>{formatPercent(pod.cpuLimitPct)}</span>
					<span className="text-muted-foreground">Mem req</span>
					<span>{formatPercent(pod.memoryRequestPct)}</span>
					<span className="text-muted-foreground">Mem limit</span>
					<span>{formatPercent(pod.memoryLimitPct)}</span>
				</div>
				<div className="border-t pt-1 text-[10px] text-muted-foreground">
					{pod.namespace ? `ns ${pod.namespace}` : "no namespace"}
					{pod.nodeName ? ` · node ${pod.nodeName}` : ""} · {formatRelativeTime(pod.lastSeen)}
				</div>
			</>
		),
	}
}

export function PodHoneycomb({ pods, referenceTime }: PodHoneycombProps) {
	const cells = useMemo(() => pods.map((p) => toCell(p, referenceTime)), [pods, referenceTime])

	const legend = useMemo<HoneycombLegendItem[]>(() => {
		const c: Record<HoneycombTone, number> = { ok: 0, warn: 0, crit: 0, stale: 0 }
		for (const p of pods) c[toneOf(p, referenceTime)]++
		return [
			{ tone: "ok", label: "Healthy", count: c.ok },
			{ tone: "warn", label: "Elevated", count: c.warn },
			{ tone: "crit", label: "Saturated", count: c.crit },
			{ tone: "stale", label: "Stale", count: c.stale },
		]
	}, [pods, referenceTime])

	return (
		<HoneycombSection
			label="Pods"
			count={pods.length}
			unit="pod"
			cells={cells}
			legend={legend}
			footnote="cell = max(cpu limit, memory limit)"
		/>
	)
}
