import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { GridIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { WorkloadDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable, type PodRow } from "@/components/infra/pod-table"
import {
  listPodsResultAtom,
  workloadDetailSummaryResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type {
  WorkloadInfraMetric,
  WorkloadKind,
} from "@/api/tinybird/infra"

const workloadDetailSearchSchema = Schema.Struct({
  namespace: Schema.optional(Schema.String),
})

const WorkloadKindSchema = Schema.Literals(["deployment", "statefulset", "daemonset"])

const paramsSchema = Schema.Struct({
  kind: WorkloadKindSchema,
  workloadName: Schema.String,
})

export const Route = createFileRoute("/infra/workloads/$kind/$workloadName")({
  component: WorkloadDetailPage,
  validateSearch: Schema.toStandardSchemaV1(workloadDetailSearchSchema),
  params: {
    parse: (raw) => Schema.decodeUnknownSync(paramsSchema)(raw),
    stringify: (p) => ({ kind: p.kind, workloadName: p.workloadName }),
  },
})

const TIME_PRESETS = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "12h", label: "Last 12 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
]

function bucketSecondsFor(preset: string): number {
  switch (preset) {
    case "15m":
      return 15
    case "1h":
      return 60
    case "6h":
      return 300
    case "12h":
      return 600
    case "24h":
      return 900
    case "7d":
      return 3600
    default:
      return 60
  }
}

const KIND_LABEL: Record<WorkloadKind, string> = {
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
}

function WorkloadDetailPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <WorkloadDetailContent />
}

function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—"
  return `${(v * 100).toFixed(0)}%`
}

function WorkloadDetailContent() {
  const params = Route.useParams() as { kind: WorkloadKind; workloadName: string }
  const search = Route.useSearch() as { namespace?: string }
  const namespace = search.namespace
  const [preset, setPreset] = useState("1h")
  const [metric, setMetric] = useState<WorkloadInfraMetric>("cpu_limit")
  const [groupByPod, setGroupByPod] = useState(true)

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
  const bucketSeconds = bucketSecondsFor(preset)

  const summaryResult = useAtomValue(
    workloadDetailSummaryResultAtom({
      data: {
        kind: params.kind,
        workloadName: params.workloadName,
        namespace,
        startTime,
        endTime,
      },
    }),
  )

  const podsResult = useAtomValue(
    listPodsResultAtom({
      data: {
        workloadKind: params.kind,
        workloadName: params.workloadName,
        namespace,
        startTime,
        endTime,
        limit: 200,
      },
    }),
  )

  const summary = Result.builder(summaryResult)
    .onSuccess((r) => r.data)
    .orElse(() => null)

  const toolbar = (
    <Select value={preset} onValueChange={(v) => v && setPreset(v)}>
      <SelectTrigger className="w-[180px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIME_PRESETS.map((p) => (
          <SelectItem key={p.value} value={p.value}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const rightSidebar = summary ? (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <GridIcon size={14} className="text-muted-foreground" />
          Resource attributes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-[11px]">
        <Row label="kind" value={KIND_LABEL[params.kind]} />
        <Row label={`k8s.${params.kind}.name`} value={summary.workloadName} />
        <Row label="k8s.namespace.name" value={summary.namespace} />
        <Row label="pods" value={String(summary.podCount)} />
      </CardContent>
    </Card>
  ) : null

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Workloads", href: "/infra/workloads" },
        { label: params.workloadName },
      ]}
      title={params.workloadName}
      description={`${KIND_LABEL[params.kind]}${
        namespace ? ` in namespace ${namespace}` : ""
      } — aggregated from pod metrics.`}
      headerActions={toolbar}
      rightSidebar={rightSidebar}
    >
      <div className="space-y-6">
        {summary ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Pods" value={String(summary.podCount)} />
            <Kpi
              label="Avg CPU vs limit"
              value={formatPercent(summary.avgCpuLimitPct)}
            />
            <Kpi
              label="Avg memory vs limit"
              value={formatPercent(summary.avgMemoryLimitPct)}
            />
            <Kpi
              label="Avg CPU cores"
              value={
                Number.isFinite(summary.avgCpuUsage)
                  ? summary.avgCpuUsage.toFixed(3)
                  : "—"
              }
            />
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            No metrics arrived for this workload in the selected window.
          </div>
        )}

        <div className="flex items-center gap-2">
          <Tabs
            value={metric}
            onValueChange={(v) => v && setMetric(v as WorkloadInfraMetric)}
          >
            <TabsList>
              <TabsTrigger value="cpu_limit">CPU vs limit</TabsTrigger>
              <TabsTrigger value="memory_limit">Memory vs limit</TabsTrigger>
              <TabsTrigger value="cpu_usage">CPU cores</TabsTrigger>
            </TabsList>
          </Tabs>
          <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={groupByPod}
              onChange={(e) => setGroupByPod(e.target.checked)}
            />
            Per-pod breakdown
          </label>
        </div>

        <WorkloadDetailChart
          kind={params.kind}
          workloadName={params.workloadName}
          namespace={namespace}
          metric={metric}
          groupByPod={groupByPod}
          startTime={startTime}
          endTime={endTime}
          bucketSeconds={bucketSeconds}
        />

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Pods</h3>
          {Result.builder(podsResult)
            .onSuccess((r) => {
              const pods = r.data as ReadonlyArray<PodRow>
              if (pods.length === 0) {
                return (
                  <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                    No pods reporting for this workload in the selected window.
                  </div>
                )
              }
              return <PodTable pods={pods} />
            })
            .orElse(() => null)}
        </div>
      </div>
    </DashboardLayout>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums leading-none">
        {value}
      </div>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
      <span className="font-mono text-muted-foreground">{label}</span>
      <span className="font-mono break-all text-right text-foreground/80">{value}</span>
    </div>
  )
}
