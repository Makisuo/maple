import { assert, describe, it } from "@effect/vitest"
import { DatabaseError, toDatabaseError } from "./DatabaseLive"
import {
	isPostgresConnectionError,
	isRetryablePostgresContention,
	postgresErrorType,
	postgresSqlState,
} from "./postgres-errors"

/** postgres.js hangs its machine-readable class off `code`, not the message. */
const driverError = (code: string, message: string): Error => Object.assign(new Error(message), { code })

describe("postgresErrorType", () => {
	it("reports the driver code for a dial that timed out", () => {
		const error = toDatabaseError(driverError("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT"))
		assert.strictEqual(postgresErrorType(error), "CONNECT_TIMEOUT")
		assert.isTrue(isPostgresConnectionError(error))
		// A connection failure has no SQLSTATE — nothing was ever executed.
		assert.isUndefined(postgresSqlState(error))
	})

	it("reports SQLSTATE for a statement failure", () => {
		const error = toDatabaseError(
			driverError("23505", 'duplicate key value violates unique constraint "api_keys_pkey"'),
		)
		assert.strictEqual(postgresErrorType(error), "23505")
		assert.strictEqual(postgresSqlState(error), "23505")
		// The distinction the flattened message could not carry: this is the query
		// failing, not the connection.
		assert.isFalse(isPostgresConnectionError(error))
	})

	it("unwraps a driver code nested one level down", () => {
		const outer = new Error("Failed query", { cause: driverError("ECONNRESET", "socket hang up") })
		const error = toDatabaseError(outer)
		assert.strictEqual(postgresErrorType(error), "ECONNRESET")
		assert.isTrue(isPostgresConnectionError(error))
	})

	it("falls back to the error name when there is no code", () => {
		const named = new Error("something else")
		named.name = "PostgresError"
		assert.strictEqual(postgresErrorType(toDatabaseError(named)), "PostgresError")
	})

	it("returns undefined for a bare Error rather than inventing a class", () => {
		assert.isUndefined(postgresErrorType(toDatabaseError(new Error("boom"))))
		assert.isFalse(isPostgresConnectionError(toDatabaseError(new Error("boom"))))
	})

	it("leaves contention classification unchanged", () => {
		const deadlock = toDatabaseError(driverError("40P01", "deadlock detected"))
		assert.isTrue(isRetryablePostgresContention(deadlock))
		// Contention is a statement failure, not a connection one — a retry there
		// must not be counted against the dial budget.
		assert.isFalse(isPostgresConnectionError(deadlock))
	})

	it("does not treat a connection failure as retryable contention", () => {
		const error = new DatabaseError({
			message: "write CONNECT_TIMEOUT",
			cause: driverError("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT"),
		})
		assert.isFalse(isRetryablePostgresContention(error))
	})
})
