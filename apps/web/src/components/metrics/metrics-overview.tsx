import { useState } from "react"

import { Input } from "@maple/ui/components/ui/input"
import { MetricsSummaryCards, type MetricType } from "./metrics-summary-cards"
import { MetricsVolumeChart } from "./metrics-volume-chart"
import { MetricsTable } from "./metrics-table"
import type { Metric } from "@/api/tinybird/metrics"
import type { GetMetricTimeSeriesInput } from "@/api/tinybird/metrics"

export function MetricsOverview() {
  const [search, setSearch] = useState("")
  const [selectedType, setSelectedType] = useState<MetricType | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<Metric | null>(null)

  const handleSelectType = (type: MetricType | null) => {
    setSelectedType(type)
    setSelectedMetric(null)
  }

  const handleSelectMetric = (metric: Metric | null) => {
    setSelectedMetric(metric)
  }

  return (
    <div className="space-y-6">
      <MetricsSummaryCards
        selectedType={selectedType}
        onSelectType={handleSelectType}
      />

      <div className="flex items-center gap-4">
        <Input
          placeholder="Search metrics..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        {selectedType && (
          <span className="text-sm text-muted-foreground">
            Filtered by: <span className="font-medium">{selectedType}</span>
          </span>
        )}
      </div>

      <MetricsVolumeChart
        metricName={selectedMetric?.metricName ?? null}
        metricType={selectedMetric?.metricType as GetMetricTimeSeriesInput["metricType"] ?? null}
      />

      <div>
        <h3 className="mb-4 text-lg font-semibold">Available Metrics</h3>
        <MetricsTable
          search={search}
          metricType={selectedType}
          selectedMetric={selectedMetric}
          onSelectMetric={handleSelectMetric}
        />
      </div>
    </div>
  )
}
