import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AlertDestinationId, OrgId } from "@maple/domain/http"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const emailStub: (typeof EmailService)["Service"] = {
	isConfigured: true,
	send: () => Effect.void,
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const ORG = asOrgId("org_dispatcher_test")
const DESTINATION_ID = asDestinationId("00000000-0000-4000-8000-000000000001")

const request: NotificationRequest = {
	deliveryKey: "org_dispatcher_test:dest:delivery",
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: null,
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	eventType: "trigger",
	incidentId: null,
	incidentStatus: "open",
	dedupeKey: "org_dispatcher_test:rule_1",
	windowMinutes: 5,
	value: 0.08,
	sampleCount: 1200,
	linkUrl: "https://web.localhost/alerts",
}

describe("NotificationDispatcher.dispatch", () => {
	it.effect("reports a destination-lookup failure as failed, not missing", () => {
		// A transient database error must keep the consumers' retry machinery in
		// play — "missing" is terminal to the escalation outbox and error
		// notification queue, which would silently drop the notification.
		const failingDb = Layer.succeed(Database, {
			execute: () => Effect.fail(new DatabaseError({ message: "connection reset", cause: null })),
		})
		const layer = NotificationDispatcher.layer.pipe(
			Layer.provide(Layer.succeed(EmailService, emailStub)),
			Layer.provideMerge(failingDb),
			Layer.provideMerge(Env.layer),
			Layer.provide(testConfig()),
		)
		return Effect.gen(function* () {
			const dispatcher = yield* NotificationDispatcher
			const result = yield* dispatcher.dispatch(ORG, [DESTINATION_ID], request)

			assert.strictEqual(result.delivered, 0)
			assert.strictEqual(result.failed, 1)
			assert.strictEqual(result.destinations[0]?.status, "failed")
			assert.strictEqual(result.destinations[0]?.error, "destination_lookup_failed")
		}).pipe(Effect.provide(layer))
	})

	it.effect("still reports a genuinely absent destination as missing", () => {
		const testDb = createTestDb(createdDbs)
		const layer = NotificationDispatcher.layer.pipe(
			Layer.provide(Layer.succeed(EmailService, emailStub)),
			Layer.provideMerge(testDb.layer),
			Layer.provideMerge(Env.layer),
			Layer.provide(testConfig()),
		)
		return Effect.gen(function* () {
			const dispatcher = yield* NotificationDispatcher
			const result = yield* dispatcher.dispatch(ORG, [DESTINATION_ID], request)

			assert.strictEqual(result.delivered, 0)
			// Missing is not a delivery failure: the row does not exist, so there
			// is nothing a retry could reach.
			assert.strictEqual(result.failed, 0)
			assert.strictEqual(result.destinations[0]?.status, "missing")
			assert.strictEqual(result.destinations[0]?.error, "destination_missing")
		}).pipe(Effect.provide(layer))
	})
})
