import { useMemo, useRef, useState, useCallback } from "react"
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
import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/utils"
import { getServiceLegendColor } from "@maple/ui/colors"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@maple/ui/components/ui/popover"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@maple/ui/components/ui/resizable"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Button } from "@maple/ui/components/ui/button"
import { XmarkIcon } from "@/components/icons"
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

// --- Detail Panel ---

function formatRate(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (value >= 1) return value.toFixed(1)
  return value.toFixed(2)
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(1)}ms`
}

function getHealthDotClass(errorRate: number): string {
  if (errorRate > 5) return "bg-severity-error"
  if (errorRate > 1) return "bg-severity-warn"
  return "bg-severity-info"
}

interface ServiceDetailPanelProps {
  serviceId: string
  services: string[]
  edges: ServiceEdge[]
  overviews: ServiceOverview[]
  durationSeconds: number
  onClose: () => void
}

function ServiceDetailPanel({
  serviceId,
  services,
  edges,
  overviews,
  durationSeconds,
  onClose,
}: ServiceDetailPanelProps) {
  const overview = overviews.find((o) => o.serviceName === serviceId)
  const accentColor = getServiceLegendColor(serviceId, services)
  const errorRate = overview?.errorRate ?? 0

  const throughput = overview?.throughput ?? 0
  const hasSampling = overview?.hasSampling ?? false
  const avgLatencyMs = overview?.p50LatencyMs ?? 0
  const p95LatencyMs = overview?.p95LatencyMs ?? 0

  const dependencies = edges.filter((e) => e.sourceService === serviceId)
  const calledBy = edges.filter((e) => e.targetService === serviceId)

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-[3px] h-[18px] rounded-sm shrink-0"
            style={{ backgroundColor: accentColor }}
          />
          <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getHealthDotClass(errorRate))} />
          <span className="text-sm font-semibold text-foreground truncate">{serviceId}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/services/$serviceName"
            params={{ serviceName: serviceId }}
            className="text-[10px] text-primary hover:text-primary/80 transition-colors"
          >
            View service
          </Link>
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <XmarkIcon size={14} />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Metrics */}
          <div className="space-y-3">
            <h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">Metrics</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Throughput</span>
                <p className="text-xl font-semibold text-foreground tabular-nums font-mono">
                  {hasSampling ? "~" : ""}{formatRate(throughput)}
                </p>
                <span className="text-[10px] text-muted-foreground">req/s</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Error Rate</span>
                <p className={cn(
                  "text-xl font-semibold tabular-nums font-mono",
                  errorRate > 5 ? "text-severity-error" : errorRate > 1 ? "text-severity-warn" : "text-foreground",
                )}>
                  {errorRate.toFixed(1)}%
                </p>
              </div>
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Avg Latency</span>
                <p className="text-xl font-semibold text-foreground tabular-nums font-mono">
                  {formatLatency(avgLatencyMs)}
                </p>
              </div>
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">P95 Latency</span>
                <p className={cn(
                  "text-xl font-semibold tabular-nums font-mono",
                  p95LatencyMs > avgLatencyMs * 3 ? "text-severity-warn" : "text-foreground",
                )}>
                  {formatLatency(p95LatencyMs)}
                </p>
              </div>
            </div>
          </div>

          {/* Dependencies */}
          {dependencies.length > 0 && (
            <div className="space-y-3">
              <div className="h-px bg-border" />
              <h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">Dependencies</h4>
              <div className="space-y-1.5">
                {dependencies.map((dep) => {
                  const depColor = getServiceLegendColor(dep.targetService, services)
                  const depErrorRate = dep.errorRate
                  const isError = depErrorRate > 5
                  const safeDuration = Math.max(durationSeconds, 1)
                  const depReqPerSec = dep.hasSampling
                    ? dep.estimatedCallCount / safeDuration
                    : dep.callCount / safeDuration
                  const depTracedReqPerSec = dep.callCount / safeDuration
                  return (
                    <div
                      key={dep.targetService}
                      className={cn(
                        "flex items-center justify-between px-2.5 py-2 rounded-md border text-xs",
                        isError
                          ? "bg-severity-error/[0.04] border-severity-error/[0.12]"
                          : "bg-card border-border",
                      )}
                      title={dep.hasSampling ? `Estimated x${dep.samplingWeight.toFixed(0)} from ${formatRate(depTracedReqPerSec)} traced req/s` : undefined}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div
                          className="w-[3px] h-3.5 rounded-sm shrink-0"
                          style={{ backgroundColor: depColor }}
                        />
                        <span className="text-foreground truncate">{dep.targetService}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-[10px]">
                        <span className="text-muted-foreground tabular-nums font-mono">
                          {dep.hasSampling ? "~" : ""}{formatRate(depReqPerSec)} req/s
                        </span>
                        <span
                          className={cn(
                            "tabular-nums font-mono",
                            depErrorRate > 5
                              ? "text-severity-error"
                              : depErrorRate > 1
                                ? "text-severity-warn"
                                : "text-severity-info",
                          )}
                        >
                          {depErrorRate.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Called By */}
          {calledBy.length > 0 && (
            <div className="space-y-3">
              <div className="h-px bg-border" />
              <h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">Called By</h4>
              <div className="space-y-1.5">
                {calledBy.map((caller) => {
                  const callerColor = getServiceLegendColor(caller.sourceService, services)
                  const callerErrorRate = caller.errorRate
                  const safeDuration = Math.max(durationSeconds, 1)
                  const callerReqPerSec = caller.hasSampling
                    ? caller.estimatedCallCount / safeDuration
                    : caller.callCount / safeDuration
                  const callerTracedReqPerSec = caller.callCount / safeDuration
                  return (
                    <div
                      key={caller.sourceService}
                      className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-card border-border text-xs"
                      title={caller.hasSampling ? `Estimated x${caller.samplingWeight.toFixed(0)} from ${formatRate(callerTracedReqPerSec)} traced req/s` : undefined}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div
                          className="w-[3px] h-3.5 rounded-sm shrink-0"
                          style={{ backgroundColor: callerColor }}
                        />
                        <span className="text-foreground truncate">{caller.sourceService}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-[10px]">
                        <span className="text-muted-foreground tabular-nums font-mono">
                          {caller.hasSampling ? "~" : ""}{formatRate(callerReqPerSec)} req/s
                        </span>
                        <span
                          className={cn(
                            "tabular-nums font-mono",
                            callerErrorRate > 5
                              ? "text-severity-error"
                              : callerErrorRate > 1
                                ? "text-severity-warn"
                                : "text-severity-info",
                          )}
                        >
                          {callerErrorRate.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// --- Main Canvas ---

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
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null)

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

  // Inject selected state into node data
  const nodesWithSelection = useMemo(() => {
    return layoutedNodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        selected: node.id === selectedServiceId,
      },
    }))
  }, [layoutedNodes, selectedServiceId])

  const [nodes, , onNodesChange] = useNodesState(nodesWithSelection)
  const [edges] = useEdgesState(flowEdges)

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node<ServiceNodeData>) => {
    setSelectedServiceId((prev) => (prev === node.id ? null : node.id))
  }, [])

  const handlePaneClick = useCallback(() => {
    setSelectedServiceId(null)
  }, [])

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
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={selectedServiceId ? 65 : 100} minSize={40}>
          <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0">
              <ReactFlow
                key={nodes.map((n) => n.id).join(",")}
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onNodeClick={handleNodeClick}
                onPaneClick={handlePaneClick}
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
        </ResizablePanel>

        {selectedServiceId && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={35} minSize={25}>
              <ServiceDetailPanel
                serviceId={selectedServiceId}
                services={services}
                edges={serviceEdges}
                overviews={overviews}
                durationSeconds={durationSeconds}
                onClose={() => setSelectedServiceId(null)}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
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
