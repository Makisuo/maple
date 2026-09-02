import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Database, DatabaseError, type DatabaseApi } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { resolveSlackBotTokenForDispatch } from "./slack-bot-token"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 7)

describe("resolveSlackBotTokenForDispatch", () => {
	it.effect("classifies a database lookup failure as retryable, not as an auth failure", () => {
		// A transient Postgres blip must re-enqueue the alert, not permanently drop
		// it — AlertDeliveryAuthError is `retry: "never"` and counts toward
		// auto-disabling the destination.
		const failing: DatabaseApi = {
			execute: () => Effect.fail(new DatabaseError({ message: "connection reset", cause: "boom" })),
		}
		return Effect.gen(function* () {
			const error = yield* resolveSlackBotTokenForDispatch(failing, ENCRYPTION_KEY, "org_slack").pipe(
				Effect.flip,
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AlertDeliveryError")
		})
	})

	it.effect("still classifies a missing installation as a terminal auth failure", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const database = yield* Database
			const error = yield* resolveSlackBotTokenForDispatch(database, ENCRYPTION_KEY, "org_slack").pipe(
				Effect.flip,
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AlertDeliveryAuthError")
		}).pipe(Effect.provide(testDb.layer))
	})
})
