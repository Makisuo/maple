import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

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

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { GridIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import {
  WorkloadTable,
  WorkloadTableLoading,
  type WorkloadRow,
} from "@/components/infra/workload-table"
import { listWorkloadsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { WorkloadKind } from "@/api/tinybird/infra"

const workloadsSearchSchema = Schema.Struct({
  kind: Schema.optional(
    Schema.Literals(["deployment", "statefulset", "daemonset"]),
  ),
})

export const Route = createFileRoute("/infra/workloads/")({
  component: WorkloadsPage,
  validateSearch: Schema.toStandardSchemaV1(workloadsSearchSchema),
})

function WorkloadsPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <WorkloadsPageContent />
}

function WorkloadsPageContent() {
  const search = Route.useSearch() as { kind?: WorkloadKind }
  const navigate = Route.useNavigate()
  const kind: WorkloadKind = search.kind ?? "deployment"

  const [searchText, setSearchText] = useState("")
  const [namespace, setNamespace] = useState("")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "12h")

  const wlResult = useAtomValue(
    listWorkloadsResultAtom({
      data: {
        kind,
        startTime,
        endTime,
        search: searchText.trim() || undefined,
        namespace: namespace.trim() || undefined,
      },
    }),
  )

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Workloads" },
      ]}
      title="Workloads"
      description="Kubernetes Deployments, StatefulSets, and DaemonSets aggregated from pod metrics."
    >
      <div className="space-y-6">
        <Tabs
          value={kind}
          onValueChange={(v) =>
            v &&
            navigate({
              search: { kind: v as WorkloadKind },
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

                if (wls.length === 0 && !searchText.trim() && !namespace.trim()) {
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
                    className={`space-y-6 transition-opacity ${
                      result.waiting ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <Input
                        placeholder="Search…"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        className="max-w-xs"
                      />
                      <Input
                        placeholder="Namespace…"
                        value={namespace}
                        onChange={(e) => setNamespace(e.target.value)}
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
                    />
                  </div>
                )
              })
              .render()}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
