import { afterEach, describe, expect, it } from "vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
	OrgId,
	OrgTinybirdSettingsForbiddenError,
	OrgTinybirdSettingsSyncConflictError,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { TinybirdDeploymentReadiness } from "@maple/domain/tinybird-project-sync"
import { encryptAes256Gcm } from "./Crypto"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"
import { OrgTinybirdSettingsService } from "./OrgTinybirdSettingsService"
import { SelfManagedCollectorConfigService } from "./SelfManagedCollectorConfigService"
import {
	makeTestTinybirdSyncClientLayer,
	type TinybirdSyncClientOverrides,
} from "./TinybirdSyncClient.testing"
import { cleanupTempDirs, createTempDbUrl as makeTempDb, executeSql, queryFirstRow } from "./test-sqlite"

const createdTempDirs: string[] = []
const encryptionKey = Buffer.alloc(32, 7)

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
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

const createTempDbUrl = () => makeTempDb("maple-org-tinybird-", createdTempDirs)

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
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (url: string, overrides: TinybirdSyncClientOverrides = {}) =>
	OrgTinybirdSettingsService.Live.pipe(
		Layer.provide(makeTestTinybirdSyncClientLayer(overrides)),
		Layer.provide(
			SelfManagedCollectorConfigService.Live.pipe(
				Layer.provide(DatabaseLibsqlLive),
				Layer.provide(Env.Default),
				Layer.provide(makeConfig(url)),
			),
		),
		Layer.provide(DatabaseLibsqlLive),
		Layer.provide(Env.Default),
		Layer.provide(makeConfig(url)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const orgAdminRoles = [asRoleName("org:admin")]
const memberRoles = [asRoleName("org:member")]

const getTableRow = <T>(dbPath: string, sql: string, ...params: Array<string | number>) =>
	queryFirstRow<T>(dbPath, sql, params)

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

// Simulate the Cloudflare Workflow binding returning right away while mutating
// DB state asynchronously — mirrors how a real workflow queues and then runs.
const deferred = (fn: () => Promise<void>) => () =>
	new Promise<void>((resolve, reject) => {
		setTimeout(() => {
			fn().then(resolve, reject)
		}, 5)
	})

const simulateSuccessfulWorkflow = (
	dbPath: string,
	opts: { host: string; deploymentId: string; projectRevision: string },
) => {
	const run = async (orgId: string) => {
		const now = Date.now()
		const existing = await queryFirstRow<{
			requested_by: string
			target_token_ciphertext: string
			target_token_iv: string
			target_token_tag: string
		}>(
			dbPath,
			"SELECT requested_by, target_token_ciphertext, target_token_iv, target_token_tag FROM org_tinybird_sync_runs WHERE org_id = ?",
			[orgId],
		)
		if (!existing) throw new Error(`No sync run for ${orgId}`)

		await executeSql(
			dbPath,
			`INSERT INTO org_tinybird_settings (
        org_id, host, token_ciphertext, token_iv, token_tag, sync_status,
        last_sync_at, last_sync_error, project_revision, last_deployment_id,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET
        host=excluded.host,
        token_ciphertext=excluded.token_ciphertext,
        token_iv=excluded.token_iv,
        token_tag=excluded.token_tag,
        sync_status='active',
        last_sync_at=excluded.last_sync_at,
        last_sync_error=NULL,
        project_revision=excluded.project_revision,
        last_deployment_id=excluded.last_deployment_id,
        updated_at=excluded.updated_at,
        updated_by=excluded.updated_by`,
			[
				orgId,
				opts.host,
				existing.target_token_ciphertext,
				existing.target_token_iv,
				existing.target_token_tag,
				now,
				opts.projectRevision,
				opts.deploymentId,
				now,
				now,
				existing.requested_by,
				existing.requested_by,
			],
		)

		await executeSql(
			dbPath,
			`UPDATE org_tinybird_sync_runs
       SET run_status = 'succeeded', phase = 'succeeded',
           deployment_id = ?, deployment_status = 'live',
           error_message = NULL, updated_at = ?, finished_at = ?
       WHERE org_id = ?`,
			[opts.deploymentId, now, now, orgId],
		)
	}
	return async (orgId: OrgId) => {
		void deferred(() => run(orgId))()
	}
}

const simulateFailingWorkflow = (dbPath: string, errorMessage: string) => {
	const run = async (orgId: string) => {
		const now = Date.now()
		await executeSql(
			dbPath,
			`UPDATE org_tinybird_sync_runs
       SET run_status = 'failed', phase = 'failed',
           error_message = ?, updated_at = ?, finished_at = ?
       WHERE org_id = ?`,
			[errorMessage, now, now, orgId],
		)
	}
	return async (orgId: OrgId) => {
		void deferred(() => run(orgId))()
	}
}

const simulateNoOpWorkflow = () => async () => {
	// Leave the queued row as-is; simulates a workflow instance queued but idle.
}

describe("OrgTinybirdSettingsService", () => {
	it("encrypts the token at rest and never returns it from get", async () => {
		const { url, dbPath } = createTempDbUrl()
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: simulateSuccessfulWorkflow(dbPath, {
				host: "https://customer.tinybird.co",
				deploymentId: "dep-1",
				projectRevision: "rev-1",
			}),
		})

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* OrgTinybirdSettingsService.upsert(asOrgId("org_a"), asUserId("user_a"), adminRoles, {
					host: "https://customer.tinybird.co",
					token: "secret-token",
				})

				yield* Effect.promise(() =>
					waitFor(
						() =>
							getTableRow<{ host: string }>(
								dbPath,
								"SELECT host FROM org_tinybird_settings WHERE org_id = ?",
								"org_a",
							),
						(row) => row?.host === "https://customer.tinybird.co",
					),
				)

				return yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles)
			}).pipe(Effect.provide(layer)),
		)

		expect(result.configured).toBe(true)
		expect(result.activeHost).toBe("https://customer.tinybird.co")
		expect(result.syncStatus).toBe("active")
		expect(result.currentRun?.runStatus).toBe("succeeded")
		expect(result.currentRun?.deploymentStatus).toBe("live")
		expect(JSON.stringify(result)).not.toContain("secret-token")

		const row = await getTableRow<{
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
	})

	it("preserves a failed first-time setup as a draft and does not create an active config", async () => {
		const { url, dbPath } = createTempDbUrl()
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: simulateFailingWorkflow(dbPath, "bad credentials"),
		})

		const { immediate, result } = await Effect.runPromise(
			Effect.gen(function* () {
				const immediate = yield* OrgTinybirdSettingsService.upsert(
					asOrgId("org_a"),
					asUserId("user_a"),
					adminRoles,
					{ host: "https://customer.tinybird.co", token: "secret-token" },
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
					),
				)

				const result = yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles)
				return { immediate, result }
			}).pipe(Effect.provide(layer)),
		)

		expect(immediate.configured).toBe(false)
		expect(immediate.draftHost).toBe("https://customer.tinybird.co")
		expect(immediate.syncStatus).toBe("syncing")

		const activeCount = await getTableRow<{ count: number }>(
			dbPath,
			"SELECT COUNT(*) as count FROM org_tinybird_settings WHERE org_id = ?",
			"org_a",
		)
		expect(activeCount?.count).toBe(0)

		expect(result.configured).toBe(false)
		expect(result.activeHost).toBeNull()
		expect(result.syncStatus).toBe("error")
		expect(result.lastSyncError).toBe("bad credentials")
		expect(result.currentRun?.runStatus).toBe("failed")
	})

	it("reconciles stale running settings from Tinybird when the deployment is already live", async () => {
		const { url, dbPath } = createTempDbUrl()
		const encrypted = await Effect.runPromise(
			encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
		)

		const liveStatus: TinybirdDeploymentReadiness = {
			deploymentId: "dep-1",
			status: "live",
			isTerminal: true,
			isReady: true,
			errorMessage: null,
		}

		const layer = makeLayer(url, {
			getDeploymentStatus: async () => liveStatus,
			getProjectRevision: async () => "rev-1",
		})

		// Warm up the service (creates the schema via the first-load bootstrap path).
		await Effect.runPromiseExit(
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		await insertSyncRun(dbPath, {
			orgId: "org_a",
			requestedBy: "user_a",
			targetHost: "https://customer.tinybird.co",
			targetTokenCiphertext: encrypted.ciphertext,
			targetTokenIv: encrypted.iv,
			targetTokenTag: encrypted.tag,
			targetProjectRevision: "rev-1",
			runStatus: "running",
			phase: "starting",
			deploymentId: "dep-1",
			deploymentStatus: "deploying",
			errorMessage: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			finishedAt: null,
		})

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.get(asOrgId("org_a"), adminRoles).pipe(Effect.provide(layer)),
		)

		expect(result.configured).toBe(true)
		expect(result.activeHost).toBe("https://customer.tinybird.co")
		expect(result.syncStatus).toBe("active")
		expect(result.currentRun?.runStatus).toBe("succeeded")
		expect(result.currentRun?.phase).toBe("succeeded")
		expect(result.currentRun?.deploymentStatus).toBe("live")
	})

	it("refreshes the stored deploymentStatus from Tinybird on every read", async () => {
		const { url, dbPath } = createTempDbUrl()
		const encrypted = await Effect.runPromise(
			encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
		)

		const dataReady: TinybirdDeploymentReadiness = {
			deploymentId: "dep-1",
			status: "data_ready",
			isTerminal: false,
			isReady: true,
			errorMessage: null,
		}

		const layer = makeLayer(url, {
			getDeploymentStatus: async () => dataReady,
			getProjectRevision: async () => "rev-1",
		})

		await Effect.runPromiseExit(
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		await insertSyncRun(dbPath, {
			orgId: "org_a",
			requestedBy: "user_a",
			targetHost: "https://customer.tinybird.co",
			targetTokenCiphertext: encrypted.ciphertext,
			targetTokenIv: encrypted.iv,
			targetTokenTag: encrypted.tag,
			targetProjectRevision: "rev-1",
			runStatus: "running",
			phase: "deploying",
			deploymentId: "dep-1",
			deploymentStatus: "creating_schema",
			errorMessage: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			finishedAt: null,
		})

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.use((service) =>
				service.getDeploymentStatus(asOrgId("org_a"), adminRoles),
			).pipe(Effect.provide(layer)),
		)

		expect(result.deploymentStatus).toBe("data_ready")
		expect(result.phase).toBe("setting_live")
		expect(result.runStatus).toBe("running")
		expect(result.isTerminal).toBe(false)

		const row = await getTableRow<{ deployment_status: string | null; phase: string }>(
			dbPath,
			"SELECT deployment_status, phase FROM org_tinybird_sync_runs WHERE org_id = ?",
			"org_a",
		)
		expect(row?.deployment_status).toBe("data_ready")
		expect(row?.phase).toBe("setting_live")
	})

	it("fails stuck non-terminal runs past the workflow timeout", async () => {
		const { url, dbPath } = createTempDbUrl()
		const encrypted = await Effect.runPromise(
			encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
		)

		const stuckStatus: TinybirdDeploymentReadiness = {
			deploymentId: "dep-1",
			status: "creating_schema",
			isTerminal: false,
			isReady: false,
			errorMessage: null,
		}

		const layer = makeLayer(url, {
			getDeploymentStatus: async () => stuckStatus,
			getProjectRevision: async () => "rev-1",
		})

		await Effect.runPromiseExit(
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		const wellPastTimeout = Date.now() - 30 * 60 * 60 * 1000 // 30h > 24h timeout
		await insertSyncRun(dbPath, {
			orgId: "org_a",
			requestedBy: "user_a",
			targetHost: "https://customer.tinybird.co",
			targetTokenCiphertext: encrypted.ciphertext,
			targetTokenIv: encrypted.iv,
			targetTokenTag: encrypted.tag,
			targetProjectRevision: "rev-1",
			runStatus: "running",
			phase: "deploying",
			deploymentId: "dep-1",
			deploymentStatus: "creating_schema",
			errorMessage: null,
			startedAt: wellPastTimeout,
			updatedAt: wellPastTimeout,
			finishedAt: null,
		})

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.use((service) =>
				service.getDeploymentStatus(asOrgId("org_a"), adminRoles),
			).pipe(Effect.provide(layer)),
		)

		expect(result.runStatus).toBe("failed")
		expect(result.isTerminal).toBe(true)
		expect(result.errorMessage).toMatch(/stuck in "creating_schema"/)

		const row = await getTableRow<{ run_status: string; phase: string }>(
			dbPath,
			"SELECT run_status, phase FROM org_tinybird_sync_runs WHERE org_id = ?",
			"org_a",
		)
		expect(row?.run_status).toBe("failed")
		expect(row?.phase).toBe("failed")
	})

	it("returns the last live deployment when the org is idle", async () => {
		const { url, dbPath } = createTempDbUrl()
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: simulateSuccessfulWorkflow(dbPath, {
				host: "https://customer.tinybird.co",
				deploymentId: "dep-1",
				projectRevision: "rev-1",
			}),
		})

		await Effect.runPromise(
			OrgTinybirdSettingsService.upsert(asOrgId("org_a"), asUserId("user_a"), adminRoles, {
				host: "https://customer.tinybird.co",
				token: "token-a",
			}).pipe(Effect.provide(layer)),
		)

		await waitFor(
			() =>
				getTableRow<{ last_deployment_id: string | null }>(
					dbPath,
					"SELECT last_deployment_id FROM org_tinybird_settings WHERE org_id = ?",
					"org_a",
				),
			(row) => row?.last_deployment_id === "dep-1",
		)

		await executeSql(dbPath, "DELETE FROM org_tinybird_sync_runs WHERE org_id = ?", ["org_a"])

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.use((service) =>
				service.getDeploymentStatus(asOrgId("org_a"), adminRoles),
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
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		await insertSyncRun(dbPath, {
			orgId: "org_a",
			requestedBy: "user_a",
			targetHost: "https://customer.tinybird.co",
			targetTokenCiphertext: encrypted.ciphertext,
			targetTokenIv: encrypted.iv,
			targetTokenTag: encrypted.tag,
			targetProjectRevision: "rev-1",
			runStatus: "failed",
			phase: "failed",
			deploymentId: "dep-9",
			deploymentStatus: "failed",
			errorMessage: "broken pipe",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			finishedAt: Date.now(),
		})

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.use((service) =>
				service.getDeploymentStatus(asOrgId("org_a"), adminRoles),
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
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		const result = await Effect.runPromise(
			OrgTinybirdSettingsService.use((service) =>
				service.getDeploymentStatus(asOrgId("org_a"), adminRoles),
			).pipe(Effect.provide(layer)),
		)

		expect(result.hasRun).toBe(false)
		expect(result.hasDeployment).toBe(false)
		expect(result.deploymentId).toBeNull()
		expect(result.deploymentStatus).toBeNull()
	})

	it("returns a conflict when another sync is already active", async () => {
		const { url, dbPath } = createTempDbUrl()
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: simulateNoOpWorkflow(),
		})

		await Effect.runPromiseExit(
			OrgTinybirdSettingsService.get(asOrgId("org_bootstrap"), adminRoles).pipe(Effect.provide(layer)),
		)

		const encrypted = await Effect.runPromise(
			encryptAes256Gcm("token-a", encryptionKey, (message) => new Error(message)),
		)
		await insertSyncRun(dbPath, {
			orgId: "org_a",
			requestedBy: "user_a",
			targetHost: "https://customer-a.tinybird.co",
			targetTokenCiphertext: encrypted.ciphertext,
			targetTokenIv: encrypted.iv,
			targetTokenTag: encrypted.tag,
			targetProjectRevision: "rev-1",
			runStatus: "running",
			phase: "deploying",
			deploymentId: null,
			deploymentStatus: null,
			errorMessage: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			finishedAt: null,
		})

		const exit = await Effect.runPromiseExit(
			OrgTinybirdSettingsService.upsert(asOrgId("org_a"), asUserId("user_b"), adminRoles, {
				host: "https://customer-b.tinybird.co",
				token: "token-b",
			}).pipe(Effect.provide(layer)),
		)

		expect(getError(exit)).toBeInstanceOf(OrgTinybirdSettingsSyncConflictError)
	})

	it("upsert enqueues the sync workflow with the org id", async () => {
		const { url } = createTempDbUrl()

		const calls: Array<{ orgId: string }> = []
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: async (orgId) => {
				calls.push({ orgId })
			},
		})

		await Effect.runPromise(
			OrgTinybirdSettingsService.upsert(asOrgId("org_a"), asUserId("user_a"), adminRoles, {
				host: "https://customer.tinybird.co",
				token: "secret",
			}).pipe(Effect.provide(layer)),
		)

		expect(calls).toEqual([{ orgId: "org_a" }])
	})

	it("allows root and org admins, and rejects members", async () => {
		const { url, dbPath } = createTempDbUrl()
		const layer = makeLayer(url, {
			getProjectRevision: async () => "rev-1",
			startWorkflow: simulateSuccessfulWorkflow(dbPath, {
				host: "https://customer.tinybird.co",
				deploymentId: "dep-1",
				projectRevision: "rev-1",
			}),
		})

		const orgAdminResult = await Effect.runPromise(
			Effect.gen(function* () {
				yield* OrgTinybirdSettingsService.upsert(asOrgId("org_a"), asUserId("user_a"), adminRoles, {
					host: "https://customer.tinybird.co",
					token: "secret-token",
				})

				yield* Effect.promise(() =>
					waitFor(
						() =>
							getTableRow<{ host: string }>(
								dbPath,
								"SELECT host FROM org_tinybird_settings WHERE org_id = ?",
								"org_a",
							),
						(row) => row?.host === "https://customer.tinybird.co",
					),
				)

				return yield* OrgTinybirdSettingsService.get(asOrgId("org_a"), orgAdminRoles)
			}).pipe(Effect.provide(layer)),
		)
		expect(orgAdminResult.activeHost).toBe("https://customer.tinybird.co")

		const memberExit = await Effect.runPromiseExit(
			OrgTinybirdSettingsService.get(asOrgId("org_a"), memberRoles).pipe(Effect.provide(layer)),
		)
		expect(getError(memberExit)).toBeInstanceOf(OrgTinybirdSettingsForbiddenError)
	})
})
