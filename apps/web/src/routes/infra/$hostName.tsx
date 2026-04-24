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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@maple/ui/components/ui/tabs"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
  HostDetailHeader,
  HostDetailHeaderLoading,
} from "@/components/infra/host-detail-header"
import { HostDetailChart } from "@/components/infra/host-detail-chart"
import { HostMetadataPanel } from "@/components/infra/host-metadata-panel"
import { hostDetailSummaryResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { HostInfraMetric } from "@/api/tinybird/infra"

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
  const [metric, setMetric] = useState<HostInfraMetric>("cpu")

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
      title={hostName}
      description="Host metrics scraped by the Maple infrastructure agent."
      headerActions={toolbar}
      rightSidebar={rightSidebar}
    >
      <div className="space-y-6">
        {Result.builder(summaryResult)
          .onInitial(() => <HostDetailHeaderLoading />)
          .onError(() => (
            <HostDetailHeader summary={null} hostName={hostName} />
          ))
          .onSuccess((r) => (
            <HostDetailHeader summary={r.data} hostName={hostName} />
          ))
          .render()}

        <Tabs
          value={metric}
          onValueChange={(v) => v && setMetric(v as HostInfraMetric)}
        >
          <TabsList>
            <TabsTrigger value="cpu">CPU</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="filesystem">Filesystem</TabsTrigger>
            <TabsTrigger value="network">Network</TabsTrigger>
            <TabsTrigger value="load15">Load</TabsTrigger>
          </TabsList>
          <TabsContent value="cpu" className="pt-4">
            <HostDetailChart
              hostName={hostName}
              metric="cpu"
              startTime={startTime}
              endTime={endTime}
              bucketSeconds={bucketSeconds}
            />
          </TabsContent>
          <TabsContent value="memory" className="pt-4">
            <HostDetailChart
              hostName={hostName}
              metric="memory"
              startTime={startTime}
              endTime={endTime}
              bucketSeconds={bucketSeconds}
            />
          </TabsContent>
          <TabsContent value="filesystem" className="pt-4">
            <HostDetailChart
              hostName={hostName}
              metric="filesystem"
              startTime={startTime}
              endTime={endTime}
              bucketSeconds={bucketSeconds}
            />
          </TabsContent>
          <TabsContent value="network" className="pt-4">
            <HostDetailChart
              hostName={hostName}
              metric="network"
              startTime={startTime}
              endTime={endTime}
              bucketSeconds={bucketSeconds}
            />
          </TabsContent>
          <TabsContent value="load15" className="pt-4">
            <HostDetailChart
              hostName={hostName}
              metric="load15"
              startTime={startTime}
              endTime={endTime}
              bucketSeconds={bucketSeconds}
            />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
