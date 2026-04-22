import { datasources, pipes, projectRevision } from "../generated/tinybird-project-manifest"
import { TinybirdApi, TinybirdApiError } from "@tinybirdco/sdk"
import { Duration, Effect, Layer, Schema, Context } from "effect"
import {
  applyRawTtlOverrides,
  computeEffectiveRevision,
  EMPTY_TTL_OVERRIDES,
  type RawTableTtlOverrides,
} from "./ttl-override"

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

const DeploymentsListBodySchema = Schema.Struct({
  deployments: Schema.Array(Schema.Struct({
    id: Schema.String,
    status: Schema.optionalKey(Schema.String),
    live: Schema.optionalKey(Schema.Boolean),
  })),
})
const DeploymentsListBodyFromJson = Schema.fromJsonString(DeploymentsListBodySchema)

type FeedbackEntry = typeof FeedbackEntrySchema.Type

const READY_STATUSES = new Set(["data_ready", "live"])
const FAILURE_STATUSES = new Set(["failed", "error", "deleting", "deleted"])

export interface TinybirdProjectSyncParams {
  readonly baseUrl: string
  readonly token: string
}

export interface TinybirdDeployParams extends TinybirdProjectSyncParams {
  readonly overrides?: RawTableTtlOverrides
}

export interface TinybirdStartDeploymentResult {
  readonly projectRevision: string
  readonly result: "success" | "no_changes"
  readonly deploymentId: string | null
  readonly deploymentStatus: string | null
  readonly errorMessage: string | null
}

export interface TinybirdDeploymentReadiness {
  readonly deploymentId: string
  readonly status: string
  readonly isTerminal: boolean
  readonly isReady: boolean
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

const SqlResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
})
type SqlResponse = typeof SqlResponseSchema.Type

const WorkspaceProbeSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
})
type WorkspaceProbe = typeof WorkspaceProbeSchema.Type

export class TinybirdSyncRejectedError extends Schema.TaggedErrorClass<TinybirdSyncRejectedError>()(
  "@maple/tinybird/errors/SyncRejected",
  {
    message: Schema.String,
    statusCode: Schema.NullOr(Schema.Number),
  },
) {}

export class TinybirdSyncUnavailableError extends Schema.TaggedErrorClass<TinybirdSyncUnavailableError>()(
  "@maple/tinybird/errors/SyncUnavailable",
  {
    message: Schema.String,
    statusCode: Schema.NullOr(Schema.Number),
  },
) {}

// Not-yet-ready signal for poll steps. Thrown so Cloudflare Workflow step retry
// policies re-run the step; not a real failure. Cloudflare inspects the thrown
// JS Error for retry semantics — TaggedErrorClass produces a class that extends
// Error, so `instanceof` still works at the step boundary.
export class TinybirdDeploymentNotReadyError extends Schema.TaggedErrorClass<TinybirdDeploymentNotReadyError>()(
  "@maple/tinybird/errors/DeploymentNotReady",
  {
    message: Schema.String,
    deploymentId: Schema.String,
    status: Schema.String,
  },
) {
  static from(deploymentId: string, status: string): TinybirdDeploymentNotReadyError {
    return new TinybirdDeploymentNotReadyError({
      message: `Tinybird deployment ${deploymentId} not ready yet (status: ${status})`,
      deploymentId,
      status,
    })
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
  new TinybirdSyncUnavailableError({ message, statusCode })

const toRejectedError = (message: string, statusCode: number | null = null) =>
  new TinybirdSyncRejectedError({ message, statusCode })

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

const parseJsonSafe = <A, I>(
  schema: Schema.Codec<A, I>,
) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return (rawBody: string): Effect.Effect<A | null> => {
    const body = rawBody.trim()
    if (body.length === 0) return Effect.succeed(null)
    return decode(body).pipe(
      Effect.orElseSucceed(() => null),
    )
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

const makeApi = (params: TinybirdProjectSyncParams) =>
  new TinybirdApi({
    baseUrl: normalizeBaseUrl(params.baseUrl),
    token: params.token,
    fetch: globalThis.fetch,
    timeout: Duration.toMillis(REQUEST_TIMEOUT),
  })

const buildDeployFormData = (overrides: RawTableTtlOverrides) => {
  const effectiveDatasources = applyRawTtlOverrides(datasources, overrides)
  const formData = new FormData()
  for (const datasource of effectiveDatasources) {
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
  return formData
}

export interface TinybirdProjectSyncShape {
  readonly cleanupStaleDeployments: (
    params: TinybirdProjectSyncParams,
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly startDeployment: (
    params: TinybirdDeployParams,
  ) => Effect.Effect<TinybirdStartDeploymentResult, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly pollDeployment: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<
    TinybirdDeploymentReadiness,
    TinybirdSyncRejectedError | TinybirdSyncUnavailableError | TinybirdDeploymentNotReadyError
  >
  readonly getDeploymentStatus: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<TinybirdDeploymentReadiness, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly setDeploymentLive: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly cleanupOwnedDeployment: (
    params: TinybirdProjectSyncParams & { readonly deploymentId: string },
  ) => Effect.Effect<void, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly fetchInstanceHealth: (
    params: TinybirdProjectSyncParams,
  ) => Effect.Effect<TinybirdInstanceHealth, TinybirdSyncRejectedError | TinybirdSyncUnavailableError>
  readonly getCurrentProjectRevision: () => Effect.Effect<string>
}

export class TinybirdProjectSync extends Context.Service<TinybirdProjectSync, TinybirdProjectSyncShape>()(
  "TinybirdProjectSync",
  {
    make: Effect.gen(function* () {
      const fetchDeploymentStatusInternal = Effect.fn("TinybirdProjectSync.fetchDeploymentStatus")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          yield* Effect.annotateCurrentSpan("deploymentId", params.deploymentId)
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
              isReady: false,
              errorMessage: `Deployment ${params.deploymentId} was deleted.\nResponse: ${rawBody}`,
            } satisfies TinybirdDeploymentReadiness
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
          const isReady = READY_STATUSES.has(status)
          const isTerminal = status === "live" || FAILURE_STATUSES.has(status)
          const errorMessage = extractStatusErrorMessage(body, status)

          return {
            deploymentId: params.deploymentId,
            status,
            isTerminal,
            isReady,
            errorMessage,
          } satisfies TinybirdDeploymentReadiness
        },
      )

      const cleanupStaleDeployments = Effect.fn("TinybirdProjectSync.cleanupStaleDeployments")(
        function* (params: TinybirdProjectSyncParams) {
          yield* Effect.annotateCurrentSpan("baseUrl", params.baseUrl)
          const api = makeApi(params)

          const listResponse = yield* Effect.tryPromise({
            try: () => api.request(`/v1/deployments`),
            catch: (error) => mapApiFailure(error, "Deployments list failed"),
          })

          if (listResponse.status === 404) return
          const rawBody = yield* Effect.promise(() => listResponse.text()).pipe(Effect.orElseSucceed(() => ""))
          if (listResponse.status >= 400) {
            return yield* Effect.fail(
              classifyHttpError(
                listResponse.status,
                `Deployments list failed (HTTP ${listResponse.status}).\nResponse: ${rawBody}`,
              ),
            )
          }

          const body = yield* Schema.decodeUnknownEffect(DeploymentsListBodyFromJson)(rawBody).pipe(
            Effect.mapError(() =>
              toUnavailableError(
                `Tinybird returned invalid JSON from deployments list.\nResponse: ${rawBody}`,
                listResponse.status,
              ),
            ),
          )

          const stale = body.deployments.filter((d) => !d.live && d.status !== "live")
          if (stale.length === 0) return

          yield* Effect.forEach(
            stale,
            (deployment) =>
              Effect.tryPromise({
                try: () =>
                  api.request(`/v1/deployments/${deployment.id}`, { method: "DELETE" }),
                catch: () => null,
              }).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          )
        },
      )

      const startDeployment = Effect.fn("TinybirdProjectSync.startDeployment")(
        function* (params: TinybirdDeployParams) {
          yield* Effect.annotateCurrentSpan("baseUrl", params.baseUrl)
          const api = makeApi(params)
          const overrides = params.overrides ?? EMPTY_TTL_OVERRIDES
          const formData = buildDeployFormData(overrides)
          const effectiveRevision = computeEffectiveRevision(projectRevision, overrides)

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
            const parsedDeployBody = yield* parseJsonSafe(DeployResponseSchema)(deployRawBody)
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

          return {
            projectRevision: effectiveRevision,
            result: deployBody.result,
            deploymentId: deployBody.deployment?.id ?? null,
            deploymentStatus: deployBody.deployment?.status ?? null,
            errorMessage: formatFeedback(feedback),
          } satisfies TinybirdStartDeploymentResult
        },
      )

      const pollDeployment = Effect.fn("TinybirdProjectSync.pollDeployment")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          const status = yield* fetchDeploymentStatusInternal(params)

          if (status.isReady) return status

          if (status.isTerminal) {
            return yield* Effect.fail(
              toRejectedError(
                status.errorMessage
                  ? `Tinybird deployment ${status.status}: ${status.errorMessage}`
                  : `Tinybird deployment ${status.status} before reaching data_ready.`,
              ),
            )
          }

          return yield* Effect.fail(TinybirdDeploymentNotReadyError.from(params.deploymentId, status.status))
        },
      )

      const setDeploymentLive = Effect.fn("TinybirdProjectSync.setDeploymentLive")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          yield* Effect.annotateCurrentSpan("deploymentId", params.deploymentId)
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

      const cleanupOwnedDeployment = Effect.fn("TinybirdProjectSync.cleanupOwnedDeployment")(
        function* (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) {
          yield* Effect.annotateCurrentSpan("deploymentId", params.deploymentId)
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
          yield* Effect.annotateCurrentSpan("baseUrl", params.baseUrl)
          const api = makeApi(params)

          const requestJsonBestEffort = <A, I>(
            schema: Schema.Codec<A, I>,
            path: string,
            init?: RequestInit,
          ): Effect.Effect<A | null> => {
            const parse = parseJsonSafe(schema)
            return Effect.promise(() => api.request(path, init)).pipe(
              Effect.flatMap((response) =>
                Effect.promise(() => response.text()).pipe(
                  Effect.flatMap((rawBody) => response.ok ? parse(rawBody) : Effect.succeed(null)),
                )
              ),
              Effect.orElseSucceed(() => null),
            )
          }

          const querySql = (sql: string) =>
            requestJsonBestEffort(
              SqlResponseSchema,
              `/v0/sql?q=${encodeURIComponent(`${sql} FORMAT JSON`)}`,
            )

          // Raw SQL against Tinybird's `tinybird.*` admin schema — fixed strings,
          // no interpolation. Kept raw because @maple/domain cannot depend on
          // @maple/query-engine (the DSL) without inverting the existing
          // query-engine → domain dependency. These three queries have no
          // dynamic input, so there's no injection surface to protect.
          const DATASOURCES_STORAGE_SQL =
            "SELECT datasource_name, bytes, rows FROM tinybird.datasources_storage WHERE timestamp = (SELECT max(timestamp) FROM tinybird.datasources_storage) ORDER BY bytes DESC"
          const ENDPOINT_ERRORS_24H_SQL =
            "SELECT count() as cnt FROM tinybird.endpoint_errors WHERE start_datetime >= now() - interval 1 day"
          const PIPE_LATENCY_24H_SQL =
            "SELECT avg(duration) as avg_ms FROM tinybird.pipe_stats_rt WHERE start_datetime >= now() - interval 1 day"

          const [workspace, datasourcesResult, errorsResult, latencyResult] = yield* Effect.all(
            [
              requestJsonBestEffort(WorkspaceProbeSchema, "/v1/workspace"),
              querySql(DATASOURCES_STORAGE_SQL),
              querySql(ENDPOINT_ERRORS_24H_SQL),
              querySql(PIPE_LATENCY_24H_SQL),
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
        cleanupStaleDeployments,
        startDeployment,
        pollDeployment,
        getDeploymentStatus: fetchDeploymentStatusInternal,
        setDeploymentLive,
        cleanupOwnedDeployment,
        fetchInstanceHealth,
        getCurrentProjectRevision,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer

  static readonly cleanupStaleDeployments = (params: TinybirdProjectSyncParams) =>
    this.use((service) => service.cleanupStaleDeployments(params))

  static readonly startDeployment = (params: TinybirdDeployParams) =>
    this.use((service) => service.startDeployment(params))

  static readonly pollDeployment = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.pollDeployment(params))

  static readonly getDeploymentStatus = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.getDeploymentStatus(params))

  static readonly setDeploymentLive = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.setDeploymentLive(params))

  static readonly cleanupOwnedDeployment = (params: TinybirdProjectSyncParams & { readonly deploymentId: string }) =>
    this.use((service) => service.cleanupOwnedDeployment(params))

  static readonly fetchInstanceHealth = (params: TinybirdProjectSyncParams) =>
    this.use((service) => service.fetchInstanceHealth(params))

  static readonly getCurrentProjectRevision = () =>
    this.use((service) => service.getCurrentProjectRevision())
}

// ---------------------------------------------------------------------------
// Promise-returning wrappers for non-Effect callers (Cloudflare Workflow steps)
// ---------------------------------------------------------------------------

const provideSync = <A, E>(effect: Effect.Effect<A, E, TinybirdProjectSync>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TinybirdProjectSync.layer)))

export const cleanupStaleTinybirdDeployments = (
  params: TinybirdProjectSyncParams,
): Promise<void> => provideSync(TinybirdProjectSync.cleanupStaleDeployments(params))

export const startTinybirdDeploymentStep = (
  params: TinybirdDeployParams,
): Promise<TinybirdStartDeploymentResult> =>
  provideSync(TinybirdProjectSync.startDeployment(params))

export const pollTinybirdDeploymentStep = (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<TinybirdDeploymentReadiness> =>
  provideSync(TinybirdProjectSync.pollDeployment(params))

export const getTinybirdDeploymentStatus = (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<TinybirdDeploymentReadiness> =>
  provideSync(TinybirdProjectSync.getDeploymentStatus(params))

export const setTinybirdDeploymentLiveStep = (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<void> => provideSync(TinybirdProjectSync.setDeploymentLive(params))

export const cleanupOwnedTinybirdDeployment = (
  params: TinybirdProjectSyncParams & { readonly deploymentId: string },
): Promise<void> => provideSync(TinybirdProjectSync.cleanupOwnedDeployment(params))

export const fetchInstanceHealth = (
  params: TinybirdProjectSyncParams,
): Promise<TinybirdInstanceHealth> => provideSync(TinybirdProjectSync.fetchInstanceHealth(params))

export const getCurrentTinybirdProjectRevision = (): Promise<string> =>
  provideSync(TinybirdProjectSync.getCurrentProjectRevision())
