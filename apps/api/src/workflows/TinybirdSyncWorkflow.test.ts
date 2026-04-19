import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { encryptAes256Gcm } from "../services/Crypto"
import { DatabaseLibsqlLive } from "../services/DatabaseLibsqlLive"
import { Env } from "../services/Env"
import {
  cleanupTempDirs,
  createTempDbUrl as makeTempDb,
  executeSql,
  queryFirstRow,
} from "../services/test-sqlite"
import {
  runTinybirdSyncWorkflow,
  type TinybirdSyncWorkflowPayload,
  type WorkflowEventLike,
  type WorkflowStepLike,
} from "./TinybirdSyncWorkflow.run"

const createdTempDirs: string[] = []
const encryptionKey = Buffer.alloc(32, 7)
const encryptionKeyBase64 = encryptionKey.toString("base64")

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanupTempDirs(createdTempDirs)
})

const makeAppLayer = (dbUrl: string) =>
  DatabaseLibsqlLive.pipe(
    Layer.provide(Env.Default),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PORT: "3472",
          TINYBIRD_HOST: "https://maple-managed.tinybird.co",
          TINYBIRD_TOKEN: "managed-token",
          MAPLE_DB_URL: dbUrl,
          MAPLE_AUTH_MODE: "self_hosted",
          MAPLE_ROOT_PASSWORD: "test-root-password",
          MAPLE_DEFAULT_ORG_ID: "default",
          MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64,
          MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
        }),
      ),
    ),
  )

const bootstrapDb = async (dbUrl: string) => {
  // Run a trivial query through the layer to trigger migrations.
  await Effect.runPromise(
    Effect.gen(function* () {
      // Just provide the layer — migrations run as a side-effect of building it.
      yield* Effect.succeed(void 0)
    }).pipe(Effect.provide(makeAppLayer(dbUrl))),
  )
}

const insertSyncRun = async (
  dbPath: string,
  row: {
    orgId: string
    requestedBy: string
    targetHost: string
    targetTokenCiphertext: string
    targetTokenIv: string
    targetTokenTag: string
    targetProjectRevision: string
    runStatus: string
    phase: string
    deploymentId: string | null
    deploymentStatus: string | null
    errorMessage: string | null
    startedAt: number
    updatedAt: number
    finishedAt: number | null
  },
) =>
  executeSql(
    dbPath,
    `INSERT INTO org_tinybird_sync_runs (
      org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
      target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
      started_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.orgId,
      row.requestedBy,
      row.targetHost,
      row.targetTokenCiphertext,
      row.targetTokenIv,
      row.targetTokenTag,
      row.targetProjectRevision,
      row.runStatus,
      row.phase,
      row.deploymentId,
      row.deploymentStatus,
      row.errorMessage,
      row.startedAt,
      row.updatedAt,
      row.finishedAt,
    ],
  )

/** Stub WorkflowStep that just invokes callbacks inline and records names. */
const makeStepStub = (): { step: WorkflowStepLike; names: string[] } => {
  const names: string[] = []
  const step: WorkflowStepLike = {
    do: (async (
      name: string,
      configOrCallback: unknown,
      maybeCallback?: unknown,
    ) => {
      names.push(name)
      const callback =
        typeof configOrCallback === "function"
          ? (configOrCallback as () => Promise<unknown>)
          : (maybeCallback as () => Promise<unknown>)
      return callback()
    }) as WorkflowStepLike["do"],
  }
  return { step, names }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const makeEvent = (orgId: string): WorkflowEventLike<TinybirdSyncWorkflowPayload> => ({
  payload: { orgId },
})

describe("TinybirdSyncWorkflow", () => {
  let dbUrl: string
  let dbPath: string

  beforeEach(async () => {
    const temp = makeTempDb("maple-tinybird-workflow-", createdTempDirs)
    dbUrl = temp.url
    dbPath = temp.dbPath
    await bootstrapDb(dbUrl)
  })

  const seedPendingRun = async (opts: {
    orgId: string
    targetHost: string
  }) => {
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("plaintext-token", encryptionKey, (message) => new Error(message)),
    )

    const now = Date.now()
    await insertSyncRun(dbPath, {
      orgId: opts.orgId,
      requestedBy: "user_a",
      targetHost: opts.targetHost,
      targetTokenCiphertext: encrypted.ciphertext,
      targetTokenIv: encrypted.iv,
      targetTokenTag: encrypted.tag,
      targetProjectRevision: "rev-1",
      runStatus: "queued",
      phase: "starting",
      deploymentId: null,
      deploymentStatus: null,
      errorMessage: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    })
  }

  it("completes the full happy path and marks the run succeeded", async () => {
    await seedPendingRun({ orgId: "org_a", targetHost: "https://customer.tinybird.co" })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"

      if (url.includes("/v1/deploy") && method === "POST") {
        return jsonResponse({
          result: "success",
          deployment: { id: "dep-1", status: "deploying" },
        })
      }

      if (url.includes("/v1/deployments/dep-1") && method === "GET") {
        return jsonResponse({ deployment: { status: "data_ready" } })
      }

      if (url.includes("/v1/deployments/dep-1/set-live") && method === "POST") {
        return new Response("", { status: 204 })
      }

      if (url.includes("/v1/deployments") && method === "GET") {
        return jsonResponse({ deployments: [] })
      }

      if (url.includes("/v1/deployments/") && method === "DELETE") {
        return new Response("", { status: 204 })
      }

      throw new Error(`Unexpected request: ${method} ${url}`)
    }) as unknown as typeof fetch

    const { step, names } = makeStepStub()
    const appLayer = makeAppLayer(dbUrl)

    const result = await runTinybirdSyncWorkflow(
      { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64 },
      makeEvent("org_a"),
      step,
      { appLayer },
    )

    expect(result.result).toBe("succeeded")
    expect(result.deploymentId).toBe("dep-1")
    expect(names).toEqual([
      "load-sync-run",
      "decrypt-token",
      "mark-running",
      "cleanup-stale-deployments",
      "start-deployment",
      "mark-deploying",
      "poll-deployment",
      "mark-setting-live",
      "set-live",
      "promote-active-config",
      "mark-succeeded",
    ])

    const runRow = await queryFirstRow<{
      run_status: string
      phase: string
      deployment_status: string
      deployment_id: string
    }>(
      dbPath,
      "SELECT run_status, phase, deployment_status, deployment_id FROM org_tinybird_sync_runs WHERE org_id = ?",
      ["org_a"],
    )
    expect(runRow?.run_status).toBe("succeeded")
    expect(runRow?.phase).toBe("succeeded")
    expect(runRow?.deployment_status).toBe("live")

    const activeRow = await queryFirstRow<{
      host: string
      last_deployment_id: string
      sync_status: string
    }>(
      dbPath,
      "SELECT host, last_deployment_id, sync_status FROM org_tinybird_settings WHERE org_id = ?",
      ["org_a"],
    )
    expect(activeRow?.host).toBe("https://customer.tinybird.co")
    expect(activeRow?.last_deployment_id).toBe("dep-1")
    expect(activeRow?.sync_status).toBe("active")
  })

  it("short-circuits on no_changes and promotes the active config", async () => {
    await seedPendingRun({ orgId: "org_a", targetHost: "https://customer.tinybird.co" })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"

      if (url.includes("/v1/deploy") && method === "POST") {
        return jsonResponse({
          result: "no_changes",
          deployment: { id: "dep-n", status: "live" },
        })
      }

      if (url.includes("/v1/deployments") && method === "GET") {
        return jsonResponse({ deployments: [] })
      }

      return new Response("", { status: 204 })
    }) as unknown as typeof fetch

    const { step, names } = makeStepStub()
    const appLayer = makeAppLayer(dbUrl)

    const result = await runTinybirdSyncWorkflow(
      { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64 },
      makeEvent("org_a"),
      step,
      { appLayer },
    )

    expect(result.result).toBe("no_changes")
    expect(names).toContain("promote-no-changes")
    expect(names).not.toContain("poll-deployment")

    const runRow = await queryFirstRow<{ run_status: string; deployment_status: string }>(
      dbPath,
      "SELECT run_status, deployment_status FROM org_tinybird_sync_runs WHERE org_id = ?",
      ["org_a"],
    )
    expect(runRow?.run_status).toBe("succeeded")
    expect(runRow?.deployment_status).toBe("live")
  })

  it("marks the run failed when start-deployment returns a rejected error", async () => {
    await seedPendingRun({ orgId: "org_a", targetHost: "https://customer.tinybird.co" })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"

      if (url.includes("/v1/deployments") && method === "GET") {
        return jsonResponse({ deployments: [] })
      }

      if (url.includes("/v1/deploy") && method === "POST") {
        return new Response("bad credentials", { status: 401 })
      }

      throw new Error(`Unexpected request: ${method} ${url}`)
    }) as unknown as typeof fetch

    const { step } = makeStepStub()
    const appLayer = makeAppLayer(dbUrl)

    const result = await runTinybirdSyncWorkflow(
      { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64 },
      makeEvent("org_a"),
      step,
      { appLayer },
    )

    expect(result.result).toBe("failed")
    expect(result.errorMessage).toBeTruthy()

    const runRow = await queryFirstRow<{ run_status: string; error_message: string | null }>(
      dbPath,
      "SELECT run_status, error_message FROM org_tinybird_sync_runs WHERE org_id = ?",
      ["org_a"],
    )
    expect(runRow?.run_status).toBe("failed")
    expect(runRow?.error_message).toBeTruthy()
  })

  it("re-throws TinybirdDeploymentNotReadyError so Cloudflare step retries fire", async () => {
    await seedPendingRun({ orgId: "org_a", targetHost: "https://customer.tinybird.co" })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"

      if (url.includes("/v1/deployments/dep-1") && method === "GET") {
        // Non-terminal, non-ready → pollDeploymentStep throws NotReady.
        return jsonResponse({ deployment: { status: "deploying" } })
      }

      if (url.includes("/v1/deploy") && method === "POST") {
        return jsonResponse({
          result: "success",
          deployment: { id: "dep-1", status: "deploying" },
        })
      }

      if (url.includes("/v1/deployments") && method === "GET") {
        return jsonResponse({ deployments: [] })
      }

      return new Response("", { status: 204 })
    }) as unknown as typeof fetch

    const { step } = makeStepStub()
    const appLayer = makeAppLayer(dbUrl)

    await expect(
      runTinybirdSyncWorkflow(
        { MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64 },
        makeEvent("org_a"),
        step,
        { appLayer },
      ),
    ).rejects.toMatchObject({ _tag: "TinybirdDeploymentNotReadyError" })

    // The run should stay in a non-terminal state so a retry is meaningful.
    const runRow = await queryFirstRow<{ run_status: string; phase: string }>(
      dbPath,
      "SELECT run_status, phase FROM org_tinybird_sync_runs WHERE org_id = ?",
      ["org_a"],
    )
    expect(runRow?.run_status).toBe("running")
    expect(runRow?.phase).toBe("deploying")
  })
})
