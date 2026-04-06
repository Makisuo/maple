import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  OrgId,
  OrgTinybirdSettingsForbiddenError,
  OrgTinybirdSettingsSyncConflictError,
  RoleName,
  UserId,
} from "@maple/domain/http"
import { TinybirdSyncRejectedError } from "@maple/domain/tinybird-project-sync"
import { encryptAes256Gcm } from "./Crypto"
import { Database as DatabaseService } from "./DatabaseLive"
import { Env } from "./Env"
import { OrgTinybirdSettingsService, __testables } from "./OrgTinybirdSettingsService"

const createdTempDirs: string[] = []
const encryptionKey = Buffer.alloc(32, 7)

afterEach(() => {
  __testables.reset()
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async <T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2000) => {
  const startedAt = Date.now()
  while (true) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await sleep(20)
  }
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
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://maple-managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_DB_AUTH_TOKEN: "",
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey.toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
      CLERK_JWT_KEY: "",
    }),
  )

const makeLayer = (url: string) =>
  OrgTinybirdSettingsService.Live.pipe(
    Layer.provide(DatabaseService.Default),
    Layer.provide(Env.Default),
    Layer.provide(makeConfigProvider(url)),
  )

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const orgAdminRoles = [asRoleName("org:admin")]
const memberRoles = [asRoleName("org:member")]

const getTableRow = <T>(dbPath: string, sql: string, ...params: Array<string | number>) => {
  const db = new Database(dbPath, { readonly: true })
  const result = db.query(sql).get(...params) as T | undefined
  db.close()
  return result
}

describe("OrgTinybirdSettingsService", () => {
  it("encrypts the token at rest and never returns it from get", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setStartDeploymentImpl(async () => ({
      projectRevision: "rev-1",
      result: "no_changes",
      deploymentId: "dep-1",
      deploymentStatus: "live",
      errorMessage: null,
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

        yield* Effect.promise(() =>
          waitFor(
            () => getTableRow<{ host: string }>(dbPath, "SELECT host FROM org_tinybird_settings WHERE org_id = ?", "org_a"),
            (row) => row?.host === "https://customer.tinybird.co",
          )
        )

        return yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      configured: true,
      activeHost: "https://customer.tinybird.co",
      draftHost: "https://customer.tinybird.co",
      syncStatus: "active",
      lastSyncAt: expect.any(String),
      lastSyncError: null,
      projectRevision: "rev-1",
      currentRun: {
        targetHost: "https://customer.tinybird.co",
        targetProjectRevision: "rev-1",
        runStatus: "succeeded",
        phase: "succeeded",
        deploymentId: "dep-1",
        deploymentStatus: "live",
        errorMessage: null,
        startedAt: expect.any(String),
        updatedAt: expect.any(String),
        finishedAt: expect.any(String),
        isTerminal: true,
      },
    })
    expect(JSON.stringify(result)).not.toContain("secret-token")

    const row = getTableRow<{
      token_ciphertext: string
      token_iv: string
      token_tag: string
    }>(
      dbPath,
      "SELECT token_ciphertext, token_iv, token_tag FROM org_tinybird_settings WHERE org_id = ?",
      "org_a",
    )

    expect(row).toBeDefined()
    expect(row?.token_ciphertext).not.toBe("secret-token")
    expect(row?.token_iv).toBeTruthy()
    expect(row?.token_tag).toBeTruthy()
  })

  it("preserves a failed first-time setup as a draft and does not create an active config", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setStartDeploymentImpl(async () => {
      throw new TinybirdSyncRejectedError("bad credentials", 401)
    })
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    const { immediate, result } = await Effect.runPromise(
      Effect.gen(function* () {
        const immediate = yield* OrgTinybirdSettingsService.upsert(
          asOrgId("org_a"),
          asUserId("user_a"),
          adminRoles,
          {
            host: "https://customer.tinybird.co",
            token: "secret-token",
          },
        )

        yield* Effect.promise(() =>
          waitFor(
            () =>
              getTableRow<{ run_status: string; error_message: string | null }>(
                dbPath,
                "SELECT run_status, error_message FROM org_tinybird_sync_runs WHERE org_id = ?",
                "org_a",
              ),
            (row) => row?.run_status === "failed" && row.error_message === "bad credentials",
          )
        )

        const result = yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles)
        return { immediate, result }
      }).pipe(Effect.provide(layer)),
    )

    expect(immediate.configured).toBe(false)
    expect(immediate.draftHost).toBe("https://customer.tinybird.co")
    expect(immediate.syncStatus).toBe("syncing")

    const activeCount = getTableRow<{ count: number }>(
      dbPath,
      "SELECT COUNT(*) as count FROM org_tinybird_settings WHERE org_id = ?",
      "org_a",
    )
    expect(activeCount?.count).toBe(0)

    expect(result.configured).toBe(false)
    expect(result.activeHost).toBeNull()
    expect(result.draftHost).toBe("https://customer.tinybird.co")
    expect(result.syncStatus).toBe("error")
    expect(result.lastSyncError).toBe("bad credentials")
    expect(result.currentRun?.runStatus).toBe("failed")
  })

  it("reconciles stale running settings from Tinybird when the deployment is already live", async () => {
    const { url, dbPath } = createTempDbUrl()
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
    )

    __testables.setGetDeploymentTransportStatusImpl(async () => ({
      deploymentId: "dep-1",
      status: "live",
      isTerminal: true,
      errorMessage: null,
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    const db = new Database(dbPath)
    db
      .query(
        `INSERT INTO org_tinybird_sync_runs (
          org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
          target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_a",
        "user_a",
        "https://customer.tinybird.co",
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        "rev-1",
        "running",
        "starting",
        "dep-1",
        "deploying",
        null,
        Date.now(),
        Date.now(),
        null,
      )
    db.close()

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.configured).toBe(true)
    expect(result.activeHost).toBe("https://customer.tinybird.co")
    expect(result.syncStatus).toBe("active")
    expect(result.currentRun?.runStatus).toBe("succeeded")
    expect(result.currentRun?.phase).toBe("succeeded")
    expect(result.currentRun?.deploymentStatus).toBe("live")
  })

  it("refreshes deployment status from Tinybird instead of leaving a run stuck at starting", async () => {
    const { url, dbPath } = createTempDbUrl()
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
    )

    __testables.setGetDeploymentTransportStatusImpl(async () => ({
      deploymentId: "dep-1",
      status: "deploying",
      isTerminal: false,
      errorMessage: null,
    }))

    const layer = makeLayer(url)

    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    const db = new Database(dbPath)
    db
      .query(
        `INSERT INTO org_tinybird_sync_runs (
          org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
          target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_a",
        "user_a",
        "https://customer.tinybird.co",
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        "rev-1",
        "running",
        "starting",
        "dep-1",
        "starting",
        null,
        Date.now(),
        Date.now(),
        null,
      )
    db.close()

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.use((service) =>
        service.getDeploymentStatus(asOrgId("org_a"), adminRoles)
      ).pipe(Effect.provide(layer)),
    )

    expect(result.runStatus).toBe("running")
    expect(result.phase).toBe("deploying")
    expect(result.deploymentStatus).toBe("deploying")
    expect(result.isTerminal).toBe(false)
  })

  it("returns the last live deployment when the org is idle", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setStartDeploymentImpl(async () => ({
      projectRevision: "rev-1",
      result: "no_changes",
      deploymentId: "dep-1",
      deploymentStatus: "live",
      errorMessage: null,
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    await Effect.runPromise(
      OrgTinybirdSettingsService.upsert(
        asOrgId("org_a"),
        asUserId("user_a"),
        adminRoles,
        {
          host: "https://customer.tinybird.co",
          token: "token-a",
        },
      ).pipe(Effect.provide(layer)),
    )

    await Effect.runPromise(
      Effect.promise(() =>
        waitFor(
          () => getTableRow<{ last_deployment_id: string | null }>(
            dbPath,
            "SELECT last_deployment_id FROM org_tinybird_settings WHERE org_id = ?",
            "org_a",
          ),
          (row) => row?.last_deployment_id === "dep-1",
        ),
      ).pipe(Effect.provide(layer)),
    )

    const db = new Database(dbPath)
    db.query("DELETE FROM org_tinybird_sync_runs WHERE org_id = ?").run("org_a")
    db.close()

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.use((service) =>
        service.getDeploymentStatus(asOrgId("org_a"), adminRoles)
      ).pipe(Effect.provide(layer)),
    )

    expect(result.hasRun).toBe(true)
    expect(result.deploymentId).toBe("dep-1")
    expect(result.deploymentStatus).toBe("live")
    expect(result.runStatus).toBe("succeeded")
    expect(result.isTerminal).toBe(true)
  })

  it("returns the final failed deployment summary with its error message", async () => {
    const { url, dbPath } = createTempDbUrl()
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
    )

    const layer = makeLayer(url)

    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    const db = new Database(dbPath)
    db
      .query(
        `INSERT INTO org_tinybird_sync_runs (
          org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
          target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_a",
        "user_a",
        "https://customer.tinybird.co",
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        "rev-1",
        "failed",
        "failed",
        "dep-9",
        "failed",
        "broken pipe",
        Date.now(),
        Date.now(),
        Date.now(),
      )
    db.close()

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.use((service) =>
        service.getDeploymentStatus(asOrgId("org_a"), adminRoles)
      ).pipe(Effect.provide(layer)),
    )

    expect(result.hasRun).toBe(true)
    expect(result.deploymentId).toBe("dep-9")
    expect(result.deploymentStatus).toBe("failed")
    expect(result.runStatus).toBe("failed")
    expect(result.errorMessage).toBe("broken pipe")
    expect(result.isTerminal).toBe(true)
  })

  it("returns no deployment summary when the org has never deployed", async () => {
    const { url } = createTempDbUrl()
    const layer = makeLayer(url)

    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.use((service) =>
        service.getDeploymentStatus(asOrgId("org_a"), adminRoles)
      ).pipe(Effect.provide(layer)),
    )

    expect(result.hasRun).toBe(false)
    expect(result.hasDeployment).toBe(false)
    expect(result.deploymentId).toBeNull()
    expect(result.deploymentStatus).toBeNull()
  })

  it("marks a run as failed when it never gets a deployment id", async () => {
    const { url, dbPath } = createTempDbUrl()
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
    )

    const layer = makeLayer(url)

    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(layer),
      ),
    )

    const staleStartedAt = Date.now() - (2_000 * 300) - 1_000

    const db = new Database(dbPath)
    db
      .query(
        `INSERT INTO org_tinybird_sync_runs (
          org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
          target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_a",
        "user_a",
        "https://customer.tinybird.co",
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        "rev-1",
        "running",
        "starting",
        null,
        null,
        null,
        staleStartedAt,
        staleStartedAt,
        null,
      )
    db.close()

    const result = await Effect.runPromise(
      OrgTinybirdSettingsService.use((service) =>
        service.getDeploymentStatus(asOrgId("org_a"), adminRoles)
      ).pipe(Effect.provide(layer)),
    )

    expect(result.runStatus).toBe("failed")
    expect(result.phase).toBe("failed")
    expect(result.errorMessage).toContain("deployment id")
    expect(result.isTerminal).toBe(true)
  })

  it("keeps the previous active config live until a new host finishes syncing", async () => {
    const { url, dbPath } = createTempDbUrl()
    let currentRevision = "rev-a"
    __testables.setGetProjectRevisionImpl(async () => currentRevision)
    __testables.setStartDeploymentImpl(async ({ baseUrl }) => {
      if (baseUrl.includes("customer-a")) {
        return {
          projectRevision: "rev-a",
          result: "no_changes",
          deploymentId: "dep-a",
          deploymentStatus: "live",
          errorMessage: null,
        }
      }

      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            projectRevision: "rev-b",
            result: "success" as const,
            deploymentId: "dep-b",
            deploymentStatus: "deploying",
            errorMessage: null,
          })
        }, 100)
      })
    })
    __testables.setGetDeploymentTransportStatusImpl(async () => ({
      deploymentId: "dep-b",
      status: "data_ready",
      isTerminal: true,
      errorMessage: null,
    }))
    __testables.setSetDeploymentLiveImpl(async () => {})

    const layer = makeLayer(url)

    const { stillActive, switched } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* OrgTinybirdSettingsService.upsert(
          asOrgId("org_a"),
          asUserId("user_a"),
          adminRoles,
          {
            host: "https://customer-a.tinybird.co",
            token: "token-a",
          },
        )

        yield* Effect.promise(() =>
          waitFor(
            () => getTableRow<{ host: string }>(dbPath, "SELECT host FROM org_tinybird_settings WHERE org_id = ?", "org_a"),
            (row) => row?.host === "https://customer-a.tinybird.co",
          )
        )

        currentRevision = "rev-b"

        yield* OrgTinybirdSettingsService.upsert(
          asOrgId("org_a"),
          asUserId("user_b"),
          adminRoles,
          {
            host: "https://customer-b.tinybird.co",
            token: "token-b",
          },
        )

        const stillActive = yield* OrgTinybirdSettingsService.resolveRuntimeConfig(asOrgId("org_a"))
        const switched = yield* Effect.promise(() =>
          waitFor(
            () => getTableRow<{ host: string; project_revision: string }>(dbPath, "SELECT host, project_revision FROM org_tinybird_settings WHERE org_id = ?", "org_a"),
            (row) => row?.host === "https://customer-b.tinybird.co",
          )
        )

        return { stillActive, switched }
      }).pipe(Effect.provide(layer)),
    )

    expect(switched).toBeDefined()
    expect(switched?.project_revision).toBe("rev-b")
    expect(Option.getOrUndefined(stillActive)?.host).toBe("https://customer-a.tinybird.co")
  })

  it("returns a conflict when another sync is already active", async () => {
    const { url } = createTempDbUrl()
    type StartResult = {
      projectRevision: string
      result: "success"
      deploymentId: string
      deploymentStatus: string | null
      errorMessage: string | null
    }
    let resolveStart: ((value: StartResult) => void) | null = null

    __testables.setGetProjectRevisionImpl(async () => "rev-1")
    __testables.setGetDeploymentTransportStatusImpl(async () => ({
      deploymentId: "dep-1",
      status: "data_ready",
      isTerminal: true,
      errorMessage: null,
    }))
    __testables.setSetDeploymentLiveImpl(async () => {})
    __testables.setStartDeploymentImpl(
      () =>
        new Promise<StartResult>((resolve) => {
          resolveStart = resolve
        }),
    )

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

    expect(getError(exit)).toBeInstanceOf(OrgTinybirdSettingsSyncConflictError)

    if (resolveStart) {
      ;(resolveStart as (value: StartResult) => void)({
        projectRevision: "rev-1",
        result: "success",
        deploymentId: "dep-1",
        deploymentStatus: "deploying",
        errorMessage: null,
      })
    }
  })

  it("resumes a pending sync run after restart and promotes it when deployment is ready", async () => {
    const { url, dbPath } = createTempDbUrl()
    const encrypted = await Effect.runPromise(
      encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
    )

    const bootstrapLayer = makeLayer(url)
    await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(
        Effect.provide(bootstrapLayer),
      ),
    )

    const db = new Database(dbPath)
    db
      .query(
        `INSERT INTO org_tinybird_sync_runs (
          org_id, requested_by, target_host, target_token_ciphertext, target_token_iv, target_token_tag,
          target_project_revision, run_status, phase, deployment_id, deployment_status, error_message,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_a",
        "user_a",
        "https://customer.tinybird.co",
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        "rev-1",
        "running",
        "waiting_for_data",
        "dep-1",
        "deploying",
        null,
        Date.now(),
        Date.now(),
        null,
      )
    db.close()

    __testables.setGetDeploymentTransportStatusImpl(async () => ({
      deploymentId: "dep-1",
      status: "data_ready",
      isTerminal: true,
      errorMessage: null,
    }))
    __testables.setSetDeploymentLiveImpl(async () => {})
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const resumeLayer = makeLayer(url)

    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitFor(
            () => getTableRow<{ host: string }>(dbPath, "SELECT host FROM org_tinybird_settings WHERE org_id = ?", "org_a"),
            (row) => row?.host === "https://customer.tinybird.co",
          )
        )
        return yield* OrgTinybirdSettingsService.resolveRuntimeConfig(asOrgId("org_a"))
      }).pipe(Effect.provide(resumeLayer)),
    )

    expect(Option.getOrUndefined(resumed)?.projectRevision).toBe("rev-1")
  })

  it("allows root and org admins, and rejects members", async () => {
    const { url, dbPath } = createTempDbUrl()
    __testables.setStartDeploymentImpl(async () => ({
      projectRevision: "rev-1",
      result: "no_changes",
      deploymentId: "dep-1",
      deploymentStatus: "live",
      errorMessage: null,
    }))
    __testables.setGetProjectRevisionImpl(async () => "rev-1")

    const layer = makeLayer(url)

    const orgAdminResult = await Effect.runPromise(
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

        yield* Effect.promise(() =>
          waitFor(
            () => getTableRow<{ host: string }>(dbPath, "SELECT host FROM org_tinybird_settings WHERE org_id = ?", "org_a"),
            (row) => row?.host === "https://customer.tinybird.co",
          )
        )

        return yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), orgAdminRoles)
      }).pipe(Effect.provide(layer)),
    )
    expect(orgAdminResult.activeHost).toBe("https://customer.tinybird.co")

    const memberExit = await Effect.runPromiseExit(
      OrgTinybirdSettingsService.get(asOrgId("org_a"), memberRoles).pipe(
        Effect.provide(layer),
      ),
    )
    expect(getError(memberExit)).toBeInstanceOf(OrgTinybirdSettingsForbiddenError)
  })
});
