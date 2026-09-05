import { useMemo } from "react"
import type { Edge, Node } from "@xyflow/react"
import type { ServiceEdgeData, ServiceNodeData } from "../service-map-utils"
import { liveTopology } from "./live-topology"
import { ServiceMap3DViewport } from "./viewport"

export default function LiveServiceMap3D({
	nodes,
	edges,
	dimmedNodeIds,
	dimmedEdgeIds,
	selectedId,
	onSelect,
}: {
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	dimmedNodeIds: ReadonlySet<string>
	dimmedEdgeIds: ReadonlySet<string>
	selectedId: string | null
	onSelect: (id: string | null) => void
}) {
	const topology = useMemo(
		() => liveTopology(nodes, edges, dimmedNodeIds, dimmedEdgeIds),
		[nodes, edges, dimmedNodeIds, dimmedEdgeIds],
	)
	return <ServiceMap3DViewport topology={topology} selectedId={selectedId} onSelect={onSelect} />
}
