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

import { Result } from "@effect-atom/atom-react"

import { getServiceLegendColor } from "@maple/ui/colors"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@maple/ui/components/ui/popover"
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
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

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
          fitViewOptions={{ padding: 0.15, maxZoom: 1.5 }}
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
        {services.length > 0 && (
          <>
            <span className="text-foreground/30">|</span>
            {services.slice(0, 3).map((service) => (
              <div key={service} className="flex items-center gap-1.5">
                <div
                  className="h-2.5 w-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: getServiceLegendColor(service, services) }}
                />
                <span className="font-medium">{service}</span>
              </div>
            ))}
            {services.length > 3 && (
              <Popover>
                <PopoverTrigger className="font-medium hover:text-foreground transition-colors cursor-pointer">
                  +{services.length - 3} more
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-3" side="top">
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    {services.map((service) => (
                      <div key={service} className="flex items-center gap-1.5 min-w-0">
                        <div
                          className="h-2.5 w-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: getServiceLegendColor(service, services) }}
                        />
                        <span className="truncate font-medium">{service}</span>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-severity-info" />
            <span>Healthy</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-severity-warn" />
            <span>Degraded</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-severity-error" />
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

  const mapResult = useRefreshableAtomValue(getServiceMapResultAtom(mapInput))
  const overviewResult = useRefreshableAtomValue(getServiceOverviewResultAtom(overviewInput))

  // Render map as soon as edges arrive — don't wait for overview metrics
  const overviews = Result.isSuccess(overviewResult) ? overviewResult.value.data : []

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
    .onSuccess((mapResponse) => (
      <ServiceMapCanvas
        edges={mapResponse.edges}
        overviews={overviews}
        durationSeconds={durationSeconds}
      />
    ))
    .render()
}
