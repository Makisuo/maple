import { getTinybird, type ServiceDependenciesOutput } from "@/lib/tinybird"

export interface ServiceEdge {
  sourceService: string
  targetService: string
  callCount: number
  errorCount: number
  errorRate: number
  avgDurationMs: number
  p95DurationMs: number
}

export interface ServiceMapResponse {
  edges: ServiceEdge[]
  error: string | null
}

export interface GetServiceMapInput {
  startTime?: string
  endTime?: string
  deploymentEnv?: string
}

function transformEdge(row: ServiceDependenciesOutput): ServiceEdge {
  const callCount = Number(row.callCount)
  const errorCount = Number(row.errorCount)
  return {
    sourceService: row.sourceService,
    targetService: row.targetService,
    callCount,
    errorCount,
    errorRate: callCount > 0 ? (errorCount / callCount) * 100 : 0,
    avgDurationMs: Number(row.avgDurationMs),
    p95DurationMs: Number(row.p95DurationMs),
  }
}

export async function getServiceMap({
  data,
}: {
  data: GetServiceMapInput
}): Promise<ServiceMapResponse> {
  try {
    const tinybird = getTinybird()
    const result = await tinybird.query.service_dependencies({
      start_time: data.startTime,
      end_time: data.endTime,
      deployment_env: data.deploymentEnv,
    })

    return {
      edges: result.data.map(transformEdge),
      error: null,
    }
  } catch (error) {
    console.error("[Tinybird] getServiceMap failed:", error)
    return {
      edges: [],
      error: error instanceof Error ? error.message : "Failed to fetch service map",
    }
  }
}
