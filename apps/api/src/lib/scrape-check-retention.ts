import { scrapeTargetChecks, scrapeTargets } from "@maple/db"
import { and, desc, eq, inArray, lt } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { Database } from "./DatabaseLive"

/**
 * Check-history retention for `scrape_target_checks`.
 *
 * This used to run inline on `POST /api/internal/scrape-results`, where it cost
 * 1 + 2N `Database.execute` calls per report — ~39k Postgres round-trips a day
 * and 29% of that route's latency — for maintenance no caller is waiting on. It
 * now runs from the API worker's hourly cron.
 *
 * It lives outside `ScrapeTargetsService` so the cron's layer graph needs only
 * `Database`, not the PlanetScale discovery/OAuth services that the request-path
 * service depends on.
 */

/** Retention: 24h sliding window… */
const CHECK_RETENTION_MS = 24 * 60 * 60 * 1000
/** …with a per-target row cap as backstop against very short intervals. */
const CHECK_MAX_ROWS_PER_TARGET = 10_000

/**
 * Apply retention to the given targets.
 *
 * Every statement runs inside ONE `execute`: under `DatabasePgLive` each call
 * dials and tears down its own postgres.js client, so the handshake count is
 * what costs, not the statement count.
 */
export const pruneChecksForTargets = Effect.fn("ScrapeCheckRetention.pruneForTargets")(function* (
	targetIds: ReadonlyArray<string>,
) {
	if (targetIds.length === 0) return
	const now = yield* Clock.currentTimeMillis
	const cutoff = new Date(now - CHECK_RETENTION_MS)
	const ids = [...targetIds]
	const database = yield* Database

	yield* database.execute(async (db) => {
		await db
			.delete(scrapeTargetChecks)
			.where(and(inArray(scrapeTargetChecks.targetId, ids), lt(scrapeTargetChecks.checkedAt, cutoff)))

		// Cap backstop for misconfigured/very short intervals: drop everything
		// older than the Nth-newest row per target. The OFFSET probe rides the
		// (target_id, checked_at) index, so it stays cheaper than a window
		// function over the target's full history.
		for (const targetId of ids) {
			const capBoundary = await db
				.select({ checkedAt: scrapeTargetChecks.checkedAt })
				.from(scrapeTargetChecks)
				.where(eq(scrapeTargetChecks.targetId, targetId))
				.orderBy(desc(scrapeTargetChecks.checkedAt))
				.limit(1)
				.offset(CHECK_MAX_ROWS_PER_TARGET - 1)
			const boundary = capBoundary[0]
			if (boundary === undefined) continue
			await db
				.delete(scrapeTargetChecks)
				.where(
					and(
						eq(scrapeTargetChecks.targetId, targetId),
						lt(scrapeTargetChecks.checkedAt, boundary.checkedAt),
					),
				)
		}
	})
})

/** The cron program: apply retention across every scrape target. */
export const runScrapeCheckRetention = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db.select({ id: scrapeTargets.id }).from(scrapeTargets),
	)
	yield* pruneChecksForTargets(rows.map((row) => row.id))
	yield* Effect.annotateCurrentSpan({
		"scrape.retention.targets": rows.length,
		"scrape.retention.outcome": "completed",
	})
	yield* Effect.logInfo("[scrape] check retention tick complete").pipe(
		Effect.annotateLogs({ targets: rows.length }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "scrape.retention.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[scrape] check retention tick failed").pipe(
					Effect.annotateLogs({ error: String(cause) }),
				),
			),
		),
	),
	Effect.withSpan("ScrapeCheckRetention.tick"),
)
