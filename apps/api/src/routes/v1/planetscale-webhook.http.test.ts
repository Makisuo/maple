import { createHmac } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { planetscaleConnections } from "@maple/db"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { encryptAes256Gcm } from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import {
	MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES,
	PlanetScaleWebhookQueue,
	PlanetScaleWebhookQueueError,
	type PlanetScaleWebhookJob,
} from "@/services/integrations/planetscale/PlanetScaleWebhookQueue"
import { PlanetScaleWebhookRouter } from "./planetscale-webhook.http"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 5)
const SECRET = "planetscale-webhook-secret"
const CONNECTION_ID = "ps-connection-1"
const WEBHOOK_PATH = `/api/integrations/planetscale/webhook/${CONNECTION_ID}`
const BODY = JSON.stringify({ event: "webhook.test", organization: "acme" })

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeRouterLayer = (
	testDb: TestDb,
	send: (job: PlanetScaleWebhookJob) => Effect.Effect<void, PlanetScaleWebhookQueueError> = () =>
		Effect.void,
) =>
	PlanetScaleWebhookRouter.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Layer.succeed(PlanetScaleWebhookQueue, { send })),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

describe("PlanetScaleWebhookRouter", () => {
	it.effect("enforces connection-scoped signatures and accepts a verified test delivery", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const database = yield* Database
			const handlerContext = Context.make(Database, database)
			const encrypted = yield* encryptAes256Gcm(
				SECRET,
				ENCRYPTION_KEY,
				(message) => new Error(message),
			).pipe(Effect.orDie)
			const now = new Date("2026-07-11T00:00:00.000Z")
			yield* database.execute((db) =>
				db.insert(planetscaleConnections).values({
					id: CONNECTION_ID,
					orgId: "org_1",
					psOrganization: "acme",
					connectedByUserId: "user_1",
					webhookSecretCiphertext: encrypted.ciphertext,
					webhookSecretIv: encrypted.iv,
					webhookSecretTag: encrypted.tag,
					createdAt: now,
					updatedAt: now,
				}),
			)

			const { handler, dispose } = HttpRouter.toWebHandler(makeRouterLayer(testDb), {
				disableLogger: true,
			})

			yield* Effect.gen(function* () {
				const unknown = yield* Effect.promise(() =>
					handler(
						new Request("http://api.localhost/api/integrations/planetscale/webhook/unknown", {
							method: "POST",
							body: BODY,
						}),
						handlerContext,
					),
				)
				assert.strictEqual(unknown.status, 404)

				const rejected = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: { "x-planetscale-signature": "invalid" },
							body: BODY,
						}),
						handlerContext,
					),
				)
				assert.strictEqual(rejected.status, 401)

				const signature = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex")
				const accepted = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: { "x-planetscale-signature": signature },
							body: BODY,
						}),
						handlerContext,
					),
				)
				assert.strictEqual(accepted.status, 200)
				assert.strictEqual(yield* Effect.promise(() => accepted.text()), "ok")
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("durably enqueues issue events before returning 202", () => {
		const testDb = createTestDb(trackedDbs)
		const jobs: PlanetScaleWebhookJob[] = []
		return Effect.gen(function* () {
			const database = yield* Database
			const encrypted = yield* encryptAes256Gcm(
				SECRET,
				ENCRYPTION_KEY,
				(message) => new Error(message),
			).pipe(Effect.orDie)
			const now = new Date("2026-07-11T00:00:00.000Z")
			yield* database.execute((db) =>
				db.insert(planetscaleConnections).values({
					id: CONNECTION_ID,
					orgId: "org_1",
					psOrganization: "acme",
					connectedByUserId: "user_1",
					webhookSecretCiphertext: encrypted.ciphertext,
					webhookSecretIv: encrypted.iv,
					webhookSecretTag: encrypted.tag,
					createdAt: now,
					updatedAt: now,
				}),
			)
			const issueBody = JSON.stringify({
				timestamp: 1_698_252_879,
				event: "branch.out_of_memory",
				organization: "acme",
				database: "shop",
				resource: { name: "main" },
			})
			const signature = createHmac("sha256", SECRET).update(issueBody, "utf8").digest("hex")
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(testDb, (job) => Effect.sync(() => jobs.push(job))),
				{ disableLogger: true },
			)

			yield* Effect.gen(function* () {
				const rejected = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: { "x-planetscale-signature": "invalid" },
							body: issueBody,
						}),
						Context.make(Database, database),
					),
				)
				assert.strictEqual(rejected.status, 401)
				assert.strictEqual(jobs.length, 0)

				const timestampLessBody = JSON.stringify({
					event: "branch.out_of_memory",
					organization: "acme",
					database: "shop",
				})
				const timestampLess = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: {
								"x-planetscale-signature": createHmac("sha256", SECRET)
									.update(timestampLessBody, "utf8")
									.digest("hex"),
							},
							body: timestampLessBody,
						}),
						Context.make(Database, database),
					),
				)
				assert.strictEqual(timestampLess.status, 400)
				assert.strictEqual(jobs.length, 0)

				const oversizedBody = JSON.stringify({
					timestamp: 1_698_252_879,
					event: "branch.out_of_memory",
					organization: "acme",
					database: "shop",
					resource: { payload: "x".repeat(MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES) },
				})
				const oversized = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: {
								"x-planetscale-signature": createHmac("sha256", SECRET)
									.update(oversizedBody, "utf8")
									.digest("hex"),
							},
							body: oversizedBody,
						}),
						Context.make(Database, database),
					),
				)
				assert.strictEqual(oversized.status, 413)
				assert.strictEqual(jobs.length, 0)

				const accepted = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: { "x-planetscale-signature": signature },
							body: issueBody,
						}),
						Context.make(Database, database),
					),
				)
				assert.strictEqual(accepted.status, 202)
				assert.strictEqual(jobs.length, 1)
				assert.strictEqual(jobs[0]?.kind, "planetscale-webhook")
				assert.strictEqual(jobs[0]?.orgId, "org_1")
				assert.strictEqual(jobs[0]?.connectionId, CONNECTION_ID)
				assert.strictEqual(
					(jobs[0]?.event.data as { readonly event: string }).event,
					"branch.out_of_memory",
				)
				assert.strictEqual(jobs[0]?.event.type, "dev.maple.planetscale.webhook.received.v1")
				assert.strictEqual(jobs[0]?.event.tenantid, "org_1")
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("enqueues every verified factual event before downstream classification", () => {
		const testDb = createTestDb(trackedDbs)
		const jobs: PlanetScaleWebhookJob[] = []
		return Effect.gen(function* () {
			const database = yield* Database
			const encrypted = yield* encryptAes256Gcm(
				SECRET,
				ENCRYPTION_KEY,
				(message) => new Error(message),
			).pipe(Effect.orDie)
			const now = new Date("2026-07-11T00:00:00.000Z")
			yield* database.execute((db) =>
				db.insert(planetscaleConnections).values({
					id: CONNECTION_ID,
					orgId: "org_1",
					psOrganization: "acme",
					connectedByUserId: "user_1",
					webhookSecretCiphertext: encrypted.ciphertext,
					webhookSecretIv: encrypted.iv,
					webhookSecretTag: encrypted.tag,
					createdAt: now,
					updatedAt: now,
				}),
			)
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(testDb, (job) => Effect.sync(() => jobs.push(job))),
				{ disableLogger: true },
			)

			const post = (payload: Record<string, unknown>) => {
				const body = JSON.stringify({ timestamp: 1_698_252_879, ...payload })
				return Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: {
								"x-planetscale-signature": createHmac("sha256", SECRET)
									.update(body, "utf8")
									.digest("hex"),
							},
							body,
						}),
						Context.make(Database, database),
					),
				)
			}

			yield* Effect.gen(function* () {
				// A deploy transition is not an issue, but it IS a chart marker —
				// before the timeline existed this returned 202 and enqueued nothing.
				const deploy = yield* post({
					event: "deploy_request.schema_applied",
					organization: "acme",
					database: "shop",
					resource: { number: 42 },
				})
				assert.strictEqual(deploy.status, 202)
				assert.strictEqual(jobs.length, 1)
				assert.strictEqual(
					(jobs[0]?.event.data as { readonly event: string }).event,
					"deploy_request.schema_applied",
				)

				const branchReady = yield* post({
					event: "branch.ready",
					organization: "acme",
					database: "shop",
					resource: { name: "main" },
				})
				assert.strictEqual(branchReady.status, 202)
				assert.strictEqual(jobs.length, 2)

				// Unknown provider facts also enter the typed event layer. The current
				// issue/timeline consumer may ignore them, but other consumers can opt in.
				const unknown = yield* post({
					event: "branch.some_future_event",
					organization: "acme",
					database: "shop",
				})
				assert.strictEqual(unknown.status, 202)
				assert.strictEqual(jobs.length, 3)
				assert.strictEqual(
					(jobs[2]?.event.data as { readonly event: string }).event,
					"branch.some_future_event",
				)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("returns 503 when durable enqueueing fails", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const database = yield* Database
			const encrypted = yield* encryptAes256Gcm(
				SECRET,
				ENCRYPTION_KEY,
				(message) => new Error(message),
			).pipe(Effect.orDie)
			const now = new Date("2026-07-11T00:00:00.000Z")
			yield* database.execute((db) =>
				db.insert(planetscaleConnections).values({
					id: CONNECTION_ID,
					orgId: "org_1",
					psOrganization: "acme",
					connectedByUserId: "user_1",
					webhookSecretCiphertext: encrypted.ciphertext,
					webhookSecretIv: encrypted.iv,
					webhookSecretTag: encrypted.tag,
					createdAt: now,
					updatedAt: now,
				}),
			)
			const issueBody = JSON.stringify({
				timestamp: 1_698_252_879,
				event: "branch.anomaly",
				organization: "acme",
				database: "shop",
			})
			const signature = createHmac("sha256", SECRET).update(issueBody, "utf8").digest("hex")
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(testDb, () =>
					Effect.fail(new PlanetScaleWebhookQueueError({ message: "queue unavailable" })),
				),
				{ disableLogger: true },
			)

			yield* Effect.gen(function* () {
				const response = yield* Effect.promise(() =>
					handler(
						new Request(`http://api.localhost${WEBHOOK_PATH}`, {
							method: "POST",
							headers: { "x-planetscale-signature": signature },
							body: issueBody,
						}),
						Context.make(Database, database),
					),
				)
				assert.strictEqual(response.status, 503)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}).pipe(Effect.provide(testDb.layer))
	})
})
