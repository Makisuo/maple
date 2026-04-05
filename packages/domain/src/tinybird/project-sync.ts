import { datasources, pipes, projectRevision } from "../generated/tinybird-project-manifest"
import { TinybirdApi, TinybirdApiError } from "@tinybirdco/sdk"
import { Duration, Effect, Layer, Schema, ServiceMap } from "effect"

const POLL_INTERVAL_MS = 2_000
const MAX_POLL_ATTEMPTS = 300
const REQUEST_TIMEOUT = Duration.seconds(30)

const FeedbackEntrySchema = Schema.Struct({
  resource: Schema.NullOr(Schema.String),
  level: Schema.String,
  message: Schema.String,
})

const DeployResponseSchema = Schema.Struct({
  result: Schema.Literals(["success", "failed", "no_changes"]),
  deployment: Schema.optionalKey(Schema.Struct({
    id: Schema.String,
    status: Schema.optionalKey(Schema.String),
    feedback: Schema.optionalKey(Schema.Array(FeedbackEntrySchema)),
    deleted_datasource_names: Schema.optionalKey(Schema.Array(Schema.String)),
    deleted_pipe_names: Schema.optionalKey(Schema.Array(Schema.String)),
    changed_datasource_names: Schema.optionalKey(Schema.Array(Schema.String)),
    changed_pipe_names: Schema.optionalKey(Schema.Array(Schema.String)),
    new_datasource_names: Schema.optionalKey(Schema.Array(Schema.String)),
    new_pipe_names: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
  error: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({
    filename: Schema.optionalKey(Schema.String),
    error: Schema.String,
  }))),
})
type DeployResponse = typeof DeployResponseSchema.Type
const DeployResponseFromJson = Schema.fromJsonString(DeployResponseSchema)

const DeploymentStatusBodySchema = Schema.Struct({
  deployment: Schema.optionalKey(Schema.Struct({
    status: Schema.optionalKey(Schema.String),
    feedback: Schema.optionalKey(Schema.Array(FeedbackEntrySchema)),
    errors: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
})
type DeploymentStatusBody = typeof DeploymentStatusBodySchema.Type
const DeploymentStatusBodyFromJson = Schema.fromJsonString(DeploymentStatusBodySchema)

type FeedbackEntry = typeof FeedbackEntrySchema.Type

const TERMINAL_STATUSES = new Set(["live", "failed", "error", "deleting", "deleted"])
const FAILURE_STATUSES = new Set(["failed", "error", "deleting", "deleted"])

export interface TinybirdProjectSyncParams {
  readonly baseUrl: string
  readonly token: string
}

export interface TinybirdProjectSyncResult {
  readonly projectRevision: string
  readonly result: "success" | "no_changes"
  readonly deploymentId?: string
}

export interface TinybirdStartDeploymentResult {
  readonly projectRevision: string
  readonly result: "success" | "no_changes"
  readonly deploymentId?: string
  readonly deploymentStatus: string | null
  readonly errorMessage: string | null
}

export interface TinybirdDeploymentStatus {
  readonly deploymentId: string
  readonly status: string
  readonly isTerminal: boolean
  readonly errorMessage: string | null
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

abstract class TinybirdSyncError extends Error {
  readonly statusCode: number | null

  constructor(message: string, statusCode: number | null = null) {
    super(message)
    this.statusCode = statusCode
  }
}

export class TinybirdSyncRejectedError extends TinybirdSyncError {
  readonly _tag = "TinybirdSyncRejectedError" as const

  constructor(message: string, statusCode: number | null = null) {
    super(message, statusCode)
    this.name = "TinybirdSyncRejectedError"
  }
}

export class TinybirdSyncUnavailableError extends TinybirdSyncError {
  readonly _tag = "TinybirdSyncUnavailableError" as const

  constructor(message: string, statusCode: number | null = null) {
    super(message, statusCode)
    this.name = "TinybirdSyncUnavailableError"
  }
}

const normalizeBaseUrl = (raw: string) => raw.trim().replace(/\/+$/, "")

const simplifyDeployFailureMessage = (message: string): string => {
  const trimmed = message.trim()

  if (/already a deployment in progress/i.test(trimmed)) {
    return "Tinybird already has a deployment in progress. Wait for it to finish, then retry. If needed, promote or discard the existing deployment in Tinybird first."
  }

  return trimmed
}

const toDeployErrorMessage = (body: DeployResponse, fallback: string): string => {
  const feedbackErrors = body.deployment?.feedback
    ?.filter((entry) => entry.level === "ERROR")
    .map((entry) => simplifyDeployFailureMessage(entry.message))

  if (feedbackErrors && feedbackErrors.length > 0) {
    return feedbackErrors.join("\n")
  }

  if (body.error) return simplifyDeployFailureMessage(body.error)
  if (body.errors && body.errors.length > 0) {
    return body.errors.map((entry) => simplifyDeployFailureMessage(entry.error)).join("\n")
  }

  return fallback
}

const extractStatusErrorMessage = (body: DeploymentStatusBody, status: string): string | null => {
  if (!FAILURE_STATUSES.has(status)) return null

  const deployErrors = body.deployment?.errors
  if (deployErrors && deployErrors.length > 0) {
    return deployErrors.join("\n")
  }

  const feedbackErrors = body.deployment?.feedback
    ?.filter((entry) => entry.level === "ERROR")
    .map((entry) => entry.message)
  if (feedbackErrors && feedbackErrors.length > 0) {
    return feedbackErrors.join("\n")
  }

  return null
}

const formatFeedback = (feedback: ReadonlyArray<FeedbackEntry>): string | null => {
  if (feedback.length === 0) return null
  return feedback
    .map((entry) => `[${entry.level}]${entry.resource ? ` ${entry.resource}:` : ""} ${entry.message}`)
    .join("\n")
}

const toUnavailableError = (message: string, statusCode: number | null = null) =>
  new TinybirdSyncUnavailableError(message, statusCode)

const toRejectedError = (message: string, statusCode: number | null = null) =>
  new TinybirdSyncRejectedError(message, statusCode)

const classifyHttpError = (statusCode: number, message: string) =>
  statusCode >= 400 && statusCode < 500
    ? toRejectedError(message, statusCode)
    : toUnavailableError(message, statusCode)

const mapApiFailure = (
  error: unknown,
  fallback: string,
): TinybirdSyncRejectedError | TinybirdSyncUnavailableError => {
  if (error instanceof TinybirdSyncRejectedError || error instanceof TinybirdSyncUnavailableError) {
    return error
  }

  if (error instanceof TinybirdApiError) {
    return classifyHttpError(error.statusCode, error.message || fallback)
  }

  if (error instanceof Error) {
    return toUnavailableError(error.message || fallback)
  }

  return toUnavailableError(fallback)
}

const parseJsonOrNull = <T>(rawBody: string): T | null => {
  const body = rawBody.trim()
  if (body.length === 0) return null

  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const catchHttpErrors = <A>(
  effect: Effect.Effect<
    A,
    TinybirdSyncRejectedError | TinybirdSyncUnavailableError | { readonly _tag: string; readonly message?: string },
    never
  >,
): Effect.Effect<A, TinybirdSyncRejectedError | TinybirdSyncUnavailableError, never> =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is {
        readonly _tag: string
        readonly message?: string
      } => !(error instanceof TinybirdSyncRejectedError) && !(error instanceof TinybirdSyncUnavailableError),
      (error) => Effect.fail(toUnavailableError(error.message ?? `Tinybird request failed (${error._tag})`)),
    ),
  ) as Effect.Effect<A, TinybirdSyncRejectedError | TinybirdSyncUnavailableError, never>

export interface TinybirdProjectSyncShape {
  readonly startDeployment: (
    params: TinybirdProjectSyncParams,
  ) => Effect.Effect<TinybirdStartDeploymentResult, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly getDeploymentStatus: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<TinybirdDeploymentStatus, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly setDeploymentLive: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly resumeDeployment: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<TinybirdDeploymentStatus, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly cleanupOwnedDeployment: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly fetchInstanceHealth: (
    params: TinybirdProjectSyncParams,
  ) => Effect.Effect<TinybirdInstanceHealth, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly getCurrentProjectRevision: () => Effect.Effect<string>
}

export class TinybirdProjectSync extends ServiceMap.Service<TinybirdProjectSync, TinybirdProjectSyncShape>()(
  "TinybirdProjectSync",
  {
    make: Effect.gen(function* () {
      const makeApi = (params: TinybirdProjectSyncParams) =>
        new TinybirdApi({
          baseUrl: normalizeBaseUrl(params.baseUrl),
          token: params.token,
          fetch: globalThis.fetch,
          timeout: Duration.toMillis(REQUEST_TIMEOUT),
        })

      const fetchDeploymentStatusInternal = Effect.fn("TinybirdProjectSync.fetchDeploymentStatusInternal")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          const api = makeApi(params)
          const response = yield* Effect.tryPromise({
            try: () => api.request(`/v1/deployments/${params.deploymentId}`),
            catch: (error) => mapApiFailure(error, "Deployment status check failed"),
          })

          const rawBody = yield* Effect.promise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))

          if (response.status === 404) {
            return {
              deploymentId: params.deploymentId,
              status: "deleted",
              isTerminal: true,
              errorMessage: `Deployment ${params.deploymentId} was deleted.\nResponse: ${rawBody}`,
            } satisfies TinybirdDeploymentStatus
          }
          if (response.status >= 400) {
            return yield* Effect.fail(
              classifyHttpError(
                response.status,
                `Deployment status check failed (HTTP ${response.status}).\nResponse: ${rawBody}`,
              ),
            )
          }

          const body = yield* Schema.decodeUnknownEffect(DeploymentStatusBodyFromJson)(rawBody).pipe(
            Effect.mapError(() =>
              toUnavailableError(
                `Tinybird returned invalid JSON from deployment status.\nResponse: ${rawBody}`,
                response.status,
              ),
            ),
          )
          const status = body.deployment?.status ?? "unknown"
          const errorMessage = extractStatusErrorMessage(body, status)

          return {
            deploymentId: params.deploymentId,
            status,
            isTerminal: TERMINAL_STATUSES.has(status),
            errorMessage,
          } satisfies TinybirdDeploymentStatus
        },
      )

      const startDeployment = Effect.fn("TinybirdProjectSync.startDeployment")(
        function* (params: TinybirdProjectSyncParams) {
          const api = makeApi(params)

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

          const deployResponse = yield* Effect.tryPromise({
            try: () =>
              api.request("/v1/deploy?allow_destructive_operations=true", {
                method: "POST",
                body: formData,
              }),
            catch: (error) => mapApiFailure(error, "Tinybird project sync failed"),
          })

          const deployRawBody = yield* Effect.promise(() => deployResponse.text()).pipe(Effect.orElseSucceed(() => ""))

          if (deployResponse.status >= 400) {
            const parsedDeployBody = parseJsonOrNull<DeployResponse>(deployRawBody)
            return yield* Effect.fail(
              classifyHttpError(
                deployResponse.status,
                parsedDeployBody
                  ? toDeployErrorMessage(
                    parsedDeployBody,
                    `Tinybird project sync failed (HTTP ${deployResponse.status}).\nResponse: ${deployRawBody}`,
                  )
                  : `Tinybird project sync failed (HTTP ${deployResponse.status}).\nResponse: ${deployRawBody}`,
              ),
            )
          }

          const deployBody = yield* Schema.decodeUnknownEffect(DeployResponseFromJson)(deployRawBody).pipe(
            Effect.mapError(() =>
              toUnavailableError(
                `Tinybird returned invalid JSON from /v1/deploy.\nResponse: ${deployRawBody}`,
                deployResponse.status,
              ),
            ),
          )

          if (deployBody.result === "failed") {
            return yield* Effect.fail(
              toRejectedError(
                toDeployErrorMessage(deployBody, `Tinybird project sync failed.\nResponse: ${deployRawBody}`),
                deployResponse.status,
              ),
            )
          }

          const feedback = deployBody.deployment?.feedback ?? []

          if (deployBody.result === "no_changes") {
            return {
              projectRevision,
              result: "no_changes" as const,
              deploymentId: deployBody.deployment?.id,
              deploymentStatus: deployBody.deployment?.status ?? null,
              errorMessage: formatFeedback(feedback),
            } satisfies TinybirdStartDeploymentResult
          }

          const deploymentId = deployBody.deployment?.id
          if (!deploymentId) {
            return yield* Effect.fail(
              toUnavailableError("Tinybird project sync did not return a deployment id"),
            )
          }

          return {
            projectRevision,
            result: "success" as const,
            deploymentId,
            deploymentStatus: deployBody.deployment?.status ?? null,
            errorMessage: formatFeedback(feedback),
          } satisfies TinybirdStartDeploymentResult
        },
      )

      const setDeploymentLive = Effect.fn("TinybirdProjectSync.setDeploymentLive")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          const api = makeApi(params)
          const liveResponse = yield* Effect.tryPromise({
            try: () =>
              api.request(`/v1/deployments/${params.deploymentId}/set-live`, {
                method: "POST",
              }),
            catch: (error) =>
              mapApiFailure(
                error,
                `Failed to set Tinybird deployment ${params.deploymentId} live`,
              ),
          })

          if (liveResponse.status >= 400) {
            const liveRawBody = yield* Effect.promise(() => liveResponse.text()).pipe(Effect.orElseSucceed(() => ""))
            return yield* Effect.fail(
              classifyHttpError(
                liveResponse.status,
                `Failed to set Tinybird deployment ${params.deploymentId} live (HTTP ${liveResponse.status}).\nResponse: ${liveRawBody}`,
              ),
            )
          }
        },
      )

      const resumeDeployment = Effect.fn("TinybirdProjectSync.resumeDeployment")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
            yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS))

            const status = yield* fetchDeploymentStatusInternal(params)
            if (status.status === "data_ready" || status.status === "live") {
              return status
            }
            if (status.isTerminal) {
              return yield* Effect.fail(
                toRejectedError(
                  status.errorMessage
                    ? `Tinybird deployment ${status.status}: ${status.errorMessage}`
                    : `Tinybird deployment ${status.status} before reaching data_ready.`,
                ),
              )
            }
          }

          return yield* Effect.fail(
            toUnavailableError("Tinybird deployment timed out before reaching data_ready"),
          )
        },
      )

      const cleanupOwnedDeployment = Effect.fn("TinybirdProjectSync.cleanupOwnedDeployment")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          const status = yield* fetchDeploymentStatusInternal(params)
          if (!status.isTerminal || status.status === "live" || status.status === "data_ready") {
            return
          }
          if (status.status === "deleted") {
            return
          }

          const api = makeApi(params)
          const response = yield* Effect.tryPromise({
            try: () =>
              api.request(`/v1/deployments/${params.deploymentId}`, {
                method: "DELETE",
              }),
            catch: (error) =>
              mapApiFailure(
                error,
                `Failed to delete Tinybird deployment ${params.deploymentId}`,
              ),
          })

          if (response.status === 404) return
          if (response.status >= 400) {
            const rawBody = yield* Effect.promise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
            return yield* Effect.fail(
              classifyHttpError(
                response.status,
                `Failed to delete Tinybird deployment ${params.deploymentId} (HTTP ${response.status}).\nResponse: ${rawBody}`,
              ),
            )
          }
        },
      )

      const fetchInstanceHealth = Effect.fn("TinybirdProjectSync.fetchInstanceHealth")(
        function* (params: TinybirdProjectSyncParams) {
          const api = makeApi(params)

          const requestJsonBestEffort = <T>(path: string, init?: RequestInit) =>
            Effect.promise(() => api.request(path, init))
              .pipe(
                Effect.flatMap((response) =>
                  Effect.promise(() => response.text()).pipe(
                    Effect.map((rawBody) => (response.ok ? parseJsonOrNull<T>(rawBody) : null)),
                  )
                ),
                Effect.orElseSucceed(() => null as T | null),
              )

          const querySql = (sql: string) =>
            requestJsonBestEffort<SqlResponse>(
              `/v0/sql?q=${encodeURIComponent(`${sql} FORMAT JSON`)}`,
            )

          const [workspace, datasourcesResult, errorsResult, latencyResult] = yield* Effect.all(
            [
              requestJsonBestEffort<{ name?: string }>("/v1/workspace"),
              querySql(
                "SELECT datasource_name, bytes, rows FROM tinybird.datasources_storage WHERE timestamp = (SELECT max(timestamp) FROM tinybird.datasources_storage) ORDER BY bytes DESC",
              ),
              querySql(
                "SELECT count() as cnt FROM tinybird.endpoint_errors WHERE start_datetime >= now() - interval 1 day",
              ),
              querySql(
                "SELECT avg(duration) as avg_ms FROM tinybird.pipe_stats_rt WHERE start_datetime >= now() - interval 1 day",
              ),
            ],
            { concurrency: "unbounded" },
          )

          const ds = (datasourcesResult?.data ?? []).map((row) => ({
            name: String(row.datasource_name ?? ""),
            rowCount: Number(row.rows ?? 0),
            bytes: Number(row.bytes ?? 0),
          }))

          const totalRows = ds.reduce((sum, d) => sum + d.rowCount, 0)
          const totalBytes = ds.reduce((sum, d) => sum + d.bytes, 0)

          const recentErrorCount = Number(errorsResult?.data?.[0]?.cnt ?? 0)
          const avgLatencyRaw = toNumberOrNull(latencyResult?.data?.[0]?.avg_ms)
          const avgQueryLatencyMs = avgLatencyRaw == null ? null : avgLatencyRaw * 1000

          return {
            workspaceName: workspace?.name ?? null,
            datasources: ds,
            totalRows,
            totalBytes,
            recentErrorCount,
            avgQueryLatencyMs,
          }
        },
      )

      const getCurrentProjectRevision = Effect.fn("TinybirdProjectSync.getCurrentProjectRevision")(function* () {
        return projectRevision
      })

      return {
        startDeployment: (params: TinybirdProjectSyncParams) => catchHttpErrors(startDeployment(params)),
        getDeploymentStatus: (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
          catchHttpErrors(fetchDeploymentStatusInternal(params)),
        setDeploymentLive: (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
          catchHttpErrors(setDeploymentLive(params)),
        resumeDeployment: (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
          catchHttpErrors(resumeDeployment(params)),
        cleanupOwnedDeployment: (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
          catchHttpErrors(cleanupOwnedDeployment(params)),
        fetchInstanceHealth: (params: TinybirdProjectSyncParams) => catchHttpErrors(fetchInstanceHealth(params)),
        getCurrentProjectRevision,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer

  static readonly startDeployment = (params: TinybirdProjectSyncParams) =>
    this.use((service) => service.startDeployment(params))

  static readonly getDeploymentStatus = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.getDeploymentStatus(params))

  static readonly setDeploymentLive = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.setDeploymentLive(params))

  static readonly resumeDeployment = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.resumeDeployment(params))

  static readonly cleanupOwnedDeployment = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.cleanupOwnedDeployment(params))

  static readonly fetchInstanceHealth = (params: TinybirdProjectSyncParams) =>
    this.use((service) => service.fetchInstanceHealth(params))

  static readonly getCurrentProjectRevision = () =>
    this.use((service) => service.getCurrentProjectRevision())
}

export const syncTinybirdProject = async (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdProjectSyncResult> => {
  const started = await Effect.runPromise(
    TinybirdProjectSync.startDeployment(params).pipe(Effect.provide(TinybirdProjectSync.layer)),
  )

  if (started.result === "no_changes") {
    return {
      projectRevision: started.projectRevision,
      result: started.result,
      deploymentId: started.deploymentId,
    }
  }

  if (!started.deploymentId) {
    throw new TinybirdSyncUnavailableError("Tinybird project sync did not return a deployment id")
  }

  const resumed = await Effect.runPromise(
    TinybirdProjectSync.resumeDeployment({
      ...params,
      deploymentId: started.deploymentId,
    }).pipe(Effect.provide(TinybirdProjectSync.layer)),
  )

  if (resumed.status !== "live") {
    await Effect.runPromise(
      TinybirdProjectSync.setDeploymentLive({
        ...params,
        deploymentId: started.deploymentId,
      }).pipe(Effect.provide(TinybirdProjectSync.layer)),
    )
  }

  return {
    projectRevision: started.projectRevision,
    result: started.result,
    deploymentId: started.deploymentId,
  }
}

export const startTinybirdDeployment = async (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdStartDeploymentResult> =>
  Effect.runPromise(TinybirdProjectSync.startDeployment(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const getDeploymentStatus = async (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<TinybirdDeploymentStatus> =>
  Effect.runPromise(TinybirdProjectSync.getDeploymentStatus(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const setTinybirdDeploymentLive = async (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<void> =>
  Effect.runPromise(TinybirdProjectSync.setDeploymentLive(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const resumeTinybirdDeployment = async (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<TinybirdDeploymentStatus> =>
  Effect.runPromise(TinybirdProjectSync.resumeDeployment(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const cleanupOwnedTinybirdDeployment = async (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<void> =>
  Effect.runPromise(TinybirdProjectSync.cleanupOwnedDeployment(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const fetchInstanceHealth = async (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdInstanceHealth> =>
  Effect.runPromise(TinybirdProjectSync.fetchInstanceHealth(params).pipe(Effect.provide(TinybirdProjectSync.layer)))

export const getCurrentTinybirdProjectRevision = async (): Promise<string> =>
  Effect.runPromise(TinybirdProjectSync.getCurrentProjectRevision().pipe(Effect.provide(TinybirdProjectSync.layer)))
