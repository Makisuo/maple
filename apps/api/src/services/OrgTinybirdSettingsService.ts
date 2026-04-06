import {
  IsoDateTimeString,
  OrgTinybirdCurrentRunResponse,
  OrgTinybirdDeploymentStatusResponse,
  OrgTinybirdInstanceHealthResponse,
  OrgTinybirdSettingsDeleteResponse,
  OrgTinybirdSettingsEncryptionError,
  OrgTinybirdSettingsForbiddenError,
  OrgTinybirdSettingsPersistenceError,
  OrgTinybirdSettingsResponse,
  OrgTinybirdSettingsSyncConflictError,
  OrgTinybirdSettingsUpstreamRejectedError,
  OrgTinybirdSettingsUpstreamUnavailableError,
  OrgTinybirdSettingsValidationError,
  type OrgTinybirdSettingsUpsertRequest,
  OrgTinybirdSyncPhase,
  OrgTinybirdSyncRunStatus,
  OrgId,
  RoleName,
  UserId,
} from "@maple/domain/http"
import {
  cleanupOwnedTinybirdDeployment,
  fetchInstanceHealth as fetchInstanceHealthFn,
  getCurrentTinybirdProjectRevision,
  getDeploymentStatus as getDeploymentStatusFn,
  resumeTinybirdDeployment as resumeTinybirdDeploymentFn,
  setTinybirdDeploymentLive as setTinybirdDeploymentLiveFn,
  startTinybirdDeployment,
  TinybirdSyncRejectedError,
  TinybirdSyncUnavailableError,
} from "@maple/domain/tinybird-project-sync"
import { orgTinybirdSettings, orgTinybirdSyncRuns } from "@maple/db"
import { eq } from "drizzle-orm"
import { Duration, Effect, Layer, Option, Redacted, Schema, Semaphore, ServiceMap } from "effect"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
  type EncryptedValue,
} from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

interface RuntimeTinybirdConfig {
  readonly host: string
  readonly token: string
  readonly projectRevision: string
}

type ActiveRow = typeof orgTinybirdSettings.$inferSelect
type SyncRunRow = typeof orgTinybirdSyncRuns.$inferSelect
type SyncRunUpdate = Partial<Omit<typeof orgTinybirdSyncRuns.$inferInsert, "orgId">>

const NON_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running"])
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "succeeded"])
const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeUserId = Schema.decodeUnknownSync(UserId)
const decodeRunStatus = Schema.decodeUnknownSync(OrgTinybirdSyncRunStatus)
const decodePhase = Schema.decodeUnknownSync(OrgTinybirdSyncPhase)
const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")

const POLL_INTERVAL = Duration.millis(2_000)
const MAX_DEPLOYMENT_POLL_ATTEMPTS = 300
const SYNC_RUN_TIMEOUT_MS = Duration.toMillis(POLL_INTERVAL) * MAX_DEPLOYMENT_POLL_ATTEMPTS

export interface OrgTinybirdSettingsServiceShape {
  readonly get: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => Effect.Effect<
    OrgTinybirdSettingsResponse,
    OrgTinybirdSettingsForbiddenError | OrgTinybirdSettingsPersistenceError
  >
  readonly upsert: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    payload: OrgTinybirdSettingsUpsertRequest,
  ) => Effect.Effect<
    OrgTinybirdSettingsResponse,
    | OrgTinybirdSettingsForbiddenError
    | OrgTinybirdSettingsValidationError
    | OrgTinybirdSettingsPersistenceError
    | OrgTinybirdSettingsEncryptionError
    | OrgTinybirdSettingsSyncConflictError
    | OrgTinybirdSettingsUpstreamRejectedError
    | OrgTinybirdSettingsUpstreamUnavailableError
  >
  readonly delete: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => Effect.Effect<
    OrgTinybirdSettingsDeleteResponse,
    OrgTinybirdSettingsForbiddenError | OrgTinybirdSettingsPersistenceError
  >
  readonly resync: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
  ) => Effect.Effect<
    OrgTinybirdSettingsResponse,
    | OrgTinybirdSettingsForbiddenError
    | OrgTinybirdSettingsValidationError
    | OrgTinybirdSettingsPersistenceError
    | OrgTinybirdSettingsEncryptionError
    | OrgTinybirdSettingsSyncConflictError
    | OrgTinybirdSettingsUpstreamRejectedError
    | OrgTinybirdSettingsUpstreamUnavailableError
  >
  readonly getDeploymentStatus: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => Effect.Effect<
    OrgTinybirdDeploymentStatusResponse,
    | OrgTinybirdSettingsForbiddenError
    | OrgTinybirdSettingsValidationError
    | OrgTinybirdSettingsPersistenceError
    | OrgTinybirdSettingsEncryptionError
    | OrgTinybirdSettingsUpstreamUnavailableError
  >
  readonly getInstanceHealth: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => Effect.Effect<
    OrgTinybirdInstanceHealthResponse,
    | OrgTinybirdSettingsForbiddenError
    | OrgTinybirdSettingsValidationError
    | OrgTinybirdSettingsPersistenceError
    | OrgTinybirdSettingsEncryptionError
    | OrgTinybirdSettingsUpstreamRejectedError
    | OrgTinybirdSettingsUpstreamUnavailableError
  >
  readonly resolveRuntimeConfig: (
    orgId: OrgId,
  ) => Effect.Effect<Option.Option<RuntimeTinybirdConfig>, OrgTinybirdSettingsPersistenceError | OrgTinybirdSettingsEncryptionError>
}

const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
let startDeploymentImpl = startTinybirdDeployment
let getDeploymentTransportStatusImpl = getDeploymentStatusFn
let resumeDeploymentImpl = resumeTinybirdDeploymentFn
let setDeploymentLiveImpl = setTinybirdDeploymentLiveFn
let cleanupOwnedDeploymentImpl = cleanupOwnedTinybirdDeployment
let getProjectRevisionImpl = getCurrentTinybirdProjectRevision
let fetchInstanceHealthImpl = fetchInstanceHealthFn

const toPersistenceError = (error: unknown) =>
  new OrgTinybirdSettingsPersistenceError({
    message: error instanceof Error ? error.message : "Org Tinybird settings persistence failed",
  })

const toEncryptionError = (message: string) =>
  new OrgTinybirdSettingsEncryptionError({ message })

const parseEncryptionKey = (
  raw: string,
): Effect.Effect<Buffer, OrgTinybirdSettingsEncryptionError> =>
  parseBase64Aes256GcmKey(raw, (message) =>
    toEncryptionError(
      message === "Expected a non-empty base64 encryption key"
        ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
        : message === "Expected base64 for exactly 32 bytes"
          ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
          : message,
    ),
  )

const encryptToken = (
  plaintext: string,
  encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, OrgTinybirdSettingsEncryptionError> =>
  encryptAes256Gcm(plaintext, encryptionKey, () =>
    toEncryptionError("Failed to encrypt Tinybird token"),
  )

const decryptToken = (
  encrypted: EncryptedValue,
  encryptionKey: Buffer,
): Effect.Effect<string, OrgTinybirdSettingsEncryptionError> =>
  decryptAes256Gcm(encrypted, encryptionKey, () =>
    toEncryptionError("Failed to decrypt Tinybird token"),
  )

const normalizeHost = (
  raw: string,
): Effect.Effect<string, OrgTinybirdSettingsValidationError> =>
  Effect.sync(() => raw.trim()).pipe(
    Effect.flatMap((trimmed) =>
      Effect.try({
        try: () => {
          if (trimmed.length === 0) {
            throw new Error("Tinybird host is required")
          }

          const url = new URL(trimmed)
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Tinybird host must use http or https")
          }

          return trimmed.replace(/\/+$/, "")
        },
        catch: (error) =>
          new OrgTinybirdSettingsValidationError({
            message: error instanceof Error ? error.message : "Invalid Tinybird host",
          }),
      }),
    ),
  )

const normalizeToken = (
  raw: string,
): Effect.Effect<string, OrgTinybirdSettingsValidationError> =>
  Effect.sync(() => raw.trim()).pipe(
    Effect.flatMap((trimmed) =>
      trimmed.length > 0
        ? Effect.succeed(trimmed)
        : Effect.fail(
            new OrgTinybirdSettingsValidationError({
              message: "Tinybird token is required",
            }),
          ),
    ),
  )

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
  roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const isTerminalRun = (runStatus: string): runStatus is Extract<OrgTinybirdSyncRunStatus, "failed" | "succeeded"> =>
  TERMINAL_RUN_STATUSES.has(runStatus)

const isIsoDateTime = (value: number | null | undefined) =>
  value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

const inferPhaseFromDeploymentStatus = (
  status: string | null | undefined,
): OrgTinybirdSyncPhase => {
  if (!status) return "starting"
  if (status === "live") return "succeeded"
  if (status === "data_ready") return "setting_live"
  if (status === "failed" || status === "error" || status === "deleting" || status === "deleted") {
    return "failed"
  }
  return "deploying"
}

const mapTinybirdError = (error: unknown) => {
  if (error instanceof TinybirdSyncRejectedError) {
    return new OrgTinybirdSettingsUpstreamRejectedError({
      message: error.message,
      statusCode: error.statusCode,
    })
  }

  return new OrgTinybirdSettingsUpstreamUnavailableError({
    message: error instanceof Error ? error.message : "Tinybird request failed",
    statusCode: error instanceof TinybirdSyncUnavailableError ? error.statusCode : null,
  })
}

export class OrgTinybirdSettingsService extends ServiceMap.Service<OrgTinybirdSettingsService, OrgTinybirdSettingsServiceShape>()(
  "OrgTinybirdSettingsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const env = yield* Env
      const encryptionKey = yield* parseEncryptionKey(
        Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      )
      const kickoffSemaphore = yield* Semaphore.make(1)

      const requireAdmin = Effect.fn("OrgTinybirdSettingsService.requireAdmin")(function* (
        roles: ReadonlyArray<RoleName>,
      ) {
        if (isOrgAdmin(roles)) return

        return yield* Effect.fail(
          new OrgTinybirdSettingsForbiddenError({
            message: "Only org admins can manage Tinybird settings",
          }),
        )
      })

      const selectActiveRow = Effect.fn("OrgTinybirdSettingsService.selectActiveRow")(function* (orgId: OrgId) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(orgTinybirdSettings)
            .where(eq(orgTinybirdSettings.orgId, orgId))
            .limit(1),
        ).pipe(Effect.mapError(toPersistenceError))

        return Option.fromNullishOr(rows[0])
      })

      const selectSyncRunRow = Effect.fn("OrgTinybirdSettingsService.selectSyncRunRow")(function* (orgId: OrgId) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(orgTinybirdSyncRuns)
            .where(eq(orgTinybirdSyncRuns.orgId, orgId))
            .limit(1),
        ).pipe(Effect.mapError(toPersistenceError))

        return Option.fromNullishOr(rows[0])
      })

      const requireActiveRow = Effect.fn("OrgTinybirdSettingsService.requireActiveRow")(function* (orgId: OrgId) {
        const row = yield* selectActiveRow(orgId)
        if (Option.isSome(row)) return row.value

        return yield* Effect.fail(
          new OrgTinybirdSettingsValidationError({
            message: "BYO Tinybird is not configured for this org",
          }),
        )
      })

      const updateSyncRun = Effect.fn("OrgTinybirdSettingsService.updateSyncRun")(function* (
        orgId: OrgId,
        patch: SyncRunUpdate,
      ) {
        if (Object.keys(patch).length === 0) return

        yield* database.execute((db) =>
          db
            .update(orgTinybirdSyncRuns)
            .set({
              ...patch,
              updatedAt: patch.updatedAt ?? Date.now(),
            })
            .where(eq(orgTinybirdSyncRuns.orgId, orgId)),
        ).pipe(Effect.mapError(toPersistenceError))
      })

      const upsertSyncRun = Effect.fn("OrgTinybirdSettingsService.upsertSyncRun")(function* (
        row: typeof orgTinybirdSyncRuns.$inferInsert,
      ) {
        yield* database.execute((db) =>
          db
            .insert(orgTinybirdSyncRuns)
            .values(row)
            .onConflictDoUpdate({
              target: orgTinybirdSyncRuns.orgId,
              set: {
                requestedBy: row.requestedBy,
                targetHost: row.targetHost,
                targetTokenCiphertext: row.targetTokenCiphertext,
                targetTokenIv: row.targetTokenIv,
                targetTokenTag: row.targetTokenTag,
                targetProjectRevision: row.targetProjectRevision,
                runStatus: row.runStatus,
                phase: row.phase,
                deploymentId: row.deploymentId,
                deploymentStatus: row.deploymentStatus,
                errorMessage: row.errorMessage,
                startedAt: row.startedAt,
                updatedAt: row.updatedAt,
                finishedAt: row.finishedAt,
              },
            }),
        ).pipe(Effect.mapError(toPersistenceError))
      })

      const deleteSyncRun = Effect.fn("OrgTinybirdSettingsService.deleteSyncRun")(function* (orgId: OrgId) {
        yield* database.execute((db) =>
          db
            .delete(orgTinybirdSyncRuns)
            .where(eq(orgTinybirdSyncRuns.orgId, orgId)),
        ).pipe(Effect.mapError(toPersistenceError))
      })

      const getCurrentProjectRevision = Effect.fn("OrgTinybirdSettingsService.getCurrentProjectRevision")(function* () {
        return yield* Effect.tryPromise({
          try: () => getProjectRevisionImpl(),
          catch: (error) => mapTinybirdError(error),
        })
      })

      const toCurrentRun = (
        row: SyncRunRow | null | undefined,
      ): OrgTinybirdCurrentRunResponse | null => {
        if (row == null) return null

        return new OrgTinybirdCurrentRunResponse({
          targetHost: row.targetHost,
          targetProjectRevision: row.targetProjectRevision,
          runStatus: decodeRunStatus(row.runStatus),
          phase: decodePhase(row.phase),
          deploymentId: row.deploymentId ?? null,
          deploymentStatus: row.deploymentStatus ?? null,
          errorMessage: row.errorMessage ?? null,
          startedAt: decodeIsoDateTimeStringSync(new Date(row.startedAt).toISOString()),
          updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
          finishedAt: isIsoDateTime(row.finishedAt),
          isTerminal: isTerminalRun(row.runStatus),
        })
      }

      const resolveSyncStatus = (
        activeRow: ActiveRow | null | undefined,
        currentRevision: string | null,
        syncRun: SyncRunRow | null | undefined,
      ) => {
        if (syncRun && NON_TERMINAL_RUN_STATUSES.has(syncRun.runStatus)) {
          return "syncing" as const
        }
        if (syncRun?.runStatus === "failed") return "error" as const
        if (activeRow == null) return null
        if (currentRevision !== null && activeRow.projectRevision !== currentRevision) {
          return "out_of_sync" as const
        }
        return "active" as const
      }

      const toResponse = (
        activeRow: ActiveRow | null | undefined,
        currentRevision: string | null,
        syncRun: SyncRunRow | null | undefined,
      ): OrgTinybirdSettingsResponse => {
        const currentRun = toCurrentRun(syncRun)

        return new OrgTinybirdSettingsResponse({
          configured: activeRow != null,
          activeHost: activeRow?.host ?? null,
          draftHost: syncRun?.targetHost ?? null,
          syncStatus: resolveSyncStatus(activeRow, currentRevision, syncRun),
          lastSyncAt: isIsoDateTime(syncRun?.finishedAt ?? syncRun?.updatedAt ?? activeRow?.lastSyncAt ?? null),
          lastSyncError: syncRun?.runStatus === "failed" ? syncRun.errorMessage ?? null : null,
          projectRevision: activeRow?.projectRevision ?? syncRun?.targetProjectRevision ?? null,
          currentRun,
        })
      }

      const toDeploymentStatusResponse = (
        activeRow: ActiveRow | null | undefined,
        syncRun: SyncRunRow | null | undefined,
      ): OrgTinybirdDeploymentStatusResponse => {
        const deploymentId = syncRun?.deploymentId ?? activeRow?.lastDeploymentId ?? null
        const hasRun = syncRun != null || deploymentId != null
        const deploymentStatus = syncRun?.deploymentStatus ?? (deploymentId ? "live" : null)
        const runStatus = syncRun?.runStatus == null
          ? deploymentId
            ? "succeeded"
            : null
          : decodeRunStatus(syncRun.runStatus)
        const phase = syncRun?.phase == null
          ? deploymentStatus == null
            ? null
            : inferPhaseFromDeploymentStatus(deploymentStatus)
          : decodePhase(syncRun.phase)
        const syncedAt = activeRow?.lastSyncAt ?? null

        return new OrgTinybirdDeploymentStatusResponse({
          hasRun,
          hasDeployment: deploymentId != null,
          deploymentId,
          status: deploymentStatus,
          deploymentStatus,
          runStatus,
          phase,
          isTerminal: runStatus == null ? null : isTerminalRun(runStatus),
          errorMessage: syncRun?.errorMessage ?? null,
          startedAt: isIsoDateTime(syncRun?.startedAt ?? syncedAt),
          updatedAt: isIsoDateTime(syncRun?.updatedAt ?? syncedAt),
          finishedAt: isIsoDateTime(syncRun?.finishedAt ?? syncedAt),
        })
      }

      const markRunFailed = Effect.fn("OrgTinybirdSettingsService.markRunFailed")(function* (
        orgId: OrgId,
        error: unknown,
      ) {
        const message = error instanceof Error ? error.message : "Tinybird sync failed"
        yield* updateSyncRun(orgId, {
          runStatus: "failed",
          phase: "failed",
          errorMessage: message,
          finishedAt: Date.now(),
        })
      })

      const promoteActiveConfig = Effect.fn("OrgTinybirdSettingsService.promoteActiveConfig")(function* (
        orgId: OrgId,
        requestedBy: UserId,
        host: string,
        token: string,
        projectRevision: string,
        deploymentId: string | null,
      ) {
        const existing = yield* selectActiveRow(orgId)
        const encryptedToken = yield* encryptToken(token, encryptionKey)
        const now = Date.now()

        yield* database.execute((db) =>
          db
            .insert(orgTinybirdSettings)
            .values({
              orgId,
              host,
              tokenCiphertext: encryptedToken.ciphertext,
              tokenIv: encryptedToken.iv,
              tokenTag: encryptedToken.tag,
              syncStatus: "active",
              lastSyncAt: now,
              lastSyncError: null,
              projectRevision,
              lastDeploymentId: deploymentId,
              createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
              updatedAt: now,
              createdBy: Option.isSome(existing) ? existing.value.createdBy : requestedBy,
              updatedBy: requestedBy,
            })
            .onConflictDoUpdate({
              target: orgTinybirdSettings.orgId,
              set: {
                host,
                tokenCiphertext: encryptedToken.ciphertext,
                tokenIv: encryptedToken.iv,
                tokenTag: encryptedToken.tag,
                syncStatus: "active",
                lastSyncAt: now,
                lastSyncError: null,
                projectRevision,
                lastDeploymentId: deploymentId,
                updatedAt: now,
                updatedBy: requestedBy,
              },
            }),
        ).pipe(Effect.mapError(toPersistenceError))
      })

      const waitForDeploymentReady = Effect.fn("OrgTinybirdSettingsService.waitForDeploymentReady")(function* (
        orgId: OrgId,
        host: string,
        token: string,
        deploymentId: string,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* Effect.annotateCurrentSpan("deploymentId", deploymentId)
        for (let attempt = 0; attempt < MAX_DEPLOYMENT_POLL_ATTEMPTS; attempt += 1) {
          if (attempt > 0) {
            yield* Effect.sleep(POLL_INTERVAL)
          }

          const status = yield* Effect.tryPromise({
            try: () =>
              getDeploymentTransportStatusImpl({
                baseUrl: host,
                token,
                deploymentId,
              }),
            catch: (error) => mapTinybirdError(error),
          })

          yield* updateSyncRun(orgId, {
            deploymentStatus: status.status,
            phase: inferPhaseFromDeploymentStatus(status.status),
            errorMessage: status.errorMessage,
          })

          if (status.status === "data_ready" || status.status === "live") {
            return status
          }

          if (status.isTerminal) {
            return yield* Effect.fail(
              new OrgTinybirdSettingsUpstreamRejectedError({
                message: status.errorMessage
                  ? `Tinybird deployment ${status.status}: ${status.errorMessage}`
                  : `Tinybird deployment ${status.status} before reaching data_ready`,
                statusCode: null,
              }),
            )
          }
        }

        return yield* Effect.fail(
          new OrgTinybirdSettingsUpstreamUnavailableError({
            message: "Tinybird deployment timed out before reaching data_ready",
            statusCode: null,
          }),
        )
      })

      const performSyncRun = Effect.fn("OrgTinybirdSettingsService.performSyncRun")(function* (
        run: SyncRunRow,
        token: string,
      ) {
        const runOrgId = decodeOrgId(run.orgId)
        const runUserId = decodeUserId(run.requestedBy)
        yield* Effect.annotateCurrentSpan("orgId", runOrgId)
        let deploymentId = run.deploymentId ?? undefined

        if (!deploymentId) {
          yield* updateSyncRun(runOrgId, {
            runStatus: "running",
            phase: "starting",
            deploymentId: null,
            deploymentStatus: null,
            errorMessage: null,
            finishedAt: null,
          })

          const started = yield* Effect.tryPromise({
            try: () =>
              startDeploymentImpl({
                baseUrl: run.targetHost,
                token,
              }),
            catch: (error) => mapTinybirdError(error),
          })

          if (started.result === "no_changes") {
            yield* promoteActiveConfig(
              runOrgId,
              runUserId,
              run.targetHost,
              token,
              started.projectRevision,
              started.deploymentId ?? null,
            )

            yield* updateSyncRun(runOrgId, {
              runStatus: "succeeded",
              phase: "succeeded",
              deploymentId: started.deploymentId ?? null,
              deploymentStatus: started.deploymentStatus ?? "live",
              errorMessage: null,
              finishedAt: Date.now(),
            })
            return
          }

          deploymentId = started.deploymentId
          if (!deploymentId) {
            return yield* Effect.fail(
              new OrgTinybirdSettingsUpstreamUnavailableError({
                message: "Tinybird project sync did not return a deployment id",
                statusCode: null,
              }),
            )
          }

          yield* updateSyncRun(runOrgId, {
            runStatus: "running",
            phase: inferPhaseFromDeploymentStatus(started.deploymentStatus ?? "deploying"),
            deploymentId,
            deploymentStatus: started.deploymentStatus ?? "deploying",
            errorMessage: started.errorMessage,
          })
        }

        const initialStatus = yield* Effect.tryPromise({
          try: () =>
            getDeploymentTransportStatusImpl({
              baseUrl: run.targetHost,
              token,
              deploymentId,
            }),
          catch: (error) => mapTinybirdError(error),
        })

        yield* updateSyncRun(runOrgId, {
          phase: inferPhaseFromDeploymentStatus(initialStatus.status),
          deploymentStatus: initialStatus.status,
          errorMessage: initialStatus.errorMessage,
        })

        if (initialStatus.isTerminal && initialStatus.status !== "data_ready" && initialStatus.status !== "live") {
          return yield* Effect.fail(
            new OrgTinybirdSettingsUpstreamRejectedError({
              message: initialStatus.errorMessage
                ? `Tinybird deployment ${initialStatus.status}: ${initialStatus.errorMessage}`
                : `Tinybird deployment ${initialStatus.status} before reaching data_ready`,
              statusCode: null,
            }),
          )
        }

        const readyStatus = initialStatus.status === "data_ready" || initialStatus.status === "live"
          ? initialStatus
          : yield* waitForDeploymentReady(runOrgId, run.targetHost, token, deploymentId)

        if (readyStatus.status !== "live") {
          yield* updateSyncRun(runOrgId, {
            runStatus: "running",
            phase: "setting_live",
            deploymentStatus: readyStatus.status,
            errorMessage: null,
          })

          yield* Effect.tryPromise({
            try: () =>
              setDeploymentLiveImpl({
                baseUrl: run.targetHost,
                token,
                deploymentId,
              }),
            catch: (error) => mapTinybirdError(error),
          })
        }

        yield* promoteActiveConfig(
          runOrgId,
          runUserId,
          run.targetHost,
          token,
          run.targetProjectRevision,
          deploymentId,
        )

        yield* updateSyncRun(runOrgId, {
          runStatus: "succeeded",
          phase: "succeeded",
          deploymentId,
          deploymentStatus: "live",
          errorMessage: null,
          finishedAt: Date.now(),
        })
      })

      const resumeSyncRun = Effect.fn("OrgTinybirdSettingsService.resumeSyncRun")(function* (orgId: OrgId) {
        const syncRun = yield* selectSyncRunRow(orgId)
        if (Option.isNone(syncRun)) return
        if (!NON_TERMINAL_RUN_STATUSES.has(syncRun.value.runStatus)) return

        const token = yield* decryptToken(
          {
            ciphertext: syncRun.value.targetTokenCiphertext,
            iv: syncRun.value.targetTokenIv,
            tag: syncRun.value.targetTokenTag,
          },
          encryptionKey,
        )

        yield* performSyncRun(syncRun.value, token).pipe(
          Effect.tapError((error) => markRunFailed(orgId, error)),
          Effect.result,
        )
      })

      const reconcileSyncRunWithTinybird = Effect.fn("OrgTinybirdSettingsService.reconcileSyncRunWithTinybird")(function* (
        syncRun: SyncRunRow | null | undefined,
        options?: { readonly swallowUnavailable?: boolean },
      ) {
        if (syncRun == null) return null
        if (!NON_TERMINAL_RUN_STATUSES.has(syncRun.runStatus)) {
          return syncRun
        }

        const orgId = decodeOrgId(syncRun.orgId)
        yield* Effect.annotateCurrentSpan("orgId", orgId)

        if (!syncRun.deploymentId) {
          if (Date.now() - syncRun.startedAt >= SYNC_RUN_TIMEOUT_MS) {
            yield* markRunFailed(
              orgId,
              new OrgTinybirdSettingsUpstreamUnavailableError({
                message: "Tinybird sync timed out before a deployment id was created",
                statusCode: null,
              }),
            )

            const timedOut = yield* selectSyncRunRow(orgId)
            return Option.getOrUndefined(timedOut) ?? syncRun
          }

          yield* resumeSyncRun(orgId).pipe(
            Effect.forkDetach,
            Effect.ignore,
          )

          const refreshed = yield* selectSyncRunRow(orgId)
          return Option.getOrUndefined(refreshed) ?? syncRun
        }

        const syncRunDeploymentId = syncRun.deploymentId

        const token = yield* decryptToken(
          {
            ciphertext: syncRun.targetTokenCiphertext,
            iv: syncRun.targetTokenIv,
            tag: syncRun.targetTokenTag,
          },
          encryptionKey,
        )

        const status = yield* Effect.tryPromise({
          try: () =>
            getDeploymentTransportStatusImpl({
              baseUrl: syncRun.targetHost,
              token,
              deploymentId: syncRunDeploymentId,
            }),
          catch: (error) => mapTinybirdError(error),
        }).pipe(
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsUpstreamRejectedError", (error) =>
            markRunFailed(orgId, error).pipe(
              Effect.as({
                deploymentId: syncRunDeploymentId,
                status: "failed",
                isTerminal: true,
                errorMessage: error.message,
              }),
            )),
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsUpstreamUnavailableError", (error) =>
            options?.swallowUnavailable === true
              ? Effect.succeed(null)
              : Effect.fail(error)),
        )

        if (status == null) {
          const refreshed = yield* selectSyncRunRow(orgId)
          return Option.getOrUndefined(refreshed) ?? syncRun
        }

        if (status.status === "live") {
          yield* promoteActiveConfig(
            orgId,
            decodeUserId(syncRun.requestedBy),
            syncRun.targetHost,
            token,
            syncRun.targetProjectRevision,
            syncRun.deploymentId,
          )

          yield* updateSyncRun(orgId, {
            runStatus: "succeeded",
            phase: "succeeded",
            deploymentStatus: status.status,
            errorMessage: null,
            finishedAt: Date.now(),
          })
        } else if (status.status === "data_ready") {
          yield* updateSyncRun(orgId, {
            runStatus: "running",
            phase: "setting_live",
            deploymentStatus: status.status,
            errorMessage: status.errorMessage,
          })

          yield* resumeSyncRun(orgId).pipe(
            Effect.forkDetach,
            Effect.ignore,
          )
        } else if (status.isTerminal) {
          yield* markRunFailed(
            orgId,
            new OrgTinybirdSettingsUpstreamRejectedError({
              message: status.errorMessage
                ? `Tinybird deployment ${status.status}: ${status.errorMessage}`
                : `Tinybird deployment ${status.status} before reaching data_ready`,
              statusCode: null,
            }),
          )
        } else {
          yield* updateSyncRun(orgId, {
            runStatus: "running",
            phase: inferPhaseFromDeploymentStatus(status.status),
            deploymentStatus: status.status,
            errorMessage: status.errorMessage,
          })
        }

        const refreshed = yield* selectSyncRunRow(orgId)
        return Option.getOrUndefined(refreshed) ?? syncRun
      })

      const kickoffSyncRun = Effect.fn("OrgTinybirdSettingsService.kickoffSyncRun")(function* (
        orgId: OrgId,
        userId: UserId,
        host: string,
        token: string,
        currentRevision: string,
      ) {
        return yield* kickoffSemaphore.withPermit(
          Effect.gen(function* () {
            const existingRun = yield* selectSyncRunRow(orgId)

            if (
              Option.isSome(existingRun)
              && NON_TERMINAL_RUN_STATUSES.has(existingRun.value.runStatus)
            ) {
              return yield* Effect.fail(
                new OrgTinybirdSettingsSyncConflictError({
                  message: "A Tinybird sync is already in progress for this org",
                }),
              )
            }

            if (Option.isSome(existingRun) && existingRun.value.deploymentId) {
              const existingDeploymentId = existingRun.value.deploymentId
              const cleanupToken = yield* decryptToken(
                {
                  ciphertext: existingRun.value.targetTokenCiphertext,
                  iv: existingRun.value.targetTokenIv,
                  tag: existingRun.value.targetTokenTag,
                },
                encryptionKey,
              )

              yield* Effect.tryPromise({
                try: () =>
                  cleanupOwnedDeploymentImpl({
                    baseUrl: existingRun.value.targetHost,
                    token: cleanupToken,
                    deploymentId: existingDeploymentId,
                  }),
                catch: (error) => error,
              }).pipe(
                Effect.tapError(() => Effect.logWarning("Failed to cleanup previous Tinybird deployment")),
                Effect.ignore,
              )
            }

            const encrypted = yield* encryptToken(token, encryptionKey)
            const now = Date.now()

            yield* upsertSyncRun({
              orgId,
              requestedBy: userId,
              targetHost: host,
              targetTokenCiphertext: encrypted.ciphertext,
              targetTokenIv: encrypted.iv,
              targetTokenTag: encrypted.tag,
              targetProjectRevision: currentRevision,
              runStatus: "queued",
              phase: "starting",
              deploymentId: null,
              deploymentStatus: null,
              errorMessage: null,
              startedAt: now,
              updatedAt: now,
              finishedAt: null,
            })

            yield* resumeSyncRun(orgId).pipe(Effect.forkDetach)
          }),
        )
      })

      const resolveInputToken = Effect.fn("OrgTinybirdSettingsService.resolveInputToken")(function* (
        rawToken: string,
        activeRow: Option.Option<ActiveRow>,
        syncRun: Option.Option<SyncRunRow>,
      ) {
        if (rawToken.trim().length > 0) {
          return yield* normalizeToken(rawToken)
        }

        if (Option.isSome(syncRun)) {
          return yield* decryptToken(
            {
              ciphertext: syncRun.value.targetTokenCiphertext,
              iv: syncRun.value.targetTokenIv,
              tag: syncRun.value.targetTokenTag,
            },
            encryptionKey,
          )
        }

        if (Option.isSome(activeRow)) {
          return yield* decryptToken(
            {
              ciphertext: activeRow.value.tokenCiphertext,
              iv: activeRow.value.tokenIv,
              tag: activeRow.value.tokenTag,
            },
            encryptionKey,
          )
        }

        return yield* normalizeToken(rawToken)
      })

      const get = Effect.fn("OrgTinybirdSettingsService.get")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* requireAdmin(roles)
        const activeRow = yield* selectActiveRow(orgId)
        const storedSyncRun = yield* selectSyncRunRow(orgId)
        const syncRun = yield* reconcileSyncRunWithTinybird(
          Option.getOrUndefined(storedSyncRun),
          { swallowUnavailable: true },
        ).pipe(
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsEncryptionError", () =>
            Effect.succeed(Option.getOrUndefined(storedSyncRun))),
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsUpstreamUnavailableError", () =>
            Effect.succeed(Option.getOrUndefined(storedSyncRun))),
        )
        const currentRevision = yield* getCurrentProjectRevision().pipe(
          Effect.map((revision) => revision as string | null),
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsUpstreamUnavailableError", () => Effect.succeed(null)),
          Effect.catchTag("@maple/http/errors/OrgTinybirdSettingsUpstreamRejectedError", () => Effect.succeed(null)),
        )

        const refreshedActiveRow = yield* selectActiveRow(orgId)
        return toResponse(Option.getOrUndefined(refreshedActiveRow), currentRevision, syncRun)
      })

      const upsert = Effect.fn("OrgTinybirdSettingsService.upsert")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        payload: OrgTinybirdSettingsUpsertRequest,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* Effect.annotateCurrentSpan("userId", userId)
        yield* requireAdmin(roles)
        const host = yield* normalizeHost(payload.host)
        const activeRow = yield* selectActiveRow(orgId)
        const syncRun = yield* selectSyncRunRow(orgId)
        const token = yield* resolveInputToken(payload.token, activeRow, syncRun)
        const currentRevision = yield* getCurrentProjectRevision()

        yield* kickoffSyncRun(orgId, userId, host, token, currentRevision)

        const nextActiveRow = yield* selectActiveRow(orgId)
        const nextSyncRun = yield* selectSyncRunRow(orgId)
        return toResponse(
          Option.getOrUndefined(nextActiveRow),
          currentRevision,
          Option.getOrUndefined(nextSyncRun),
        )
      })

      const deleteSettings = Effect.fn("OrgTinybirdSettingsService.delete")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* requireAdmin(roles)

        yield* database.execute((db) =>
          db
            .delete(orgTinybirdSettings)
            .where(eq(orgTinybirdSettings.orgId, orgId)),
        ).pipe(Effect.mapError(toPersistenceError))

        yield* deleteSyncRun(orgId)

        return new OrgTinybirdSettingsDeleteResponse({
          configured: false,
        })
      })

      const resync = Effect.fn("OrgTinybirdSettingsService.resync")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* Effect.annotateCurrentSpan("userId", userId)
        yield* requireAdmin(roles)
        const activeRow = yield* requireActiveRow(orgId)
        const token = yield* decryptToken(
          {
            ciphertext: activeRow.tokenCiphertext,
            iv: activeRow.tokenIv,
            tag: activeRow.tokenTag,
          },
          encryptionKey,
        )
        const currentRevision = yield* getCurrentProjectRevision()

        yield* kickoffSyncRun(orgId, userId, activeRow.host, token, currentRevision)

        const nextSyncRun = yield* selectSyncRunRow(orgId)
        return toResponse(activeRow, currentRevision, Option.getOrUndefined(nextSyncRun))
      })

      const resolveRuntimeConfig = Effect.fn("OrgTinybirdSettingsService.resolveRuntimeConfig")(function* (
        orgId: OrgId,
      ) {
        const row = yield* selectActiveRow(orgId)
        if (Option.isNone(row)) {
          return Option.none<RuntimeTinybirdConfig>()
        }

        const token = yield* decryptToken(
          {
            ciphertext: row.value.tokenCiphertext,
            iv: row.value.tokenIv,
            tag: row.value.tokenTag,
          },
          encryptionKey,
        )

        return Option.some({
          host: row.value.host,
          token,
          projectRevision: row.value.projectRevision,
        })
      })

      const getDeploymentStatus = Effect.fn("OrgTinybirdSettingsService.getDeploymentStatus")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* requireAdmin(roles)
        const syncRun = yield* selectSyncRunRow(orgId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.flatMap((row) => reconcileSyncRunWithTinybird(row)),
        )
        const refreshedActiveRow = yield* selectActiveRow(orgId)
        return toDeploymentStatusResponse(
          Option.getOrUndefined(refreshedActiveRow),
          syncRun,
        )
      })

      const getInstanceHealth = Effect.fn("OrgTinybirdSettingsService.getInstanceHealth")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* requireAdmin(roles)
        const row = yield* requireActiveRow(orgId)
        const token = yield* decryptToken(
          { ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
          encryptionKey,
        )

        const result = yield* Effect.tryPromise({
          try: () =>
            fetchInstanceHealthImpl({
              baseUrl: row.host,
              token,
            }),
          catch: (error) => mapTinybirdError(error),
        })

        return new OrgTinybirdInstanceHealthResponse({
          workspaceName: result.workspaceName,
          datasources: result.datasources.map((d) => ({
            name: d.name,
            rowCount: d.rowCount,
            bytes: d.bytes,
          })),
          totalRows: result.totalRows,
          totalBytes: result.totalBytes,
          recentErrorCount: result.recentErrorCount,
          avgQueryLatencyMs: result.avgQueryLatencyMs,
        })
      })

      const resumePendingRuns = Effect.fn("OrgTinybirdSettingsService.resumePendingRuns")(function* () {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(orgTinybirdSyncRuns),
        ).pipe(Effect.mapError(toPersistenceError))

        yield* Effect.forEach(
          rows.filter((row) => NON_TERMINAL_RUN_STATUSES.has(row.runStatus)),
          (row) => resumeSyncRun(decodeOrgId(row.orgId)).pipe(Effect.forkDetach),
          { discard: true },
        )
      })

      yield* resumePendingRuns().pipe(Effect.forkDetach)

      return {
        get,
        upsert,
        delete: deleteSettings,
        resync,
        getDeploymentStatus,
        getInstanceHealth,
        resolveRuntimeConfig,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer

  static readonly get = (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => this.use((service) => service.get(orgId, roles))

  static readonly upsert = (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    payload: OrgTinybirdSettingsUpsertRequest,
  ) => this.use((service) => service.upsert(orgId, userId, roles, payload))

  static readonly delete = (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
  ) => this.use((service) => service.delete(orgId, roles))

  static readonly resync = (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
  ) => this.use((service) => service.resync(orgId, userId, roles))

  static readonly resolveRuntimeConfig = (orgId: OrgId) =>
    this.use((service) => service.resolveRuntimeConfig(orgId))
}

export const __testables = {
  setStartDeploymentImpl: (impl: typeof startTinybirdDeployment) => {
    startDeploymentImpl = impl
  },
  setGetDeploymentTransportStatusImpl: (impl: typeof getDeploymentStatusFn) => {
    getDeploymentTransportStatusImpl = impl
  },
  setResumeDeploymentImpl: (impl: typeof resumeTinybirdDeploymentFn) => {
    resumeDeploymentImpl = impl
  },
  setSetDeploymentLiveImpl: (impl: typeof setTinybirdDeploymentLiveFn) => {
    setDeploymentLiveImpl = impl
  },
  setCleanupOwnedDeploymentImpl: (impl: typeof cleanupOwnedTinybirdDeployment) => {
    cleanupOwnedDeploymentImpl = impl
  },
  setGetProjectRevisionImpl: (impl: typeof getCurrentTinybirdProjectRevision) => {
    getProjectRevisionImpl = impl
  },
  setFetchInstanceHealthImpl: (impl: typeof fetchInstanceHealthFn) => {
    fetchInstanceHealthImpl = impl
  },
  reset: () => {
    startDeploymentImpl = startTinybirdDeployment
    getDeploymentTransportStatusImpl = getDeploymentStatusFn
    resumeDeploymentImpl = resumeTinybirdDeploymentFn
    setDeploymentLiveImpl = setTinybirdDeploymentLiveFn
    cleanupOwnedDeploymentImpl = cleanupOwnedTinybirdDeployment
    getProjectRevisionImpl = getCurrentTinybirdProjectRevision
    fetchInstanceHealthImpl = fetchInstanceHealthFn
  },
}
