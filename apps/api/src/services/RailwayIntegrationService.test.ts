import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import {
	CreateRailwayTargetRequest,
	OrgId,
	RailwayMetricsIntervalSeconds,
	RailwayResultReport,
	UpdateRailwayTargetRequest,
} from "@maple/domain/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { RailwayIntegrationService } from "./RailwayIntegrationService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) =>
	RailwayIntegrationService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asInterval = Schema.decodeUnknownSync(RailwayMetricsIntervalSeconds)

const ACCOUNT_TOKEN = "railway-account-token"
const WORKSPACE_TOKEN = "railway-workspace-token"

const projectsFixture = {
	projects: {
		edges: [
			{
				node: {
					id: "proj-1",
					name: "maple-demo",
					environments: {
						edges: [
							{
								node: {
									id: "env-1",
									name: "production",
									serviceInstances: {
										edges: [
											{ node: { serviceId: "svc-1", serviceName: "api" } },
											{ node: { serviceId: "svc-2", serviceName: "worker" } },
										],
									},
								},
							},
							{
								node: {
									id: "env-2",
									name: "staging",
									serviceInstances: { edges: [] },
								},
							},
						],
					},
					services: {
						edges: [
							{ node: { id: "svc-1", name: "api" } },
							{ node: { id: "svc-2", name: "worker" } },
						],
					},
				},
			},
		],
	},
}

/**
 * Emulates Railway's GraphQL endpoint: account tokens resolve `me`, workspace
 * tokens get a GraphQL "Not Authorized" for `me` but can list projects, and
 * unknown tokens are rejected with HTTP 401.
 */
const stubRailwayFetch = () => {
	const calls: Array<{ query: string; authorization: string | null }> = []
	globalThis.fetch = (async (input, init) => {
		const headers = new Headers(init?.headers)
		const authorization = headers.get("authorization")
		const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
		const query = body.query ?? ""
		calls.push({ query, authorization })

		const token = authorization?.replace(/^Bearer /, "")
		if (token !== ACCOUNT_TOKEN && token !== WORKSPACE_TOKEN) {
			return new Response("Unauthorized", { status: 401 })
		}

		if (query.includes("mapleValidateToken")) {
			if (token === WORKSPACE_TOKEN) {
				return Response.json({ data: null, errors: [{ message: "Not Authorized" }] })
			}
			return Response.json({ data: { me: { name: "David", email: "david@example.com" } } })
		}

		return Response.json({ data: projectsFixture })
	}) as typeof fetch
	return calls
}

describe("RailwayIntegrationService", () => {
	it.effect("connect validates an account token and reports a connected status", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const status = yield* service.connect(asOrgId("org_1"), "user_1", ACCOUNT_TOKEN)

			assert.isTrue(status.connected)
			assert.strictEqual(status.tokenType, "account")
			assert.strictEqual(status.accountName, "David")
			assert.isNull(status.lastValidationError)
			assert.strictEqual(status.targetCount, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("connect classifies a workspace token via the projects fallback", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const status = yield* service.connect(asOrgId("org_1"), "user_1", WORKSPACE_TOKEN)

			assert.isTrue(status.connected)
			assert.strictEqual(status.tokenType, "workspace")
			assert.isNull(status.accountName)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("connect rejects a token Railway does not accept", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const exit = yield* service.connect(asOrgId("org_1"), "user_1", "bogus-token").pipe(Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const status = yield* service.status(asOrgId("org_1"))
			assert.isFalse(status.connected)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("discover annotates environments with existing target ids", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			const target = yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			const discovery = yield* service.discover(orgId)
			assert.strictEqual(discovery.projects.length, 1)
			const project = discovery.projects[0]!
			assert.strictEqual(project.name, "maple-demo")
			const production = project.environments.find((environment) => environment.id === "env-1")!
			assert.strictEqual(production.targetId, target.id)
			assert.deepStrictEqual(
				production.services.map((service_) => service_.name),
				["api", "worker"],
			)
			const staging = project.environments.find((environment) => environment.id === "env-2")!
			assert.isNull(staging.targetId)
			// No service instances in staging → falls back to the project-level services.
			assert.strictEqual(staging.services.length, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("createTarget stores names + services and rejects duplicates", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)

			const target = yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)
			assert.strictEqual(target.projectName, "maple-demo")
			assert.strictEqual(target.environmentName, "production")
			assert.strictEqual(target.serviceCount, 2)
			assert.strictEqual(target.metricsIntervalSeconds, 300)
			assert.isTrue(target.logsEnabled)
			assert.isTrue(target.metricsEnabled)

			const duplicate = yield* service
				.createTarget(
					orgId,
					new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
				)
				.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(duplicate))

			const unknownEnv = yield* service
				.createTarget(
					orgId,
					new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-404" }),
				)
				.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(unknownEnv))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("updateTarget toggles flags and deleteTarget removes the row", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			const target = yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			const updated = yield* service.updateTarget(
				orgId,
				target.id,
				new UpdateRailwayTargetRequest({
					logsEnabled: false,
					metricsIntervalSeconds: asInterval(120),
				}),
			)
			assert.isFalse(updated.logsEnabled)
			assert.strictEqual(updated.metricsIntervalSeconds, 120)
			assert.isTrue(updated.metricsEnabled)

			yield* service.deleteTarget(orgId, target.id)
			const listed = yield* service.listTargets(orgId)
			assert.strictEqual(listed.targets.length, 0)

			const missing = yield* service.deleteTarget(orgId, target.id).pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(missing))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listAllEnabledInternal returns the decrypted token and cached services", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			const entries = yield* service.listAllEnabledInternal()
			assert.strictEqual(entries.length, 1)
			const entry = entries[0]!
			// Round-trips through AES-256-GCM — proves the token was stored encrypted
			// with the configured key, not in plaintext.
			assert.strictEqual(entry.token, ACCOUNT_TOKEN)
			assert.strictEqual(entry.target.environmentId, "env-1")
			assert.deepStrictEqual(
				entry.services.map((service_) => service_.id),
				["svc-1", "svc-2"],
			)

			// Disabled targets drop out of the work list.
			const target = (yield* service.listTargets(orgId)).targets[0]!
			yield* service.updateTarget(orgId, target.id, new UpdateRailwayTargetRequest({ enabled: false }))
			const afterDisable = yield* service.listAllEnabledInternal()
			assert.strictEqual(afterDisable.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordResults advances watermarks monotonically and tracks health", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			const target = yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			yield* service.recordResults([
				new RailwayResultReport({
					targetId: target.id,
					kind: "logs",
					at: 2_000,
					error: null,
					recordsIngested: 10,
					newLogWatermarkMs: 5_000,
				}),
			])
			// An older/duplicate report must not rewind the watermark.
			yield* service.recordResults([
				new RailwayResultReport({
					targetId: target.id,
					kind: "logs",
					at: 3_000,
					error: null,
					newLogWatermarkMs: 4_000,
				}),
			])

			const entries = yield* service.listAllEnabledInternal()
			assert.strictEqual(entries[0]!.target.logWatermarkAt?.getTime(), 5_000)

			// A failing metrics report surfaces on target health without clearing lastLogAt.
			yield* service.recordResults([
				new RailwayResultReport({
					targetId: target.id,
					kind: "metrics",
					at: 6_000,
					error: "Railway API returned HTTP 500",
				}),
			])
			const listed = yield* service.listTargets(orgId)
			assert.strictEqual(listed.targets[0]!.lastError, "[metrics] Railway API returned HTTP 500")
			assert.isNotNull(listed.targets[0]!.lastLogAt)

			const status = yield* service.status(orgId)
			assert.strictEqual(status.erroredTargetCount, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("discover flags the connection only on auth rejections, not transient outages", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)

			// Transient Railway outage: discovery fails, but the card must NOT
			// flip to "Reconnect needed".
			globalThis.fetch = (async () => new Response("oops", { status: 500 })) as typeof fetch
			const outage = yield* service.discover(orgId).pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(outage))
			const afterOutage = yield* service.status(orgId)
			assert.isNull(afterOutage.lastValidationError)

			// A genuine token rejection does flag it.
			globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch
			const revoked = yield* service.discover(orgId).pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(revoked))
			const afterRevocation = yield* service.status(orgId)
			assert.isNotNull(afterRevocation.lastValidationError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("an unauthorized report flags the connection for reconnection", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			const target = yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			yield* service.recordResults([
				new RailwayResultReport({
					targetId: target.id,
					kind: "logs",
					at: 1_000,
					error: "Railway rejected the API token",
					unauthorized: true,
				}),
			])

			const status = yield* service.status(orgId)
			assert.isNotNull(status.lastValidationError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("disconnect removes the connection and its targets", () => {
		const testDb = createTestDb(trackedDbs)
		stubRailwayFetch()
		return Effect.gen(function* () {
			const service = yield* RailwayIntegrationService
			const orgId = asOrgId("org_1")
			yield* service.connect(orgId, "user_1", ACCOUNT_TOKEN)
			yield* service.createTarget(
				orgId,
				new CreateRailwayTargetRequest({ projectId: "proj-1", environmentId: "env-1" }),
			)

			const result = yield* service.disconnect(orgId)
			assert.isTrue(result.disconnected)

			const status = yield* service.status(orgId)
			assert.isFalse(status.connected)
			assert.strictEqual(status.targetCount, 0)

			const entries = yield* service.listAllEnabledInternal()
			assert.strictEqual(entries.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
