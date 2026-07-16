import { memo, useEffect, useId } from "react"
import { getSmoothStepPath, type EdgeProps } from "@xyflow/react"
import { getServiceColor, getValueHue } from "@maple/ui/colors"
import { getDbNodeColor } from "./service-map-db"
import {
	isDbNodeId,
	isNsAggregateId,
	NS_AGGREGATE_PREFIX,
	parseDbNodeId,
	type ServiceEdgeData,
} from "./service-map-utils"
import { useParticleRegistry } from "./service-map-particles"

// Db endpoints (`db:<system>:<namespace>` ids) resolve to their brand color per
// system — Hyperdrive-collapsed nodes get the Cloudflare orange instead.
const dbEndpointColor = (nodeId: string): string => {
	const { dbSystem, dbNamespace } = parseDbNodeId(nodeId)
	return getDbNodeColor(dbSystem, dbNamespace)
}

const endpointColor = (nodeId: string): string => {
	if (isDbNodeId(nodeId)) return dbEndpointColor(nodeId)
	if (isNsAggregateId(nodeId)) {
		// Collapsed-namespace aggregate: match the namespace box / aggregate card hue.
		const ns = decodeURIComponent(nodeId.slice(NS_AGGREGATE_PREFIX.length))
		return `oklch(0.66 0.12 ${getValueHue(ns) ?? 0})`
	}
	return getServiceColor(nodeId)
}

function getStrokeWidth(callCount: number): number {
	if (callCount <= 0) return 2
	return Math.min(8, Math.max(2, 2 + Math.log10(callCount) * 2))
}

function getEdgeIntensity(callsPerSecond: number): number {
	if (callsPerSecond <= 0) return 0.15
	return Math.min(1, 0.3 + 0.7 * (Math.log10(1 + callsPerSecond) / Math.log10(100)))
}

function formatCallCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
	return String(count)
}

/**
 * Edges are rendered as cheap, filter-free SVG "tubes" (stacked translucent
 * gradient strokes). All animation — the flowing-traffic particles — is drawn
 * on a single shared <canvas> ({@link ServiceMapParticleCanvas}); each edge just
 * publishes its path + rate into the particle registry. This keeps the SVG layer
 * free of `feGaussianBlur` filters and SMIL animations, which previously
 * re-rasterized every frame and scaled with traffic.
 */
export const ServiceMapEdge = memo(function ServiceMapEdge({
	id,
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
}: EdgeProps) {
	const uniqueId = useId()
	const edgeData = data as ServiceEdgeData | undefined

	const callCount = edgeData?.callCount ?? 0
	const estimatedCallCount = edgeData?.hasSampling
		? Math.round(
				(edgeData?.estimatedCallsPerSecond ?? 0) *
					(callCount / Math.max(edgeData?.callsPerSecond ?? 1, 0.001)),
			)
		: callCount
	const callsPerSecond = edgeData?.callsPerSecond ?? 0
	const errorRate = edgeData?.errorRate ?? 0
	const hasSampling = edgeData?.hasSampling ?? false
	const dimmed = edgeData?.dimmed === true

	const [edgePath, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		borderRadius: 12,
	})

	const sourceColor = endpointColor(source)
	const targetColor = endpointColor(target)
	const sw = getStrokeWidth(callCount)
	// Dimmed edges (focus mode) drop to a faint trace so the neighborhood pops.
	const i = dimmed ? 0 : getEdgeIntensity(callsPerSecond)
	const dimFactor = dimmed ? 0.18 : 1

	const gradientId = `grad-${id}-${uniqueId}`.replace(/[^a-zA-Z0-9-_]/g, "_")

	// Publish geometry into the registry so the shared particle canvas can animate
	// traffic along this edge. Re-runs only when the path / color / rate changes.
	// Dimmed edges publish a zero rate so the global particle budget flows to the
	// focused neighborhood instead of the faded background.
	const registry = useParticleRegistry()
	useEffect(() => {
		if (!registry) return
		registry.set(id, {
			pathString: edgePath,
			sourceColor,
			callsPerSecond: dimmed ? 0 : callsPerSecond,
			strokeWidth: sw,
		})
		return () => registry.remove(id)
	}, [registry, id, edgePath, sourceColor, callsPerSecond, sw, dimmed])

	return (
		<>
			<defs>
				{/* Per-edge gradient from source → target service color */}
				<linearGradient
					id={gradientId}
					gradientUnits="userSpaceOnUse"
					x1={sourceX}
					y1={sourceY}
					x2={targetX}
					y2={targetY}
				>
					<stop offset="0%" stopColor={sourceColor} />
					<stop offset="100%" stopColor={targetColor} />
				</linearGradient>
			</defs>

			{/* Layer 0: Ambient halo — wide, very low-opacity stroke (no filter) */}
			<path
				d={edgePath}
				fill="none"
				stroke={`url(#${gradientId})`}
				strokeWidth={sw * 3 + 12}
				strokeOpacity={(0.03 + i * 0.05) * dimFactor}
				strokeLinecap="round"
			/>

			{/* Layer 1: Tube outer wall — bright rim highlight */}
			<path
				d={edgePath}
				fill="none"
				stroke={`url(#${gradientId})`}
				strokeWidth={sw + 4}
				strokeOpacity={(0.12 + i * 0.15) * dimFactor}
			/>

			{/* Layer 2: Tube core — hollow interior matching the canvas background
			    (theme token; SVG presentation attrs don't support var(), so set via style) */}
			<path
				d={edgePath}
				fill="none"
				style={{ stroke: "var(--service-map-edge-core)" }}
				strokeWidth={sw}
				strokeOpacity={(0.5 + i * 0.2) * dimFactor}
				className="react-flow__edge-path"
			/>

			{/* Layer 3: Inner highlight — thin bright gradient line (no filter) */}
			<path
				d={edgePath}
				fill="none"
				stroke={`url(#${gradientId})`}
				strokeWidth={Math.max(1, sw * 0.4)}
				strokeOpacity={(0.15 + i * 0.25) * dimFactor}
			/>

			{/* Layer 4: Label — offset vertically based on edge direction to reduce
			    overlap. Hidden entirely on dimmed edges so the focus reads clean. */}
			{dimmed ? null : (
			<foreignObject
				x={labelX - 40}
				y={labelY + (targetY > sourceY ? -16 : 4) - 12}
				width={80}
				height={24}
				className="overflow-visible pointer-events-none"
			>
				<div
					className="flex items-center justify-center"
					title={
						hasSampling
							? "Based on traced requests — actual rate may be higher with sampling enabled"
							: undefined
					}
				>
					<span className="rounded bg-card/90 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-mono font-medium text-muted-foreground border border-border/50 whitespace-nowrap tabular-nums">
						{hasSampling ? "~" : ""}
						{formatCallCount(hasSampling ? estimatedCallCount : callCount)}
						{errorRate > 0 && (
							<span
								className={
									errorRate > 0.05
										? " text-severity-error"
										: errorRate > 0.01
											? " text-severity-warn"
											: ""
								}
							>
								{" "}
								{(errorRate * 100).toFixed(1)}%
							</span>
						)}
					</span>
				</div>
			</foreignObject>
			)}
		</>
	)
})
