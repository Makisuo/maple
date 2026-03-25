import { randomUUID } from "node:crypto"
import {
  IsoDateTimeString,
  OrgId,
  ScrapeAuthType,
  ScrapeIntervalSeconds,
  ScrapeTargetDeleteResponse,
  ScrapeTargetEncryptionError,
  ScrapeTargetId,
  ScrapeTargetNotFoundError,
  ScrapeTargetPersistenceError,
  ScrapeTargetProbeResponse,
  ScrapeTargetResponse,
  ScrapeTargetsListResponse,
  ScrapeTargetValidationError,
  type CreateScrapeTargetRequest,
  type UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import { scrapeTargets } from "@maple/db"
import { and, eq } from "drizzle-orm"
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  ServiceMap,
} from "effect"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
  type EncryptedValue,
} from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

type ScrapeTargetRow = typeof scrapeTargets.$inferSelect

export interface ScrapeTargetsServiceShape {
  readonly list: (
    orgId: OrgId,
  ) => Effect.Effect<ScrapeTargetsListResponse, ScrapeTargetPersistenceError>
  readonly create: (
    orgId: OrgId,
    request: CreateScrapeTargetRequest,
  ) => Effect.Effect<
    ScrapeTargetResponse,
    | ScrapeTargetValidationError
    | ScrapeTargetPersistenceError
    | ScrapeTargetEncryptionError
  >
  readonly update: (
    orgId: OrgId,
    targetId: ScrapeTargetId,
    request: UpdateScrapeTargetRequest,
  ) => Effect.Effect<
    ScrapeTargetResponse,
    | ScrapeTargetNotFoundError
    | ScrapeTargetValidationError
    | ScrapeTargetPersistenceError
    | ScrapeTargetEncryptionError
  >
  readonly delete: (
    orgId: OrgId,
    targetId: ScrapeTargetId,
  ) => Effect.Effect<
    ScrapeTargetDeleteResponse,
    ScrapeTargetNotFoundError | ScrapeTargetPersistenceError
  >
  readonly listAllEnabled: () => Effect.Effect<
    ReadonlyArray<ScrapeTargetRow>,
    ScrapeTargetPersistenceError
  >
  readonly probe: (
    orgId: OrgId,
    targetId: ScrapeTargetId,
  ) => Effect.Effect<
    ScrapeTargetProbeResponse,
    | ScrapeTargetNotFoundError
    | ScrapeTargetPersistenceError
    | ScrapeTargetEncryptionError
  >
}

const toPersistenceError = (error: unknown) =>
  new ScrapeTargetPersistenceError({
    message:
      error instanceof Error ? error.message : "Scrape target persistence failed",
  })

const toEncryptionError = (message: string) =>
  new ScrapeTargetEncryptionError({ message })

const decodeTargetIdSync = Schema.decodeUnknownSync(ScrapeTargetId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeScrapeIntervalSecondsSync = Schema.decodeUnknownSync(
  ScrapeIntervalSeconds,
)
const decodeScrapeAuthTypeSync = Schema.decodeUnknownSync(ScrapeAuthType)
const ScrapeLabelsSchema = Schema.Record(Schema.String, Schema.String)
const BearerCredentialsSchema = Schema.Struct({
  token: Schema.String,
})
const BasicCredentialsSchema = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
})

const parseEncryptionKey = (
  raw: string,
): Effect.Effect<Buffer, ScrapeTargetEncryptionError> =>
  parseBase64Aes256GcmKey(raw, (message) =>
    toEncryptionError(
      message === "Expected a non-empty base64 encryption key"
        ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
        : message === "Expected base64 for exactly 32 bytes"
          ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
          : message,
    ),
  )

const encryptCredentials = (
  plaintext: string,
  encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, ScrapeTargetEncryptionError> =>
  encryptAes256Gcm(plaintext, encryptionKey, () =>
    toEncryptionError("Failed to encrypt credentials"),
  )

const decryptCredentials = (
  row: {
    authCredentialsCiphertext: string
    authCredentialsIv: string
    authCredentialsTag: string
  },
  encryptionKey: Buffer,
): Effect.Effect<string, ScrapeTargetEncryptionError> =>
  decryptAes256Gcm(
    {
      ciphertext: row.authCredentialsCiphertext,
      iv: row.authCredentialsIv,
      tag: row.authCredentialsTag,
    },
    encryptionKey,
    () => toEncryptionError("Failed to decrypt auth credentials"),
  )

const VALID_AUTH_TYPES = ["none", "bearer", "basic"] as const

const validateAuthType = (authType: string | undefined) => {
  if (authType === undefined) return Effect.succeed(undefined)
  if (!(VALID_AUTH_TYPES as readonly string[]).includes(authType)) {
    return Effect.fail(
      new ScrapeTargetValidationError({
        message: `Invalid auth type: "${authType}". Must be one of: ${VALID_AUTH_TYPES.join(", ")}`,
      }),
    )
  }
  return Effect.succeed(authType as (typeof VALID_AUTH_TYPES)[number])
}

const validateAuthCredentials = (
  authType: string,
  authCredentials: string | null | undefined,
) => {
  if (authType === "none") return Effect.succeed(undefined)

  if (!authCredentials) {
    return Effect.fail(
      new ScrapeTargetValidationError({
        message: `Credentials are required for auth type "${authType}"`,
      }),
    )
  }

  return Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      authType === "bearer" ? BearerCredentialsSchema : BasicCredentialsSchema,
    ),
  )(authCredentials).pipe(
    Effect.mapError(() =>
      new ScrapeTargetValidationError({
        message:
          authType === "bearer"
            ? 'Bearer auth credentials must include a "token" string field'
            : 'Basic auth credentials must include "username" and "password" string fields',
      }),
    ),
    Effect.as(authCredentials),
  )
}

const rowToResponse = (row: ScrapeTargetRow): ScrapeTargetResponse =>
  new ScrapeTargetResponse({
    id: decodeTargetIdSync(row.id),
    name: row.name,
    serviceName: row.serviceName ?? null,
    url: row.url,
    scrapeIntervalSeconds: decodeScrapeIntervalSecondsSync(
      row.scrapeIntervalSeconds,
    ),
    labelsJson: row.labelsJson,
    authType: decodeScrapeAuthTypeSync(row.authType),
    hasCredentials: row.authCredentialsCiphertext !== null,
    enabled: row.enabled === 1,
    lastScrapeAt: row.lastScrapeAt
      ? decodeIsoDateTimeStringSync(new Date(row.lastScrapeAt).toISOString())
      : null,
    lastScrapeError: row.lastScrapeError,
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
  })

const MIN_SCRAPE_INTERVAL = 5
const MAX_SCRAPE_INTERVAL = 300

const validateUrl = (url: string) => {
  return Effect.sync(() => url.trim()).pipe(
    Effect.flatMap((trimmed) =>
      Effect.try({
        try: () => {
          if (trimmed.length === 0) {
            throw new Error("URL is required")
          }

          new URL(trimmed)
          return trimmed
        },
        catch: (error) =>
          new ScrapeTargetValidationError({
            message: error instanceof Error ? error.message : `Invalid URL: ${trimmed}`,
          }),
      }),
    ),
  )
}

const validateInterval = (seconds: number | undefined) => {
  if (seconds === undefined) return Effect.succeed(undefined)
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_SCRAPE_INTERVAL ||
    seconds > MAX_SCRAPE_INTERVAL
  ) {
    return Effect.fail(
      new ScrapeTargetValidationError({
        message: `Scrape interval must be an integer between ${MIN_SCRAPE_INTERVAL} and ${MAX_SCRAPE_INTERVAL} seconds`,
      }),
    )
  }
  return Effect.succeed(seconds)
}

const validateLabelsJson = (labelsJson: string | null | undefined) => {
  if (labelsJson === undefined || labelsJson === null) return Effect.succeed(labelsJson)
  return Schema.decodeUnknownEffect(
    Schema.fromJsonString(ScrapeLabelsSchema),
  )(labelsJson).pipe(
    Effect.mapError(() =>
      new ScrapeTargetValidationError({
        message: "labelsJson must be a JSON object with string values",
      }),
    ),
    Effect.as(labelsJson),
  )
}

export class ScrapeTargetsService extends ServiceMap.Service<ScrapeTargetsService, ScrapeTargetsServiceShape>()(
  "ScrapeTargetsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const env = yield* Env
      const encryptionKey = yield* parseEncryptionKey(
        Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      )

      const selectById = Effect.fn("ScrapeTargetsService.selectById")(function* (
        orgId: OrgId,
        targetId: ScrapeTargetId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(scrapeTargets)
            .where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId)))
            .limit(1),
        ).pipe(Effect.mapError(toPersistenceError))

        return Option.fromNullishOr(rows[0])
      })

      const requireTarget = Effect.fn("ScrapeTargetsService.requireTarget")(function* (
        orgId: OrgId,
        targetId: ScrapeTargetId,
      ) {
        const row = yield* selectById(orgId, targetId)
        if (Option.isSome(row)) return row.value

        return yield* Effect.fail(
          new ScrapeTargetNotFoundError({
            targetId,
            message: "Scrape target not found",
          }),
        )
      })

      const list = Effect.fn("ScrapeTargetsService.list")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* database.execute((db) =>
          db.select().from(scrapeTargets).where(eq(scrapeTargets.orgId, orgId)),
        ).pipe(Effect.mapError(toPersistenceError))

        return new ScrapeTargetsListResponse({
          targets: rows.map(rowToResponse),
        })
      })

      const create = Effect.fn("ScrapeTargetsService.create")(function* (
        orgId: OrgId,
        request: CreateScrapeTargetRequest,
      ) {
        const url = yield* validateUrl(request.url)
        yield* validateInterval(request.scrapeIntervalSeconds)
        yield* validateLabelsJson(request.labelsJson)

        const authType = (yield* validateAuthType(request.authType)) ?? "none"
        const name = request.name.trim()
        const serviceName = request.serviceName ?? null

        let credentialFields: {
          authCredentialsCiphertext: string | null
          authCredentialsIv: string | null
          authCredentialsTag: string | null
        } = {
          authCredentialsCiphertext: null,
          authCredentialsIv: null,
          authCredentialsTag: null,
        }

        if (authType !== "none") {
          yield* validateAuthCredentials(authType, request.authCredentials)
          const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
          credentialFields = {
            authCredentialsCiphertext: encrypted.ciphertext,
            authCredentialsIv: encrypted.iv,
            authCredentialsTag: encrypted.tag,
          }
        }

        const now = Date.now()
        const id = decodeTargetIdSync(randomUUID())

        yield* database.execute((db) =>
          db.insert(scrapeTargets).values({
            id,
            orgId,
            name,
            serviceName,
            url,
            scrapeIntervalSeconds: request.scrapeIntervalSeconds ?? 15,
            labelsJson: request.labelsJson ?? null,
            authType,
            ...credentialFields,
            enabled: request.enabled === false ? 0 : 1,
            createdAt: now,
            updatedAt: now,
          }),
        ).pipe(Effect.mapError(toPersistenceError))

        const row = yield* selectById(orgId, id)
        if (Option.isNone(row)) {
          return yield* Effect.fail(
            new ScrapeTargetPersistenceError({
              message: "Failed to create scrape target",
            }),
          )
        }

        yield* probe(orgId, id).pipe(Effect.ignore, Effect.forkDetach)

        return rowToResponse(row.value)
      })

      const update = Effect.fn("ScrapeTargetsService.update")(function* (
        orgId: OrgId,
        targetId: ScrapeTargetId,
        request: UpdateScrapeTargetRequest,
      ) {
        const existing = yield* requireTarget(orgId, targetId)

        if (request.url !== undefined) {
          yield* validateUrl(request.url)
        }
        yield* validateInterval(request.scrapeIntervalSeconds)
        yield* validateLabelsJson(request.labelsJson)

        const now = Date.now()
        const updates: Record<string, unknown> = { updatedAt: now }

        if (request.name !== undefined) updates.name = request.name.trim()
        if (request.url !== undefined) updates.url = request.url.trim()
        if (request.scrapeIntervalSeconds !== undefined) {
          updates.scrapeIntervalSeconds = request.scrapeIntervalSeconds
        }
        if (request.labelsJson !== undefined) updates.labelsJson = request.labelsJson
        if (request.enabled !== undefined) updates.enabled = request.enabled ? 1 : 0
        if (request.serviceName !== undefined) updates.serviceName = request.serviceName

        if (request.authType !== undefined) {
          const newAuthType = yield* validateAuthType(request.authType)
          updates.authType = newAuthType

          if (newAuthType === "none") {
            updates.authCredentialsCiphertext = null
            updates.authCredentialsIv = null
            updates.authCredentialsTag = null
          } else if (newAuthType !== existing.authType || request.authCredentials) {
            yield* validateAuthCredentials(newAuthType!, request.authCredentials)
            const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
            updates.authCredentialsCiphertext = encrypted.ciphertext
            updates.authCredentialsIv = encrypted.iv
            updates.authCredentialsTag = encrypted.tag
          }
        } else if (request.authCredentials) {
          const currentAuthType = existing.authType
          if (currentAuthType !== "none") {
            yield* validateAuthCredentials(currentAuthType, request.authCredentials)
            const encrypted = yield* encryptCredentials(request.authCredentials!, encryptionKey)
            updates.authCredentialsCiphertext = encrypted.ciphertext
            updates.authCredentialsIv = encrypted.iv
            updates.authCredentialsTag = encrypted.tag
          }
        }

        yield* database.execute((db) =>
          db
            .update(scrapeTargets)
            .set(updates)
            .where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId))),
        ).pipe(Effect.mapError(toPersistenceError))

        const row = yield* selectById(orgId, targetId)
        if (Option.isNone(row)) {
          return yield* Effect.fail(
            new ScrapeTargetPersistenceError({
              message: "Failed to load updated scrape target",
            }),
          )
        }

        return rowToResponse(row.value)
      })

      const remove = Effect.fn("ScrapeTargetsService.delete")(function* (
        orgId: OrgId,
        targetId: ScrapeTargetId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .delete(scrapeTargets)
            .where(and(eq(scrapeTargets.orgId, orgId), eq(scrapeTargets.id, targetId)))
            .returning({ id: scrapeTargets.id }),
        ).pipe(Effect.mapError(toPersistenceError))

        const deleted = Option.fromNullishOr(rows[0])
        if (Option.isNone(deleted)) {
          return yield* Effect.fail(
            new ScrapeTargetNotFoundError({
              targetId,
              message: "Scrape target not found",
            }),
          )
        }

        return new ScrapeTargetDeleteResponse({
          id: decodeTargetIdSync(deleted.value.id),
        })
      })

      const listAllEnabled = Effect.fn("ScrapeTargetsService.listAllEnabled")(function* () {
        const rows = yield* database.execute((db) =>
          db.select().from(scrapeTargets).where(eq(scrapeTargets.enabled, 1)),
        ).pipe(Effect.mapError(toPersistenceError))

        return rows
      })

      const probe = Effect.fn("ScrapeTargetsService.probe")(function* (
        orgId: OrgId,
        targetId: ScrapeTargetId,
      ) {
        const row = yield* requireTarget(orgId, targetId)

        const headers: Record<string, string> = {}
        if (
          row.authType !== "none" &&
          row.authCredentialsCiphertext &&
          row.authCredentialsIv &&
          row.authCredentialsTag
        ) {
          const credentialsJson = yield* decryptCredentials(
            {
              authCredentialsCiphertext: row.authCredentialsCiphertext,
              authCredentialsIv: row.authCredentialsIv,
              authCredentialsTag: row.authCredentialsTag,
            },
            encryptionKey,
          )
          if (row.authType === "bearer") {
            const credentials = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(BearerCredentialsSchema),
            )(credentialsJson).pipe(
              Effect.mapError(() =>
                new ScrapeTargetEncryptionError({
                  message: "Failed to decode auth credentials",
                }),
              ),
            )
            headers.Authorization = `Bearer ${credentials.token}`
          } else if (row.authType === "basic") {
            const credentials = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(BasicCredentialsSchema),
            )(credentialsJson).pipe(
              Effect.mapError(() =>
                new ScrapeTargetEncryptionError({
                  message: "Failed to decode auth credentials",
                }),
              ),
            )
            const encoded = Buffer.from(
              `${credentials.username}:${credentials.password}`,
            ).toString("base64")
            headers.Authorization = `Basic ${encoded}`
          }
        }

        const now = Date.now()
        const requestExit = yield* Effect.tryPromise({
          try: async () => {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 10_000)
            try {
              const response = await fetch(row.url, {
                method: "GET",
                headers,
                signal: controller.signal,
                redirect: "follow",
              })
              if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`)
              }
            } finally {
              clearTimeout(timeout)
            }
          },
          catch: (error) =>
            error instanceof Error ? error : new Error("Connection failed"),
        }).pipe(Effect.exit)

        if (Exit.isSuccess(requestExit)) {
          yield* database.execute((db) =>
            db
              .update(scrapeTargets)
              .set({ lastScrapeAt: now, lastScrapeError: null, updatedAt: now })
              .where(eq(scrapeTargets.id, targetId)),
          ).pipe(Effect.mapError(toPersistenceError))
        } else {
          yield* database.execute((db) =>
            db
              .update(scrapeTargets)
              .set({
                lastScrapeError: Cause.pretty(requestExit.cause),
                updatedAt: now,
                })
              .where(eq(scrapeTargets.id, targetId)),
          ).pipe(Effect.mapError(toPersistenceError))
        }

        const updatedRows = yield* database.execute((db) =>
          db
            .select()
            .from(scrapeTargets)
            .where(eq(scrapeTargets.id, targetId))
            .limit(1),
        ).pipe(Effect.mapError(toPersistenceError))

        const updated = Option.fromNullishOr(updatedRows[0])
        if (Option.isNone(updated)) {
          return yield* Effect.fail(
            new ScrapeTargetPersistenceError({
              message: "Failed to load probed scrape target",
            }),
          )
        }

        return new ScrapeTargetProbeResponse({
          success: Exit.isSuccess(requestExit),
          lastScrapeAt: updated.value.lastScrapeAt
            ? decodeIsoDateTimeStringSync(
                new Date(updated.value.lastScrapeAt).toISOString(),
              )
            : null,
          lastScrapeError: updated.value.lastScrapeError ?? null,
        })
      })

      return {
        list,
        create,
        update,
        delete: remove,
        listAllEnabled,
        probe,
      } satisfies ScrapeTargetsServiceShape
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
