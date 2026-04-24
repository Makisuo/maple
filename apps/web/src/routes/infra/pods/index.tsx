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
import { FolderIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import {
  PodTable,
  PodTableLoading,
  type PodRow,
} from "@/components/infra/pod-table"
import { listPodsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export const Route = createFileRoute("/infra/pods/")({
  component: PodsPage,
})

function PodsPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <PodsPageContent />
}

function PodsPageContent() {
  const [search, setSearch] = useState("")
  const [namespace, setNamespace] = useState("")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "12h")

  const podsResult = useAtomValue(
    listPodsResultAtom({
      data: {
        startTime,
        endTime,
        search: search.trim() || undefined,
        namespace: namespace.trim() || undefined,
      },
    }),
  )

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Pods" },
      ]}
      title="Pods"
      description="Kubernetes pods reporting via the kubelet stats receiver."
    >
      {Result.builder(podsResult)
        .onInitial(() => <PodTableLoading />)
        .onError((err) => (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
            <p className="font-medium text-destructive">Failed to load pods</p>
            <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
              {err.message}
            </pre>
          </div>
        ))
        .onSuccess((response, result) => {
          const pods = response.data as ReadonlyArray<PodRow>

          if (pods.length === 0 && !search.trim() && !namespace.trim()) {
            return (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderIcon size={16} />
                  </EmptyMedia>
                  <EmptyTitle>No pods reporting yet</EmptyTitle>
                  <EmptyDescription>
                    Install the Maple Kubernetes Helm chart so the kubelet stats
                    receiver can start collecting per-pod CPU and memory metrics.
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
                  placeholder="Search pods…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
                <Input
                  placeholder="Namespace…"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className="max-w-xs"
                />
                <span className="text-muted-foreground text-xs">
                  {pods.length} {pods.length === 1 ? "pod" : "pods"}
                </span>
              </div>
              <PodTable pods={pods} waiting={result.waiting} />
            </div>
          )
        })
        .render()}
    </DashboardLayout>
  )
}
