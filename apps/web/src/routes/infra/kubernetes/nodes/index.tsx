import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Input } from "@maple/ui/components/ui/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServerIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import {
  NodeTable,
  NodeTableLoading,
  type NodeRow,
} from "@/components/infra/node-table"
import {
  NodesFilterSidebarView,
  type NodeFilters,
} from "@/components/infra/k8s-filter-sidebar"
import {
  listNodesResultAtom,
  nodeFacetsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const nodesSearchSchema = Schema.Struct({
  search: Schema.optional(Schema.String),
  nodeNames: OptionalStringArrayParam,
  clusters: OptionalStringArrayParam,
  environments: OptionalStringArrayParam,
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export type NodesSearchParams = Schema.Schema.Type<typeof nodesSearchSchema>

export const Route = effectRoute(createFileRoute("/infra/kubernetes/nodes/"))({
  component: NodesPage,
  validateSearch: Schema.toStandardSchemaV1(nodesSearchSchema),
})

function NodesPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <NodesPageContent />
}

function NodesPageContent() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { startTime, endTime } = useEffectiveTimeRange(
    search.startTime,
    search.endTime,
    search.timePreset ?? "12h",
  )

  const filters: NodeFilters = {
    nodeNames: search.nodeNames,
    clusters: search.clusters,
    environments: search.environments,
  }

  const nodesResult = useAtomValue(
    listNodesResultAtom({
      data: {
        startTime,
        endTime,
        search: search.search?.trim() || undefined,
        ...filters,
      },
    }),
  )

  const facetsResult = useAtomValue(
    nodeFacetsResultAtom({
      data: {
        startTime,
        endTime,
        search: search.search?.trim() || undefined,
      },
    }),
  )

  const onFilterChange = <K extends keyof NodeFilters>(key: K, value: NodeFilters[K]) => {
    navigate({
      search: (prev) => ({
        ...prev,
        [key]:
          value === undefined || (Array.isArray(value) && value.length === 0)
            ? undefined
            : value,
      }),
    })
  }

  const onClearFilters = () => {
    navigate({
      search: {
        startTime: search.startTime,
        endTime: search.endTime,
        timePreset: search.timePreset,
      },
    })
  }

  const handleTimeChange = (
    range: { startTime?: string; endTime?: string; presetValue?: string },
    options?: { replace?: boolean },
  ) => {
    navigate({
      replace: options?.replace,
      search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
    })
  }

  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <DashboardLayout
        breadcrumbs={[
          { label: "Infrastructure", href: "/infra" },
          { label: "Kubernetes" },
          { label: "Nodes" },
        ]}
        filterSidebar={
          <NodesFilterSidebarView
            facetsResult={facetsResult}
            filters={filters}
            onFilterChange={onFilterChange}
            onClearFilters={onClearFilters}
          />
        }
        headerActions={
          <TimeRangeHeaderControls
            startTime={search.startTime ?? startTime}
            endTime={search.endTime ?? endTime}
            presetValue={search.timePreset ?? "12h"}
            onTimeChange={handleTimeChange}
          />
        }
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
            const hasAnyFilter =
              !!search.search?.trim() ||
              (filters.nodeNames?.length ?? 0) > 0 ||
              (filters.clusters?.length ?? 0) > 0 ||
              (filters.environments?.length ?? 0) > 0

            if (nodes.length === 0 && !hasAnyFilter) {
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
                className={`space-y-4 transition-opacity ${
                  result.waiting ? "opacity-60" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <Input
                    placeholder="Search nodes…"
                    value={search.search ?? ""}
                    onChange={(e) =>
                      navigate({
                        search: (prev) => ({
                          ...prev,
                          search: e.target.value || undefined,
                        }),
                      })
                    }
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
    </PageRefreshProvider>
  )
}
