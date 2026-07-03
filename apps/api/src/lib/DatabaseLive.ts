import type { MapleDatabaseClient } from "@maple/db/client"
import { fingerprintSql, SQL_TRACE_MAX, truncateSql } from "@maple/query-engine/execution"
import { Clock, Context, Effect, Schema } from "effect"

export type DatabaseClient = MapleDatabaseClient

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("@maple/api/lib/DatabaseError", {
	message: Schema.String,
	cause: Schema.Unknown,
}) {}

export interface DatabaseShape {
	readonly execute: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
}

export const toDatabaseError = (cause: unknown): DatabaseError => {
	const message = cause instanceof Error ? cause.message : "Database operation failed"
	const rootCause = cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : undefined
	return new DatabaseError({
		message: rootCause ? `${message} [caused by: ${rootCause}]` : message,
		cause,
	})
}

/**
 * Wraps one Database.execute call in a Client-kind span per Maple's telemetry
 * conventions (db.system.name + peer.service power the service-map DB edge;
 * db.query.text feeds the query-shapes panel). `run` receives a per-call
 * statement collector — wire it to the db client's `onQuery` so every
 * parameterized statement (including inside transactions) lands in
 * `db.query.text`. The identity attributes live on the span declaration, not
 * the success path, so failed calls still produce map edges.
 */
export const executeWithSpan = <T>(
	run: (collect: (query: string) => void) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
): Effect.Effect<T, DatabaseError> =>
	Effect.gen(function* () {
		const statements: Array<string> = []
		const startedMs = yield* Clock.currentTimeMillis
		// Shared by the success and error paths — tapError runs inside the span,
		// so a failing statement still carries its SQL and timing.
		const annotate = Effect.gen(function* () {
			const sqlText = statements.join(";\n")
			yield* Effect.annotateCurrentSpan({
				"db.query.text": truncateSql(sqlText, SQL_TRACE_MAX),
				"db.query.length": sqlText.length,
				"db.query.truncated": sqlText.length > SQL_TRACE_MAX,
				"db.query.fingerprint": fingerprintSql(sqlText),
				"db.statement_count": statements.length,
				"db.duration_ms": (yield* Clock.currentTimeMillis) - startedMs,
			})
		})
		const result = yield* Effect.tryPromise({
			try: () => run((query) => statements.push(query)),
			catch: toDatabaseError,
		}).pipe(Effect.tapError(() => annotate))
		yield* annotate
		if (Array.isArray(result)) {
			yield* Effect.annotateCurrentSpan("result.rowCount", result.length)
		}
		return result
	}).pipe(
		Effect.withSpan("Database.execute", {
			kind: "client",
			attributes: {
				"db.system.name": "postgresql",
				"peer.service": "postgresql",
				...extraAttributes,
			},
		}),
	)

export class Database extends Context.Service<Database, DatabaseShape>()("@maple/api/services/Database") {}
