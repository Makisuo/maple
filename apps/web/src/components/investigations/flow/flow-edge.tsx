/**
 * One edge component for all three kinds, because they differ only in stroke and
 * in whether they carry a word.
 *
 * The label sits *above* the line rather than on it. A label boxed over the
 * stroke breaks the strand it is describing, and with four fan strands 60px apart
 * the breaks line up into a second, meaningless column.
 */
import { memo } from "react"
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react"
import { cn } from "@maple/ui/lib/utils"

import type { EdgeKind } from "./provenance-graph"

export interface FlowEdgeData extends Record<string, unknown> {
	readonly kind: EdgeKind
	readonly label?: string
}

/**
 * The dot sits centred on the card's own edge, so it reads as a port on the card
 * rather than a bead floating in the gutter. That means it has to hold its own
 * against the border it lands on: full muted-foreground and a hair wider than the
 * 2px it takes to merely cap the strand.
 */
const DOT = "fill-muted-foreground"
const DOT_R = 2.5

export const FlowEdge = memo(function FlowEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
}: EdgeProps & { data?: FlowEdgeData }) {
	const [path, labelX] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		// Square corners, softened. The 1→1 causal hops share a Y so they stay dead
		// straight; the radius only ever shows on the fan and merge columns.
		borderRadius: 8,
		// Under GUTTER/2 (52/2), so the vertical trunk clears both node edges.
		offset: 16,
	})
	const kind = data?.kind ?? "causal"

	return (
		<>
			<BaseEdge
				path={path}
				// Marching dashes, drifting source→target. Keyframes live in styles.css
				// because they have to stay in step with the dasharray below.
				className={kind === "roadmap" ? "provenance-strand-roadmap" : "provenance-strand"}
				style={{
					// Not `--border`: a 1px dashed run at border contrast is roughly half a
					// solid one, and the strand disappears. Muted-foreground held back to 45%
					// lands it between the card border and the label text.
					stroke: "var(--muted-foreground)",
					strokeOpacity: 0.45,
					strokeWidth: 1,
					// Dashed throughout — direction is carried by the left-to-right layout,
					// not by an arrowhead.
					strokeDasharray: kind === "roadmap" ? "4 4" : "3 3",
				}}
			/>
			{/*
			 * The junction dots. They do the work the arrowhead used to: without them a
			 * dashed strand fades out a pixel short of the card and reads as unattached.
			 * A fan re-draws the same source dot four times over — identical coordinates,
			 * so it costs three overdrawn circles and stays one dot on screen.
			 */}
			<circle cx={sourceX} cy={sourceY} r={DOT_R} className={DOT} />
			<circle cx={targetX} cy={targetY} r={DOT_R} className={DOT} />
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
