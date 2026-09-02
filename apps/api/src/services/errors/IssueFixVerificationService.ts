import { randomUUID } from "node:crypto"
import {
	type ActorDocument,
	type ActorId,
	type ErrorIssuePullRequestId,
	ErrorIssuePullRequestId as ErrorIssuePullRequestIdSchema,
	ErrorIssuePullRequestDocument,
	ErrorIssuePullRequestInvalidError,
	ErrorIssuePullRequestNotFoundError,
	ErrorIssuePullRequestsResponse,
	type ErrorIssueId,
	ErrorIssueNotFoundError,
	ErrorIssueTransitionError,
	type ErrorIssueVerificationId,
	ErrorIssueVerificationId as ErrorIssueVerificationIdSchema,
	ErrorIssueVerificationDocument,
	ErrorIssueVerificationsResponse,
	ErrorPersistenceError,
	extractIssueIdsFromText,
	type OrgId,
	parsePullRequestUrl,
	type PullRequestLinkSource,
	type PullRequestLinkState,
	type VerificationVerdict,
	verificationVerdictAutoCloses,
	verificationWindowMs,
	MAX_VERIFICATION_ATTEMPTS,
} from "@maple/domain/http"
import { ErrorIssueId as ErrorIssueIdSchema, type InvestigationId } from "@maple/domain/primitives"
import {
	errorIssueEvents,
	errorIssuePullRequests,
	errorIssues,
	errorIssueVerifications,
	investigations,
	type ErrorIssuePullRequestRow,
	type ErrorIssueRow,
	type ErrorIssueVerificationRow,
} from "@maple/db"
import { and, desc, eq, inArray, lte, ne } from "drizzle-orm"
import { Array as Arr, Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { summarizeCause } from "@/platform/describe-cause"
import { Env } from "@/platform/Env"
import { dateToMs, msToDate } from "@/platform/time"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { PullRequestLookup } from "./PullRequestLookup"
import { makeErrorDatabaseExecute } from "./error-persistence"

const decodePullRequestIdSync = Schema.decodeUnknownSync(ErrorIssuePullRequestIdSchema)
const decodeVerificationIdSync = Schema.decodeUnknownSync(ErrorIssueVerificationIdSchema)
const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueIdSchema)
const decodeDateTimeSync = Schema.decodeUnknownSync(ErrorIssuePullRequestDocument.fields.createdAt)

const HOUR_MS = 60 * 60_000

/**
 * The issue's own occurrence rate, in occurrences per hour, over the span it has
 * been observed.
 *
 * A lifetime average rather than a trailing window, and deliberately so: the
 * numbers are already on the issue row, so sizing a verification window costs no
 * query at all, and a warehouse read on every merge would put a ClickHouse
 * dependency on the webhook path. The trade is real — an error that was quiet
 * for a month and then started firing hourly reads as slower than it is now, and
 * gets a longer window than it needs. Erring long is the safe direction here:
 * the cost is a late auto-close, not a wrong one.
 *
 * Returns 0 when the span is degenerate (a brand-new issue seen once), which
 * `verificationWindowMs` reads as "no usable rate" and answers with the band
 * maximum.
 */
export const occurrenceRatePerHour = (
	row: Pick<ErrorIssueRow, "occurrenceCount" | "firstSeenAt" | "lastSeenAt">,
): number => {
	const firstMs = dateToMs(row.firstSeenAt)
	const lastMs = dateToMs(row.lastSeenAt)
	if (firstMs === null || lastMs === null) return 0
	const spanMs = lastMs - firstMs
	if (spanMs <= 0 || row.occurrenceCount <= 0) return 0
	return row.occurrenceCount / (spanMs / HOUR_MS)
}

/**
 * Whether any of the builds observed in a window postdates the merge.
 *
 * The same membership test `isRegression` applies to a resolution, applied to a
 * merge instead: a build already running when the fix landed is an old client
 * still in the wild, and a build absent from that set is the fix demonstrably
 * not working. An empty observation carries no information and is not treated as
 * evidence either way — note this differs from `isRegression`, which treats
 * "no build information at all" as a regression. That asymmetry is deliberate:
 * a regression check errs toward reopening, while a verification that guessed
 * the same way would refute every fix arriving from a service that does not
 * report `service.version`.
 */
export const hasPostMergeVersion = (
	baselineVersions: ReadonlyArray<string>,
	observedVersions: ReadonlyArray<string>,
): boolean => {
	const fresh = observedVersions.filter((version) => version !== "")
	if (fresh.length === 0) return false
	return fresh.some((version) => !baselineVersions.includes(version))
}

export interface PullRequestEventInput {
	readonly orgId: OrgId
	readonly provider: "github"
	readonly externalRepoId: string
	readonly repoFullName: string
	readonly number: number
	readonly action: "opened" | "edited" | "reopened" | "closed" | "synchronize"
	readonly url: string
	readonly title: string | null
	readonly body: string | null
	readonly authorLogin: string | null
	readonly merged: boolean
	readonly mergeCommitSha: string | null
	readonly mergedAtMs: number | null
}

export interface PullRequestEventOutcome {
	readonly linksAutoCreated: number
	readonly verificationsOpened: number
	readonly linksUpdated: number
}

export interface IssueFixVerificationServiceApi {
	readonly listPullRequests: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssuePullRequestsResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly linkPullRequest: (
		orgId: OrgId,
		actorId: ActorId | null,
		issueId: ErrorIssueId,
		url: string,
		source: PullRequestLinkSource,
	) => Effect.Effect<
		ErrorIssuePullRequestDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssuePullRequestInvalidError
	>
	readonly unlinkPullRequest: (
		orgId: OrgId,
		actorId: ActorId | null,
		issueId: ErrorIssueId,
		pullRequestId: ErrorIssuePullRequestId,
	) => Effect.Effect<
		ErrorIssuePullRequestsResponse,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssuePullRequestNotFoundError
	>
	readonly listVerifications: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssueVerificationsResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	/** Webhook entry point. Never fails the delivery on a per-issue problem. */
	readonly onPullRequestEvent: (
		input: PullRequestEventInput,
	) => Effect.Effect<PullRequestEventOutcome, ErrorPersistenceError>
	/**
	 * The error tick's short-circuit: an occurrence from a build that postdates the
	 * merge refutes the fix immediately, without waiting out the window or spending
	 * an agent pass.
	 */
	readonly refuteOnPostMergeOccurrence: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		observedVersions: ReadonlyArray<string>,
		nowMs: number,
	) => Effect.Effect<boolean, ErrorPersistenceError>
	/**
	 * Verifications whose agent run has finished, paired with the outcome of that
	 * run. Read by the tick to settle the verdict.
	 */
	readonly settledRuns: (limit: number) => Effect.Effect<
		ReadonlyArray<{
			readonly verification: ErrorIssueVerificationRow
			readonly investigationStatus: string
			readonly summary: string | null
		}>,
		ErrorPersistenceError
	>
	/** Verifications whose window has closed and which are ready for a verdict. */
	readonly dueVerifications: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<ErrorIssueVerificationRow>, ErrorPersistenceError>
	readonly markRunning: (
		row: ErrorIssueVerificationRow,
		investigationId: InvestigationId | null,
		nowMs: number,
	) => Effect.Effect<void, ErrorPersistenceError>
	readonly applyVerdict: (
		row: ErrorIssueVerificationRow,
		verdict: VerificationVerdict,
		note: string,
		nowMs: number,
	) => Effect.Effect<void, ErrorPersistenceError>
}

/**
 * How far back the repository suggester scans this org's pull-request links
 * looking for one in a connected repository. Bounded because it is the weakest
 * of the four signals — an org whose last few dozen links are all in repos it
 * has since disconnected does not get a suggestion, and that is the right answer.
 */
const RECENT_LINK_SCAN_LIMIT = 50

const make: Effect.Effect<
	IssueFixVerificationServiceApi,
	never,
	Database | Env | ErrorActorsService | ErrorIssueWorkflowService | PullRequestLookup
> = Effect.gen(function* () {
	const database = yield* Database
	const env = yield* Env
	const actors = yield* ErrorActorsService
	const workflow = yield* ErrorIssueWorkflowService
	const lookup = yield* PullRequestLookup
	const dbExecute = makeErrorDatabaseExecute(database, "IssueFixVerificationService")

	const newPullRequestId = () => decodePullRequestIdSync(randomUUID())
	const newVerificationId = () => decodeVerificationIdSync(randomUUID())
	const isoFromDate = (date: Date) => decodeDateTimeSync(date.toISOString())

	const rowToDocument = (
		row: ErrorIssuePullRequestRow,
		actorMap: Map<ActorId, ActorDocument>,
	): ErrorIssuePullRequestDocument =>
		new ErrorIssuePullRequestDocument({
			id: row.id,
			issueId: row.issueId,
			provider: row.provider,
			repoFullName: row.repoFullName,
			number: row.number,
			url: row.url,
			title: row.title ?? null,
			authorLogin: row.authorLogin ?? null,
			state: row.state,
			mergedAt: row.mergedAt == null ? null : isoFromDate(row.mergedAt),
			mergeCommitSha: row.mergeCommitSha ?? null,
			linkSource: row.linkSource,
			linkedByActor: row.linkedByActorId == null ? null : (actorMap.get(row.linkedByActorId) ?? null),
			createdAt: isoFromDate(row.createdAt),
		})

	const verificationToDocument = (row: ErrorIssueVerificationRow): ErrorIssueVerificationDocument =>
		new ErrorIssueVerificationDocument({
			id: row.id,
			issueId: row.issueId,
			pullRequestId: row.pullRequestId,
			status: row.status,
			mergedAt: isoFromDate(row.mergedAt),
			verifyAfter: isoFromDate(row.verifyAfter),
			baselineVersions: row.baselineVersionsJson,
			baselineOccurrenceCount: row.baselineOccurrenceCount,
			baselineRatePerHour: row.baselineRatePerHour,
			postMergeOccurrenceCount: row.postMergeOccurrenceCount,
			investigationId: row.investigationId ?? null,
			verdict: row.verdict ?? null,
			verdictNote: row.verdictNote ?? null,
			attempt: row.attempt,
			createdAt: isoFromDate(row.createdAt),
			updatedAt: isoFromDate(row.updatedAt),
		})

	const selectLinks = (orgId: OrgId, issueId: ErrorIssueId) =>
		dbExecute((db) =>
			db
				.select()
				.from(errorIssuePullRequests)
				.where(
					and(eq(errorIssuePullRequests.orgId, orgId), eq(errorIssuePullRequests.issueId, issueId)),
				)
				.orderBy(desc(errorIssuePullRequests.createdAt)),
		)

	const hydrateLinks = Effect.fn("IssueFixVerification.hydrateLinks")(function* (
		orgId: OrgId,
		rows: ReadonlyArray<ErrorIssuePullRequestRow>,
		suggestedRepository: string | null = null,
	) {
		const actorIds = Array.from(
			new Set(rows.flatMap((row) => (row.linkedByActorId == null ? [] : [row.linkedByActorId]))),
		)
		const actorMap = yield* actors.collectActorDocs(orgId, actorIds)
		return new ErrorIssuePullRequestsResponse({
			pullRequests: rows.map((row) => rowToDocument(row, actorMap)),
			suggestedRepository,
		})
	})

	/**
	 * Which repository the attach-a-PR picker should open on.
	 *
	 * Four signals, strongest first, first hit wins — and every one of them is a
	 * Postgres read, deliberately. The exact answer would be to resolve the
	 * service's recent `deployment.commit_sha` values against `vcs_commits`, but
	 * that puts a warehouse query on the issue page to compute a *default* the user
	 * can override with one click. Not worth it.
	 *
	 * Signal 3 abstains when more than one repository matches the service name.
	 * A wrong preselection is worse than none: it is silent, and it is the kind of
	 * mistake somebody only notices after attaching the wrong PR.
	 */
	const suggestRepository = Effect.fn("IssueFixVerification.suggestRepository")(function* (
		orgId: OrgId,
		serviceName: string,
		existingLinks: ReadonlyArray<ErrorIssuePullRequestRow>,
	) {
		// 1. A PR already attached to this issue. The follow-up fix almost always
		// lands in the same repository as the first one.
		const alreadyLinked = existingLinks[0]?.repoFullName
		if (alreadyLinked !== undefined) return alreadyLinked

		const connected = yield* lookup.listRepositories(orgId)
		if (connected.length === 0) return null
		// 2. Nothing to choose between.
		if (connected.length === 1) return connected[0] ?? null

		// 3. The service name against the repository name.
		const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
		const service = normalize(serviceName)
		if (service.length > 0) {
			const matches = connected.filter((fullName) => {
				const name = normalize(fullName.split("/")[1] ?? fullName)
				if (name.length === 0) return false
				return name === service || name.includes(service) || service.includes(name)
			})
			if (matches.length === 1) return matches[0] ?? null
		}

		// 4. Wherever this org's fixes have most recently been landing.
		const recent = yield* dbExecute((db) =>
			db
				.select({ repoFullName: errorIssuePullRequests.repoFullName })
				.from(errorIssuePullRequests)
				.where(eq(errorIssuePullRequests.orgId, orgId))
				.orderBy(desc(errorIssuePullRequests.createdAt))
				.limit(RECENT_LINK_SCAN_LIMIT),
		)
		const connectedSet = new Set(connected)
		for (const row of recent) {
			if (connectedSet.has(row.repoFullName)) return row.repoFullName
		}

		return null
	})

	const listPullRequests: IssueFixVerificationServiceApi["listPullRequests"] = Effect.fn(
		"IssueFixVerification.listPullRequests",
	)(function* (orgId, issueId) {
		const issue = yield* workflow.requireIssue(orgId, issueId)
		const rows = yield* selectLinks(orgId, issueId)
		const suggested = yield* suggestRepository(orgId, issue.serviceName, rows)
		return yield* hydrateLinks(orgId, rows, suggested)
	})

	const listVerifications: IssueFixVerificationServiceApi["listVerifications"] = Effect.fn(
		"IssueFixVerification.listVerifications",
	)(function* (orgId, issueId) {
		yield* workflow.requireIssue(orgId, issueId)
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssueVerifications)
				.where(
					and(
						eq(errorIssueVerifications.orgId, orgId),
						eq(errorIssueVerifications.issueId, issueId),
					),
				)
				.orderBy(desc(errorIssueVerifications.createdAt)),
		)
		return new ErrorIssueVerificationsResponse({
			verifications: rows.map(verificationToDocument),
		})
	})

	/**
	 * Insert-or-return the link row. Idempotent on the unique
	 * `(org, issue, provider, repo, number)` index because three independent paths
	 * create the same link — `propose_fix`, the manual dialog, and the webhook's
	 * body scan — and two of them can race on a single PR.
	 */
	const upsertLink = Effect.fn("IssueFixVerification.upsertLink")(function* (input: {
		readonly orgId: OrgId
		readonly issueId: ErrorIssueId
		readonly actorId: ActorId | null
		readonly source: PullRequestLinkSource
		readonly provider: "github"
		readonly repoFullName: string
		readonly number: number
		readonly url: string
		readonly title?: string | null
		readonly authorLogin?: string | null
		readonly externalRepoId?: string | null
		/** The PR's real state when the caller already knows it. Defaults to `open`. */
		readonly state?: PullRequestLinkState
		readonly mergedAtMs?: number | null
		readonly mergeCommitSha?: string | null
		readonly nowMs: number
	}) {
		const now = msToDate(input.nowMs)
		yield* dbExecute((db) =>
			db
				.insert(errorIssuePullRequests)
				.values({
					id: newPullRequestId(),
					orgId: input.orgId,
					issueId: input.issueId,
					provider: input.provider,
					externalRepoId: input.externalRepoId ?? null,
					repoFullName: input.repoFullName,
					number: input.number,
					url: input.url,
					title: input.title ?? null,
					authorLogin: input.authorLogin ?? null,
					state: input.state ?? "open",
					mergedAt: input.mergedAtMs == null ? null : msToDate(input.mergedAtMs),
					mergeCommitSha: input.mergeCommitSha ?? null,
					linkSource: input.source,
					linkedByActorId: input.actorId,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing({
					target: [
						errorIssuePullRequests.orgId,
						errorIssuePullRequests.issueId,
						errorIssuePullRequests.provider,
						errorIssuePullRequests.repoFullName,
						errorIssuePullRequests.number,
					],
				}),
		)

		// A caller that resolved the PR's real state applies it to the existing row
		// too, not just the one it may have just inserted. Re-attaching a PR is then
		// a repair for a link whose `pull_request` webhook was missed or never sent:
		// without this the conflict path would leave a merged PR recorded as `open`
		// forever, since the insert wrote nothing.
		if (input.state !== undefined) {
			yield* dbExecute((db) =>
				db
					.update(errorIssuePullRequests)
					.set({
						title: input.title ?? null,
						authorLogin: input.authorLogin ?? null,
						state: input.state,
						mergedAt: input.mergedAtMs == null ? null : msToDate(input.mergedAtMs),
						mergeCommitSha: input.mergeCommitSha ?? null,
						updatedAt: now,
					})
					.where(
						and(
							eq(errorIssuePullRequests.orgId, input.orgId),
							eq(errorIssuePullRequests.issueId, input.issueId),
							eq(errorIssuePullRequests.provider, input.provider),
							eq(errorIssuePullRequests.repoFullName, input.repoFullName),
							eq(errorIssuePullRequests.number, input.number),
						),
					),
			)
		}

		// Read back rather than trusting a driver write-result shape (see the
		// Postgres conventions in CLAUDE.md) — and because on a conflict the insert
		// wrote nothing and the existing row is what callers need.
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssuePullRequests)
				.where(
					and(
						eq(errorIssuePullRequests.orgId, input.orgId),
						eq(errorIssuePullRequests.issueId, input.issueId),
						eq(errorIssuePullRequests.provider, input.provider),
						eq(errorIssuePullRequests.repoFullName, input.repoFullName),
						eq(errorIssuePullRequests.number, input.number),
					),
				)
				.limit(1),
		)
		return rows[0] ?? null
	})

	const linkPullRequest: IssueFixVerificationServiceApi["linkPullRequest"] = Effect.fn(
		"IssueFixVerification.linkPullRequest",
	)(function* (orgId, actorId, issueId, url, source) {
		yield* workflow.requireIssue(orgId, issueId)
		const parsed = parsePullRequestUrl(url)
		if (parsed === null) {
			return yield* Effect.fail(
				new ErrorIssuePullRequestInvalidError({
					message: "Not a recognizable GitHub pull request URL",
					rawUrl: url,
				}),
			)
		}
		const nowMs = yield* Clock.currentTimeMillis

		// Ask the provider what this PR actually is, before storing it. Without
		// this the row goes in as `title: null, state: "open"` and stays that way
		// until a webhook happens to arrive — which for a PR that merged BEFORE it
		// was attached is never, because GitHub does not redeliver a past `closed`
		// event. Best-effort by construction: the port answers `Option.none` for an
		// unconnected repo or an unreachable provider, and the link is stored
		// unenriched exactly as it was before.
		const summary = yield* lookup.fetch(orgId, parsed.repoFullName, parsed.number)
		yield* Effect.annotateCurrentSpan({
			"vcs.pull_request.hydrated": Option.isSome(summary),
			...(Option.isSome(summary) ? { "vcs.pull_request.state": summary.value.state } : undefined),
		})

		const row = yield* upsertLink({
			orgId,
			issueId,
			actorId,
			source,
			provider: parsed.provider,
			repoFullName: parsed.repoFullName,
			number: parsed.number,
			url: parsed.url,
			...(Option.isSome(summary)
				? {
						title: summary.value.title,
						authorLogin: summary.value.authorLogin,
						state: summary.value.state,
						mergedAtMs: summary.value.mergedAtMs,
						mergeCommitSha: summary.value.mergeCommitSha,
					}
				: undefined),
			nowMs,
		})
		if (row === null) {
			// Not an invalid URL — it parsed at `:388`. The insert-and-read-back found
			// no row, which is a persistence anomaly: reporting it as a 400 would tell
			// the caller their well-formed URL was unrecognizable, and because the
			// invalid-URL tag is an anticipated error its span exception is suppressed,
			// so the anomaly would vanish from error dashboards entirely.
			return yield* Effect.fail(
				new ErrorPersistenceError({
					message: "Pull request link could not be stored",
					cause: `upsert returned no row for ${parsed.url}`,
				}),
			)
		}
		yield* workflow.recordEvent(orgId, issueId, actorId, "pr_linked", {
			payload: {
				pullRequestId: row.id,
				url: row.url,
				repoFullName: row.repoFullName,
				number: row.number,
				source,
			},
			timestamp: nowMs,
		})

		// The PR had already merged by the time somebody attached it — the normal
		// human order of operations. GitHub will not redeliver the `closed` event
		// that would have opened the verification window, so open it here or the
		// issue waits in `in_review` for a webhook that is never coming.
		if (row.state === "merged") {
			yield* openMergedVerifications(orgId, [row], {
				mergedAtMs: row.mergedAt === null ? nowMs : dateToMs(row.mergedAt),
				mergeCommitSha: row.mergeCommitSha,
				nowMs,
			})
		}

		const response = yield* hydrateLinks(orgId, [row])
		const document = response.pullRequests[0]
		if (document === undefined) {
			// Same reasoning as the store path above: the link exists, hydration lost it.
			return yield* Effect.fail(
				new ErrorPersistenceError({
					message: "Pull request link could not be rendered",
					cause: `hydrate returned no document for pull request ${row.id}`,
				}),
			)
		}
		return document
	})

	const unlinkPullRequest: IssueFixVerificationServiceApi["unlinkPullRequest"] = Effect.fn(
		"IssueFixVerification.unlinkPullRequest",
	)(function* (orgId, actorId, issueId, pullRequestId) {
		yield* workflow.requireIssue(orgId, issueId)
		const existing = yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssuePullRequests)
				.where(
					and(
						eq(errorIssuePullRequests.orgId, orgId),
						eq(errorIssuePullRequests.issueId, issueId),
						eq(errorIssuePullRequests.id, pullRequestId),
					),
				)
				.limit(1),
		)
		const row = existing[0]
		if (row === undefined) {
			return yield* Effect.fail(
				new ErrorIssuePullRequestNotFoundError({
					message: "Pull request link not found on this issue",
					pullRequestId,
				}),
			)
		}
		const nowMs = yield* Clock.currentTimeMillis
		// Abandon any verification riding on this link: without the PR there is
		// nothing left to verify, and a live row would keep the issue pinned in
		// `verifying` with no way out.
		yield* dbExecute((db) =>
			db
				.update(errorIssueVerifications)
				.set({ status: "abandoned", updatedAt: msToDate(nowMs) })
				.where(
					and(
						eq(errorIssueVerifications.orgId, orgId),
						eq(errorIssueVerifications.pullRequestId, pullRequestId),
						inArray(errorIssueVerifications.status, ["waiting", "running"]),
					),
				),
		)
		yield* dbExecute((db) =>
			db.delete(errorIssuePullRequests).where(eq(errorIssuePullRequests.id, pullRequestId)),
		)
		yield* workflow.recordEvent(orgId, issueId, actorId, "pr_unlinked", {
			payload: { pullRequestId, url: row.url, repoFullName: row.repoFullName, number: row.number },
			timestamp: nowMs,
		})
		const remaining = yield* selectLinks(orgId, issueId)
		return yield* hydrateLinks(orgId, remaining)
	})

	/**
	 * Open a verification window for one issue whose linked PR just merged.
	 *
	 * Failures here are logged and swallowed rather than propagated: a webhook
	 * delivery covering several issues must not lose the rest because one issue
	 * was mid-transition, and GitHub retries a 500 on the whole delivery, which
	 * would re-verify the issues that already succeeded.
	 */
	const openVerification = Effect.fn("IssueFixVerification.openVerification")(function* (input: {
		readonly orgId: OrgId
		readonly issue: ErrorIssueRow
		readonly link: ErrorIssuePullRequestRow
		readonly mergedAtMs: number
		readonly nowMs: number
		readonly systemActor: ActorDocument
	}) {
		const { orgId, issue, link, mergedAtMs, nowMs, systemActor } = input

		const ratePerHour = occurrenceRatePerHour(issue)
		const windowMs = verificationWindowMs({ severity: issue.severity ?? null, ratePerHour })
		const verifyAfterMs = mergedAtMs + windowMs

		const verificationId = newVerificationId()
		// `onConflictDoNothing` against the unique partial index: the concurrent
		// delivery that lost the race stops here rather than opening a second
		// window, and `.returning()` is what says which one this was — a driver
		// write-result shape would not.
		const opened = yield* dbExecute((db) =>
			db
				.insert(errorIssueVerifications)
				.values({
					id: verificationId,
					orgId,
					issueId: issue.id,
					pullRequestId: link.id,
					status: "waiting",
					mergedAt: msToDate(mergedAtMs),
					verifyAfter: msToDate(verifyAfterMs),
					// The builds this issue was known to affect at merge time. Everything
					// downstream is a membership test against this array.
					baselineVersionsJson: issue.seenVersionsJson,
					baselineOccurrenceCount: issue.occurrenceCount,
					baselineRatePerHour: ratePerHour,
					attempt: 0,
					createdAt: msToDate(nowMs),
					updatedAt: msToDate(nowMs),
				})
				.onConflictDoNothing()
				.returning({ id: errorIssueVerifications.id }),
		)
		if (opened.length === 0) return

		yield* workflow.recordEvent(orgId, issue.id, systemActor.id, "verification_started", {
			payload: {
				verificationId,
				pullRequestId: link.id,
				url: link.url,
				repoFullName: link.repoFullName,
				number: link.number,
				windowMs,
				verifyAfter: new Date(verifyAfterMs).toISOString(),
				ratePerHour,
				baselineVersions: issue.seenVersionsJson,
			},
			timestamp: nowMs,
		})

		// A cancelled or wontfix issue has no legal edge into `verifying`, and an
		// issue already verifying stays put. Both are normal, so a rejected
		// transition leaves the verification row in place rather than failing.
		yield* workflow
			.applyTransition(orgId, systemActor.id, issue, "verifying", {
				payload: { viaPullRequestMerge: true, pullRequestId: link.id },
				timestamp: nowMs,
			})
			.pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueTransitionError": (error) =>
						Effect.logInfo("[FixVerification] issue could not enter verifying").pipe(
							Effect.annotateLogs({
								issueId: issue.id,
								workflowState: issue.workflowState,
								reason: error.message,
							}),
						),
					"@maple/http/errors/ErrorIssueNotFoundError": () => Effect.void,
				}),
			)

		return verificationId
	})

	/**
	 * Open a post-merge verification window for every issue linked to a PR that
	 * has merged, and return how many were actually opened.
	 *
	 * Shared by the two ways Maple learns a fix merged: the `pull_request` webhook,
	 * and a link attached to a PR that had *already* merged. The second is not an
	 * edge case — attaching the PR after the fact is the normal human order of
	 * operations — and GitHub never redelivers a past `closed` event, so without
	 * this call from the link path the window would never open and the issue would
	 * sit in `in_review` forever.
	 */
	const openMergedVerifications = Effect.fn("IssueFixVerification.openMergedVerifications")(function* (
		orgId: OrgId,
		links: ReadonlyArray<typeof errorIssuePullRequests.$inferSelect>,
		merge: {
			readonly mergedAtMs: number
			readonly mergeCommitSha: string | null
			readonly nowMs: number
		},
	) {
		const { mergedAtMs, mergeCommitSha, nowMs } = merge
		const systemActor = yield* actors.ensureSystemActor(orgId)

		// One issue's problem must not cost the others. The API doc on
		// `onPullRequestEvent` and `openVerification`'s both promise a multi-issue
		// delivery does not lose the rest when one issue fails, but only the
		// transition/not-found cases were caught — every `dbExecute` in here fails
		// outward as `ErrorPersistenceError` and aborted the remaining links, which
		// the sink then swallowed, so those links were dropped with no retry and no
		// trace of why.
		const openForLink = Effect.fn("IssueFixVerification.openForLink")(function* (
			link: (typeof links)[number],
		) {
			// One live verification per issue. A `synchronize` after a merge, a
			// redelivered webhook, or a second PR attached to the same issue must
			// not open a second window.
			const open = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssueVerifications)
					.where(
						and(
							eq(errorIssueVerifications.orgId, orgId),
							eq(errorIssueVerifications.issueId, link.issueId),
							inArray(errorIssueVerifications.status, ["waiting", "running"]),
						),
					)
					.limit(1),
			)
			if (Arr.isArrayNonEmpty(open)) return false

			const issueRows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, link.issueId)))
					.limit(1),
			)
			const issue = Arr.head(issueRows)
			if (Option.isNone(issue)) return false

			yield* workflow.recordEvent(orgId, link.issueId, systemActor.id, "pr_merged", {
				payload: {
					pullRequestId: link.id,
					url: link.url,
					repoFullName: link.repoFullName,
					number: link.number,
					mergeCommitSha,
					mergedAt: new Date(mergedAtMs).toISOString(),
				},
				timestamp: nowMs,
			})

			yield* openVerification({
				orgId,
				issue: issue.value,
				link: { ...link, mergedAt: msToDate(mergedAtMs), mergeCommitSha },
				mergedAtMs,
				nowMs,
				systemActor,
			})
			return true
		})

		let opened = 0
		for (const link of links) {
			const didOpen = yield* openForLink(link).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logError("[IssueFixVerification] could not open a verification").pipe(
								Effect.annotateLogs({
									orgId,
									issueId: link.issueId,
									pullRequestId: link.id,
									error: summarizeCause(cause),
								}),
								Effect.as(false),
							),
				),
			)
			if (didOpen) opened += 1
		}
		return opened
	})

	const onPullRequestEvent: IssueFixVerificationServiceApi["onPullRequestEvent"] = Effect.fn(
		"IssueFixVerification.onPullRequestEvent",
	)(function* (input) {
		const nowMs = yield* Clock.currentTimeMillis
		let linksAutoCreated = 0
		let verificationsOpened = 0

		// Auto-link: a PR whose title or body names a Maple issue links itself.
		// Runs on every action, not just `opened` — a description edited after the
		// fact is the common case, and `upsertLink` makes repeats free.
		const referenceText = [input.title ?? "", input.body ?? ""].join("\n")
		const referencedIds = extractIssueIdsFromText(referenceText, env.MAPLE_APP_BASE_URL)
		for (const rawId of referencedIds) {
			const decoded = decodeIssueId(rawId)
			if (Option.isNone(decoded)) continue
			const issueId = decoded.value
			// Confirm the issue exists in THIS org before linking. A PR body is
			// attacker-influenced text, so a well-formed id from another tenant must
			// not create a cross-org link.
			const issueRows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, issueId)))
					.limit(1),
			)
			if (issueRows[0] === undefined) continue
			const created = yield* upsertLink({
				orgId: input.orgId,
				issueId,
				actorId: null,
				source: "auto",
				provider: input.provider,
				repoFullName: input.repoFullName,
				number: input.number,
				url: input.url,
				title: input.title,
				authorLogin: input.authorLogin,
				externalRepoId: input.externalRepoId,
				nowMs,
			})
			if (created !== null && dateToMs(created.createdAt) === nowMs) {
				linksAutoCreated += 1
				yield* workflow.recordEvent(input.orgId, issueId, null, "pr_linked", {
					payload: {
						pullRequestId: created.id,
						url: created.url,
						repoFullName: created.repoFullName,
						number: created.number,
						source: "auto",
					},
					timestamp: nowMs,
				})
			}
		}

		// Every link pointing at this PR, however it was created.
		const links = yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssuePullRequests)
				.where(
					and(
						eq(errorIssuePullRequests.orgId, input.orgId),
						eq(errorIssuePullRequests.provider, input.provider),
						eq(errorIssuePullRequests.repoFullName, input.repoFullName),
						eq(errorIssuePullRequests.number, input.number),
					),
				),
		)
		if (links.length === 0) {
			return { linksAutoCreated, verificationsOpened, linksUpdated: 0 }
		}

		// `closed` on GitHub covers both outcomes; `merged` is what separates them.
		const nextState: PullRequestLinkState = input.merged
			? "merged"
			: input.action === "closed"
				? "closed"
				: "open"
		yield* dbExecute((db) =>
			db
				.update(errorIssuePullRequests)
				.set({
					state: nextState,
					title: input.title ?? null,
					authorLogin: input.authorLogin ?? null,
					externalRepoId: input.externalRepoId,
					mergedAt: input.mergedAtMs === null ? null : msToDate(input.mergedAtMs),
					mergeCommitSha: input.mergeCommitSha,
					updatedAt: msToDate(nowMs),
				})
				.where(
					and(
						inArray(
							errorIssuePullRequests.id,
							links.map((link) => link.id),
						),
						// A GitHub merge is irreversible, so a non-merged event reaching a
						// link already marked merged can only be a stale or out-of-order
						// queue delivery — never let it regress the state or null the merge
						// metadata a verification window was opened from.
						...(input.merged ? [] : [ne(errorIssuePullRequests.state, "merged")]),
					),
				),
		)

		if (!input.merged) {
			return { linksAutoCreated, verificationsOpened, linksUpdated: links.length }
		}

		const openedCount = yield* openMergedVerifications(input.orgId, links, {
			mergedAtMs: input.mergedAtMs ?? nowMs,
			mergeCommitSha: input.mergeCommitSha,
			nowMs,
		})
		verificationsOpened += openedCount

		return { linksAutoCreated, verificationsOpened, linksUpdated: links.length }
	})

	const refuteOnPostMergeOccurrence: IssueFixVerificationServiceApi["refuteOnPostMergeOccurrence"] =
		Effect.fn("IssueFixVerification.refuteOnPostMergeOccurrence")(
			function* (orgId, issueId, observedVersions, nowMs) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(errorIssueVerifications)
						.where(
							and(
								eq(errorIssueVerifications.orgId, orgId),
								eq(errorIssueVerifications.issueId, issueId),
								inArray(errorIssueVerifications.status, ["waiting", "running"]),
							),
						)
						.limit(1),
				)
				const verification = rows[0]
				if (verification === undefined) return false
				if (!hasPostMergeVersion(verification.baselineVersionsJson, observedVersions)) return false

				yield* applyVerdict(
					verification,
					"not_fixed",
					"An occurrence arrived from a build that was not running when the fix merged, so the fix did not resolve this error.",
					nowMs,
				)
				return true
			},
		)

	const settledRuns: IssueFixVerificationServiceApi["settledRuns"] = Effect.fn(
		"IssueFixVerification.settledRuns",
	)(function* (limit) {
		const rows = yield* dbExecute((db) =>
			db
				.select({
					verification: errorIssueVerifications,
					investigationStatus: investigations.status,
					reportJson: investigations.reportJson,
				})
				.from(errorIssueVerifications)
				.innerJoin(investigations, eq(investigations.id, errorIssueVerifications.investigationId))
				.where(
					and(
						eq(errorIssueVerifications.status, "running"),
						// `investigating` is still in flight. Everything else — diagnosed,
						// inconclusive, failed — is a finished run with something to say.
						ne(investigations.status, "investigating"),
					),
				)
				.limit(limit),
		)
		return rows.map((row) => ({
			verification: row.verification,
			investigationStatus: row.investigationStatus,
			summary:
				typeof row.reportJson === "object" &&
				row.reportJson !== null &&
				typeof (row.reportJson as { summary?: unknown }).summary === "string"
					? (row.reportJson as { summary: string }).summary
					: null,
		}))
	})

	const dueVerifications: IssueFixVerificationServiceApi["dueVerifications"] = Effect.fn(
		"IssueFixVerification.dueVerifications",
	)(function* (nowMs, limit) {
		return yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssueVerifications)
				.where(
					and(
						eq(errorIssueVerifications.status, "waiting"),
						lte(errorIssueVerifications.verifyAfter, msToDate(nowMs)),
					),
				)
				.limit(limit),
		)
	})

	const markRunning: IssueFixVerificationServiceApi["markRunning"] = Effect.fn(
		"IssueFixVerification.markRunning",
	)(function* (row, investigationId, nowMs) {
		// CAS on the state the tick selected the row in: the error tick can refute
		// this row while the agent is being enqueued, and resurrecting a terminal
		// `not_fixed` back to `running` would overwrite that decisive verdict. The
		// orphaned agent run is the cheaper casualty — with no investigationId
		// linked, `settledRuns` never picks it up.
		yield* dbExecute((db) =>
			db
				.update(errorIssueVerifications)
				.set({
					status: "running",
					investigationId,
					updatedAt: msToDate(nowMs),
				})
				.where(
					and(
						eq(errorIssueVerifications.id, row.id),
						eq(errorIssueVerifications.status, row.status),
						eq(errorIssueVerifications.attempt, row.attempt),
					),
				),
		)
	})

	const applyVerdict: IssueFixVerificationServiceApi["applyVerdict"] = Effect.fn(
		"IssueFixVerification.applyVerdict",
	)(function* (row, verdict, note, nowMs) {
		const systemActor = yield* actors.ensureSystemActor(row.orgId)

		// Every status write CASes on the state and attempt the caller read. Two
		// writers travel these rows — the error tick's refutation and this path —
		// so a stale snapshot must become a no-op, never a `verified` written over
		// a decisive `not_fixed`. The verdict event commits in the same
		// transaction: a status that settled without its event is invisible to
		// the timeline AND to the next tick, so nothing could ever repair it.
		const guard = () =>
			and(
				eq(errorIssueVerifications.id, row.id),
				eq(errorIssueVerifications.status, row.status),
				eq(errorIssueVerifications.attempt, row.attempt),
			)
		const lostRace = Effect.logInfo("[FixVerification] verdict lost a race and was not applied").pipe(
			Effect.annotateLogs({ orgId: row.orgId, verificationId: row.id, verdict }),
		)

		// An inconclusive verdict re-arms one longer window rather than settling.
		// Past the attempt cap it hands the issue back to a human instead of
		// looping forever in `verifying`.
		if (verdict === "inconclusive" && row.attempt + 1 < MAX_VERIFICATION_ATTEMPTS) {
			// Wait at least as long again as the first window did, and never less
			// than the untriaged-severity window — an inconclusive result means the
			// last look was too short, so a shorter retry would be pointless.
			const verifyAfterMs = dateToMs(row.verifyAfter)
			const mergedAtMs = dateToMs(row.mergedAt)
			const firstWindowMs =
				verifyAfterMs === null || mergedAtMs === null ? 0 : verifyAfterMs - mergedAtMs
			const extendedMs = Math.max(
				verificationWindowMs({ severity: null, ratePerHour: row.baselineRatePerHour }),
				firstWindowMs,
			)
			const retryEvent = workflow.buildEvent(
				row.orgId,
				row.issueId,
				systemActor.id,
				"verification_verdict",
				nowMs,
				{
					payload: {
						verificationId: row.id,
						verdict: "inconclusive",
						note,
						retrying: true,
						verifyAfter: new Date(nowMs + extendedMs).toISOString(),
					},
				},
			)
			const landed = yield* dbExecute((db) =>
				db.transaction(async (tx) => {
					const updated = await tx
						.update(errorIssueVerifications)
						.set({
							status: "waiting",
							attempt: row.attempt + 1,
							verifyAfter: msToDate(nowMs + extendedMs),
							verdict: null,
							verdictNote: note,
							investigationId: null,
							updatedAt: msToDate(nowMs),
						})
						.where(guard())
						.returning({ id: errorIssueVerifications.id })
					if (updated.length === 0) return false
					await tx.insert(errorIssueEvents).values(retryEvent)
					return true
				}),
			)
			if (!landed) yield* lostRace
			return
		}

		const status =
			verdict === "verified" ? "verified" : verdict === "not_fixed" ? "not_fixed" : "inconclusive"

		const issueRows = yield* dbExecute((db) =>
			db
				.select()
				.from(errorIssues)
				.where(and(eq(errorIssues.orgId, row.orgId), eq(errorIssues.id, row.issueId)))
				.limit(1),
		)
		const issue = Arr.head(issueRows)

		const autoCloses =
			Option.isSome(issue) &&
			verdict === "verified" &&
			verificationVerdictAutoCloses(issue.value.severity ?? null)

		// A vanished issue still gets its verdict on the verification row; there is
		// just no timeline to write the event to.
		const verdictEvent = Option.map(issue, (issue) =>
			workflow.buildEvent(row.orgId, row.issueId, systemActor.id, "verification_verdict", nowMs, {
				payload: {
					verificationId: row.id,
					verdict,
					note,
					autoClosed: autoCloses,
					severity: issue.severity ?? null,
					postMergeOccurrenceCount: row.postMergeOccurrenceCount,
					investigationId: row.investigationId,
				},
			}),
		)

		const landed = yield* dbExecute((db) =>
			db.transaction(async (tx) => {
				const updated = await tx
					.update(errorIssueVerifications)
					.set({
						status,
						verdict,
						verdictNote: note,
						updatedAt: msToDate(nowMs),
					})
					.where(guard())
					.returning({ id: errorIssueVerifications.id })
				if (updated.length === 0) return false
				if (Option.isSome(verdictEvent)) await tx.insert(errorIssueEvents).values(verdictEvent.value)
				return true
			}),
		)
		if (!landed) {
			yield* lostRace
			return
		}
		if (Option.isNone(issue)) return

		// `verified` on a high/critical issue deliberately transitions nothing: the
		// verdict and its evidence are on the timeline, and a human closes it. See
		// `verificationVerdictAutoCloses`.
		const target =
			verdict === "not_fixed"
				? "in_progress"
				: autoCloses
					? "done"
					: verdict === "inconclusive"
						? "in_review"
						: null
		if (target === null) return

		yield* workflow
			.applyTransition(row.orgId, systemActor.id, issue.value, target, {
				payload: { viaVerification: row.id, verdict },
				timestamp: nowMs,
			})
			.pipe(
				Effect.catchTags({
					"@maple/http/errors/ErrorIssueTransitionError": (error) =>
						Effect.logInfo("[FixVerification] verdict could not move the issue").pipe(
							Effect.annotateLogs({
								issueId: row.issueId,
								from: issue.value.workflowState,
								to: target,
								reason: error.message,
							}),
						),
					"@maple/http/errors/ErrorIssueNotFoundError": () => Effect.void,
				}),
			)
	})

	return {
		listPullRequests,
		linkPullRequest,
		unlinkPullRequest,
		listVerifications,
		onPullRequestEvent,
		settledRuns,
		refuteOnPostMergeOccurrence,
		dueVerifications,
		markRunning,
		applyVerdict,
	} satisfies IssueFixVerificationServiceApi
})

export class IssueFixVerificationService extends Context.Service<
	IssueFixVerificationService,
	IssueFixVerificationServiceApi
>()("@maple/api/services/errors/IssueFixVerificationService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
