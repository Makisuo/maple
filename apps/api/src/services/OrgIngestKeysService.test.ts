import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  IngestKeyEncryptionError,
  IngestKeyPersistenceError,
  OrgId,
  UserId,
} from "@maple/domain/http"
import { hashIngestKey } from "@maple/db"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import { OrgIngestKeysService } from "./OrgIngestKeysService"

const createdTempDirs: string[] = []

afterEach(() => {
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (!Exit.isFailure(exit)) return undefined

  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure !== undefined) return failure

  return Cause.squash(exit.cause)
}

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-ingest-keys-"))
  createdTempDirs.push(dir)

  const dbPath = join(dir, "maple.db")
  const db = new Database(dbPath)
  db.close()

  return { url: `file:${dbPath}`, dbPath }
}

const makeConfig = (
  url: string,
  encryptionKey?: string,
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      MCP_PORT: "3473",
      TINYBIRD_HOST: "https://api.tinybird.co",
      TINYBIRD_TOKEN: "test-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      ...(encryptionKey === undefined
        ? {}
        : { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey }),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
    }),
  )

const makeLayer = (url: string, encryptionKey = Buffer.alloc(32, 7).toString("base64")) =>
  OrgIngestKeysService.Live.pipe(
    Layer.provide(DatabaseLibsqlLive),
    Layer.provide(Env.Default),
    Layer.provide(makeConfig(url, encryptionKey)),
  )

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

describe("OrgIngestKeysService", () => {
  it("lazily creates keys for a new org", async () => {
    const { url } = createTempDbUrl()

    const result = await Effect.runPromise(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(makeLayer(url)),
      ),
    )

    expect(result.publicKey.startsWith("maple_pk_")).toBe(true)
    expect(result.privateKey.startsWith("maple_sk_")).toBe(true)
    expect(Date.parse(result.publicRotatedAt)).not.toBeNaN()
    expect(Date.parse(result.privateRotatedAt)).not.toBeNaN()
  })

  it("returns stable keys when called repeatedly without reroll", async () => {
    const { url } = createTempDbUrl()

    const program = Effect.gen(function* () {
      const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
      const second = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
      return { first, second }
    }).pipe(Effect.provide(makeLayer(url)))

    const result = await Effect.runPromise(program)

    expect(result.second).toEqual(result.first)
  })

  it("rerolls only the public key", async () => {
    const { url } = createTempDbUrl()

    const program = Effect.gen(function* () {
      const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
      const rerolled = yield* OrgIngestKeysService.rerollPublic(asOrgId("org_a"), asUserId("user_a"))
      return { first, rerolled }
    }).pipe(Effect.provide(makeLayer(url)))

    const result = await Effect.runPromise(program)

    expect(result.rerolled.publicKey).not.toBe(result.first.publicKey)
    expect(result.rerolled.privateKey).toBe(result.first.privateKey)
    expect(
      Date.parse(result.rerolled.publicRotatedAt) >=
        Date.parse(result.first.publicRotatedAt),
    ).toBe(true)
    expect(result.rerolled.privateRotatedAt).toBe(result.first.privateRotatedAt)
  })

  it("rerolls only the private key", async () => {
    const { url } = createTempDbUrl()

    const program = Effect.gen(function* () {
      const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
      const rerolled = yield* OrgIngestKeysService.rerollPrivate(asOrgId("org_a"), asUserId("user_a"))
      return { first, rerolled }
    }).pipe(Effect.provide(makeLayer(url)))

    const result = await Effect.runPromise(program)

    expect(result.rerolled.publicKey).toBe(result.first.publicKey)
    expect(result.rerolled.privateKey).not.toBe(result.first.privateKey)
    expect(result.rerolled.publicRotatedAt).toBe(result.first.publicRotatedAt)
    expect(
      Date.parse(result.rerolled.privateRotatedAt) >=
        Date.parse(result.first.privateRotatedAt),
    ).toBe(true)
  })

  it("keeps keys isolated by org", async () => {
    const { url } = createTempDbUrl()

    const program = Effect.gen(function* () {
      const orgA = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
      const orgB = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_b"), asUserId("user_b"))
      return { orgA, orgB }
    }).pipe(Effect.provide(makeLayer(url)))

    const result = await Effect.runPromise(program)

    expect(result.orgA.publicKey).not.toBe(result.orgB.publicKey)
    expect(result.orgA.privateKey).not.toBe(result.orgB.privateKey)
  })

  it("stores private key encrypted at rest", async () => {
    const { url, dbPath } = createTempDbUrl()

    const created = await Effect.runPromise(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(makeLayer(url)),
      ),
    )

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query(
        "SELECT private_key_ciphertext, private_key_iv, private_key_tag FROM org_ingest_keys WHERE org_id = ?",
      )
      .get("org_a") as
      | {
          private_key_ciphertext: string
          private_key_iv: string
          private_key_tag: string
        }
      | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.private_key_ciphertext).toBeTruthy()
    expect(row?.private_key_iv).toBeTruthy()
    expect(row?.private_key_tag).toBeTruthy()
    expect(row?.private_key_ciphertext).not.toBe(created.privateKey)
  })

  it("stores deterministic HMAC hashes for public/private keys", async () => {
    const { url, dbPath } = createTempDbUrl()
    const lookupHmacKey = "maple-test-lookup-secret"

    const created = await Effect.runPromise(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(makeLayer(url)),
      ),
    )

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query(
        "SELECT public_key_hash, private_key_hash FROM org_ingest_keys WHERE org_id = ?",
      )
      .get("org_a") as
      | {
          public_key_hash: string
          private_key_hash: string
        }
      | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.public_key_hash).toBe(hashIngestKey(created.publicKey, lookupHmacKey))
    expect(row?.private_key_hash).toBe(hashIngestKey(created.privateKey, lookupHmacKey))
  })

  it("resolves keys by hash and key type", async () => {
    const { url } = createTempDbUrl()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
        const publicResolved = yield* OrgIngestKeysService.resolveIngestKey(
          created.publicKey,
        )
        const privateResolved = yield* OrgIngestKeysService.resolveIngestKey(
          created.privateKey,
        )
        const invalidResolved = yield* OrgIngestKeysService.resolveIngestKey(
          "not-a-maple-key",
        )

        return {
          publicResolved,
          privateResolved,
          invalidResolved,
        }
      }).pipe(Effect.provide(makeLayer(url))),
    )

    expect(Option.isSome(result.publicResolved)).toBe(true)
    expect(Option.isSome(result.privateResolved)).toBe(true)
    if (Option.isSome(result.publicResolved)) {
      expect(result.publicResolved.value).toEqual(
        expect.objectContaining({
          orgId: asOrgId("org_a"),
          keyType: "public",
        }),
      )
    }
    if (Option.isSome(result.privateResolved)) {
      expect(result.privateResolved.value).toEqual(
        expect.objectContaining({
          orgId: asOrgId("org_a"),
          keyType: "private",
        }),
      )
    }
    expect(result.invalidResolved).toEqual(Option.none())
  })

  it("reroll invalidates previous key hashes immediately", async () => {
    const { url } = createTempDbUrl()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a"))
        const rerolledPublic = yield* OrgIngestKeysService.rerollPublic(asOrgId("org_a"), asUserId("user_a"))
        const oldPublic = yield* OrgIngestKeysService.resolveIngestKey(first.publicKey)
        const newPublic = yield* OrgIngestKeysService.resolveIngestKey(
          rerolledPublic.publicKey,
        )
        const rerolledPrivate = yield* OrgIngestKeysService.rerollPrivate(asOrgId("org_a"), asUserId("user_a"))
        const oldPrivate = yield* OrgIngestKeysService.resolveIngestKey(first.privateKey)
        const newPrivate = yield* OrgIngestKeysService.resolveIngestKey(
          rerolledPrivate.privateKey,
        )

        return {
          oldPublic,
          newPublic,
          oldPrivate,
          newPrivate,
        }
      }).pipe(Effect.provide(makeLayer(url))),
    )

    expect(result.oldPublic).toEqual(Option.none())
    expect(Option.isSome(result.newPublic)).toBe(true)
    if (Option.isSome(result.newPublic)) {
      expect(result.newPublic.value).toEqual(
        expect.objectContaining({
          orgId: asOrgId("org_a"),
          keyType: "public",
        }),
      )
    }
    expect(result.oldPrivate).toEqual(Option.none())
    expect(Option.isSome(result.newPrivate)).toBe(true)
    if (Option.isSome(result.newPrivate)) {
      expect(result.newPrivate.value).toEqual(
        expect.objectContaining({
          orgId: asOrgId("org_a"),
          keyType: "private",
        }),
      )
    }
  })

  it("fails fast on invalid encryption key configuration", async () => {
    const { url } = createTempDbUrl()
    const layer = makeLayer(url, "invalid-base64-key")

    const exit = await Effect.runPromiseExit(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(layer),
      ),
    )
    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toBeInstanceOf(IngestKeyEncryptionError)
  })

  it("fails when encryption key config is missing", async () => {
    const { url } = createTempDbUrl()
    const layer = OrgIngestKeysService.Live.pipe(
      Layer.provide(DatabaseLibsqlLive),
      Layer.provide(Env.Default),
      Layer.provide(makeConfig(url)),
    )

    const exit = await Effect.runPromiseExit(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(layer),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("maps database errors to IngestKeyPersistenceError", async () => {
    const layer = makeLayer(
      "http://127.0.0.1:9",
      Buffer.alloc(32, 3).toString("base64"),
    )

    const exit = await Effect.runPromiseExit(
      OrgIngestKeysService.getOrCreate(asOrgId("org_a"), asUserId("user_a")).pipe(
        Effect.provide(layer),
      ),
    )
    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (failure instanceof IngestKeyPersistenceError) {
      expect(failure).toBeInstanceOf(IngestKeyPersistenceError)
      return
    }

    expect(String(failure)).toContain("DatabaseError")
  })
})
