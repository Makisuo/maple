import { ErrorPersistenceError } from "@maple/domain/http"
import { Effect, Schedule } from "effect"
import { DatabaseError, type DatabaseClient, type DatabaseShape } from "@/platform/DatabaseLive"
import { isRetryablePostgresContention } from "@/platform/postgres-errors"

export const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

export const makePersistenceError = (error: unknown): ErrorPersistenceError => {
	const baseFor = (message: string, raw: unknown) => {
		const cause = describeCause(raw)
		return cause === undefined ? { message } : { message, cause }
	}
	if (error instanceof DatabaseError) {
		return new ErrorPersistenceError(baseFor(error.message, error.cause))
	}
	if (error instanceof Error) {
		return new ErrorPersistenceError(baseFor(error.message, error.cause))
	}
	return new ErrorPersistenceError(baseFor("Error persistence failure", error))
}

const CONTENTION_RETRY_SCHEDULE = Schedule.max([Schedule.exponential("50 millis", 2.0), Schedule.recurs(3)])

/**
 * Shared persistence boundary for error-issue capabilities. Keeping the retry
 * and error mapping here lets narrow services retain the exact contention and
 * observability contract of the compatibility facade.
 */
export const makeErrorDatabaseExecute =
	(database: DatabaseShape) =>
	<T>(fn: (db: DatabaseClient) => Promise<T>) =>
		database.execute(fn).pipe(
			Effect.retry({
				schedule: CONTENTION_RETRY_SCHEDULE,
				while: isRetryablePostgresContention,
			}),
			Effect.tapError((error) =>
				Effect.gen(function* () {
					// Every service method runs inside an Effect.fn span — its name says
					// which operation's query failed without threading a label through.
					const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => null))
					yield* Effect.logError("ErrorsService dbExecute failed").pipe(
						Effect.annotateLogs({
							operation: span?.name ?? "(unknown)",
							message: error.message,
							cause: describeCause(error.cause) ?? "(none)",
						}),
					)
				}),
			),
			Effect.mapError(makePersistenceError),
		)
