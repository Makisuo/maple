import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { ErrorIssueId, ErrorIssuePullRequestId, ErrorIssueVerificationId } from "@maple/domain/primitives"
import {
	aiTriageSettings,
	errorIssues,
	errorIssueVerifications,
	investigations,
	type ErrorIssueVerificationRow,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { enqueueFixVerification } from "./fix-verification-enqueue"

const ORG = Schema.decodeSync(OrgId)("org_fix_verification_enqueue")
const PR_URL = "https://github.com/MapleTechLabs/maple/pull/612"
const HOUR = 60 * 60_000

const createdDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3480",
			MCP_PORT: "3481",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
}

const fakeFanoutWorkflow = () => {
	const created: Array<{ id: string; params: Record<string, unknown> }> = []
	return {
		created,
		binding: {
			create: async (input: { id: string; params: Record<string, unknown> }) => {
				created.push(input)
				return { id: input.id }
			},
		},
	}
}

const enableAutomation = (maxRunsPerDay = 20, maxPassesPerDay = 200) =>
	Effect.gen(function* () {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(aiTriageSettings).values({
				orgId: ORG,
				enabled: true,
				maxRunsPerDay,
				maxPassesPerDay,
				updatedAt: new Date(nowMs),
			}),
		)
	})

/** An issue with a merged PR and an open verification window, ready for a verdict. */
const seedVerification = (options: { readonly withIssue?: boolean } = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis
		const issueId = Schema.decodeSync(ErrorIssueId)(randomUUID())
		const now = new Date(nowMs)
		if (options.withIssue !== false) {
			yield* database.execute((db) =>
				db.insert(errorIssues).values({
					id: issueId,
					orgId: ORG,
					kind: "error",
					fingerprintHash: `fp-${issueId.slice(0, 8)}`,
					serviceName: "checkout",
					exceptionType: "TypeError",
					exceptionMessage: "undefined is not a function",
					errorLabel: "",
					topFrame: "src/checkout.ts:42",
					workflowState: "verifying",
					severity: "low",
					firstSeenAt: new Date(nowMs - 10 * HOUR),
					lastSeenAt: now,
					occurrenceCount: 200,
					seenVersionsJson: ["v1", "v2"],
					createdAt: now,
					updatedAt: now,
				}),
			)
		}
		// Branded through the domain schemas rather than cast: a cast here would
		// happily accept an id shape the real decode rejects.
		const verification: ErrorIssueVerificationRow = {
			id: Schema.decodeSync(ErrorIssueVerificationId)(randomUUID()),
			orgId: ORG,
			issueId,
			pullRequestId: Schema.decodeSync(ErrorIssuePullRequestId)(randomUUID()),
			status: "waiting",
			mergedAt: new Date(nowMs - HOUR),
			verifyAfter: now,
			baselineVersionsJson: ["v1", "v2"],
			baselineOccurrenceCount: 200,
			baselineRatePerHour: 20,
			investigationId: null,
			verdict: null,
			verdictNote: null,
			postMergeOccurrenceCount: 0,
			attempt: 0,
			createdAt: now,
			updatedAt: now,
		}
		yield* database.execute((db) => db.insert(errorIssueVerifications).values(verification))
		return { issueId, verification }
	})

const input = (verification: ErrorIssueVerificationRow, fanoutBinding?: unknown) => ({
	verification,
	pullRequestUrl: PR_URL,
	postMergeOccurrences: 0,
	staleClientOccurrences: 3,
	fanoutBinding,
})

/**
 * These outcomes are not interchangeable to the caller. The tick reads
 * `enqueued: false` as "no agent available" and can answer it with a terminal
 * `verified` verdict that auto-closes the issue, so which branch produced it —
 * and whether an investigation row was left behind — is load-bearing.
 */
describe("enqueueFixVerification", () => {
	it.effect("starts the fan-out and records the investigation", () =>
		Effect.gen(function* () {
			yield* enableAutomation()
			const { verification } = yield* seedVerification()
			const workflow = fakeFanoutWorkflow()

			const result = yield* enqueueFixVerification(input(verification, workflow.binding))

			assert.strictEqual(result.enqueued, true)
			assert.strictEqual(workflow.created.length, 1)
			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db
					.select()
					.from(investigations)
					.where(eq(investigations.id, workflow.created[0]?.id ?? "")),
			)
			assert.strictEqual(rows.length, 1)
			assert.strictEqual(rows[0]?.status, "investigating")
			// The fence a restart needs: `restartInvestigation` terminates the prior
			// workflow only when this column is populated. Left null, the old
			// instance survives every restart and publishes over the new attempt.
			assert.strictEqual(rows[0]?.workflowInstanceId, workflow.created[0]?.id)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reports no_binding, and marks the run failed, when the workflow is unwired", () =>
		Effect.gen(function* () {
			yield* enableAutomation()
			const { verification } = yield* seedVerification()

			// The local/test/misconfigured-deploy state. It must be distinguishable
			// from a genuine error: the tick turns this one into a verdict.
			const result = yield* enqueueFixVerification(input(verification, undefined))

			assert.strictEqual(result.enqueued, false)
			if (result.enqueued) return
			assert.strictEqual(result.reason, "no_binding")
			assert.notStrictEqual(result.investigationId, undefined)
			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db
					.select()
					.from(investigations)
					.where(eq(investigations.id, result.investigationId ?? "")),
			)
			assert.strictEqual(rows[0]?.status, "failed")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reports daily_cap without starting anything once the quota is spent", () =>
		Effect.gen(function* () {
			// One run allowed, and the reserve for a verification exceeds one pass.
			yield* enableAutomation(1, 1)
			const { verification } = yield* seedVerification()
			const workflow = fakeFanoutWorkflow()

			const result = yield* enqueueFixVerification(input(verification, workflow.binding))

			assert.strictEqual(result.enqueued, false)
			if (result.enqueued) return
			assert.strictEqual(result.reason, "daily_cap")
			assert.strictEqual(workflow.created.length, 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reports an error, not no_binding, when the issue row is gone", () =>
		Effect.gen(function* () {
			yield* enableAutomation()
			const { verification } = yield* seedVerification({ withIssue: false })
			const workflow = fakeFanoutWorkflow()

			const result = yield* enqueueFixVerification(input(verification, workflow.binding))

			assert.strictEqual(result.enqueued, false)
			if (result.enqueued) return
			assert.strictEqual(result.reason, "error")
			assert.strictEqual(workflow.created.length, 0)
		}).pipe(Effect.provide(makeLayer())),
	)
})
