export type AnomalyKind =
  | "error_rate_spike"
  | "new_error_type"
  | "latency_degradation"
  | "apdex_drop"

export type Severity = "critical" | "warning" | "info"

export interface DetectedAnomaly {
  kind: AnomalyKind
  severity: Severity
  fingerprint: string
  title: string
  description: string
  serviceName?: string
  affectedServices: string[]
  detectedAt: string
  currentValue: number
  baselineValue?: number
  thresholdValue: number
  sampleTraceIds?: string[]
}

export interface EnrichedAnomaly extends DetectedAnomaly {
  sampleTraces: Array<{
    traceId: string
    rootSpanName: string
    durationMs: number
    serviceName: string
    statusCode: string
  }>
  correlatedLogs: Array<{
    timestamp: string
    severity: string
    body: string
    serviceName: string
  }>
}

export interface OrgConfig {
  orgId: string
  installationId: number
  selectedRepos: RepoInfo[]
  defaultRepo: RepoInfo | null
  serviceRepoMappings: ServiceRepoMapping[]
}

export interface RepoInfo {
  id: number
  fullName: string
  owner: string
  name: string
}

export interface ServiceRepoMapping {
  serviceName: string
  repoFullName: string
}
