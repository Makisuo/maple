import { afterEach, assert, describe, it } from "@effect/vitest"
import { alertDestinations } from "@maple/db"
import { AlertDestinationId, OrgId } from "@maple/domain/http"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { encryptAes256Gcm } from "@/lib/Crypto"
import { Database } from "@/lib/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { hydrateDestinationRow, type DestinationSecretConfig } from "./AlertDestinationHydration"

/*
 * These go through a real driver round-trip on purpose. `config_json` is a
 * jsonb column, so the driver hands back a parsed object — decoding it as a
 * JSON *string* fails for every destination of every type, which is exactly
 * what silently broke escalation and error-issue delivery in production
 * ("Stored destination config is invalid"). A hand-built row object would pass
 * with or without the bug; only the DB read pins it.
 */

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 1)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const ORG = asOrgId("org_destination_hydration_test")

const hydrationErrors = {
	onPublicConfigInvalid: () => "public_config_invalid" as const,
	onDecryptFailure: () => "decrypt_failure" as const,
	onSecretConfigInvalid: () => "secret_config_invalid" as const,
}

const seedDestination = (options: {
	readonly id: AlertDestinationId
	readonly type: string
	readonly publicConfig: Record<string, unknown>
	readonly secretConfig: DestinationSecretConfig
}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const encrypted = yield* encryptAes256Gcm(
			JSON.stringify(options.secretConfig),
			ENCRYPTION_KEY,
			(message) => new Error(message),
		)
		const now = new Date(0)
		yield* database.execute((db) =>
			db.insert(alertDestinations).values({
				id: options.id,
				orgId: ORG,
				name: `destination-${options.type}`,
				type: options.type,
				enabled: true,
				// Stored as an object, exactly as AlertsService writes it.
				configJson: options.publicConfig,
				secretCiphertext: encrypted.ciphertext,
				secretIv: encrypted.iv,
				secretTag: encrypted.tag,
				createdAt: now,
				updatedAt: now,
				createdBy: "test",
				updatedBy: "test",
			}),
		)
	})

const loadDestination = (id: AlertDestinationId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.select().from(alertDestinations).where(eq(alertDestinations.id, id)),
		)
		const row = rows[0]
		assert.isDefined(row)
		return row
	})

describe("hydrateDestinationRow", () => {
	it.effect("hydrates a webhook destination read back from the database", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000001")
		const secretConfig: DestinationSecretConfig = {
			type: "webhook",
			url: "https://hooks.example.com/maple",
			signingSecret: "s3cret",
		}
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "webhook",
				publicConfig: { summary: "POST hooks.example.com", channelLabel: null },
				secretConfig,
			})
			const row = yield* loadDestination(id)

			// The defect this test exists for: jsonb comes back parsed.
			assert.notTypeOf(row.configJson, "string")

			const hydrated = yield* hydrateDestinationRow(row, ENCRYPTION_KEY, hydrationErrors)
			assert.deepStrictEqual(hydrated.publicConfig, {
				summary: "POST hooks.example.com",
				channelLabel: null,
			})
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("hydrates a chat destination carrying optional public config keys", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000002")
		const secretConfig: DestinationSecretConfig = {
			type: "slack-bot",
			channelId: "C123",
			channelName: "alerts",
		}
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "slack-bot",
				publicConfig: {
					summary: "#alerts",
					channelLabel: "#alerts",
					memberUserIds: ["user_1", "user_2"],
				},
				secretConfig,
			})
			const row = yield* loadDestination(id)

			const hydrated = yield* hydrateDestinationRow(row, ENCRYPTION_KEY, hydrationErrors)
			assert.deepStrictEqual(hydrated.publicConfig, {
				summary: "#alerts",
				channelLabel: "#alerts",
				memberUserIds: ["user_1", "user_2"],
			})
			assert.deepStrictEqual(hydrated.secretConfig, secretConfig)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("fails with onPublicConfigInvalid when the stored config is genuinely malformed", () => {
		const testDb = createTestDb(createdDbs)
		const id = asDestinationId("00000000-0000-4000-8000-000000000003")
		return Effect.gen(function* () {
			yield* seedDestination({
				id,
				type: "webhook",
				// `summary` is required by DestinationPublicConfigSchema.
				publicConfig: { channelLabel: null },
				secretConfig: {
					type: "webhook",
					url: "https://hooks.example.com/maple",
					signingSecret: null,
				},
			})
			const row = yield* loadDestination(id)

			const error = yield* Effect.flip(hydrateDestinationRow(row, ENCRYPTION_KEY, hydrationErrors))
			assert.strictEqual(error, "public_config_invalid")
		}).pipe(Effect.provide(testDb.layer))
	})
})
