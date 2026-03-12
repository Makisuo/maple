import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import type { ConfigError } from "effect/ConfigError"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import {
  OrgId,
  OrgTinybirdSettingsEncryptionError,
  RoleName,
  UserId,
} from "@maple/domain/http"
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

const makeConfigProvider = (url: string) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["PORT", "3472"],
        ["TINYBIRD_HOST", "https://managed.tinybird.co"],
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

const makeTinybirdLayer = (
  url: string,
): Layer.Layer<TinybirdService, OrgTinybirdSettingsEncryptionError | ConfigError> =>
  TinybirdService.Default.pipe(
    Layer.provide(OrgTinybirdSettingsService.Live),
    Layer.provide(Env.Default),
    Layer.provide(makeConfigProvider(url)),
  )

const makeOrgTinybirdLayer = (
  url: string,
): Layer.Layer<OrgTinybirdSettingsService, OrgTinybirdSettingsEncryptionError | ConfigError> =>
  OrgTinybirdSettingsService.Live.pipe(
    Layer.provide(Env.Default),
    Layer.provide(makeConfigProvider(url)),
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

describe("Tinybird routing", () => {
  it("uses the env-backed Tinybird client by default for raw queries", async () => {
    const { url } = createTempDbUrl()
    const calls: Array<{ baseUrl: string; token: string }> = []

    tinybirdTestables.setClientFactory((baseUrl, token) => {
      calls.push({ baseUrl, token })
      return {
        list_logs: {
          query: async () => ({
            data: [{ message: "managed" }],
          }),
        },
      } as any
    })

    const result = await Effect.runPromise(
      TinybirdService.query(tenant, {
        pipe: "list_logs",
        params: {},
      }).pipe(Effect.provide(makeTinybirdLayer(url))),
    )

    expect(result.data).toEqual([{ message: "managed" }])
    expect(calls).toEqual([
      { baseUrl: "https://managed.tinybird.co", token: "managed-token" },
    ])
  })

  it("uses the org-specific Tinybird client for raw queries when an override exists", async () => {
    const { url } = createTempDbUrl()
    orgTinybirdTestables.setSyncProjectImpl(async () => ({
      projectRevision: "rev-1",
      result: "success",
      deploymentId: "dep-1",
    }))
    orgTinybirdTestables.setGetProjectRevisionImpl(async () => "rev-1")

    const calls: Array<{ baseUrl: string; token: string; method: string }> = []
    tinybirdTestables.setClientFactory((baseUrl, token) => ({
      list_logs: {
        query: async () => {
          calls.push({ baseUrl, token, method: "list_logs" })
          return { data: [{ message: "byo" }] }
        },
      },
    } as any))

    const tinybirdLayer = makeTinybirdLayer(url)
    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        tenant.orgId,
        tenant.userId,
        tenant.roles,
        {
          host: "https://customer.tinybird.co",
          token: "customer-token",
        },
      ).pipe(Effect.provide(makeOrgTinybirdLayer(url))),
    )

    const rawResult = await Effect.runPromise(
      TinybirdService.query(tenant, {
        pipe: "list_logs",
        params: {},
      }).pipe(Effect.provide(tinybirdLayer)),
    )

    expect(rawResult.data).toEqual([{ message: "byo" }])
    expect(calls).toEqual([
      {
        baseUrl: "https://customer.tinybird.co",
        token: "customer-token",
        method: "list_logs",
      },
    ])
  })
})
