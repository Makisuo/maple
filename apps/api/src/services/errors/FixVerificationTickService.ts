import { MAX_VERIFICATION_ATTEMPTS, type VerificationVerdict, type OrgId } from "@maple/domain/http"
import { RoleName, UserId } from "@maple/domain/primitives"
import { errorIssuePullRequests, errorIssues, type ErrorIssueVerificationRow } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import type { TenantContext } from "@/services/auth/AuthService"
import { Database } from "@/platform/DatabaseLive"
import { summarizeCause } from "@/platform/describe-cause"
import { dateToMs } from "@/platform/time"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { INVESTIGATION_FANOUT_BINDING } from "@/services/errors/ai-triage-enqueue"
import { enqueueFixVerification } from "@/services/errors/fix-verification-enqueue"
import { IssueFixVerificationService } from "./IssueFixVerificationService"
import { makeErrorDatabaseExecute } from "./error-persistence"

const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

/**
 * Verifications examined per tick. The tick runs every minute and each row costs
 * one warehouse read plus (usually) one workflow start, so the cap is what keeps
 * a burst of simultaneous merges from turning one minute's tick into a long
 * outbound-call queue. Leftovers are simply due again next minute.
 */
const MAX_VERIFICATIONS_PER_TICK = 20

/**
 * Distinct versions read per occurrence scan. Membership against the baseline
 * is the decision, so a build dropped from the result could be the single
 * post-merge build that refutes the fix — a full page is treated as incomplete
 * evidence below rather than silently classified from the head.
 */
const VERSION_SCAN_LIMIT = 1000

/**
 * Split one window's version rows against the merge-time baseline.
 *
 * Occurrences with no reported build cannot be attributed either way: counting
 * one as post-merge would refute every fix from a service that does not report
 * `service.version`, and counting it as a stale client would hide a real
 * failure. They are tallied as `unattributed`, and any nonzero tally (or a
 * truncated scan) must force the verdict toward `inconclusive` — evidence that
 * exists but cannot be read is not a clean window.
 */
export const splitVersionRows = (
	rows: ReadonlyArray<{ readonly serviceVersion: string; readonly count: number }>,
	baselineVersions: ReadonlyArray<string>,
	scanLimit: number,
): { postMerge: number; staleClients: number; unattributed: number } => {
	const baseline = new Set(baselineVersions)
	let postMerge = 0
	let staleClients = 0
	let unattributed = 0
	for (const entry of rows) {
		if (entry.serviceVersion === "") unattributed += entry.count
		else if (baseline.has(entry.serviceVersion)) staleClients += entry.count
		else postMerge += entry.count
	}
	// A full page means versions beyond the cap were dropped, and any one of
	// them could be decisive. Marked unattributed so the verdict cannot claim
	// the window was clean.
	if (rows.length >= scanLimit) unattributed += 1
	return { postMerge, staleClients, unattributed }
}

/**
 * Turn a finished verification investigation into a verdict.
 *
 * The mapping reads backwards until you hold the question the run was asked.
 * For an incident, `diagnosed` means the agent established a cause and that
 * is the good outcome. For a verification, the agent was pointed at an error
 * whose occurrence counts already looked clean and asked to find anything
 * that contradicts the fix — so establishing a live cause means the fix did
 * NOT hold, and failing to establish one corroborates that it did.
 *
 * `failed` is not a verdict either way: the run never reached an answer, so
 * it is inconclusive and gets the retry the status earns it.
 */
export const verdictFromInvestigationStatus = (
	investigationStatus: string,
): { readonly verdict: VerificationVerdict; readonly reason: string } => {
	if (investigationStatus === "diagnosed") {
		return {
			verdict: "not_fixed",
			reason: "The verification agent established a live cause for this error after the merge.",
		}
	}
	if (investigationStatus === "inconclusive") {
		return {
			verdict: "verified",
			reason: "No occurrences from post-merge builds, and the verification agent found nothing contradicting the fix.",
		}
	}
	return {
		verdict: "inconclusive",
		reason: `The verification run ended as '${investigationStatus}' without reaching an answer.`,
	}
}

export interface FixVerificationTickResult {
	readonly examined: number
	readonly refuted: number
	readonly investigationsStarted: number
	readonly verdictsApplied: number
	readonly skipped: number
	/** Rows whose verdict could not be written this tick; they are due again next minute. */
	readonly failedRows: number
}

export interface FixVerificationTickServiceApi {
	/**
	 * Never fails. A tick that cannot read its own rows logs and reports nothing
	 * done — the rows stay `waiting` and are due again next minute, which is the
	 * right answer for a transient database problem and avoids a failed cron
	 * invocation for something that self-heals.
	 */
	readonly runTick: () => Effect.Effect<FixVerificationTickResult>
}

const make: Effect.Effect<
	FixVerificationTickServiceApi,
	never,
	Database | WarehouseQueryService | IssueFixVerificationService
> = Effect.gen(function* () {
	const database = yield* Database
	const warehouse = yield* WarehouseQueryService
	const verification = yield* IssueFixVerificationService
	const dbExecute = makeErrorDatabaseExecute(database, "FixVerificationTickService")

	// Present only inside a Worker isolate; absent in tests and local runs, where
	// the enqueue records `no_binding` rather than silently degrading.
	const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
	const fanoutBinding = Option.match(workerEnv, {
		onNone: () => undefined,
		onSome: (env) => env[INVESTIGATION_FANOUT_BINDING],
	})

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

	/**
	 * Split occurrences since the merge into "from a build that postdates the fix"
	 * and "from a build that was already running".
	 *
	 * Only the first is evidence against the fix. The second is what the whole
	 * baseline mechanism exists to discount — without it, any product with users
	 * on old builds could never have a fix verified.
	 */
	const occurrenceSplit = Effect.fn("FixVerificationTick.occurrenceSplit")(function* (
		row: ErrorIssueVerificationRow,
		fingerprintHash: string,
		nowMs: number,
	) {
		const mergedAtMs = dateToMs(row.mergedAt) ?? nowMs
		const compiled = CH.compile(CH.errorIssueVersionsSinceQuery({ limit: VERSION_SCAN_LIMIT }), {
			orgId: row.orgId,
			fingerprintHash,
			startTime: formatWarehouseDateTime(mergedAtMs),
			endTime: formatWarehouseDateTime(nowMs),
		})
		const rows = yield* warehouse.compiledQuery(systemTenant(row.orgId), compiled, {
			context: "errorIssueVersionsSince",
		})
		return splitVersionRows(rows, row.baselineVersionsJson, VERSION_SCAN_LIMIT)
	})

	const verdictFromRun = verdictFromInvestigationStatus

	// Not annotated with the public signature: this one can fail on persistence.
	// `runTickSafely` below is what satisfies the never-failing contract.
	const runTick = Effect.fn("FixVerificationTick.runTick")(function* () {
		const nowMs = yield* Clock.currentTimeMillis

		/**
		 * Applying a verdict is guarded per row rather than per tick. `settledRuns`
		 * re-selects on `status = "running"` and only `applyVerdict` clears it, so a
		 * row that fails deterministically would otherwise abort the tick before
		 * phase 2 is reached — every minute, freezing every other issue in
		 * `verifying` with all-zero counters to show for it. Reports whether the
		 * verdict landed so the counters describe work actually done.
		 */
		const applyVerdictGuarded = (
			row: ErrorIssueVerificationRow,
			verdict: VerificationVerdict,
			note: string,
		) =>
			verification.applyVerdict(row, verdict, note, nowMs).pipe(
				Effect.as(true),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logError("[FixVerification] could not apply a verdict").pipe(
								Effect.annotateLogs({
									orgId: row.orgId,
									verificationId: row.id,
									verdict,
									error: summarizeCause(cause),
								}),
								Effect.as(false),
							),
				),
			)

		// Phase 1: settle runs that have finished since the last tick. Done first so
		// a verification that already has an answer is not competing for this
		// minute's budget with one that still needs an agent.
		let verdictsApplied = 0
		let failedRows = 0
		const settled = yield* verification.settledRuns(MAX_VERIFICATIONS_PER_TICK)
		for (const run of settled) {
			const { verdict, reason } = verdictFromRun(run.investigationStatus)
			const note = run.summary === null ? reason : `${reason}\n\n${run.summary}`
			if (yield* applyVerdictGuarded(run.verification, verdict, note)) verdictsApplied += 1
			else failedRows += 1
		}

		const due = yield* verification.dueVerifications(nowMs, MAX_VERIFICATIONS_PER_TICK)

		let refuted = 0
		let investigationsStarted = 0
		let skipped = 0

		for (const row of due) {
			const context = yield* dbExecute((db) =>
				db
					.select({
						fingerprintHash: errorIssues.fingerprintHash,
						workflowState: errorIssues.workflowState,
						url: errorIssuePullRequests.url,
					})
					.from(errorIssues)
					.innerJoin(errorIssuePullRequests, eq(errorIssuePullRequests.id, row.pullRequestId))
					.where(and(eq(errorIssues.orgId, row.orgId), eq(errorIssues.id, row.issueId)))
					.limit(1),
			)
			const subject = context[0]
			if (subject === undefined) {
				skipped += 1
				continue
			}

			const split = yield* occurrenceSplit(row, subject.fingerprintHash, nowMs).pipe(
				Effect.map(Option.some),
				// Interrupts (isolate teardown) are NOT failures — re-raise them so the
				// tick cancels promptly instead of recording a non-answer for this row.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("[FixVerification] occurrence split unavailable").pipe(
								Effect.annotateLogs({
									orgId: row.orgId,
									verificationId: row.id,
									error: summarizeCause(cause),
								}),
								// Leave the row waiting; the warehouse being down is not a verdict.
								Effect.as(
									Option.none<{
										postMerge: number
										staleClients: number
										unattributed: number
									}>(),
								),
							),
				),
			)
			if (Option.isNone(split)) {
				skipped += 1
				continue
			}

			// The decisive case, and it needs no agent: the error fired from a build
			// that did not exist when the fix merged.
			if (split.value.postMerge > 0) {
				const applied = yield* applyVerdictGuarded(
					row,
					"not_fixed",
					`${split.value.postMerge} occurrence(s) since the merge came from builds that were not running when the fix landed.`,
				)
				if (applied) refuted += 1
				else failedRows += 1
				continue
			}

			// Occurrences that could not be attributed to a build make the window
			// unreadable: proceeding as though they did not happen is how an error
			// still firing from a version-less service gets `verified` and
			// auto-closed. Inconclusive, not a refutation — those occurrences may
			// equally be old clients — and `applyVerdict` re-arms one longer window
			// before handing the issue back to a human.
			if (split.value.unattributed > 0) {
				const applied = yield* applyVerdictGuarded(
					row,
					"inconclusive",
					"Occurrences since the merge carried no service.version (or the version scan was truncated), so they cannot be attributed to a pre- or post-merge build.",
				)
				if (applied) verdictsApplied += 1
				else failedRows += 1
				continue
			}

			// Nothing observed at all, from any build, and the window has run its
			// course. That is only meaningful if the issue had enough traffic for
			// silence to mean something — which is exactly what the window length
			// was computed from, so reaching here with a usable pre-merge rate is
			// itself the evidence. With no usable rate, say so rather than guess.
			const hadUsableRate = row.baselineRatePerHour > 0
			if (!hadUsableRate && split.value.staleClients === 0) {
				// A verdict, not a skip: the row leaves `waiting` for good here.
				const applied = yield* applyVerdictGuarded(
					row,
					"inconclusive",
					"This error fired too rarely before the merge for silence afterwards to confirm the fix.",
				)
				if (applied) verdictsApplied += 1
				else failedRows += 1
				continue
			}

			const enqueued = yield* enqueueFixVerification({
				verification: row,
				pullRequestUrl: subject.url,
				postMergeOccurrences: split.value.postMerge,
				staleClientOccurrences: split.value.staleClients,
				fanoutBinding,
			}).pipe(
				Effect.provideService(Database, database),
				// An interrupt here must never become `{ enqueued: false }`: the fallback
				// below reads that as "no agent available" and can write a terminal
				// `verified` verdict, auto-closing the issue on an isolate teardown.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("[FixVerification] could not enqueue verification agent").pipe(
								Effect.annotateLogs({
									orgId: row.orgId,
									verificationId: row.id,
									error: summarizeCause(cause),
								}),
								Effect.as({ enqueued: false, reason: "error" } as const),
							),
				),
			)

			if (enqueued.enqueued) {
				yield* verification.markRunning(row, enqueued.investigationId, nowMs)
				investigationsStarted += 1
				continue
			}

			// No agent available. Rather than leaving the row waiting forever, fall
			// back to the deterministic reading: zero post-merge occurrences across a
			// window sized from this issue's own rate IS the evidence, and the agent
			// was only ever going to corroborate it. Recorded as a verdict so the
			// timeline says what happened and why.
			const fallbackVerdict: VerificationVerdict =
				row.attempt + 1 >= MAX_VERIFICATION_ATTEMPTS || hadUsableRate ? "verified" : "inconclusive"
			// A verdict, and the riskiest one in the tick — it can auto-close without
			// any agent pass — so it is counted as a verdict rather than a skip.
			const applied = yield* applyVerdictGuarded(
				row,
				fallbackVerdict,
				fallbackVerdict === "verified"
					? `No occurrences from post-merge builds across the verification window. (Verified from the occurrence data; no agent pass ran: ${enqueued.reason}.)`
					: `Verification could not reach a confident answer and no agent pass was available: ${enqueued.reason}.`,
			)
			if (applied) verdictsApplied += 1
			else failedRows += 1
		}

		yield* Effect.annotateCurrentSpan({
			"maple.verification.examined": due.length,
			"maple.verification.refuted": refuted,
			"maple.verification.investigations_started": investigationsStarted,
			"maple.verification.verdicts_applied": verdictsApplied,
			"maple.verification.skipped": skipped,
			"maple.verification.failed_rows": failedRows,
		})

		return { examined: due.length, refuted, investigationsStarted, verdictsApplied, skipped, failedRows }
	})

	const runTickSafely: FixVerificationTickServiceApi["runTick"] = () =>
		runTick().pipe(
			// Interrupts are re-raised rather than reported as an empty tick: the
			// worker's `catchTickFailure` re-raises them for every other tick so the
			// isolate tears down gracefully, and swallowing them here would make that
			// guard dead code for this one.
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logError("[FixVerification] verification tick failed").pipe(
							Effect.annotateLogs({ error: summarizeCause(cause) }),
							Effect.as({
								examined: 0,
								refuted: 0,
								investigationsStarted: 0,
								verdictsApplied: 0,
								skipped: 0,
								failedRows: 0,
							} satisfies FixVerificationTickResult),
						),
			),
		)

	return { runTick: runTickSafely } satisfies FixVerificationTickServiceApi
})

export class FixVerificationTickService extends Context.Service<
	FixVerificationTickService,
	FixVerificationTickServiceApi
>()("@maple/api/services/errors/FixVerificationTickService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
