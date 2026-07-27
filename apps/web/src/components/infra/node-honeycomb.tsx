import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { deriveHostStatus, type HostStatus } from "./format"
import { formatUptime } from "@maple/ui/format"
import { formatRelativeTime } from "@maple/ui/time-format"
import {
	HoneycombSection,
	type HoneycombCell,
	type HoneycombLegendItem,
	type HoneycombTone,
} from "./honeycomb"
import type { NodeRow } from "./node-table"

interface NodeHoneycombProps {
	nodes: ReadonlyArray<NodeRow>
	referenceTime?: string
}

// Nodes report CPU in cores (no utilization ceiling), so color by liveness only.
const STATUS_TONE: Record<HostStatus, HoneycombTone> = {
	active: "ok",
	idle: "warn",
	down: "stale",
}

function toCell(node: NodeRow, referenceTime?: string): HoneycombCell {
	const status = deriveHostStatus(node.lastSeen, referenceTime)
	const cores = Number.isFinite(node.cpuUsage) ? node.cpuUsage.toFixed(2) : "—"
	return {
		key: node.nodeName,
		glyph: node.nodeName.charAt(0).toUpperCase() || "·",
		tone: STATUS_TONE[status],
		link: (
			<Link
				to="/infra/kubernetes/nodes/$nodeName"
				params={{ nodeName: node.nodeName }}
				aria-label={`${node.nodeName} — ${status}`}
			/>
		),
		tooltip: (
			<>
				<div className="font-mono font-medium">{node.nodeName}</div>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
					<span className="text-muted-foreground">CPU cores</span>
					<span>{cores}</span>
					<span className="text-muted-foreground">Uptime</span>
					<span>{formatUptime(node.uptime)}</span>
				</div>
				<div className="border-t pt-1 text-[10px] text-muted-foreground">
					{status === "active" ? "Active" : status === "idle" ? "Idle" : "Down"} ·{" "}
					{formatRelativeTime(node.lastSeen)}
				</div>
			</>
		),
	}
}

export function NodeHoneycomb({ nodes, referenceTime }: NodeHoneycombProps) {
	const cells = useMemo(() => nodes.map((n) => toCell(n, referenceTime)), [nodes, referenceTime])

	const legend = useMemo<HoneycombLegendItem[]>(() => {
		const c: Record<HostStatus, number> = { active: 0, idle: 0, down: 0 }
		for (const n of nodes) c[deriveHostStatus(n.lastSeen, referenceTime)]++
		return [
			{ tone: "ok", label: "Healthy", count: c.active },
			{ tone: "warn", label: "Idle", count: c.idle },
			{ tone: "stale", label: "Down", count: c.down },
		]
	}, [nodes, referenceTime])

	return (
		<HoneycombSection
			label="Nodes"
			count={nodes.length}
			unit="node"
			cells={cells}
			legend={legend}
			footnote="cell = reporting status"
		/>
	)
}
