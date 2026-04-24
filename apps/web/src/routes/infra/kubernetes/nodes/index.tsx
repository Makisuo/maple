import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Input } from "@maple/ui/components/ui/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServerIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import {
  NodeTable,
  NodeTableLoading,
  type NodeRow,
} from "@/components/infra/node-table"
import { listNodesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export const Route = createFileRoute("/infra/kubernetes/nodes/")({
  component: NodesPage,
})

function NodesPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <NodesPageContent />
}

function NodesPageContent() {
  const [search, setSearch] = useState("")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "12h")

  const nodesResult = useAtomValue(
    listNodesResultAtom({
      data: {
        startTime,
        endTime,
        search: search.trim() || undefined,
      },
    }),
  )

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Kubernetes" },
        { label: "Nodes" },
      ]}
      title="Nodes"
      description="Kubernetes nodes reporting via the kubelet stats receiver."
    >
      {Result.builder(nodesResult)
        .onInitial(() => <NodeTableLoading />)
        .onError((err) => (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
            <p className="font-medium text-destructive">Failed to load nodes</p>
            <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
              {err.message}
            </pre>
          </div>
        ))
        .onSuccess((response, result) => {
          const nodes = response.data as ReadonlyArray<NodeRow>

          if (nodes.length === 0 && !search.trim()) {
            return (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ServerIcon size={16} />
                  </EmptyMedia>
                  <EmptyTitle>No nodes reporting yet</EmptyTitle>
                  <EmptyDescription>
                    Install the Maple Kubernetes Helm chart so the kubelet stats
                    receiver can start collecting per-node metrics.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          }

          return (
            <div
              className={`space-y-6 transition-opacity ${
                result.waiting ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Search nodes…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
                <span className="text-muted-foreground text-xs">
                  {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
                </span>
              </div>
              <NodeTable nodes={nodes} waiting={result.waiting} />
            </div>
          )
        })
        .render()}
    </DashboardLayout>
  )
}
