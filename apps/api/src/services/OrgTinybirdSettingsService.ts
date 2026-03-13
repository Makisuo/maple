import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import {
  IsoDateTimeString,
  OrgTinybirdSettingsEncryptionError,
  OrgTinybirdSettingsForbiddenError,
  OrgTinybirdSettingsPersistenceError,
  OrgTinybirdSettingsResponse,
  OrgTinybirdSettingsSyncError,
  OrgTinybirdSettingsValidationError,
  type OrgTinybirdSettingsUpsertRequest,
  OrgId,
  type RoleName,
  UserId,
} from "@maple/domain/http"
import { getCurrentTinybirdProjectRevision, syncTinybirdProject } from "@maple/domain/tinybird-project-sync"
import { orgTinybirdSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
  type EncryptedValue,
} from "./Crypto"
import { DatabaseLive } from "./DatabaseLive"
import { Env } from "./Env"

interface RuntimeTinybirdConfig {
  readonly host: string
  readonly token: string
  readonly projectRevision: string
}

const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
let syncProjectImpl = syncTinybirdProject
let getProjectRevisionImpl = getCurrentTinybirdProjectRevision

const toPersistenceError = (error: unknown) =>
  new OrgTinybirdSettingsPersistenceError({
    message:
      error instanceof Error ? error.message : "Org Tinybird settings persistence failed",
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
  Effect.try({
    try: () => {
      const trimmed = raw.trim()
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
  })

const normalizeToken = (
  raw: string,
): Effect.Effect<string, OrgTinybirdSettingsValidationError> => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return Effect.fail(new OrgTinybirdSettingsValidationError({ message: "Tinybird token is required" }))
  }

  return Effect.succeed(trimmed)
}

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
  roles.includes("root" as RoleName) || roles.includes("org:admin" as RoleName)

const OUT_OF_SYNC_MESSAGE = "BYO Tinybird project is out of sync with Maple. Please resync the project in settings."

export class OrgTinybirdSettingsService extends Effect.Service<OrgTinybirdSettingsService>()(
  "OrgTinybirdSettingsService",
  {
    accessors: true,
    dependencies: [Env.Default],
    effect: Effect.gen(function* () {
      const db = yield* SqliteDrizzle
      const env = yield* Env
      const encryptionKey = yield* parseEncryptionKey(
        Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      )

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

      const selectRow = Effect.fn("OrgTinybirdSettingsService.selectRow")(function* (orgId: OrgId) {
        const rows = yield* db
          .select()
          .from(orgTinybirdSettings)
          .where(eq(orgTinybirdSettings.orgId, orgId))
          .limit(1)
          .pipe(Effect.mapError(toPersistenceError))

        return Option.fromNullable(rows[0])
      })

      const requireRow = Effect.fn("OrgTinybirdSettingsService.requireRow")(function* (orgId: OrgId) {
        const row = yield* selectRow(orgId)
        if (Option.isSome(row)) return row.value

        return yield* Effect.fail(
          new OrgTinybirdSettingsValidationError({
            message: "BYO Tinybird is not configured for this org",
          }),
        )
      })

      const getCurrentProjectRevision = Effect.fn("OrgTinybirdSettingsService.getCurrentProjectRevision")(function* () {
        return yield* Effect.tryPromise({
          try: () => getProjectRevisionImpl(),
          catch: (error) =>
            new OrgTinybirdSettingsSyncError({
              message: error instanceof Error ? error.message : "Failed to load Tinybird project revision",
            }),
        })
      })

      const resolveSyncStatus = (
        row: typeof orgTinybirdSettings.$inferSelect | null | undefined,
        currentRevision: string | null,
      ) => {
        if (row == null) return null
        if (row.syncStatus === "error") return "error" as const
        if (row.syncStatus === "active" && currentRevision !== null && row.projectRevision !== currentRevision) {
          return "out_of_sync" as const
        }
        if (row.syncStatus === "active") return "active" as const
        return null
      }

      const toResponse = (
        row: typeof orgTinybirdSettings.$inferSelect | null | undefined,
        currentRevision: string | null,
      ): OrgTinybirdSettingsResponse =>
        new OrgTinybirdSettingsResponse({
          configured: row != null,
          host: row?.host ?? null,
          syncStatus: resolveSyncStatus(row, currentRevision),
          lastSyncAt:
            row?.lastSyncAt == null
              ? null
              : decodeIsoDateTimeStringSync(new Date(row.lastSyncAt).toISOString()),
          lastSyncError: row?.lastSyncError ?? null,
          projectRevision: row?.projectRevision ?? null,
        })

      const syncCandidate = Effect.fn("OrgTinybirdSettingsService.syncCandidate")(function* (
        host: string,
        token: string,
      ) {
        return yield* Effect.tryPromise({
          try: () =>
            syncProjectImpl({
              baseUrl: host,
              token,
            }),
          catch: (error) =>
            new OrgTinybirdSettingsSyncError({
              message: error instanceof Error ? error.message : "Tinybird project sync failed",
            }),
        })
      })

      const get = Effect.fn("OrgTinybirdSettingsService.get")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* requireAdmin(roles)
        const row = yield* selectRow(orgId)
        const currentRevision = yield* getCurrentProjectRevision().pipe(
          Effect.map((revision) => revision as string | null),
          Effect.catchTag("OrgTinybirdSettingsSyncError", () => Effect.succeed(null)),
        )

        return toResponse(Option.getOrUndefined(row), currentRevision)
      })

      const upsert = Effect.fn("OrgTinybirdSettingsService.upsert")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        payload: OrgTinybirdSettingsUpsertRequest,
      ) {
        yield* requireAdmin(roles)
        const host = yield* normalizeHost(payload.host)
        const existing = yield* selectRow(orgId)
        const token = payload.token.trim().length > 0
          ? yield* normalizeToken(payload.token)
          : Option.isSome(existing)
            ? yield* decryptToken(
                {
                  ciphertext: existing.value.tokenCiphertext,
                  iv: existing.value.tokenIv,
                  tag: existing.value.tokenTag,
                },
                encryptionKey,
              )
            : yield* normalizeToken(payload.token)
        const syncResult = yield* syncCandidate(host, token)
        const encryptedToken = yield* encryptToken(token, encryptionKey)
        const now = Date.now()

        yield* db
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
            projectRevision: syncResult.projectRevision,
            createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
            updatedAt: now,
            createdBy: Option.isSome(existing) ? existing.value.createdBy : userId,
            updatedBy: userId,
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
              projectRevision: syncResult.projectRevision,
              updatedAt: now,
              updatedBy: userId,
            },
          })
          .pipe(Effect.mapError(toPersistenceError))

        const stored = yield* requireRow(orgId)
        return toResponse(stored, syncResult.projectRevision)
      })

      const deleteSettings = Effect.fn("OrgTinybirdSettingsService.delete")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* requireAdmin(roles)

        yield* db
          .delete(orgTinybirdSettings)
          .where(eq(orgTinybirdSettings.orgId, orgId))
          .pipe(Effect.mapError(toPersistenceError))

        return {
          configured: false as const,
        }
      })

      const resync = Effect.fn("OrgTinybirdSettingsService.resync")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
      ) {
        yield* requireAdmin(roles)
        const row = yield* requireRow(orgId)
        const token = yield* decryptToken(
          {
            ciphertext: row.tokenCiphertext,
            iv: row.tokenIv,
            tag: row.tokenTag,
          },
          encryptionKey,
        )
        const syncResult = yield* syncCandidate(row.host, token)
        const now = Date.now()

        yield* db
          .update(orgTinybirdSettings)
          .set({
            syncStatus: "active",
            lastSyncAt: now,
            lastSyncError: null,
            projectRevision: syncResult.projectRevision,
            updatedAt: now,
            updatedBy: userId,
          })
          .where(eq(orgTinybirdSettings.orgId, orgId))
          .pipe(Effect.mapError(toPersistenceError))

        const updated = yield* requireRow(orgId)
        return toResponse(updated, syncResult.projectRevision)
      })

      const resolveRuntimeConfig = Effect.fn("OrgTinybirdSettingsService.resolveRuntimeConfig")(function* (
        orgId: OrgId,
      ) {
        const row = yield* selectRow(orgId)
        if (Option.isNone(row)) {
          return Option.none<RuntimeTinybirdConfig>()
        }

        if (row.value.syncStatus !== "active") {
          return yield* Effect.fail(
            new OrgTinybirdSettingsSyncError({
              message: row.value.lastSyncError ?? "BYO Tinybird is configured but not healthy",
            }),
          )
        }

        const currentRevision = yield* getCurrentProjectRevision()
        if (row.value.projectRevision !== currentRevision) {
          return yield* Effect.fail(
            new OrgTinybirdSettingsSyncError({
              message: OUT_OF_SYNC_MESSAGE,
            }),
          )
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

      return {
        get,
        upsert,
        delete: deleteSettings,
        resync,
        resolveRuntimeConfig,
      }
    }),
  },
) {
  static readonly Live = this.Default.pipe(Layer.provide(DatabaseLive))
}

export const __testables = {
  setSyncProjectImpl: (impl: typeof syncTinybirdProject) => {
    syncProjectImpl = impl
  },
  setGetProjectRevisionImpl: (impl: typeof getCurrentTinybirdProjectRevision) => {
    getProjectRevisionImpl = impl
  },
  reset: () => {
    syncProjectImpl = syncTinybirdProject
    getProjectRevisionImpl = getCurrentTinybirdProjectRevision
  },
}
