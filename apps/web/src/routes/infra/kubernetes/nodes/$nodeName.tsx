import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

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
import { ServerIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { NodeDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable, type PodRow } from "@/components/infra/pod-table"
import {
  listPodsResultAtom,
  nodeDetailSummaryResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { NodeInfraMetric } from "@/api/tinybird/infra"

export const Route = createFileRoute("/infra/kubernetes/nodes/$nodeName")({
  component: NodeDetailPage,
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

function NodeDetailPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <NodeDetailContent />
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function NodeDetailContent() {
  const { nodeName } = Route.useParams()
  const [preset, setPreset] = useState("1h")
  const [metric, setMetric] = useState<NodeInfraMetric>("cpu_usage")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
  const bucketSeconds = bucketSecondsFor(preset)

  const summaryResult = useAtomValue(
    nodeDetailSummaryResultAtom({
      data: { nodeName, startTime, endTime },
    }),
  )

  const podsResult = useAtomValue(
    listPodsResultAtom({
      data: { nodeName, startTime, endTime, limit: 200 },
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
          <ServerIcon size={14} className="text-muted-foreground" />
          Resource attributes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-[11px]">
        <Row label="k8s.node.name" value={summary.nodeName} />
        <Row label="k8s.node.uid" value={summary.nodeUid} />
        <Row label="k8s.kubelet.version" value={summary.kubeletVersion} />
        <Row label="container.runtime" value={summary.containerRuntime} />
      </CardContent>
    </Card>
  ) : null

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: "Kubernetes" },
        { label: "Nodes", href: "/infra/kubernetes/nodes" },
        { label: nodeName },
      ]}
      title={nodeName}
      description="Node metrics from kubelet stats receiver."
      headerActions={toolbar}
      rightSidebar={rightSidebar}
    >
      <div className="space-y-6">
        {summary ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Kpi
              label="CPU cores"
              value={Number.isFinite(summary.cpuUsage) ? summary.cpuUsage.toFixed(2) : "—"}
            />
            <Kpi label="Uptime" value={formatUptime(summary.uptime)} />
            <Kpi
              label="Kubelet"
              value={summary.kubeletVersion || "—"}
            />
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            No metrics arrived for this node in the selected window.
          </div>
        )}

        <Tabs
          value={metric}
          onValueChange={(v) => v && setMetric(v as NodeInfraMetric)}
        >
          <TabsList>
            <TabsTrigger value="cpu_usage">CPU cores</TabsTrigger>
            <TabsTrigger value="uptime">Uptime</TabsTrigger>
          </TabsList>
          {(["cpu_usage", "uptime"] as const).map((m) => (
            <TabsContent key={m} value={m} className="pt-4">
              <NodeDetailChart
                nodeName={nodeName}
                metric={m}
                startTime={startTime}
                endTime={endTime}
                bucketSeconds={bucketSeconds}
              />
            </TabsContent>
          ))}
        </Tabs>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Pods on this node</h3>
          {Result.builder(podsResult)
            .onSuccess((r) => {
              const pods = r.data as ReadonlyArray<PodRow>
              if (pods.length === 0) {
                return (
                  <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                    No pods reporting on this node in the selected window.
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
