import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Effect, Exit } from "effect"
import { makeDbExecute, makePersistenceErrorMapper } from "./db-execute"
import { DatabaseError, type DatabaseClient, type DatabaseShape } from "./DatabaseLive"

class TestPersistenceError extends Schema.TaggedError<TestPersistenceError>()(
	"@maple/api/test/TestPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
) {}

const toTestError = makePersistenceErrorMapper(TestPersistenceError, "Test persistence failure")

/**
 * A `Database` that fails every call with `error` and counts the attempts, so a
 * test can tell a replayed contention failure from a single-shot one.
 */
const failingDatabase = (error: DatabaseError) => {
	const attempts = { count: 0 }
	const database: DatabaseShape = {
		execute: <T>(_fn: (db: DatabaseClient) => Promise<T>) =>
			Effect.sync(() => {
				attempts.count += 1
			}).pipe(Effect.flatMap(() => Effect.fail(error))) as Effect.Effect<T, DatabaseError>,
	}
	return { database, attempts }
}

const contentionError = new DatabaseError({
	message: "could not serialize access due to concurrent update",
	cause: { code: "40001" },
})

const connectionError = new DatabaseError({
	message: "write CONNECT_TIMEOUT 10.0.0.1:5432",
	cause: { code: "CONNECT_TIMEOUT" },
})

describe("makeDbExecute", () => {
	it.live("replays a contention failure before giving up", () =>
		Effect.gen(function* () {
			const { database, attempts } = failingDatabase(contentionError)
			const dbExecute = makeDbExecute(database, "TestService", toTestError)

			// Real time: the schedule is exponential from 50ms capped at 3
			// recurrences, so the whole replay costs ~350ms.
			const exit = yield* Effect.exit(dbExecute(() => Promise.resolve("unused")))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(attempts.count, 4)
		}),
	)

	it.effect("does not replay a connection failure", () =>
		Effect.gen(function* () {
			const { database, attempts } = failingDatabase(connectionError)
			const dbExecute = makeDbExecute(database, "TestService", toTestError)

			yield* Effect.exit(dbExecute(() => Promise.resolve("unused")))

			assert.strictEqual(attempts.count, 1)
		}),
	)

	it.effect("maps the DatabaseError into the service's persistence error", () =>
		Effect.gen(function* () {
			const { database } = failingDatabase(connectionError)
			const dbExecute = makeDbExecute(database, "TestService", toTestError)

			const exit = yield* Effect.exit(dbExecute(() => Promise.resolve("unused")))

			assert.isTrue(Exit.isFailure(exit))
			const failure = Exit.isFailure(exit) ? exit.cause : undefined
			assert.isDefined(failure)
		}),
	)
})

describe("makePersistenceErrorMapper", () => {
	it("carries the thrown message and the flattened nested cause", () => {
		const error = toTestError(new Error("boom", { cause: new Error("inner") }))

		assert.strictEqual(error.message, "boom")
		assert.include(error.cause ?? "", "inner")
	})

	it("falls back for a non-Error rejection", () => {
		const error = toTestError("just a string")

		assert.strictEqual(error.message, "Test persistence failure")
		assert.strictEqual(error.cause, "just a string")
	})
})
