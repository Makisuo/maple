import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ActorId, OrgId, UserId } from "@maple/domain/primitives"
import { Database, DatabaseError, type DatabaseApi } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ErrorActorsService } from "./ErrorActorsService"
import { makeErrorDatabaseExecute } from "./error-persistence"

// Compile-time guard: adding warehouse, cache, Env, notifications, or any other
// requirement to the narrow actor layer makes this assignment fail.
const databaseOnlyLayer: Layer.Layer<ErrorActorsService, never, Database> = ErrorActorsService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asActorId = Schema.decodeUnknownSync(ActorId)

const ORG = asOrgId("org_error_actors_service_test")
const USER = asUserId("user_error_actors_service_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => {
	const database = createTestDb(createdDbs).layer
	return databaseOnlyLayer.pipe(Layer.provide(database))
}

describe("ErrorActorsService", () => {
	it.effect("retains the shared Postgres contention retry contract", () =>
		Effect.gen(function* () {
			let attempts = 0
			const contention = new DatabaseError({
				message: "could not serialize access",
				cause: Object.assign(new Error("serialization failure"), { code: "40001" }),
			})
			const database: DatabaseApi = {
				execute: <T>() =>
					Effect.suspend(() => {
						attempts += 1
						return attempts < 3 ? Effect.fail(contention) : Effect.succeed("ok" as T)
					}),
			}

			const fiber = yield* Effect.forkChild(
				makeErrorDatabaseExecute(database, "ErrorActorsService")(async () => "unused"),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("1 second")
			const result = yield* Fiber.join(fiber)

			assert.strictEqual(result, "ok")
			assert.strictEqual(attempts, 3)
		}),
	)

	it.effect("ensures one stable user actor", () =>
		Effect.gen(function* () {
			const actors = yield* ErrorActorsService
			const first = yield* actors.ensureUserActor(ORG, USER)
			const second = yield* actors.ensureUserActor(ORG, USER)

			assert.strictEqual(first.id, second.id)
			assert.strictEqual(first.type, "user")
			assert.strictEqual(first.userId, USER)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("registers, lists, and looks up agents without the full errors graph", () =>
		Effect.gen(function* () {
			const actors = yield* ErrorActorsService
			const registered = yield* actors.registerAgent(ORG, USER, {
				name: "release-bot",
				model: "gpt-5.6",
				capabilities: ["triage", "patch"],
			})

			const listed = yield* actors.listAgents(ORG)
			const lookedUp = yield* actors.lookupActor(ORG, registered.id)

			expect(listed.actors.map((actor) => actor.id)).toContain(registered.id)
			assert.deepStrictEqual(lookedUp, registered)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("preserves duplicate-name and missing-actor errors", () =>
		Effect.gen(function* () {
			const actors = yield* ErrorActorsService
			yield* actors.registerAgent(ORG, USER, { name: "same-name" })

			const duplicate = yield* Effect.flip(actors.registerAgent(ORG, USER, { name: "same-name" }))
			assert.strictEqual(duplicate._tag, "@maple/http/errors/ErrorValidationError")

			const missing = yield* Effect.flip(
				actors.lookupActor(ORG, asActorId("00000000-0000-4000-8000-000000000000")),
			)
			assert.strictEqual(missing._tag, "@maple/http/errors/ActorNotFoundError")
		}).pipe(Effect.provide(makeLayer())),
	)
})
