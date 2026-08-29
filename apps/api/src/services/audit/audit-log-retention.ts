import { auditLogEntries } from "@maple/db"
import { sql } from "drizzle-orm"
import { Clock, Config, Effect } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToSqlTimestamp } from "@/platform/time"

/**
 * Retention for the org audit log (`audit_log_entries`).
 *
 * Entries older than `AUDIT_LOG_RETENTION_DAYS` (default 400 — a spec-friendly
 * 13 months) are swept in bounded batches so one tick never holds its Postgres
 * connection for minutes. Runs from the API worker's existing hourly retention
 * cron rather than its own schedule — every new cron string costs an entry in
 * both `wrangler.jsonc` and `alchemy.run.ts`, and a horizon this wide has no
 * reason to tick on a different beat.
 */

const DEFAULT_RETENTION_DAYS = 400
const DAY_MS = 24 * 60 * 60 * 1000

/** Rows per DELETE, and a per-tick ceiling; the hourly cadence drains any backlog. */
const RETENTION_BATCH_ROWS = 5_000
const RETENTION_MAX_BATCHES = 20

const retentionDaysConfig = Config.number("AUDIT_LOG_RETENTION_DAYS").pipe(
	Config.withDefault(DEFAULT_RETENTION_DAYS),
)

/**
 * Apply retention. Every batch runs inside ONE `execute`: under `DatabasePgLive`
 * each call dials and tears down its own postgres.js client, so the handshake
 * count is what costs, not the statement count.
 */
export const runAuditLogRetention = Effect.gen(function* () {
	const retentionDays = yield* retentionDaysConfig
	const now = yield* Clock.currentTimeMillis
	// Raw-fragment param: bind an ISO string, not a Date — see msToSqlTimestamp.
	const cutoff = msToSqlTimestamp(now - retentionDays * DAY_MS)
	const database = yield* Database

	const deleted = yield* database.execute(async (db) => {
		let total = 0
		for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
			// ctid-addressed delete: one scan of the standalone occurred_at index
			// finds the batch, and the DELETE fetches those exact tuples directly —
			// no second lookup by a key the PK index (org_id, id) cannot serve.
			const rows = await db
				.delete(auditLogEntries)
				.where(
					sql`ctid IN (SELECT ctid FROM ${auditLogEntries} WHERE ${auditLogEntries.occurredAt} < ${cutoff}::timestamptz LIMIT ${RETENTION_BATCH_ROWS})`,
				)
				.returning({ id: auditLogEntries.id })
			total += rows.length
			if (rows.length < RETENTION_BATCH_ROWS) break
		}
		return total
	})

	yield* Effect.annotateCurrentSpan({
		"audit.retention.deleted": deleted,
		"audit.retention.days": retentionDays,
		"audit.retention.outcome": "completed",
	})
	yield* Effect.logInfo("[audit] log retention tick complete").pipe(
		Effect.annotateLogs({ deleted, retentionDays }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "audit.retention.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[audit] log retention tick failed").pipe(
					Effect.annotateLogs({ error: String(cause) }),
				),
			),
		),
	),
	Effect.withSpan("AuditLogRetention.tick"),
)
