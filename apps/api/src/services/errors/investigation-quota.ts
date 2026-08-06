/**
 * The daily investigation budget, counted in two units.
 *
 * There are two ceilings because there are two costs. A *run* is an
 * investigation — the unit an operator thinks in and configures. A *pass* is one
 * model call — the unit that costs money, and a planned investigation spends
 * several of them (the planner, N hypotheses, the validator). Counting one
 * against the other's limit is the bug this module exists to prevent:
 * `maybeEnqueueTriage` summed `autonomous_turns`, which is incremented by the
 * *pass* count, and compared it to `max_runs_per_day`. A configured 20 runs
 * therefore became 20 passes — about three planned incidents a day — and the
 * automatic path went quiet without anything logging that a limit was wrong.
 *
 * Both producers now read the same query and the same verdict, so a change to
 * either ceiling lands in both places or in neither.
 */

import { investigations } from "@maple/db"
import { and, eq, gte, sql } from "drizzle-orm"
import type { OrgId } from "@maple/domain/http"
import type { DatabaseClient } from "@/platform/DatabaseLive"

/** Runs per UTC day when the org has no row in `ai_triage_settings`. */
export const DEFAULT_MAX_RUNS_PER_DAY = 20

/**
 * Model passes per UTC day when unconfigured.
 *
 * Sized against the planned flow: planner + 4 hypotheses + validator ≈ 6 passes
 * per incident, so 90 is roughly 15 planned incidents. The old 60 was set when a
 * fan-out was rare and a single pass was the norm.
 */
export const DEFAULT_MAX_PASSES_PER_DAY = 90

export const startOfUtcDay = (nowMs: number): number => {
	const date = new Date(nowMs)
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export interface InvestigationUsage {
	readonly runs: number
	readonly passes: number
}

/**
 * Today's usage, in both units.
 *
 * Windowed on `started_at`, not `created_at`: a restart re-stamps `started_at`,
 * so restarting an investigation opened last week correctly spends today's
 * budget instead of escaping the window entirely.
 *
 * Takes the drizzle client rather than the `Database` service so both call sites
 * can pass their own `execute` wrapper — `InvestigationService` has `dbExecute`,
 * `maybeEnqueueTriage` has `database.execute`, and neither should have to adopt
 * the other's.
 */
export const selectInvestigationUsage = async (
	db: DatabaseClient,
	orgId: OrgId,
	nowMs: number,
): Promise<InvestigationUsage> => {
	const rows = await db
		.select({
			runs: sql<number>`count(*)::int`,
			// What one start cost: N hypotheses plus the validator, or 1 for a single pass.
			passes: sql<number>`coalesce(sum(case when ${investigations.fanoutSize} > 1 then ${investigations.fanoutSize} + 1 else 1 end), 0)::int`,
		})
		.from(investigations)
		.where(
			and(
				eq(investigations.orgId, orgId),
				gte(investigations.startedAt, new Date(startOfUtcDay(nowMs))),
			),
		)
	return { runs: rows[0]?.runs ?? 0, passes: rows[0]?.passes ?? 0 }
}

export interface InvestigationQuotaLimits {
	readonly maxRunsPerDay?: number | null
	readonly maxPassesPerDay?: number | null
}

export type InvestigationQuotaVerdict =
	| { readonly kind: "allowed" }
	| {
			readonly kind: "exceeded"
			/** Which ceiling was hit. Reported so a log line says *which* limit to raise. */
			readonly dimension: "runs" | "passes"
			readonly limit: number
			readonly retryableAtMs: number
	  }

/**
 * Pure verdict, so the whole table is testable without a database.
 *
 * `passCount` is what this start is *about* to spend, which is why passes are
 * checked as `used + requested > limit` while runs are checked as
 * `used >= limit`: a run is one, and counting it twice would make the last slot
 * of the day unusable.
 */
export const evaluateInvestigationQuota = (input: {
	readonly usage: InvestigationUsage
	readonly limits: InvestigationQuotaLimits | undefined
	readonly passCount: number
	readonly nowMs: number
}): InvestigationQuotaVerdict => {
	const runLimit = input.limits?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY
	const passLimit = input.limits?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY
	const retryableAtMs = startOfUtcDay(input.nowMs) + 24 * 60 * 60 * 1000
	if (input.usage.runs >= runLimit) {
		return { kind: "exceeded", dimension: "runs", limit: runLimit, retryableAtMs }
	}
	if (input.usage.passes + input.passCount > passLimit) {
		return { kind: "exceeded", dimension: "passes", limit: passLimit, retryableAtMs }
	}
	return { kind: "allowed" }
}
