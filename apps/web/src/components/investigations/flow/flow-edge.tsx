/**
 * One edge component for all three kinds, because they differ only in stroke and
 * in whether they carry a word.
 *
 * The label sits *above* the line rather than on it. A label boxed over the
 * stroke breaks the strand it is describing, and with four fan strands 60px apart
 * the breaks line up into a second, meaningless column.
 */
import { memo } from "react"
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react"
import { cn } from "@maple/ui/lib/utils"

import type { EdgeKind } from "./provenance-graph"

export interface FlowEdgeData extends Record<string, unknown> {
	readonly kind: EdgeKind
	readonly label?: string
}

const ARROW = "url(#maple-flow-arrow)"

export const FlowEdge = memo(function FlowEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
}: EdgeProps & { data?: FlowEdgeData }) {
	const [path, labelX] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		// A low curvature keeps the causal spine reading as a straight run while
		// still letting the fan strands bow apart.
		curvature: 0.4,
	})
	const kind = data?.kind ?? "causal"

	return (
		<>
			<BaseEdge
				path={path}
				markerEnd={ARROW}
				style={{
					stroke: "var(--border)",
					strokeWidth: 1,
					...(kind === "roadmap" ? { strokeDasharray: "2 3" } : {}),
				}}
			/>
			{data?.label ? (
				<EdgeLabelRenderer>
					<span
						className={cn(
							// `whitespace-pre`, not `pre-line`: the span is shrink-to-fit inside
							// an absolutely-positioned layer, so anything that permits wrapping
							// collapses "TRIPPED" into a 23px column of single letters.
							"pointer-events-none absolute z-10 whitespace-pre text-center",
							"font-mono text-[9px] font-medium uppercase leading-3 tracking-[0.1em] text-muted-foreground",
						)}
						// Parked above the midpoint of the straight run, not on it.
						style={{
							transform: `translate(-50%, -100%) translate(${labelX}px, ${sourceY - 7}px)`,
						}}
					>
						{data.label.replace(" ", "\n")}
					</span>
				</EdgeLabelRenderer>
			) : null}
		</>
	)
})

/**
 * A single shared arrowhead definition. xyflow's built-in `MarkerType` markers
 * are re-emitted per edge; with a fan of four strands into one verdict node that
 * is a dozen identical `<marker>` elements for one triangle.
 */
export function FlowEdgeMarkers() {
	return (
		<svg className="pointer-events-none absolute size-0" aria-hidden>
			<defs>
				<marker
					id="maple-flow-arrow"
					viewBox="0 0 6 6"
					markerWidth="6"
					markerHeight="6"
					refX="5"
					refY="3"
					orient="auto"
				>
					<path d="M0 0 L5 3 L0 6 Z" fill="var(--border)" />
				</marker>
			</defs>
		</svg>
	)
}
