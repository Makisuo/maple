import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { useInfraEnabled } from "@/hooks/use-infra-enabled"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
  HostDetailHeader,
  HostDetailHeaderLoading,
} from "@/components/infra/host-detail-header"
import { MetricStrip } from "@/components/infra/host-detail-chart"
import { HostMetadataPanel } from "@/components/infra/host-metadata-panel"
import { hostDetailSummaryResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export const Route = createFileRoute("/infra/$hostName")({
  component: HostDetailPage,
})

const TIME_PRESETS = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "12h", label: "Last 12 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
]

const METRIC_STRIPS = [
  { metric: "cpu", label: "CPU", caption: "Per-mode utilization · stacked area" },
  { metric: "memory", label: "Memory", caption: "Used / cached / free · stacked" },
  { metric: "filesystem", label: "Filesystem", caption: "Mountpoint utilization" },
  { metric: "network", label: "Network", caption: "Throughput in/out per device" },
  { metric: "load15", label: "Load 15m", caption: "Linux load average" },
] as const

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

function HostDetailPage() {
  const infraEnabled = useInfraEnabled()
  if (!infraEnabled) return <Navigate to="/" replace />
  return <HostDetailPageContent />
}

function HostDetailPageContent() {
  const { hostName } = Route.useParams()
  const [preset, setPreset] = useState("1h")

  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
  const bucketSeconds = bucketSecondsFor(preset)

  const summaryResult = useAtomValue(
    hostDetailSummaryResultAtom({
      data: { hostName, startTime, endTime },
    }),
  )

  const summary = Result.builder(summaryResult)
    .onSuccess((r) => r.data)
    .orElse(() => null)

  const rightSidebar = <HostMetadataPanel summary={summary} />

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

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Infrastructure", href: "/infra" },
        { label: hostName },
      ]}
      headerActions={toolbar}
      rightSidebar={rightSidebar}
    >
      <div className="space-y-8">
        {Result.builder(summaryResult)
          .onInitial(() => <HostDetailHeaderLoading />)
          .onError(() => (
            <HostDetailHeader summary={null} hostName={hostName} />
          ))
          .onSuccess((r) => (
            <HostDetailHeader summary={r.data} hostName={hostName} />
          ))
          .render()}

        <div className="rounded-md border bg-card">
          <div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
            <span className="text-sm font-medium">Metrics</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {METRIC_STRIPS.length} signals · {preset}
            </span>
          </div>
          <div className="px-4">
            {METRIC_STRIPS.map((strip) => (
              <MetricStrip
                key={strip.metric}
                label={strip.label}
                caption={strip.caption}
                hostName={hostName}
                metric={strip.metric}
                startTime={startTime}
                endTime={endTime}
                bucketSeconds={bucketSeconds}
              />
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
