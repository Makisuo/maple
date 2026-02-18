import { useMemo, useRef } from "react"
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { Result, useAtomValue } from "@effect-atom/atom-react"

import { getServiceLegendColor } from "@/lib/colors"
import { getServiceMapResultAtom, getServiceOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import type { GetServiceMapInput, ServiceEdge } from "@/api/tinybird/service-map"
import type { GetServiceOverviewInput, ServiceOverview } from "@/api/tinybird/services"
import { ServiceMapNode } from "./service-map-node"
import { ServiceMapEdge } from "./service-map-edge"
import {
  buildFlowElements,
  layoutNodes,
  topologyChanged,
  type ServiceNodeData,
  type ServiceEdgeData,
} from "./service-map-utils"

const nodeTypes = {
  serviceNode: ServiceMapNode,
}

const edgeTypes = {
  serviceEdge: ServiceMapEdge,
}

interface ServiceMapViewProps {
  startTime: string
  endTime: string
}

function ServiceMapCanvas({
  edges: serviceEdges,
  overviews,
  durationSeconds,
}: {
  edges: ServiceEdge[]
  overviews: ServiceOverview[]
  durationSeconds: number
}) {
  const prevNodesRef = useRef<Node<ServiceNodeData>[]>([])
  const prevEdgesRef = useRef<Edge<ServiceEdgeData>[]>([])

  const { layoutedNodes, flowEdges, services } = useMemo(() => {
    const { nodes: rawNodes, edges: rawEdges } = buildFlowElements(serviceEdges, overviews, durationSeconds)

    const needsLayout = topologyChanged(
      prevNodesRef.current,
      rawNodes,
      prevEdgesRef.current,
      rawEdges,
    )

    const positioned = needsLayout
      ? layoutNodes(rawNodes, rawEdges)
      : rawNodes.map((n, i) => ({
          ...n,
          position: prevNodesRef.current[i]?.position ?? n.position,
        }))

    prevNodesRef.current = positioned
    prevEdgesRef.current = rawEdges

    const allServices = [...new Set(positioned.map((n) => n.id))].sort()

    return { layoutedNodes: positioned, flowEdges: rawEdges, services: allServices }
  }, [serviceEdges, overviews, durationSeconds])

  const [nodes, , onNodesChange] = useNodesState(layoutedNodes)
  const [edges] = useEdgesState(flowEdges)

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            No service dependencies found
          </p>
          <p className="text-xs text-muted-foreground/60">
            Service connections will appear when trace data with cross-service calls is ingested.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0">
        <ReactFlow
          key={nodes.map((n) => n.id).join(",")}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable
          nodesConnectable={false}
          connectOnClick={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node: Node) => {
              const data = node.data as ServiceNodeData
              return getServiceLegendColor(data.label, data.services)
            }}
            maskColor="oklch(0.15 0 0 / 0.8)"
            className="!bg-muted/50 !border-border"
            pannable={false}
            zoomable={false}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        </ReactFlow>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground shrink-0">
        <span className="font-medium">Drag nodes to arrange</span>
        <span className="text-foreground/30">|</span>
        <span className="font-medium">Scroll to zoom</span>
        <span className="text-foreground/30">|</span>
        <div className="flex items-center gap-3">
          {services.map((service) => (
            <div key={service} className="flex items-center gap-1.5">
              <div
                className="h-3 w-3 rounded-sm shadow-sm"
                style={{ backgroundColor: getServiceLegendColor(service, services) }}
              />
              <span className="font-medium">{service}</span>
            </div>
          ))}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>Healthy</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-amber-500" />
            <span>Degraded</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-red-500" />
            <span>Error</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ServiceMapView({ startTime, endTime }: ServiceMapViewProps) {
  const durationSeconds = useMemo(() => {
    const ms = new Date(endTime).getTime() - new Date(startTime).getTime()
    return Math.max(1, ms / 1000)
  }, [startTime, endTime])

  const mapInput: { data: GetServiceMapInput } = useMemo(
    () => ({ data: { startTime, endTime } }),
    [startTime, endTime],
  )

  const overviewInput: { data: GetServiceOverviewInput } = useMemo(
    () => ({ data: { startTime, endTime } }),
    [startTime, endTime],
  )

  const mapResult = useAtomValue(getServiceMapResultAtom(mapInput))
  const overviewResult = useAtomValue(getServiceOverviewResultAtom(overviewInput))

  // Both need to be loaded for the view
  return Result.builder(mapResult)
    .onInitial(() => (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground animate-pulse">
          Loading service map...
        </div>
      </div>
    ))
    .onError((error) => (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <p className="text-sm font-medium text-destructive">Failed to load service map</p>
          <p className="text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    ))
    .onSuccess((mapResponse) =>
      Result.builder(overviewResult)
        .onInitial(() => (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground animate-pulse">
              Loading service metrics...
            </div>
          </div>
        ))
        .onError(() => (
          // Still render the map without overview metrics
          <ServiceMapCanvas edges={mapResponse.edges} overviews={[]} durationSeconds={durationSeconds} />
        ))
        .onSuccess((overviewResponse) => (
          <ServiceMapCanvas
            edges={mapResponse.edges}
            overviews={overviewResponse.data}
            durationSeconds={durationSeconds}
          />
        ))
        .render(),
    )
    .render()
}
