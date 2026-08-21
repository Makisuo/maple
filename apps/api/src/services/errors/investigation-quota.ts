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
 *
 * The second failure this module has to prevent is subtler than a wrong unit: a
 * budget spent is not the same as a budget spent *well*. A single UTC-day bucket
 * handed out first-come-first-served lets whatever errors just after midnight
 * take the whole day, so a `critical` opening at noon is refused by noise that
 * opened at 00:03. {@link RESERVED_PASS_FRACTION} keeps a slice that only the top
 * severities may draw on, which is why the verdict needs to know the severity of
 * the start it is judging.
 */

import { investigations } from "@maple/db"
import { and, eq, gte, sql } from "drizzle-orm"
import type { IssueSeverity, OrgId } from "@maple/domain/http"
import type { DatabaseClient } from "@/platform/DatabaseLive"

/** Runs per UTC day when the org has no row in `ai_triage_settings`. */
export const DEFAULT_MAX_RUNS_PER_DAY = 250

/**
 * Model passes per day when unconfigured.
 *
 * Sized against what a fan-out actually costs, which is `fanoutSize + 1`: a
 * `low` incident settles at width 3 and spends 4, a `critical` at width 5 spends
 * 7. 1000 is therefore roughly 150–250 investigations a day depending on the mix.
 *
 * The previous 90 was sized for "planner + 4 hypotheses + validator ≈ 6 passes,
 * so about 15 incidents" — which held right up until the fan-out shipped and the
 * real settled width turned out to be 3, giving exactly 22 starts a day. Every
 * one of them was spent before 03:00 UTC, and every incident for the remaining
 * 21 hours was refused. A ceiling low enough to be hit overnight is
 * indistinguishable, from the operator's side, from the feature being off.
 */
export const DEFAULT_MAX_PASSES_PER_DAY = 1000

/**
 * The share of the pass budget only `high` and `critical` may spend.
 *
 * Reserved rather than rationed per-hour on purpose: a token bucket would also
 * stop the overnight sweep from taking everything, but it would delay a genuine
 * 03:00 incident storm just as happily. What actually needs protecting is not
 * evenness across the clock, it is that severity outranks arrival order.
 */
export const RESERVED_PASS_FRACTION = 0.3

/** Severities that may draw on the reserve. */
const PRIORITY_SEVERITIES: ReadonlySet<IssueSeverity> = new Set<IssueSeverity>(["critical", "high"])

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

/**
 * Which ceiling stopped the start.
 *
 * `passes_reserved` is deliberately not folded into `passes`: they call for
 * opposite responses. `passes` means the org is out of budget and the number
 * should go up; `passes_reserved` means the budget is intact but this start was
 * not important enough for what is left, and raising the ceiling would only move
 * the same triage decision later in the day.
 */
export type InvestigationQuotaDimension = "runs" | "passes" | "passes_reserved"

export type InvestigationQuotaVerdict =
	| { readonly kind: "allowed" }
	| {
			readonly kind: "exceeded"
			/** Which ceiling was hit. Reported so a log line says *which* limit to raise. */
			readonly dimension: InvestigationQuotaDimension
			readonly limit: number
			readonly retryableAtMs: number
	  }

/**
 * The pass ceiling this severity may spend up to.
 *
 * An unknown severity is treated as ordinary rather than as priority: the
 * reserve is worth nothing if anything that forgot to classify itself can reach
 * it, and an incident with no severity is far more often noise than an outage.
 */
export const effectivePassLimit = (passLimit: number, severity: IssueSeverity | null | undefined): number => {
	if (severity != null && PRIORITY_SEVERITIES.has(severity)) return passLimit
	return Math.floor(passLimit * (1 - RESERVED_PASS_FRACTION))
}

/**
 * Pure verdict, so the whole table is testable without a database.
 *
 * `passCount` is what this start is *about* to spend, which is why passes are
 * checked as `used + requested > limit` while runs are checked as
 * `used >= limit`: a run is one, and counting it twice would make the last slot
 * of the day unusable.
 *
 * `severity` decides which pass ceiling applies. It is optional so the manual
 * path — which can start a free-form question that has no incident and therefore
 * no severity — keeps working; absent reads as ordinary, not as priority.
 */
export const evaluateInvestigationQuota = (input: {
	readonly usage: InvestigationUsage
	readonly limits: InvestigationQuotaLimits | undefined
	readonly passCount: number
	readonly nowMs: number
	readonly severity?: IssueSeverity | null
}): InvestigationQuotaVerdict => {
	const runLimit = input.limits?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY
	const passLimit = input.limits?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY
	const retryableAtMs = startOfUtcDay(input.nowMs) + 24 * 60 * 60 * 1000
	if (input.usage.runs >= runLimit) {
		return { kind: "exceeded", dimension: "runs", limit: runLimit, retryableAtMs }
	}
	const allowedPasses = effectivePassLimit(passLimit, input.severity)
	if (input.usage.passes + input.passCount > allowedPasses) {
		// Report the ceiling that actually applied, not the configured one — a log
		// line saying "limit 1000" when the start was judged against 700 sends the
		// reader to raise a number that was never the constraint.
		return {
			kind: "exceeded",
			dimension: allowedPasses < passLimit ? "passes_reserved" : "passes",
			limit: allowedPasses,
			retryableAtMs,
		}
	}
	return { kind: "allowed" }
}
