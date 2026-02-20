import { useMemo, useCallback, useEffect } from "react"
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { EyeIcon } from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import { getServiceLegendColor } from "@maple/ui/colors"
import { FlowSpanNode } from "./flow-node"
import {
  transformSpansToFlow,
  getLayoutedElements,
  findSpanById,
  type FlowNodeData,
} from "./flow-utils"
import type { SpanNode } from "@/api/tinybird/traces"

interface TraceFlowViewProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

const nodeTypes = {
  span: FlowSpanNode,
}

const defaultEdgeOptions = {
  type: "smoothstep",
  animated: true,
  style: {
    strokeWidth: 2,
    stroke: "oklch(0.6 0.02 250)",
  },
}

export function TraceFlowView({
  rootSpans,
  services,
  selectedSpanId,
  onSelectSpan,
}: TraceFlowViewProps) {
  // Calculate initial layout
  const { initialNodes, initialEdges } = useMemo(() => {
    const { nodes, edges } = transformSpansToFlow(rootSpans, services, selectedSpanId)
    const layouted = getLayoutedElements(nodes, edges, rootSpans)
    return { initialNodes: layouted.nodes, initialEdges: layouted.edges }
  }, [rootSpans, services, selectedSpanId])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges] = useEdgesState(initialEdges)

  // Update node selection state when selectedSpanId changes
  // Handles both regular span IDs and combined node IDs
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        const nodeData = node.data as FlowNodeData
        // Check if this node contains the selected span (for combined nodes)
        const isSelected = nodeData.combinedSpans?.some(s => s.spanId === selectedSpanId) ??
          node.id === selectedSpanId
        return {
          ...node,
          data: {
            ...node.data,
            isSelected,
          },
        }
      })
    )
  }, [selectedSpanId, setNodes])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const span = findSpanById(rootSpans, node.id)
      if (span && onSelectSpan) {
        onSelectSpan(span)
      }
    },
    [rootSpans, onSelectSpan]
  )

  if (rootSpans.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center">
        <p className="text-muted-foreground">No spans found for this trace</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full rounded-md border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Flow View</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-xs"
          onClick={() => {
            const fitButton = document.querySelector(
              ".react-flow__controls-fitview"
            ) as HTMLButtonElement | null
            fitButton?.click()
          }}
        >
          <EyeIcon size={12} />
          Fit View
        </Button>
      </div>

      {/* Flow canvas */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesDraggable={false}
          nodesConnectable={false}
          connectOnClick={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.5 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node: Node) => {
              const data = node.data as FlowNodeData
              if (data.span.statusCode === "Error") {
                return "oklch(0.6 0.2 25)"
              }
              return getServiceLegendColor(data.span.serviceName, data.services)
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
        <span className="font-medium">Click to select</span>
        <span className="text-foreground/30">|</span>
        <span className="font-medium">Scroll to zoom</span>
        <span className="text-foreground/30">|</span>
        <span className="font-medium">Drag to pan</span>
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
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm shadow-sm" style={{ backgroundColor: "oklch(0.6 0.2 25)" }} />
          <span className="font-medium">Error</span>
        </div>
      </div>
    </div>
  )
}
