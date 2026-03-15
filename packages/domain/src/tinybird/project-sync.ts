import { datasources, pipes, projectRevision } from "../generated/tinybird-project-manifest"

const POLL_INTERVAL_MS = 2_000
const MAX_POLL_ATTEMPTS = 300
const FETCH_TIMEOUT_MS = 30_000

interface GeneratedResource {
  readonly name: string
  readonly content: string
}

interface TinybirdProjectBuild {
  readonly projectRevision: string
  readonly datasources: ReadonlyArray<GeneratedResource>
  readonly pipes: ReadonlyArray<GeneratedResource>
}

interface DeployResponse {
  readonly result: "success" | "failed" | "no_changes"
  readonly deployment?: {
    readonly id: string
    readonly status: string
    readonly feedback?: Array<{ readonly resource: string | null; readonly level: string; readonly message: string }>
    readonly deleted_datasource_names?: string[]
    readonly deleted_pipe_names?: string[]
    readonly changed_datasource_names?: string[]
    readonly changed_pipe_names?: string[]
    readonly new_datasource_names?: string[]
    readonly new_pipe_names?: string[]
  }
  readonly error?: string
  readonly errors?: ReadonlyArray<{ readonly filename?: string; readonly error: string }>
}

export interface TinybirdProjectSyncParams {
  readonly baseUrl: string
  readonly token: string
}

export interface TinybirdProjectSyncResult {
  readonly projectRevision: string
  readonly result: DeployResponse["result"]
  readonly deploymentId?: string
}

const bundledProject: TinybirdProjectBuild = {
  datasources,
  pipes,
  projectRevision,
}

const normalizeBaseUrl = (raw: string) => raw.trim().replace(/\/+$/, "")

const toDeployErrorMessage = (body: DeployResponse, fallback: string): string => {
  const feedbackErrors = body.deployment?.feedback
    ?.filter((entry) => entry.level === "ERROR")
    .map((entry) => entry.message)

  if (feedbackErrors && feedbackErrors.length > 0) {
    return feedbackErrors.join("\n")
  }

  if (body.error) return body.error
  if (body.errors && body.errors.length > 0) {
    return body.errors.map((entry) => entry.error).join("\n")
  }

  return fallback
}

export interface TinybirdDeploymentStatus {
  readonly deploymentId: string
  readonly status: string
  readonly isTerminal: boolean
}

const TERMINAL_STATUSES = new Set(["live", "data_ready", "failed", "error"])

export const getDeploymentStatus = async (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<TinybirdDeploymentStatus> => {
  const baseUrl = normalizeBaseUrl(params.baseUrl)
  const res = await fetch(`${baseUrl}/v1/deployments/${params.deploymentId}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Deployment status check failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { deployment?: { status?: string } }
  const status = body.deployment?.status ?? "unknown"
  return {
    deploymentId: params.deploymentId,
    status,
    isTerminal: TERMINAL_STATUSES.has(status),
  }
}

export interface TinybirdDatasourceStats {
  readonly name: string
  readonly rowCount: number
  readonly bytes: number
}

export interface TinybirdInstanceHealth {
  readonly workspaceName: string | null
  readonly datasources: ReadonlyArray<TinybirdDatasourceStats>
  readonly totalRows: number
  readonly totalBytes: number
  readonly recentErrorCount: number
  readonly avgQueryLatencyMs: number | null
}

interface SqlResponse {
  readonly data?: ReadonlyArray<Record<string, unknown>>
}

const fetchJson = async <T>(url: string, token: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Tinybird API error: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

const querySql = async (baseUrl: string, token: string, sql: string): Promise<SqlResponse | null> =>
  fetchJson<SqlResponse>(
    `${baseUrl}/v0/sql?q=${encodeURIComponent(`${sql} FORMAT JSON`)}`,
    token,
  ).catch(() => null)

export const fetchInstanceHealth = async (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdInstanceHealth> => {
  const baseUrl = normalizeBaseUrl(params.baseUrl)

  const [workspace, datasourcesResult, errorsResult, latencyResult] = await Promise.all([
    fetchJson<{ name?: string }>(
      `${baseUrl}/v1/workspace`,
      params.token,
    ).catch(() => null),

    querySql(
      baseUrl,
      params.token,
      "SELECT datasource_name, bytes, rows FROM tinybird.datasources_storage WHERE timestamp = (SELECT max(timestamp) FROM tinybird.datasources_storage) ORDER BY bytes DESC",
    ),

    querySql(
      baseUrl,
      params.token,
      "SELECT count() as cnt FROM tinybird.endpoint_errors WHERE start_datetime >= now() - interval 1 day",
    ),

    querySql(
      baseUrl,
      params.token,
      "SELECT avg(duration) as avg_ms FROM tinybird.pipe_stats_rt WHERE start_datetime >= now() - interval 1 day",
    ),
  ])

  const ds = (datasourcesResult?.data ?? []).map((row) => ({
    name: String(row.datasource_name ?? ""),
    rowCount: Number(row.rows ?? 0),
    bytes: Number(row.bytes ?? 0),
  }))

  const totalRows = ds.reduce((sum, d) => sum + d.rowCount, 0)
  const totalBytes = ds.reduce((sum, d) => sum + d.bytes, 0)

  const recentErrorCount = Number(errorsResult?.data?.[0]?.cnt ?? 0)
  const avgLatencyRaw = latencyResult?.data?.[0]?.avg_ms
  // duration from pipe_stats_rt is in seconds, convert to ms
  const avgQueryLatencyMs = typeof avgLatencyRaw === "number" ? avgLatencyRaw * 1000 : null

  return {
    workspaceName: workspace?.name ?? null,
    datasources: ds,
    totalRows,
    totalBytes,
    recentErrorCount,
    avgQueryLatencyMs,
  }
}

export const buildTinybirdProject = async (): Promise<TinybirdProjectBuild> => bundledProject

export const getCurrentTinybirdProjectRevision = async (): Promise<string> => projectRevision

export const syncTinybirdProject = async (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdProjectSyncResult> => {
  const baseUrl = normalizeBaseUrl(params.baseUrl)

  const formData = new FormData()
  for (const datasource of datasources) {
    formData.append(
      "data_project://",
      new Blob([datasource.content], { type: "text/plain" }),
      `${datasource.name}.datasource`,
    )
  }
  for (const pipe of pipes) {
    formData.append(
      "data_project://",
      new Blob([pipe.content], { type: "text/plain" }),
      `${pipe.name}.pipe`,
    )
  }

  const deployRes = await fetch(
    `${baseUrl}/v1/deploy?${new URLSearchParams({ allow_destructive_operations: "true" })}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${params.token}` },
      body: formData,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  )
  const deployBody = (await deployRes.json()) as DeployResponse

  if (!deployRes.ok || deployBody.result === "failed") {
    throw new Error(toDeployErrorMessage(deployBody, "Tinybird project sync failed"))
  }

  if (deployBody.result === "no_changes") {
    return {
      projectRevision,
      result: "no_changes",
      deploymentId: deployBody.deployment?.id,
    }
  }

  const deploymentId = deployBody.deployment?.id
  if (!deploymentId) {
    throw new Error("Tinybird project sync did not return a deployment id")
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS))

    const statusRes = await fetch(`${baseUrl}/v1/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${params.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!statusRes.ok) {
      throw new Error(`Tinybird deployment status check failed: ${statusRes.status} ${statusRes.statusText}`)
    }

    const statusBody = (await statusRes.json()) as { deployment?: { status?: string } }
    const status = statusBody.deployment?.status

    if (status === "data_ready") {
      break
    }
    if (status === "failed" || status === "error") {
      throw new Error("Tinybird deployment failed before reaching data_ready")
    }
    if (attempt === MAX_POLL_ATTEMPTS - 1) {
      throw new Error("Tinybird deployment timed out before reaching data_ready")
    }
  }

  const liveRes = await fetch(`${baseUrl}/v1/deployments/${deploymentId}/set-live`, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!liveRes.ok) {
    throw new Error(`Failed to set Tinybird deployment live: ${liveRes.status} ${await liveRes.text()}`)
  }

  return {
    projectRevision,
    result: deployBody.result,
    deploymentId,
  }
}
