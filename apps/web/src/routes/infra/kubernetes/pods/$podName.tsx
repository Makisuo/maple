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
  TabsContent,
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
import { FolderIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { PodDetailChart } from "@/components/infra/k8s-detail-chart"
import { podDetailSummaryResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { PodInfraMetric } from "@/api/tinybird/infra"

const podDetailSearchSchema = Schema.Struct({
  namespace: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/kubernetes/pods/$podName")({
  component: PodDetailPage,
  validateSearch: Schema.toStandardSchemaV1(podDetailSearchSchema),
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

function PodDetailPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <PodDetailContent />
}

function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—"
  return `${(v * 100).toFixed(0)}%`
}

function PodDetailContent() {
  const { podName } = Route.useParams()
  const search = Route.useSearch() as { namespace?: string }
  const namespace = search.namespace
  const [preset, setPreset] = useState("1h")
  const [metric, setMetric] = useState<PodInfraMetric>("cpu_usage")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
  const bucketSeconds = bucketSecondsFor(preset)

  const summaryResult = useAtomValue(
    podDetailSummaryResultAtom({
      data: { podName, namespace, startTime, endTime },
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
          <FolderIcon size={14} className="text-muted-foreground" />
          Resource attributes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-[11px]">
        <Row label="k8s.pod.name" value={summary.podName} />
        <Row label="k8s.namespace.name" value={summary.namespace} />
        <Row label="k8s.node.name" value={summary.nodeName} />
        <Row label="k8s.pod.uid" value={summary.podUid} />
        <Row label="k8s.pod.qos_class" value={summary.qosClass} />
        <Row label="k8s.deployment.name" value={summary.deploymentName} />
        <Row label="k8s.statefulset.name" value={summary.statefulsetName} />
        <Row label="k8s.daemonset.name" value={summary.daemonsetName} />
        <Row label="k8s.pod.start_time" value={summary.podStartTime} />
      </CardContent>
    </Card>
  ) : null

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Kubernetes" },
        { label: "Pods", href: "/infra/kubernetes/pods" },
        { label: podName },
      ]}
      title={podName}
      description={
        namespace
          ? `Pod metrics from kubelet stats receiver — namespace ${namespace}.`
          : "Pod metrics from kubelet stats receiver."
      }
      headerActions={toolbar}
      rightSidebar={rightSidebar}
    >
      <div className="space-y-6">
        {summary ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Kpi label="CPU vs limit" value={formatPercent(summary.cpuLimitPct)} />
            <Kpi label="CPU vs request" value={formatPercent(summary.cpuRequestPct)} />
            <Kpi
              label="Memory vs limit"
              value={formatPercent(summary.memoryLimitPct)}
            />
            <Kpi
              label="Memory vs request"
              value={formatPercent(summary.memoryRequestPct)}
            />
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            No metrics arrived for this pod in the selected window.
          </div>
        )}

        <Tabs
          value={metric}
          onValueChange={(v) => v && setMetric(v as PodInfraMetric)}
        >
          <TabsList>
            <TabsTrigger value="cpu_usage">CPU cores</TabsTrigger>
            <TabsTrigger value="cpu_limit">CPU vs limit</TabsTrigger>
            <TabsTrigger value="cpu_request">CPU vs request</TabsTrigger>
            <TabsTrigger value="memory_limit">Memory vs limit</TabsTrigger>
            <TabsTrigger value="memory_request">Memory vs request</TabsTrigger>
          </TabsList>
          {(
            [
              "cpu_usage",
              "cpu_limit",
              "cpu_request",
              "memory_limit",
              "memory_request",
            ] as const
          ).map((m) => (
            <TabsContent key={m} value={m} className="pt-4">
              <PodDetailChart
                podName={podName}
                namespace={namespace}
                metric={m}
                startTime={startTime}
                endTime={endTime}
                bucketSeconds={bucketSeconds}
              />
            </TabsContent>
          ))}
        </Tabs>
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
