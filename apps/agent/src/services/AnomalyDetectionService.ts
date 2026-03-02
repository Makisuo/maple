import { Effect } from "effect"
import { DetectedAnomaly } from "../lib/anomaly-types"
import { AgentEnv } from "./AgentEnv"
import { MapleApiClient } from "./MapleApiClient"

const formatForTinybird = (date: Date): string =>
  date.toISOString().replace("T", " ").slice(0, 19)

export class AnomalyDetectionService extends Effect.Service<AnomalyDetectionService>()(
  "AnomalyDetectionService",
  {
    accessors: true,
    dependencies: [AgentEnv.Default, MapleApiClient.Default],
    effect: Effect.gen(function* () {
      const env = yield* AgentEnv
      const api = yield* MapleApiClient

      const detectForOrg = Effect.fn("AnomalyDetectionService.detectForOrg")(
        function* (orgId: string) {
          const now = new Date()
          const windowMs = env.AGENT_DETECTION_WINDOW_MINUTES * 60 * 1000
          const currentStart = new Date(now.getTime() - windowMs)
          const baselineEnd = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const baselineStart = new Date(baselineEnd.getTime() - windowMs)

          const anomalies = yield* Effect.all(
            {
              errorRateSpikes: detectErrorRateSpike(orgId, currentStart, now, baselineStart, baselineEnd),
              newErrorTypes: detectNewErrorTypes(orgId, currentStart, now, baselineStart, baselineEnd),
              latencyDegradation: detectLatencyDegradation(orgId, currentStart, now, baselineStart, baselineEnd),
              apdexDrops: detectApdexDrop(orgId, currentStart, now),
            },
            { concurrency: "unbounded" },
          )

          return [
            ...anomalies.errorRateSpikes,
            ...anomalies.newErrorTypes,
            ...anomalies.latencyDegradation,
            ...anomalies.apdexDrops,
          ]
        },
      )

      const detectErrorRateSpike = Effect.fn("AnomalyDetectionService.detectErrorRateSpike")(
        function* (
          orgId: string,
          currentStart: Date,
          currentEnd: Date,
          baselineStart: Date,
          baselineEnd: Date,
        ) {
          const [currentResult, baselineResult] = yield* Effect.all([
            api.queryTinybird(orgId, "errors_summary", {
              start_time: formatForTinybird(currentStart),
              end_time: formatForTinybird(currentEnd),
            }),
            api.queryTinybird(orgId, "errors_summary", {
              start_time: formatForTinybird(baselineStart),
              end_time: formatForTinybird(baselineEnd),
            }),
          ])

          const current = currentResult.data[0] as
            | { errorRate: number; totalErrors: number; affectedServicesCount: number }
            | undefined
          const baseline = baselineResult.data[0] as { errorRate: number } | undefined
          if (!current) return []

          const currentRate = Number(current.errorRate)
          const baselineRate = baseline ? Number(baseline.errorRate) : 0
          const multiplier = env.AGENT_ERROR_RATE_SPIKE_MULTIPLIER
          const absoluteThreshold = env.AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD

          const isSpike =
            (baselineRate > 0 && currentRate > baselineRate * multiplier) ||
            (baselineRate === 0 && currentRate > absoluteThreshold)

          if (!isSpike) return []

          const severity = currentRate > absoluteThreshold * 2 ? "critical" as const : "warning" as const

          return [
            new DetectedAnomaly({
              kind: "error_rate_spike",
              severity,
              fingerprint: `error_rate_spike:${orgId}`,
              title: `Error rate spike: ${currentRate.toFixed(1)}% (baseline: ${baselineRate.toFixed(1)}%)`,
              description: `Error rate increased from ${baselineRate.toFixed(1)}% to ${currentRate.toFixed(1)}%. Total errors: ${current.totalErrors}, affected services: ${current.affectedServicesCount}.`,
              affectedServices: [],
              detectedAt: currentEnd.toISOString(),
              currentValue: currentRate,
              baselineValue: baselineRate,
              thresholdValue: baselineRate > 0 ? baselineRate * multiplier : absoluteThreshold,
            }),
          ]
        },
      )

      const detectNewErrorTypes = Effect.fn("AnomalyDetectionService.detectNewErrorTypes")(
        function* (
          orgId: string,
          currentStart: Date,
          currentEnd: Date,
          baselineStart: Date,
          baselineEnd: Date,
        ) {
          const [currentResult, baselineResult] = yield* Effect.all([
            api.queryTinybird(orgId, "errors_by_type", {
              start_time: formatForTinybird(currentStart),
              end_time: formatForTinybird(currentEnd),
            }),
            api.queryTinybird(orgId, "errors_by_type", {
              start_time: formatForTinybird(baselineStart),
              end_time: formatForTinybird(baselineEnd),
            }),
          ])

          type ErrorByType = { errorType: string; count: number; affectedServices: string[] }
          const currentData = currentResult.data as ErrorByType[]
          const baselineData = baselineResult.data as ErrorByType[]

          const baselineTypes = new Set(baselineData.map((e) => e.errorType))
          const anomalies: DetectedAnomaly[] = []

          for (const error of currentData) {
            if (!baselineTypes.has(error.errorType) && Number(error.count) >= 3) {
              anomalies.push(
                new DetectedAnomaly({
                  kind: "new_error_type",
                  severity: "warning",
                  fingerprint: `new_error_type:${orgId}:${error.errorType}`,
                  title: `New error type: ${error.errorType}`,
                  description: `A new error type "${error.errorType}" appeared ${error.count} times in the last ${env.AGENT_DETECTION_WINDOW_MINUTES} minutes. Affected services: ${error.affectedServices.join(", ")}.`,
                  affectedServices: [...error.affectedServices],
                  detectedAt: currentEnd.toISOString(),
                  currentValue: Number(error.count),
                  thresholdValue: 0,
                }),
              )
            }
          }

          return anomalies
        },
      )

      const detectLatencyDegradation = Effect.fn("AnomalyDetectionService.detectLatencyDegradation")(
        function* (
          orgId: string,
          currentStart: Date,
          currentEnd: Date,
          baselineStart: Date,
          baselineEnd: Date,
        ) {
          const [currentResult, baselineResult] = yield* Effect.all([
            api.queryTinybird(orgId, "service_overview", {
              start_time: formatForTinybird(currentStart),
              end_time: formatForTinybird(currentEnd),
            }),
            api.queryTinybird(orgId, "service_overview", {
              start_time: formatForTinybird(baselineStart),
              end_time: formatForTinybird(baselineEnd),
            }),
          ])

          type ServiceOverviewRow = { serviceName: string; p99LatencyMs: number }
          const currentData = currentResult.data as ServiceOverviewRow[]
          const baselineData = baselineResult.data as ServiceOverviewRow[]

          const baselineByService = new Map(
            baselineData.map((s) => [s.serviceName, s]),
          )

          const anomalies: DetectedAnomaly[] = []
          const multiplier = env.AGENT_LATENCY_SPIKE_MULTIPLIER

          for (const service of currentData) {
            const baseline = baselineByService.get(service.serviceName)
            if (!baseline) continue

            const currentP99 = Number(service.p99LatencyMs)
            const baselineP99 = Number(baseline.p99LatencyMs)

            if (baselineP99 > 0 && currentP99 > baselineP99 * multiplier) {
              anomalies.push(
                new DetectedAnomaly({
                  kind: "latency_degradation",
                  severity: currentP99 > baselineP99 * multiplier * 2 ? "critical" : "warning",
                  fingerprint: `latency_degradation:${orgId}:${service.serviceName}`,
                  title: `Latency degradation: ${service.serviceName} P99 ${currentP99.toFixed(0)}ms (baseline: ${baselineP99.toFixed(0)}ms)`,
                  description: `P99 latency for ${service.serviceName} increased from ${baselineP99.toFixed(0)}ms to ${currentP99.toFixed(0)}ms (${(currentP99 / baselineP99).toFixed(1)}x increase).`,
                  serviceName: service.serviceName,
                  affectedServices: [service.serviceName],
                  detectedAt: currentEnd.toISOString(),
                  currentValue: currentP99,
                  baselineValue: baselineP99,
                  thresholdValue: baselineP99 * multiplier,
                }),
              )
            }
          }

          return anomalies
        },
      )

      const detectApdexDrop = Effect.fn("AnomalyDetectionService.detectApdexDrop")(
        function* (orgId: string, currentStart: Date, currentEnd: Date) {
          type ServiceOverviewRow = { serviceName: string }
          type ApdexRow = { apdexScore: number; totalCount: number }

          const servicesResult = yield* api.queryTinybird(orgId, "service_overview", {
            start_time: formatForTinybird(currentStart),
            end_time: formatForTinybird(currentEnd),
          })

          const anomalies: DetectedAnomaly[] = []
          const threshold = env.AGENT_APDEX_THRESHOLD

          for (const service of servicesResult.data as ServiceOverviewRow[]) {
            const apdexResult = yield* api.queryTinybird(orgId, "service_apdex_time_series", {
              service_name: service.serviceName,
              start_time: formatForTinybird(currentStart),
              end_time: formatForTinybird(currentEnd),
              bucket_seconds: env.AGENT_DETECTION_WINDOW_MINUTES * 60,
            }).pipe(Effect.catchAll(() => Effect.succeed({ data: [] as ApdexRow[] })))

            const apdexData = apdexResult.data as ApdexRow[]
            if (apdexData.length === 0) continue

            const avgApdex =
              apdexData.reduce((sum, b) => sum + Number(b.apdexScore), 0) /
              apdexData.length

            const totalCount = apdexData.reduce((sum, b) => sum + Number(b.totalCount), 0)

            if (avgApdex < threshold && totalCount > 10) {
              anomalies.push(
                new DetectedAnomaly({
                  kind: "apdex_drop",
                  severity: avgApdex < threshold * 0.5 ? "critical" : "warning",
                  fingerprint: `apdex_drop:${orgId}:${service.serviceName}`,
                  title: `Low Apdex: ${service.serviceName} score ${avgApdex.toFixed(3)}`,
                  description: `Apdex score for ${service.serviceName} dropped to ${avgApdex.toFixed(3)} (threshold: ${threshold}). Based on ${totalCount} requests in the detection window.`,
                  serviceName: service.serviceName,
                  affectedServices: [service.serviceName],
                  detectedAt: currentEnd.toISOString(),
                  currentValue: avgApdex,
                  thresholdValue: threshold,
                }),
              )
            }
          }

          return anomalies
        },
      )

      return {
        detectForOrg,
      }
    }),
  },
) {}
