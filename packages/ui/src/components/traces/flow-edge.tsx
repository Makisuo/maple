import { memo, useState } from "react"
import { getSmoothStepPath, type EdgeProps } from "@xyflow/react"

import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import type { FlowEdge } from "./flow-utils"

/** Share of the trace below which a non-error, non-combined edge stays unlabeled. */
const LABEL_SHARE_THRESHOLD = 0.05

/** Stroke width by trace share — same sqrt scaling as the card cost rail. */
function strokeWidthForShare(share: number): number {
	return Math.min(4, 1.5 + 2.5 * Math.sqrt(Math.max(0, share)))
}

function formatShare(share: number): string | undefined {
	const pct = Math.round(share * 100)
	return pct >= 1 ? `${pct}%` : undefined
}

export const TraceFlowEdge = memo(function TraceFlowEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
}: EdgeProps<FlowEdge>) {
	const [hovered, setHovered] = useState(false)

	const [edgePath, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		borderRadius: 8,
	})

	const isError = data?.isError ?? false
	const isMissing = data?.isMissing ?? false
	const share = data?.share ?? 0
	const count = data?.count ?? 1

	const baseWidth = strokeWidthForShare(share)
	const strokeWidth = hovered ? baseWidth + 0.5 : baseWidth
	const stroke = isError ? "var(--severity-error)" : "var(--flow-edge, var(--border))"

	// Default labels only on significant edges; hover reveals the full pill.
	const showLabel = hovered || isError || count > 1 || share >= LABEL_SHARE_THRESHOLD

	let label: React.ReactNode = null
	if (showLabel && data) {
		if (isMissing) {
			label = hovered ? <span className="italic text-muted-foreground/60">no data</span> : null
		} else if (hovered) {
			const sharePct = formatShare(share)
			label = (
				<>
					{data.startOffsetMs !== undefined && data.startOffsetMs > 0 && (
						<span className={data.accentText}>+{formatDuration(data.startOffsetMs)} → </span>
					)}
					<span className={cn(isError && "text-severity-error")}>
						{formatDuration(data.durationMs)}
					</span>
					{sharePct && <span> ({sharePct})</span>}
					{count > 1 && (
						<span>
							{" "}
							· ×{count}, {formatDuration(data.minMs)}–{formatDuration(data.maxMs)}
						</span>
					)}
				</>
			)
		} else if (isError) {
			label = <span className="text-severity-error">{formatDuration(data.durationMs)}</span>
		} else if (count > 1) {
			label = (
				<span>
					×{count} · {formatDuration(data.durationMs)}
				</span>
			)
		} else {
			label = <span>{formatDuration(data.durationMs)}</span>
		}
	}

	return (
		<>
			<path
				className={cn(!isMissing && "react-flow__edge-path")}
				d={edgePath}
				fill="none"
				stroke={stroke}
				strokeWidth={strokeWidth}
				strokeDasharray={isMissing ? "4 4" : undefined}
				style={{ transition: "stroke-width 150ms" }}
			/>
			{/* Wide invisible hit area so thin edges are hoverable */}
			<path
				d={edgePath}
				fill="none"
				stroke="transparent"
				strokeWidth={16}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
			/>
			{label && (
				<foreignObject
					x={labelX - 90}
					y={labelY + (targetY > sourceY ? -16 : 4) - 12}
					width={180}
					height={24}
					className="pointer-events-none overflow-visible"
				>
					<div className="flex h-full items-center justify-center">
						<span className="whitespace-nowrap rounded border border-border/50 bg-card/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur-sm">
							{label}
						</span>
					</div>
				</foreignObject>
			)}
		</>
	)
})
