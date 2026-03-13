import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ConfigError } from "effect/ConfigError"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  OrgId,
  OrgTinybirdSettingsEncryptionError,
  OrgTinybirdSettingsForbiddenError,
  OrgTinybirdSettingsSyncError,
  RoleName,
  UserId,
} from "@maple/domain/http"
import { Env } from "./Env"
import { OrgTinybirdSettingsService, __testables } from "./OrgTinybirdSettingsService"

const createdTempDirs: string[] = []

afterEach(() => {
  __testables.reset()
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (!Exit.isFailure(exit)) return undefined

  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure !== undefined) return failure

  return Option.getOrUndefined(Cause.dieOption(exit.cause))
}

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-org-tinybird-"))
  createdTempDirs.push(dir)

  const dbPath = join(dir, "maple.db")
  const db = new Database(dbPath)
  db.close()

  return { url: `file:${dbPath}`, dbPath }
}

const makeConfigProvider = (url: string) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["PORT", "3472"],
        ["TINYBIRD_HOST", "https://maple-managed.tinybird.co"],
        ["TINYBIRD_TOKEN", "managed-token"],
        ["MAPLE_DB_URL", url],
        ["MAPLE_DB_AUTH_TOKEN", ""],
        ["MAPLE_AUTH_MODE", "self_hosted"],
        ["MAPLE_ROOT_PASSWORD", "test-root-password"],
        ["MAPLE_DEFAULT_ORG_ID", "default"],
        ["MAPLE_INGEST_KEY_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")],
        ["MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY", "maple-test-lookup-secret"],
        ["CLERK_SECRET_KEY", ""],
        ["CLERK_PUBLISHABLE_KEY", ""],
        ["CLERK_JWT_KEY", ""],
      ]),
    ),
  )

const makeLayer = (url: string): Layer.Layer<
  OrgTinybirdSettingsService,
  OrgTinybirdSettingsEncryptionError | ConfigError
> =>
  OrgTinybirdSettingsService.Live.pipe(
    Layer.provide(Env.Default),
    Layer.provide(makeConfigProvider(url)),
  )

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const orgAdminRoles = [asRoleName("org:admin")]
const memberRoles = [asRoleName("org:member")]

describe("OrgTinybirdSettingsService", () => {
  it("encrypts the token at rest and never returns it from get", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* OrgTinybirdSettingsService.upsert(
          asOrgId("org_a"),
          asUserId("user_a"),
          adminRoles,
          {
            host: "https://customer.tinybird.co",
            token: "secret-token",
          },
        )

        return yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      configured: true,
      host: "https://customer.tinybird.co",
      syncStatus: "active",
      lastSyncAt: expect.any(String),
      lastSyncError: null,
      projectRevision: "rev-1",
    })
    expect(JSON.stringify(result)).not.toContain("secret-token")

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query("SELECT token_ciphertext, token_iv, token_tag FROM org_tinybird_settings WHERE org_id = ?")
      .get("org_a") as
      | {
          token_ciphertext: string
          token_iv: string
          token_tag: string
        }
      | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.token_ciphertext).not.toBe("secret-token")
    expect(row?.token_iv).toBeTruthy()
    expect(row?.token_tag).toBeTruthy()
  })

  it("does not persist an initial configuration when sync fails", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => {
      throw new Error("bad credentials")
    })

    const exit = await Effect.runPromiseExit(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "secret-token",
        },
      ).pipe(Effect.provide(makeLayer(url))),
    )

    expect(Exit.isFailure(exit)).toBe(true)

    const db = new Database(dbPath, { readonly: true })
    const rowCount = db
      .query("SELECT COUNT(*) as count FROM org_tinybird_settings")
      .get() as { count: number }
    db.close()

    expect(rowCount.count).toBe(0)
  })

  it("leaves the previous active config untouched when an update sync fails", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setSyncProjectImpl(async ({ baseUrl }) => ({
      projectRevision: baseUrl.includes("customer-a") ? "rev-a" : "rev-b",
      result: "success",
      deploymentId: "dep-1",
    }))

    const layer = makeLayer(url)

    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer-a.tinybird.co",
          token: "token-a",
        },
      ).pipe(Effect.provide(layer)),
    )

    __testables.setSyncProjectImpl(async () => {
      throw new Error("sync failed")
    })

    const exit = await Effect.runPromiseExit(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_b"),
        adminRoles,
        {
          host: "https://customer-b.tinybird.co",
          token: "token-b",
        },
      ).pipe(Effect.provide(layer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query("SELECT host, sync_status, project_revision FROM org_tinybird_settings WHERE org_id = ?")
      .get("org_a") as
      | {
          host: string
          sync_status: string
          project_revision: string
        }
      | undefined
    db.close()

    expect(row).toEqual({
      host: "https://customer-a.tinybird.co",
      sync_status: "active",
      project_revision: "rev-a",
    })
  })

  it("deletes the override and restores runtime fallback", async () => {
    const { url } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* OrgTinybirdSettingsService.upsert(
          asOrgId("org_a"),
          asUserId("user_a"),
          adminRoles,
          {
            host: "https://customer.tinybird.co",
            token: "secret-token",
          },
        )
        yield* OrgTinybirdSettingsService.delete(asOrgId("org_a"), adminRoles)
        return yield* OrgTinybirdSettingsService.resolveRuntimeConfig(asOrgId("org_a"))
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual(Option.none())
  })

  it("allows root and org admins, and rejects members", async () => {
    const { url } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    const rootResult = await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "secret-token",
        },
      ).pipe(Effect.provide(layer)),
    )
    expect(rootResult.configured).toBe(true)

    const orgAdminResult = await Effect.runPromise(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), orgAdminRoles).pipe(
        Effect.provide(layer),
      ),
    )
    expect(orgAdminResult.host).toBe("https://customer.tinybird.co")

    const memberExit = await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), memberRoles).pipe(
        Effect.provide(layer),
      ),
    )
    expect(getError(memberExit)).toBeInstanceOf(OrgTinybirdSettingsForbiddenError)
  })

  it("reports out_of_sync when the bundled Tinybird revision changes", async () => {
    const { url } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))

    const layer = makeLayer(url)

    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "secret-token",
        },
      ).pipe(Effect.provide(layer)),
    )

    __testables.setGetProjectRevisionImpl(async () => "rev-2")

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toEqual({
      configured: true,
      host: "https://customer.tinybird.co",
      syncStatus: "out_of_sync",
      lastSyncAt: expect.any(String),
      lastSyncError: null,
      projectRevision: "rev-1",
    })
  })

  it("fails runtime resolution when the bundled Tinybird revision changes without mutating the stored config", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))

    const layer = makeLayer(url)

    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "secret-token",
        },
      ).pipe(Effect.provide(layer)),
    )

    __testables.setGetProjectRevisionImpl(async () => "rev-2")
    let syncCalls = 0
    __testables.setSyncProjectImpl(async () => {
      syncCalls += 1
      throw new Error("runtime sync should not execute")
    })

    const exit = await Effect.runPromiseExit(
      OrgTinybirdSettingsService.resolveRuntimeConfig(asOrgId("org_a")).pipe(
        Effect.provide(layer),
      ),
    )

    expect(getError(exit)).toBeInstanceOf(OrgTinybirdSettingsSyncError)
    const error = getError(exit) as OrgTinybirdSettingsSyncError
    expect(error.message).toContain("Please resync the project in settings")
    expect(syncCalls).toBe(0)

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query("SELECT sync_status, last_sync_error, project_revision FROM org_tinybird_settings WHERE org_id = ?")
      .get("org_a") as
      | {
          sync_status: string
          last_sync_error: string | null
          project_revision: string
        }
      | undefined
    db.close()

    expect(row).toEqual({
      sync_status: "active",
      last_sync_error: null,
      project_revision: "rev-1",
    })
  })

  it("reports stored error states without masking them as out_of_sync", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))

    const layer = makeLayer(url)

    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "secret-token",
        },
      ).pipe(Effect.provide(layer)),
    )

    const db = new Database(dbPath)
    db
      .query(
        "UPDATE org_tinybird_settings SET sync_status = ?, last_sync_error = ? WHERE org_id = ?",
      )
      .run("error", "customer sync failed", "org_a")
    db.close()

    __testables.setGetProjectRevisionImpl(async () => "rev-2")

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toEqual({
      configured: true,
      host: "https://customer.tinybird.co",
      syncStatus: "error",
      lastSyncAt: expect.any(String),
      lastSyncError: "customer sync failed",
      projectRevision: "rev-1",
    })
  })
})
