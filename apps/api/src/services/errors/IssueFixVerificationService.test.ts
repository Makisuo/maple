import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, type WorkflowState } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import { errorIssues, errorIssueEvents, errorIssueVerifications } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import {
	hasPostMergeVersion,
	IssueFixVerificationService,
	occurrenceRatePerHour,
	type PullRequestEventInput,
} from "./IssueFixVerificationService"

const APP_BASE_URL = "https://app.maple.test"
const ORG = Schema.decodeSync(OrgId)("org_verification")
const REPO = "MapleTechLabs/maple"
const PR_URL = `https://github.com/${REPO}/pull/612`

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const createdDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: APP_BASE_URL,
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	const databaseLive = testDb.layer
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const actorsLive = ErrorActorsService.layer.pipe(Layer.provide(databaseLive))
	const workflowLive = ErrorIssueWorkflowService.layer.pipe(
		Layer.provide(databaseLive),
		Layer.provide(actorsLive),
	)
	const verificationLive = IssueFixVerificationService.layer.pipe(
		Layer.provide(Layer.mergeAll(databaseLive, envLive, actorsLive, workflowLive)),
	)
	return Layer.mergeAll(verificationLive, workflowLive, actorsLive, databaseLive)
}

interface SeedIssueOptions {
	readonly workflowState?: WorkflowState
	readonly severity?: "critical" | "high" | "medium" | "low" | null
	readonly seenVersions?: ReadonlyArray<string>
	readonly occurrenceCount?: number
	readonly spanMs?: number
}

const seedIssue = (options: SeedIssueOptions = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const id = Schema.decodeSync(ErrorIssueId)(randomUUID())
		const now = new Date()
		const spanMs = options.spanMs ?? 10 * HOUR
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id,
				orgId: ORG,
				kind: "error",
				fingerprintHash: `fp-${id.slice(0, 8)}`,
				serviceName: "checkout",
				exceptionType: "TypeError",
				exceptionMessage: "undefined is not a function",
				errorLabel: "",
				topFrame: "src/checkout.ts:42",
				workflowState: options.workflowState ?? "in_review",
				severity: options.severity === undefined ? "low" : options.severity,
				firstSeenAt: new Date(now.getTime() - spanMs),
				lastSeenAt: now,
				occurrenceCount: options.occurrenceCount ?? 200,
				seenVersionsJson: options.seenVersions ?? ["v1", "v2"],
				createdAt: now,
				updatedAt: now,
			}),
		)
		return id
	})

const readIssueState = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.select().from(errorIssues).where(eq(errorIssues.id, issueId)).limit(1),
		)
		return rows[0]
	})

const readVerification = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db
				.select()
				.from(errorIssueVerifications)
				.where(eq(errorIssueVerifications.issueId, issueId))
				.limit(1),
		)
		return rows[0]
	})

const readAllVerifications = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		return yield* database.execute((db) =>
			db.select().from(errorIssueVerifications).where(eq(errorIssueVerifications.issueId, issueId)),
		)
	})

const readEventTypes = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db
				.select({ type: errorIssueEvents.type })
				.from(errorIssueEvents)
				.where(eq(errorIssueEvents.issueId, issueId)),
		)
		return rows.map((row) => row.type)
	})

const mergeEvent = (overrides: Partial<PullRequestEventInput> = {}): PullRequestEventInput => ({
	orgId: ORG,
	provider: "github",
	externalRepoId: "999",
	repoFullName: REPO,
	number: 612,
	action: "closed",
	url: PR_URL,
	title: "Fix the checkout crash",
	body: null,
	authorLogin: "octocat",
	merged: true,
	mergeCommitSha: "abc123",
	mergedAtMs: Date.now(),
	...overrides,
})

describe("occurrenceRatePerHour", () => {
	it("averages occurrences over the observed span", () => {
		const now = new Date()
		expect(
			occurrenceRatePerHour({
				occurrenceCount: 100,
				firstSeenAt: new Date(now.getTime() - 10 * HOUR),
				lastSeenAt: now,
			}),
		).toBeCloseTo(10)
	})

	it("returns zero for a degenerate span or no occurrences", () => {
		const now = new Date()
		expect(occurrenceRatePerHour({ occurrenceCount: 5, firstSeenAt: now, lastSeenAt: now })).toBe(0)
		expect(
			occurrenceRatePerHour({
				occurrenceCount: 0,
				firstSeenAt: new Date(now.getTime() - HOUR),
				lastSeenAt: now,
			}),
		).toBe(0)
	})
})

describe("hasPostMergeVersion", () => {
	it("is true when a build absent from the baseline is observed", () => {
		expect(hasPostMergeVersion(["v1", "v2"], ["v3"])).toBe(true)
		expect(hasPostMergeVersion(["v1"], ["v1", "v2"])).toBe(true)
	})

	it("is false when every observed build was already running at merge time", () => {
		expect(hasPostMergeVersion(["v1", "v2"], ["v1"])).toBe(false)
		expect(hasPostMergeVersion(["v1", "v2"], ["v2", "v1"])).toBe(false)
	})

	it("treats an absent build signal as no evidence, unlike the regression rule", () => {
		// `isRegression` errs toward reopening on empty version data. Verification
		// must NOT: doing so would refute every fix from a service that does not
		// report `service.version`.
		expect(hasPostMergeVersion(["v1"], [])).toBe(false)
		expect(hasPostMergeVersion(["v1"], ["", ""])).toBe(false)
		expect(hasPostMergeVersion([], [])).toBe(false)
	})
})

describe("linkPullRequest", () => {
	it.effect("stores a parsed link and records a pr_linked event", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				const doc = yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "user")
				expect(doc.repoFullName).toBe(REPO)
				expect(doc.number).toBe(612)
				expect(doc.state).toBe("open")
				expect(doc.linkSource).toBe("user")
				expect(yield* readEventTypes(issueId)).toContain("pr_linked")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("normalizes a review-tab URL and is idempotent on repeat links", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				const first = yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "user")
				const second = yield* service.linkPullRequest(ORG, null, issueId, `${PR_URL}/files`, "agent")
				// Same row, not a duplicate — three independent paths create this link.
				expect(second.id).toBe(first.id)
				const listed = yield* service.listPullRequests(ORG, issueId)
				expect(listed.pullRequests).toHaveLength(1)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("rejects a URL that is not a pull request", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				const exit = yield* service
					.linkPullRequest(ORG, null, issueId, "https://github.com/o/r/issues/7", "user")
					.pipe(Effect.exit)
				expect(exit._tag).toBe("Failure")
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("unlinkPullRequest", () => {
	it.effect("removes the link and abandons any verification riding on it", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				const link = yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "user")
				yield* service.onPullRequestEvent(mergeEvent())
				expect((yield* readVerification(issueId))?.status).toBe("waiting")

				const remaining = yield* service.unlinkPullRequest(ORG, null, issueId, link.id)
				expect(remaining.pullRequests).toHaveLength(0)
				// Without this the issue stays pinned in `verifying` with no PR to verify.
				expect((yield* readVerification(issueId))?.status).toBe("abandoned")
				expect(yield* readEventTypes(issueId)).toContain("pr_unlinked")
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("onPullRequestEvent — merge", () => {
	it.effect("opens a verification window and moves the issue to verifying", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				// 200 occurrences over 10h = 20/hour, so the derived window is one hour,
				// which `low`'s [12h, 14d] band clamps up to 12h.
				const issueId = yield* seedIssue({
					severity: "low",
					occurrenceCount: 200,
					spanMs: 10 * HOUR,
					seenVersions: ["v1", "v2"],
				})
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")

				const mergedAtMs = Date.now()
				const outcome = yield* service.onPullRequestEvent(mergeEvent({ mergedAtMs }))
				expect(outcome.verificationsOpened).toBe(1)

				const issue = yield* readIssueState(issueId)
				expect(issue?.workflowState).toBe("verifying")

				const verification = yield* readVerification(issueId)
				expect(verification?.status).toBe("waiting")
				// The baseline is the snapshot everything downstream tests membership against.
				expect(verification?.baselineVersionsJson).toEqual(["v1", "v2"])
				expect(verification?.baselineRatePerHour).toBeCloseTo(20)
				expect(verification?.verifyAfter.getTime()).toBeCloseTo(mergedAtMs + 12 * HOUR, -4)

				const events = yield* readEventTypes(issueId)
				expect(events).toContain("pr_merged")
				expect(events).toContain("verification_started")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("gives a rarer error a longer window than a busy one", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const busy = yield* seedIssue({
					severity: "critical",
					occurrenceCount: 10_000,
					spanMs: DAY,
				})
				const quiet = yield* seedIssue({
					severity: "critical",
					occurrenceCount: 3,
					spanMs: 7 * DAY,
				})
				yield* service.linkPullRequest(ORG, null, busy, PR_URL, "agent")
				yield* service.linkPullRequest(
					ORG,
					null,
					quiet,
					`https://github.com/${REPO}/pull/613`,
					"agent",
				)
				const mergedAtMs = Date.now()
				yield* service.onPullRequestEvent(mergeEvent({ mergedAtMs }))
				yield* service.onPullRequestEvent(mergeEvent({ number: 613, mergedAtMs }))

				const busyWindow = (yield* readVerification(busy))?.verifyAfter.getTime()
				const quietWindow = (yield* readVerification(quiet))?.verifyAfter.getTime()
				expect(busyWindow).toBeDefined()
				expect(quietWindow).toBeDefined()
				expect(quietWindow!).toBeGreaterThan(busyWindow!)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("does not open a second window for a redelivered merge", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())
				const second = yield* service.onPullRequestEvent(mergeEvent())
				expect(second.verificationsOpened).toBe(0)

				expect(yield* readAllVerifications(issueId)).toHaveLength(1)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("marks the link closed, and opens nothing, when a PR closes unmerged", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				const outcome = yield* service.onPullRequestEvent(
					mergeEvent({ merged: false, mergedAtMs: null, mergeCommitSha: null }),
				)
				expect(outcome.verificationsOpened).toBe(0)
				expect(yield* readVerification(issueId)).toBeUndefined()
				expect((yield* readIssueState(issueId))?.workflowState).toBe("in_review")

				const links = yield* service.listPullRequests(ORG, issueId)
				expect(links.pullRequests[0]?.state).toBe("closed")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("verifies a merge even on an issue somebody already closed", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ workflowState: "done" })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				const outcome = yield* service.onPullRequestEvent(mergeEvent())
				expect(outcome.verificationsOpened).toBe(1)
				expect((yield* readIssueState(issueId))?.workflowState).toBe("verifying")
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("onPullRequestEvent — auto-linking", () => {
	it.effect("links an issue named by dashboard URL in the PR body", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				const outcome = yield* service.onPullRequestEvent(
					mergeEvent({
						action: "opened",
						merged: false,
						mergedAtMs: null,
						body: `Fixes ${APP_BASE_URL}/errors/issues/${issueId}`,
					}),
				)
				expect(outcome.linksAutoCreated).toBe(1)
				const links = yield* service.listPullRequests(ORG, issueId)
				expect(links.pullRequests[0]?.linkSource).toBe("auto")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("ignores a well-formed issue id belonging to another org", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				// A PR body is attacker-influenced text. An id that exists in some other
				// tenant must not produce a cross-org link.
				const foreignId = randomUUID()
				const outcome = yield* service.onPullRequestEvent(
					mergeEvent({
						action: "opened",
						merged: false,
						mergedAtMs: null,
						body: `${APP_BASE_URL}/errors/issues/${foreignId}`,
					}),
				)
				expect(outcome.linksAutoCreated).toBe(0)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("does not treat a bare GitHub issue number as a Maple reference", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				yield* seedIssue()
				const outcome = yield* service.onPullRequestEvent(
					mergeEvent({ action: "opened", merged: false, mergedAtMs: null, body: "Fixes #42" }),
				)
				expect(outcome.linksAutoCreated).toBe(0)
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("refuteOnPostMergeOccurrence", () => {
	it.effect("refutes the fix when a post-merge build fires, with no agent pass", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ seenVersions: ["v1", "v2"] })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())

				const refuted = yield* service.refuteOnPostMergeOccurrence(ORG, issueId, ["v3"], Date.now())
				expect(refuted).toBe(true)
				expect((yield* readVerification(issueId))?.status).toBe("not_fixed")
				expect((yield* readIssueState(issueId))?.workflowState).toBe("in_progress")
				expect(yield* readEventTypes(issueId)).toContain("verification_verdict")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("leaves the window running for an old client on a pre-merge build", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ seenVersions: ["v1", "v2"] })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())

				const refuted = yield* service.refuteOnPostMergeOccurrence(ORG, issueId, ["v1"], Date.now())
				expect(refuted).toBe(false)
				expect((yield* readVerification(issueId))?.status).toBe("waiting")
				expect((yield* readIssueState(issueId))?.workflowState).toBe("verifying")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("does nothing when the issue has no live verification", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				expect(yield* service.refuteOnPostMergeOccurrence(ORG, issueId, ["v9"], Date.now())).toBe(
					false,
				)
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("applyVerdict", () => {
	it.effect("auto-closes a low-severity issue on a verified verdict", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ severity: "low" })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())
				const verification = yield* readVerification(issueId)

				yield* service.applyVerdict(verification!, "verified", "No occurrences.", Date.now())
				expect((yield* readVerification(issueId))?.status).toBe("verified")
				expect((yield* readIssueState(issueId))?.workflowState).toBe("done")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("leaves a critical issue for a human on a verified verdict", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ severity: "critical" })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())
				const verification = yield* readVerification(issueId)

				yield* service.applyVerdict(verification!, "verified", "No occurrences.", Date.now())
				// The verdict is recorded and visible; the close is a human's call.
				expect((yield* readVerification(issueId))?.status).toBe("verified")
				expect((yield* readIssueState(issueId))?.workflowState).toBe("verifying")
				expect(yield* readEventTypes(issueId)).toContain("verification_verdict")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("reopens the issue on a not_fixed verdict at any severity", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ severity: "critical" })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())
				const verification = yield* readVerification(issueId)

				yield* service.applyVerdict(verification!, "not_fixed", "Still firing.", Date.now())
				expect((yield* readIssueState(issueId))?.workflowState).toBe("in_progress")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("re-arms one longer window on the first inconclusive verdict", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())
				const first = yield* readVerification(issueId)

				const nowMs = Date.now()
				yield* service.applyVerdict(first!, "inconclusive", "Not enough traffic.", nowMs)
				const retried = yield* readVerification(issueId)
				expect(retried?.status).toBe("waiting")
				expect(retried?.attempt).toBe(1)
				expect(retried?.verifyAfter.getTime()).toBeGreaterThan(nowMs)
				// Still verifying — the issue has not been handed back yet.
				expect((yield* readIssueState(issueId))?.workflowState).toBe("verifying")
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("hands the issue back after the second inconclusive verdict", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue({ workflowState: "in_progress" })
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())

				const first = yield* readVerification(issueId)
				yield* service.applyVerdict(first!, "inconclusive", "Too quiet.", Date.now())
				const second = yield* readVerification(issueId)
				yield* service.applyVerdict(second!, "inconclusive", "Still too quiet.", Date.now())

				const final = yield* readVerification(issueId)
				expect(final?.status).toBe("inconclusive")
				expect((yield* readIssueState(issueId))?.workflowState).toBe("in_review")
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("dueVerifications", () => {
	it.effect("returns only waiting rows whose window has closed", () =>
		Effect.gen(function* () {
			const layer = makeLayer()
			yield* Effect.gen(function* () {
				const service = yield* IssueFixVerificationService
				const issueId = yield* seedIssue()
				yield* service.linkPullRequest(ORG, null, issueId, PR_URL, "agent")
				yield* service.onPullRequestEvent(mergeEvent())

				expect(yield* service.dueVerifications(Date.now(), 10)).toHaveLength(0)

				const verification = yield* readVerification(issueId)
				const dueAtMs = verification!.verifyAfter.getTime()
				expect(yield* service.dueVerifications(dueAtMs + 1000, 10)).toHaveLength(1)

				// A running row is somebody else's work, not due work.
				yield* service.markRunning(verification!, null, Date.now())
				expect(yield* service.dueVerifications(dueAtMs + 1000, 10)).toHaveLength(0)
			}).pipe(Effect.provide(layer))
		}),
	)
})
