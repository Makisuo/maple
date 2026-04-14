import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import {
  OrgId,
  OrgTinybirdSettingsEncryptionError,
  RoleName,
  UserId,
} from "@maple/domain/http"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import { OrgTinybirdSettingsService, __testables as orgTinybirdTestables } from "./OrgTinybirdSettingsService"
import { TinybirdService, __testables as tinybirdTestables } from "./TinybirdService"

const createdTempDirs: string[] = []

afterEach(() => {
  orgTinybirdTestables.reset()
  tinybirdTestables.reset()
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-tinybird-routing-"))
  createdTempDirs.push(dir)

  const dbPath = join(dir, "maple.db")
  const db = new Database(dbPath)
  db.close()

  return { url: `file:${dbPath}` }
}

const makeConfig = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
    }),
  )

const makeTinybirdLayer = (url: string) =>
  TinybirdService.Default.pipe(
    Layer.provide(OrgTinybirdSettingsService.Live.pipe(Layer.provide(DatabaseLibsqlLive))),
    Layer.provide(Env.Default),
    Layer.provide(makeConfig(url)),
  )

const makeOrgTinybirdLayer = (url: string) =>
  OrgTinybirdSettingsService.Live.pipe(
    Layer.provide(DatabaseLibsqlLive),
    Layer.provide(Env.Default),
    Layer.provide(makeConfig(url)),
  )

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const tenant = {
  orgId: asOrgId("org_a"),
  userId: asUserId("user_a"),
  roles: [asRoleName("root")],
  authMode: "self_hosted" as const,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Tinybird routing", () => {
  it("uses the env-backed Tinybird client by default for raw queries", async () => {
    const { url } = createTempDbUrl()
    const calls: Array<{ baseUrl: string; token: string }> = []

    tinybirdTestables.setClientFactory((baseUrl, token) => {
      calls.push({ baseUrl, token })
      return {
        sql: async () => ({
          data: [{ message: "managed" }],
        }),
      }
    })

    const result = await Effect.runPromise(
      TinybirdService.query(tenant, {
        pipe: "list_logs",
        params: {},
      }).pipe(Effect.provide(makeTinybirdLayer(url))),
    )

    expect(result.data).toBeDefined()
    expect(calls).toEqual([
      { baseUrl: "https://managed.tinybird.co", token: "managed-token" },
    ])
  })

  it("sqlQuery rejects SQL without OrgId filter", async () => {
    const { url } = createTempDbUrl()

    tinybirdTestables.setClientFactory(() => ({
      sql: async () => ({ data: [] }),
    }))

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TinybirdService
        return yield* service.sqlQuery(tenant, "SELECT 1").pipe(Effect.flip)
      }).pipe(Effect.provide(makeTinybirdLayer(url))),
    )

    expect(error.message).toContain("OrgId filter")
  })

  it("sqlQuery accepts SQL with OrgId filter", async () => {
    const { url } = createTempDbUrl()

    tinybirdTestables.setClientFactory(() => ({
      sql: async () => ({ data: [{ result: 1 }] }),
    }))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TinybirdService
        return yield* service.sqlQuery(tenant, "SELECT 1 FROM traces WHERE OrgId = 'org_a'")
      }).pipe(Effect.provide(makeTinybirdLayer(url))),
    )

    expect(result).toEqual([{ result: 1 }])
  })

  it("uses the org-specific Tinybird client for raw queries when an override exists", async () => {
    const { url } = createTempDbUrl()
    orgTinybirdTestables.setStartDeploymentImpl(async () => ({
      projectRevision: "rev-1",
      result: "no_changes",
      deploymentId: "dep-1",
      deploymentStatus: "live",
      errorMessage: null,
    }))
    orgTinybirdTestables.setGetProjectRevisionImpl(async () => "rev-1")

    const calls: Array<{ baseUrl: string; token: string; method: string }> = []
    tinybirdTestables.setClientFactory((baseUrl, token) => ({
      sql: async () => {
        calls.push({ baseUrl, token, method: "sql" })
        return { data: [{ message: "byo" }] }
      },
    }))

    const combinedLayer = Layer.mergeAll(
      makeOrgTinybirdLayer(url),
      makeTinybirdLayer(url),
    )

    const rawResult = await Effect.runPromise(
      Effect.gen(function* () {
        yield* OrgTinybirdSettingsService.upsert(
          tenant.orgId,
          tenant.userId,
          tenant.roles,
          {
            host: "https://customer.tinybird.co",
            token: "customer-token",
          },
        )
        yield* Effect.promise(() => sleep(50))

        return yield* TinybirdService.query(tenant, {
          pipe: "list_logs",
          params: {},
        })
      }).pipe(Effect.provide(combinedLayer)),
    )

    expect(rawResult.data).toEqual([{ message: "byo" }])
    expect(calls).toEqual([
      {
        baseUrl: "https://customer.tinybird.co",
        token: "customer-token",
        method: "sql",
      },
    ])
  })
})
