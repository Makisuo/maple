import { Autumn } from "autumn-js"

const BYTES_PER_KB = 1_000

interface ServiceUsageRow {
  totalLogSizeBytes: number | bigint
  totalTraceSizeBytes: number | bigint
  totalSumMetricSizeBytes: number | bigint
  totalGaugeMetricSizeBytes: number | bigint
  totalHistogramMetricSizeBytes: number | bigint
  totalExpHistogramMetricSizeBytes: number | bigint
}

function aggregateUsage(rows: ServiceUsageRow[]) {
  let logBytes = 0
  let traceBytes = 0
  let metricBytes = 0

  for (const row of rows) {
    logBytes += Number(row.totalLogSizeBytes ?? 0)
    traceBytes += Number(row.totalTraceSizeBytes ?? 0)
    metricBytes +=
      Number(row.totalSumMetricSizeBytes ?? 0) +
      Number(row.totalGaugeMetricSizeBytes ?? 0) +
      Number(row.totalHistogramMetricSizeBytes ?? 0) +
      Number(row.totalExpHistogramMetricSizeBytes ?? 0)
  }

  return {
    logsKB: logBytes / BYTES_PER_KB,
    tracesKB: traceBytes / BYTES_PER_KB,
    metricsKB: metricBytes / BYTES_PER_KB,
  }
}

export async function syncOrgUsage(
  autumn: Autumn,
  orgId: string,
  usageRows: ServiceUsageRow[],
) {
  const usage = aggregateUsage(usageRows)

  await Promise.all([
    autumn.track({ customer_id: orgId, feature_id: "logs", value: usage.logsKB }),
    autumn.track({ customer_id: orgId, feature_id: "traces", value: usage.tracesKB }),
    autumn.track({ customer_id: orgId, feature_id: "metrics", value: usage.metricsKB }),
  ])

  return usage
}
