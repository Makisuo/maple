import type { MaplePgClient } from "@maple/db/client"
import { fingerprintSql, SQL_TRACE_MAX, summarizeSql, truncateSql } from "@maple/query-engine/execution"
import { Clock, Context, Effect, Schema } from "effect"
import { isPostgresConnectionError, postgresErrorType, postgresSqlState } from "./postgres-errors"
import { updateCurrentSpanName } from "./span-name"

export type DatabaseClient = MaplePgClient

/**
 * `cause` is the driver's own error, kept for `postgres-errors.ts` to read the
 * `code`/SQLSTATE off. It is `Schema.Defect()` rather than `Schema.Unknown` for
 * the reason the convention gives: `Unknown` has no encoded form, so anything
 * that serialized a `DatabaseError` serialized the raw postgres.js object —
 * host, port, driver options and all. `Defect()` encodes an `Error` to its
 * `name` and `message`, and `excludeCause: true` stops at the driver error
 * instead of walking into the socket error underneath it. `toDatabaseError`
 * already lifts the root cause's message into `message`, so the diagnostic half
 * survives the narrowing.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@maple/api/lib/DatabaseError", {
	message: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}

export interface DatabaseApi {
	readonly execute: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
}

/**
 * Callbacks handed to an `executeWithSpan` body so it can report what only it
 * knows: which statements ran, and any transport-level attributes discovered
 * along the way.
 */
export interface ExecuteHooks {
	/**
	 * Wire to the client's `onQuery` — every parameterized statement lands in
	 * `db.query.text`.
	 */
	readonly collect: (query: string) => void
	/** Merge extra attributes into the span at annotate time. */
	readonly record: (attributes: Record<string, unknown>) => void
}

/**
 * Drizzle's own message is `Failed query: <sql>\nparams: <params>` — with the
 * params inlined, a batched upsert of error rows runs to tens of KB. Span status
 * and log lines truncate, so whatever comes first is what survives.
 */
const MAX_QUERY_MESSAGE_CHARS = 600

const capQueryMessage = (message: string): string =>
	message.length <= MAX_QUERY_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_QUERY_MESSAGE_CHARS)}…[truncated ${message.length - MAX_QUERY_MESSAGE_CHARS} chars]`

/**
 * Root cause first: the Postgres diagnostic (`invalid byte sequence for
 * encoding "UTF8": 0x00`, `relation "x" does not exist`) is the half an
 * operator needs, and the half that used to sit past the truncation point
 * behind the quoted statement. The statement follows, capped — the full SQL is
 * on the span as `db.query.text`.
 */
export const toDatabaseError = (cause: unknown): DatabaseError => {
	const message = cause instanceof Error ? cause.message : "Database operation failed"
	const rootCause = cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : undefined
	return new DatabaseError({
		message: rootCause ? `${rootCause} [while: ${capQueryMessage(message)}]` : capQueryMessage(message),
		cause,
	})
}

/** Shared by both entry points below so the two can never describe different origins. */
const DB_SPAN_OPTIONS = {
	kind: "client",
	attributes: {
		"db.system.name": "postgresql",
		"peer.service": "planetscale-postgres",
	},
} as const

/**
 * A `Database.execute` span for a call refused before any statement could run.
 *
 * The refusal is decided in Effect, so it fails in Effect — there is no promise
 * to throw out of. It still gets a span: a call that reached `Database.execute`
 * and was turned away is exactly the thing an operator needs to see, and a
 * silent `Effect.fail` would leave the trace looking as though it never
 * happened. `db.query.*` is absent on purpose — there is no statement.
 */
export const failExecuteWithSpan = Effect.fn(
	"Database.execute",
	DB_SPAN_OPTIONS,
)(function* (error: DatabaseError, extraAttributes?: Record<string, unknown>) {
	if (extraAttributes) {
		yield* Effect.annotateCurrentSpan(extraAttributes)
	}
	return yield* Effect.fail(error)
})

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
 *
 * There is no connect/query split. postgres.js connects on the first statement,
 * so there is no separate connect phase to time — the split previously came from
 * a `select 1` probe that cost a round trip on every request purely to produce
 * it. What that split was used to infer, `error.type` now states outright: a
 * `CONNECT_TIMEOUT` and a constraint violation are different classes, not
 * different durations.
 */
export const executeWithSpan = Effect.fn(
	"Database.execute",
	DB_SPAN_OPTIONS,
)(function* <T>(run: (hooks: ExecuteHooks) => Promise<T>, extraAttributes?: Record<string, unknown>) {
	if (extraAttributes) {
		yield* Effect.annotateCurrentSpan(extraAttributes)
	}
	const statements: Array<string> = []
	const recorded: Record<string, unknown> = {}
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
			...recorded,
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
	// `error.type` is what separates a stalled dial from a constraint violation
	// once the span lands — the message alone cannot, since `toDatabaseError`
	// flattens the driver's code into prose. `db.response.status_code` carries
	// SQLSTATE where there is one, per OTel's database conventions.
	const annotateFailure = (error: DatabaseError) =>
		Effect.gen(function* () {
			const errorType = postgresErrorType(error)
			if (errorType !== undefined) {
				yield* Effect.annotateCurrentSpan("error.type", errorType)
			}
			const sqlState = postgresSqlState(error)
			if (sqlState !== undefined) {
				yield* Effect.annotateCurrentSpan("db.response.status_code", sqlState)
			}
			yield* Effect.annotateCurrentSpan("db.connect.failed", isPostgresConnectionError(error))
			yield* annotate
		})
	const result = yield* Effect.tryPromise({
		try: () =>
			run({
				collect: (query) => statements.push(query),
				record: (attributes) => Object.assign(recorded, attributes),
			}),
		catch: toDatabaseError,
	}).pipe(Effect.tapError(annotateFailure))
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

export class Database extends Context.Service<Database, DatabaseApi>()("@maple/api/services/Database") {}
