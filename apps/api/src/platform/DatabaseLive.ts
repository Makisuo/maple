import type { MapleDatabaseClient } from "@maple/db/client"
import { fingerprintSql, SQL_TRACE_MAX, summarizeSql, truncateSql } from "@maple/query-engine/execution"
import { Clock, Context, Effect, Schema } from "effect"
import { updateCurrentSpanName } from "./span-name"

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
 *
 * `"Database.execute"` is only the *placeholder* name: OTel wants a DB client
 * span named after its query, so once the SQL is known the span is renamed to
 * `db.query.summary` ("SELECT alert_rules"). See `span-name.ts`. A call that
 * fails before issuing any statement keeps the placeholder.
 *
 * `peer.service` is `planetscale-postgres` — the same value `apps/ingest` emits
 * for the same origin database, so the two paths don't produce divergent
 * service-map targets (MAP-01 in the maple-audit skill).
 */
export const executeWithSpan = Effect.fn("Database.execute", {
	kind: "client",
	attributes: {
		"db.system.name": "postgresql",
		"peer.service": "planetscale-postgres",
	},
})(function* <T>(
	run: (collect: (query: string) => void) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
) {
	if (extraAttributes) {
		yield* Effect.annotateCurrentSpan(extraAttributes)
	}
	const statements: Array<string> = []
	const startedMs = yield* Clock.currentTimeMillis
	// Shared by the success and error paths — tapError runs inside the span,
	// so a failing statement still carries its SQL and timing.
	const annotate = Effect.gen(function* () {
		const sqlText = statements.join(";\n")
		// Summarize the joined text, not the first statement alone: that is
		// exactly the input the warehouse would derive a shape label from, so the
		// emitted summary can never disagree with the fallback derivation.
		const { operation, collection, summary } = summarizeSql(sqlText)
		yield* Effect.annotateCurrentSpan({
			"db.query.text": truncateSql(sqlText, SQL_TRACE_MAX),
			"db.query.length": sqlText.length,
			"db.query.truncated": sqlText.length > SQL_TRACE_MAX,
			"db.query.fingerprint": fingerprintSql(sqlText),
			"db.statement_count": statements.length,
			"db.duration_ms": (yield* Clock.currentTimeMillis) - startedMs,
		})
		if (summary !== "") {
			yield* Effect.annotateCurrentSpan("db.query.summary", summary)
			yield* updateCurrentSpanName(summary)
		}
		if (operation !== "") {
			yield* Effect.annotateCurrentSpan("db.operation.name", operation)
		}
		if (collection !== "") {
			yield* Effect.annotateCurrentSpan("db.collection.name", collection)
		}
	})
	const result = yield* Effect.tryPromise({
		try: () => run((query) => statements.push(query)),
		catch: toDatabaseError,
	}).pipe(Effect.tapError(() => annotate))
	yield* annotate
	if (Array.isArray(result)) {
		// `db.response.returned_rows` is what the span-detail database panel reads
		// (packages/ui/src/lib/cloud-platforms/database.ts); `result.rowCount` is
		// Maple's own key, also emitted by the warehouse executor. Keep both.
		yield* Effect.annotateCurrentSpan({
			"result.rowCount": result.length,
			"db.response.returned_rows": result.length,
		})
	}
	return result
})

export class Database extends Context.Service<Database, DatabaseShape>()("@maple/api/services/Database") {}
