import { afterEach, assert, describe, it } from "@effect/vitest"
import { alertDestinations } from "@maple/db"
import { AlertDestinationId, OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { randomUUID } from "node:crypto"
import { encryptAes256Gcm } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { EmailService } from "../lib/EmailService"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const trackedDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(trackedDbs)
})

const encryptionKey = Buffer.alloc(32, 5)
const encryptionKeyBase64 = encryptionKey.toString("base64")
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)

const configLayer = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://tinybird.test",
		TINYBIRD_TOKEN: "token",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKeyBase64,
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
	}),
)
const envLayer = Env.layer.pipe(Layer.provide(configLayer))
const emailLayer = Layer.succeed(EmailService, {
	isConfigured: true,
	send: () => Effect.void,
})

const makeLayer = (db: TestDb, fetchImpl: typeof globalThis.fetch) => {
	const dependencies = Layer.mergeAll(
		db.layer,
		envLayer,
		emailLayer,
		Layer.succeed(FetchHttpClient.Fetch, fetchImpl),
	)
	const dispatcher = NotificationDispatcher.layer.pipe(Layer.provide(dependencies))
	return Layer.mergeAll(db.layer, dispatcher)
}

const request: NotificationRequest = {
	deliveryKey: "delivery-1",
	ruleId: "rule-1",
	ruleName: "Checkout errors",
	groupKey: "checkout",
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 5,
	eventType: "trigger",
	incidentId: "incident-1",
	incidentStatus: "open",
	dedupeKey: "dedupe-1",
	windowMinutes: 5,
	value: 8,
	sampleCount: 100,
	linkUrl: "https://app.maple.test/alerts/incident-1",
}

describe("NotificationDispatcher", () => {
	it.effect("counts successful and failed deliveries without failing the caller", () => {
		const db = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const orgId = asOrgId("org_notification_test")
			const goodId = asDestinationId(randomUUID())
			const badId = asDestinationId(randomUUID())
			const encrypted = yield* encryptAes256Gcm(
				JSON.stringify({ type: "webhook", url: "https://hooks.test/good", signingSecret: null }),
				encryptionKey,
				(message) => new Error(message),
			)
			const now = new Date("2026-07-16T12:00:00.000Z")
			const database = yield* Database
			yield* database.execute((client) =>
				client.insert(alertDestinations).values([
					{
						id: goodId,
						orgId,
						name: "Good webhook",
						type: "webhook",
						enabled: true,
						configJson: { summary: "hooks.test", channelLabel: null },
						secretCiphertext: encrypted.ciphertext,
						secretIv: encrypted.iv,
						secretTag: encrypted.tag,
						createdAt: now,
						updatedAt: now,
						createdBy: "user_test",
						updatedBy: "user_test",
					},
					{
						id: badId,
						orgId,
						name: "Corrupt webhook",
						type: "webhook",
						enabled: true,
						configJson: { summary: "broken", channelLabel: null },
						secretCiphertext: "invalid",
						secretIv: "invalid",
						secretTag: "invalid",
						createdAt: now,
						updatedAt: now,
						createdBy: "user_test",
						updatedBy: "user_test",
					},
				]),
			)
			const dispatcher = yield* NotificationDispatcher
			const result = yield* dispatcher.dispatch(orgId, [goodId, badId], request)

			assert.deepStrictEqual(result, { delivered: 1, failed: 1 })
		}).pipe(Effect.provide(makeLayer(db, async () => new Response("ok", { status: 200 }))))
	})

	it.live("caps outbound destination delivery concurrency at five", () => {
		const db = createTestDb(trackedDbs)
		let inFlight = 0
		let peakInFlight = 0
		const delayedFetch: typeof globalThis.fetch = async () => {
			inFlight += 1
			peakInFlight = Math.max(peakInFlight, inFlight)
			await new Promise((resolve) => setTimeout(resolve, 20))
			inFlight -= 1
			return new Response("ok", { status: 200 })
		}
		return Effect.gen(function* () {
			const orgId = asOrgId("org_notification_concurrency")
			const destinationIds = Array.from({ length: 8 }, () => asDestinationId(randomUUID()))
			const encrypted = yield* encryptAes256Gcm(
				JSON.stringify({ type: "webhook", url: "https://hooks.test/delayed", signingSecret: null }),
				encryptionKey,
				(message) => new Error(message),
			)
			const now = new Date("2026-07-16T12:00:00.000Z")
			const database = yield* Database
			yield* database.execute((client) =>
				client.insert(alertDestinations).values(
					destinationIds.map((id, index) => ({
						id,
						orgId,
						name: `Delayed webhook ${index}`,
						type: "webhook" as const,
						enabled: true,
						configJson: { summary: "hooks.test", channelLabel: null },
						secretCiphertext: encrypted.ciphertext,
						secretIv: encrypted.iv,
						secretTag: encrypted.tag,
						createdAt: now,
						updatedAt: now,
						createdBy: "user_test",
						updatedBy: "user_test",
					})),
				),
			)

			const dispatcher = yield* NotificationDispatcher
			const result = yield* dispatcher.dispatch(orgId, destinationIds, request)

			assert.deepStrictEqual(result, { delivered: 8, failed: 0 })
			assert.strictEqual(peakInFlight, 5)
		}).pipe(Effect.provide(makeLayer(db, delayedFetch)))
	})
})
