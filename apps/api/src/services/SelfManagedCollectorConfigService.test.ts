import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { encryptAes256Gcm } from "./Crypto"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import {
  renderCollectorConfig,
  SelfManagedCollectorConfigService,
  type SelfManagedOrgExporter,
} from "./SelfManagedCollectorConfigService"
import {
  cleanupTempDirs,
  createTempDbUrl as makeTempDb,
  executeSql,
} from "./test-sqlite"

const createdTempDirs: string[] = []
const encryptionKey = Buffer.alloc(32, 7)
const encryptionKeyBase64 = encryptionKey.toString("base64")
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanupTempDirs(createdTempDirs)
})

// ---------------------------------------------------------------------------
// Pure renderer — no DB, no effect
// ---------------------------------------------------------------------------

describe("renderCollectorConfig (pure)", () => {
  it("emits a routing-free fallback config when no orgs are active", () => {
    // The OTel routing connector fails to start with an empty table, so the
    // zero-orgs path skips the connector entirely and pipes OTLP straight
    // into debug/fallback.
    const config = renderCollectorConfig([])
    expect(config).not.toContain("connectors:")
    expect(config).not.toContain("routing")
    expect(config).toContain("exporters: [debug/fallback]")
    expect(config).not.toContain("tinybird/")
  })

  it("emits per-org exporter, route, and pipelines when orgs are active", () => {
    const orgs: SelfManagedOrgExporter[] = [
      { orgId: "org_a", host: "https://a.tinybird.co", token: "token-a" },
      { orgId: "org_b", host: "https://b.tinybird.co", token: "token-b" },
    ]
    const config = renderCollectorConfig(orgs)

    // Exporters
    expect(config).toContain("  tinybird/org_a:")
    expect(config).toContain('    endpoint: "https://a.tinybird.co"')
    expect(config).toContain('    token: "token-a"')
    expect(config).toContain("  tinybird/org_b:")
    expect(config).toContain('    endpoint: "https://b.tinybird.co"')
    expect(config).toContain('    token: "token-b"')

    // Metrics subtype mapping matches the shared collector config
    expect(config).toContain("datasource: metrics_sum")
    expect(config).toContain("datasource: metrics_gauge")
    expect(config).toContain("datasource: metrics_histogram")
    expect(config).toContain("datasource: metrics_exponential_histogram")

    // Per-signal routing connectors (OTel Contrib's routing connector is
    // signal-scoped — one instance per traces/logs/metrics).
    expect(config).toContain("routing/traces:")
    expect(config).toContain("routing/logs:")
    expect(config).toContain("routing/metrics:")
    expect(config).toContain("default_pipelines: [traces/fallback]")
    expect(config).toContain("default_pipelines: [logs/fallback]")
    expect(config).toContain("default_pipelines: [metrics/fallback]")

    // Each signal gets its own single-pipeline routing entry per org.
    expect(config).toContain('statement: route() where attributes["maple_org_id"] == "org_a"')
    expect(config).toContain("pipelines: [traces/org_a]")
    expect(config).toContain("pipelines: [logs/org_a]")
    expect(config).toContain("pipelines: [metrics/org_a]")
    expect(config).toContain("pipelines: [traces/org_b]")
    expect(config).toContain("pipelines: [logs/org_b]")
    expect(config).toContain("pipelines: [metrics/org_b]")

    // Per-org pipelines
    expect(config).toContain("    traces/org_a:")
    expect(config).toContain("    logs/org_a:")
    expect(config).toContain("    metrics/org_a:")
    expect(config).toContain("    traces/org_b:")
    expect(config).toContain("    logs/org_b:")
    expect(config).toContain("    metrics/org_b:")

    // Fallback still present
    expect(config).toContain("    traces/fallback:")
  })

  it("renders orgs in alphabetical order regardless of input order", () => {
    const forward = renderCollectorConfig([
      { orgId: "org_a", host: "https://a", token: "a" },
      { orgId: "org_b", host: "https://b", token: "b" },
    ])
    const reverse = renderCollectorConfig([
      { orgId: "org_b", host: "https://b", token: "b" },
      { orgId: "org_a", host: "https://a", token: "a" },
    ])
    expect(forward).toEqual(reverse)
  })

  it("escapes quotes and backslashes in host/token values", () => {
    const config = renderCollectorConfig([
      {
        orgId: "org_esc",
        host: 'https://evil.example/"quote',
        token: 'tok\\"\\bad',
      },
    ])
    expect(config).toContain('endpoint: "https://evil.example/\\"quote"')
    expect(config).toContain('token: "tok\\\\\\"\\\\bad"')
  })

  it("rejects orgIds that would be unsafe as YAML keys", () => {
    // Exporter keys like `tinybird/<orgId>` and pipeline keys like
    // `traces/<orgId>` must not contain special characters that would require
    // YAML escaping — the generator refuses rather than producing invalid YAML.
    expect(() =>
      renderCollectorConfig([
        { orgId: "org with space", host: "https://h", token: "t" },
      ]),
    ).toThrow(/Unsafe orgId/)
    expect(() =>
      renderCollectorConfig([
        { orgId: "org/slash", host: "https://h", token: "t" },
      ]),
    ).toThrow(/Unsafe orgId/)
  })
})

// ---------------------------------------------------------------------------
// Service — reads real libsql + decrypts tokens
// ---------------------------------------------------------------------------

const makeConfig = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://maple-managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64,
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
      MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_URL: "http://reload.local/-/reload",
      MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_TOKEN: "reload-secret",
    }),
  )

const makeLayer = (url: string) =>
  SelfManagedCollectorConfigService.Live.pipe(
    Layer.provide(DatabaseLibsqlLive),
    Layer.provide(Env.Default),
    Layer.provide(makeConfig(url)),
  )

const bootstrapDb = async (dbUrl: string) => {
  // Provide the layer; DatabaseLibsqlLive runs migrations as a side-effect.
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.succeed(void 0)
    }).pipe(Effect.provide(makeLayer(dbUrl))),
  )
}

const insertActiveOrg = async (
  dbPath: string,
  opts: { orgId: string; host: string; token: string },
) => {
  const encrypted = await Effect.runPromise(
    encryptAes256Gcm(opts.token, encryptionKey, (message) => new Error(message)),
  )
  const now = Date.now()
  await executeSql(
    dbPath,
    `INSERT INTO org_tinybird_settings (
      org_id, host, token_ciphertext, token_iv, token_tag, sync_status,
      last_sync_at, last_sync_error, project_revision, last_deployment_id,
      created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, 'rev-1', 'dep-1', ?, ?, ?, ?)`,
    [
      opts.orgId,
      opts.host,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      now,
      now,
      now,
      "user-test",
      "user-test",
    ],
  )
}

const insertInactiveOrg = async (
  dbPath: string,
  opts: { orgId: string; host: string; token: string },
) => {
  const encrypted = await Effect.runPromise(
    encryptAes256Gcm(opts.token, encryptionKey, (message) => new Error(message)),
  )
  const now = Date.now()
  await executeSql(
    dbPath,
    `INSERT INTO org_tinybird_settings (
      org_id, host, token_ciphertext, token_iv, token_tag, sync_status,
      last_sync_at, last_sync_error, project_revision, last_deployment_id,
      created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, 'error', ?, 'broken', 'rev-1', 'dep-1', ?, ?, ?, ?)`,
    [
      opts.orgId,
      opts.host,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      now,
      now,
      now,
      "user-test",
      "user-test",
    ],
  )
}

describe("SelfManagedCollectorConfigService", () => {
  let dbUrl: string
  let dbPath: string

  beforeEach(async () => {
    const temp = makeTempDb("maple-collector-config-", createdTempDirs)
    dbUrl = temp.url
    dbPath = temp.dbPath
    await bootstrapDb(dbUrl)
  })

  it("generateConfig renders a fallback-only YAML when no active orgs exist", async () => {
    const config = await Effect.runPromise(
      SelfManagedCollectorConfigService.generateConfig().pipe(
        Effect.provide(makeLayer(dbUrl)),
      ),
    )

    expect(config).not.toContain("connectors:")
    expect(config).not.toContain("tinybird/org_")
  })

  it("generateConfig decrypts active tokens and emits one exporter per active org", async () => {
    await insertActiveOrg(dbPath, {
      orgId: "org_active_1",
      host: "https://customer-1.tinybird.co",
      token: "secret-token-1",
    })
    await insertActiveOrg(dbPath, {
      orgId: "org_active_2",
      host: "https://customer-2.tinybird.co",
      token: "secret-token-2",
    })
    await insertInactiveOrg(dbPath, {
      orgId: "org_broken",
      host: "https://broken.tinybird.co",
      token: "should-never-appear",
    })

    const config = await Effect.runPromise(
      SelfManagedCollectorConfigService.generateConfig().pipe(
        Effect.provide(makeLayer(dbUrl)),
      ),
    )

    expect(config).toContain("tinybird/org_active_1:")
    expect(config).toContain('    endpoint: "https://customer-1.tinybird.co"')
    expect(config).toContain('    token: "secret-token-1"')

    expect(config).toContain("tinybird/org_active_2:")
    expect(config).toContain('    endpoint: "https://customer-2.tinybird.co"')
    expect(config).toContain('    token: "secret-token-2"')

    // Non-active orgs must not leak into the generated config.
    expect(config).not.toContain("tinybird/org_broken")
    expect(config).not.toContain("should-never-appear")
  })

  it("publishConfig PUTs the generated YAML to the reload endpoint with auth", async () => {
    await insertActiveOrg(dbPath, {
      orgId: "org_pub",
      host: "https://pub.tinybird.co",
      token: "tok-pub",
    })

    const calls: Array<{
      url: string
      method: string
      headers: Record<string, string>
      body: string
    }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: typeof init?.body === "string" ? init.body : "",
      })
      return new Response("", { status: 204 })
    }) as unknown as typeof fetch

    const result = await Effect.runPromise(
      SelfManagedCollectorConfigService.publishConfig().pipe(
        Effect.provide(makeLayer(dbUrl)),
      ),
    )

    expect(result).toEqual({ published: true, orgCount: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("PUT")
    expect(calls[0]!.url).toBe("http://reload.local/-/reload")
    expect(calls[0]!.headers["content-type"]).toBe("application/yaml")
    expect(calls[0]!.headers["authorization"]).toBe("Bearer reload-secret")
    expect(calls[0]!.body).toContain("tinybird/org_pub:")
  })

  it("publishConfig fails with PublishError when reload endpoint returns non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server off", { status: 503 }),
    ) as unknown as typeof fetch

    const exit = await Effect.runPromiseExit(
      SelfManagedCollectorConfigService.publishConfig().pipe(
        Effect.provide(makeLayer(dbUrl)),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })
})

// ---------------------------------------------------------------------------
// Service — no reload URL configured ⇒ graceful no-op
// ---------------------------------------------------------------------------

const makeConfigNoReloadUrl = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://maple-managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64,
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
      // MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_URL intentionally omitted.
    }),
  )

const makeLayerNoReload = (url: string) =>
  SelfManagedCollectorConfigService.Live.pipe(
    Layer.provide(DatabaseLibsqlLive),
    Layer.provide(Env.Default),
    Layer.provide(makeConfigNoReloadUrl(url)),
  )

describe("SelfManagedCollectorConfigService (no reload URL)", () => {
  let dbUrl: string

  beforeEach(async () => {
    const temp = makeTempDb("maple-collector-config-noreload-", createdTempDirs)
    dbUrl = temp.url
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.succeed(void 0)
      }).pipe(Effect.provide(makeLayerNoReload(dbUrl))),
    )
  })

  it("publishConfig skips the HTTP call and reports published=false", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await Effect.runPromise(
      SelfManagedCollectorConfigService.publishConfig().pipe(
        Effect.provide(makeLayerNoReload(dbUrl)),
      ),
    )

    expect(result.published).toBe(false)
    expect(result.orgCount).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
