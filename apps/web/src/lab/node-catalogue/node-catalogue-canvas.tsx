/**
 * The studio's host: the catalogue graph, in the production renderer.
 *
 * Deliberately thin. Everything that makes `ProvenanceCanvas` a *page* widget —
 * the caption, the zoom controls, the action detail sheet, the loading ghost, the
 * viewport arithmetic that anchors a chain to its left edge — is absent, because
 * none of it is what we are looking at. What it keeps is the one thing that
 * matters: the same `nodeTypes` and `edgeTypes`, imported rather than redeclared,
 * so a node that looks right here looks right on the investigation page.
 */
import { useMemo } from "react"
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import type { FlowEdgeData } from "@/components/investigations/flow/flow-edge"
import { buildNodeCatalogue } from "./node-catalogue"
import { edgeTypes, nodeTypes } from "@/components/investigations/flow/provenance-canvas"

export function NodeCatalogueCanvas() {
	const catalogue = useMemo(() => buildNodeCatalogue(), [])

	const nodes = useMemo<Array<Node>>(
		() =>
			catalogue.nodes.map((node) => ({
				id: node.id,
				type: node.type,
				position: node.position,
				width: node.width,
				height: node.height,
				data: node.data as Record<string, unknown>,
				draggable: false,
				selectable: false,
				connectable: false,
				// Same opt-in the real canvas needs: xyflow sets `pointer-events: none`
				// on a node wrapper when nothing about it is interactive, which would
				// make every link and hover title on these cards inert — and hover
				// titles are half of what a studio is for.
				style: { pointerEvents: "all" },
			})),
		[catalogue],
	)

	const edges = useMemo<Array<Edge>>(
		() =>
			catalogue.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				type: "provenance",
				data: {
					kind: edge.kind,
					...(edge.label ? { label: edge.label } : undefined),
					...(edge.live ? { live: true } : undefined),
				} satisfies FlowEdgeData,
			})),
		[catalogue],
	)

	return (
		<ReactFlowProvider>
			{/*
			 * The pane is as tall as the catalogue at 1:1 and the *page* scrolls, rather
			 * than the graph being fitted into whatever height the layout has left.
			 * fitView on a gallery this tall settles around 0.3, at which the 9px badge
			 * words this studio exists to judge are no longer words. Pan and zoom still
			 * work for anyone who wants a closer look.
			 */}
			<div style={{ height: catalogue.height + PAD * 2, width: "100%" }}>
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					connectOnClick={false}
					proOptions={{ hideAttribution: true }}
					defaultViewport={{ x: PAD, y: PAD, zoom: 1 }}
					minZoom={0.2}
					maxZoom={1.5}
				/>
			</div>
		</ReactFlowProvider>
	)
}

/** Breathing room around the grid, and the offset the default viewport opens at. */
const PAD = 24
