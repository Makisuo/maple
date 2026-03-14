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
