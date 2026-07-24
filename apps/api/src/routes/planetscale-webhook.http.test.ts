import { createHmac } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { planetscaleConnections } from "@maple/db"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { encryptAes256Gcm } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import {
	PlanetScaleWebhookQueue,
	PlanetScaleWebhookQueueError,
	type PlanetScaleWebhookJob,
} from "../services/planetscale/PlanetScaleWebhookQueue"
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
				assert.strictEqual(jobs[0]?.payload.event, "branch.out_of_memory")
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
