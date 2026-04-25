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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { GridIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import {
  WorkloadTable,
  WorkloadTableLoading,
  type WorkloadRow,
} from "@/components/infra/workload-table"
import {
  WorkloadsFilterSidebarView,
  type WorkloadFilters,
} from "@/components/infra/k8s-filter-sidebar"
import {
  listWorkloadsResultAtom,
  workloadFacetsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { WorkloadKind } from "@/api/tinybird/infra"

const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset"])

const workloadsSearchSchema = Schema.Struct({
  kind: Schema.optional(WorkloadKindLiteral),
  search: Schema.optional(Schema.String),
  workloadNames: OptionalStringArrayParam,
  namespaces: OptionalStringArrayParam,
  clusters: OptionalStringArrayParam,
  environments: OptionalStringArrayParam,
  computeTypes: OptionalStringArrayParam,
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export type WorkloadsSearchParams = Schema.Schema.Type<typeof workloadsSearchSchema>

export const Route = effectRoute(createFileRoute("/infra/kubernetes/workloads/"))({
  component: WorkloadsPage,
  validateSearch: Schema.toStandardSchemaV1(workloadsSearchSchema),
})

function WorkloadsPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <WorkloadsPageContent />
}

const KIND_LABEL: Record<WorkloadKind, string> = {
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
}

function WorkloadsPageContent() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const kind: WorkloadKind = search.kind ?? "deployment"

  const { startTime, endTime } = useEffectiveTimeRange(
    search.startTime,
    search.endTime,
    search.timePreset ?? "12h",
  )

  const filters: WorkloadFilters = {
    workloadNames: search.workloadNames,
    namespaces: search.namespaces,
    clusters: search.clusters,
    environments: search.environments,
    computeTypes: search.computeTypes,
  }

  const wlResult = useAtomValue(
    listWorkloadsResultAtom({
      data: {
        kind,
        startTime,
        endTime,
        search: search.search?.trim() || undefined,
        ...filters,
      },
    }),
  )

  const facetsResult = useAtomValue(
    workloadFacetsResultAtom({
      data: {
        kind,
        startTime,
        endTime,
        search: search.search?.trim() || undefined,
      },
    }),
  )

  const onFilterChange = <K extends keyof WorkloadFilters>(key: K, value: WorkloadFilters[K]) => {
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
        kind: search.kind,
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
          { label: "Workloads" },
        ]}
        filterSidebar={
          <WorkloadsFilterSidebarView
            facetsResult={facetsResult}
            filters={filters}
            workloadLabel={KIND_LABEL[kind]}
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
        <Tabs
          value={kind}
          onValueChange={(v) =>
            v &&
            navigate({
              search: (prev) => ({ ...prev, kind: v as WorkloadKind, workloadNames: undefined }),
            })
          }
        >
          <TabsList>
            <TabsTrigger value="deployment">Deployments</TabsTrigger>
            <TabsTrigger value="statefulset">StatefulSets</TabsTrigger>
            <TabsTrigger value="daemonset">DaemonSets</TabsTrigger>
          </TabsList>
          <TabsContent value={kind} className="pt-4">
            {Result.builder(wlResult)
              .onInitial(() => <WorkloadTableLoading />)
              .onError((err) => (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
                  <p className="font-medium text-destructive">
                    Failed to load workloads
                  </p>
                  <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
                    {err.message}
                  </pre>
                </div>
              ))
              .onSuccess((response, result) => {
                const wls = response.data as ReadonlyArray<WorkloadRow>
                const hasAnyFilter =
                  !!search.search?.trim() ||
                  (filters.workloadNames?.length ?? 0) > 0 ||
                  (filters.namespaces?.length ?? 0) > 0 ||
                  (filters.clusters?.length ?? 0) > 0 ||
                  (filters.environments?.length ?? 0) > 0 ||
                  (filters.computeTypes?.length ?? 0) > 0

                if (wls.length === 0 && !hasAnyFilter) {
                  return (
                    <Empty className="py-16">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <GridIcon size={16} />
                        </EmptyMedia>
                        <EmptyTitle>No workloads reporting yet</EmptyTitle>
                        <EmptyDescription>
                          Maple aggregates pod metrics by k8s.deployment.name,
                          k8s.statefulset.name, and k8s.daemonset.name. Install the
                          Helm chart so the k8sattributes processor can enrich pod
                          metrics with workload identity.
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
                    <div className="flex flex-wrap items-center gap-3">
                      <Input
                        placeholder="Search…"
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
                        {wls.length}{" "}
                        {wls.length === 1 ? "workload" : "workloads"}
                      </span>
                    </div>
                    <WorkloadTable
                      workloads={wls}
                      kind={kind}
                      waiting={result.waiting}
                      referenceTime={endTime}
                    />
                  </div>
                )
              })
              .render()}
          </TabsContent>
        </Tabs>
      </DashboardLayout>
    </PageRefreshProvider>
  )
}
