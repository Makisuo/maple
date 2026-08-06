import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	errorIssueEvents,
	errorIssues,
	investigationLensRuns,
	investigations,
	runMigrations,
} from "@maple/db"
import { createMaplePgliteClient, type MaplePgClient } from "@maple/db/client"
import type { LensId } from "@maple/domain/http"
import { ErrorIssueId, InvestigationId, OrgId } from "@maple/domain/primitives"
import { eq } from "drizzle-orm"
import { Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import type { WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"
import {
	runInvestigationFanout,
	type InvestigationFanoutDeps,
	type InvestigationFanoutWorkflowPayload,
} from "./InvestigationFanoutWorkflow.run"

const createdDbs: TestDb[] = []
afterEach(async () => cleanupTestDbs(createdDbs))

/** Pass-through step harness handling both `do` overloads. */
const fakeStep: WorkflowStepLike = {
	do: (async (_name: string, configOrCb: unknown, cb?: () => Promise<unknown>) =>
		(cb ?? (configOrCb as () => Promise<unknown>))()) as WorkflowStepLike["do"],
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const ORG = asOrgId("org_fanout_test")
const FIXED_NOW = 1_765_432_100_000
const LENSES: ReadonlyArray<LensId> = ["deploy_correlation", "downstream_dependency", "resource_saturation"]

const report = {
	summary: "Checkout latency traced to pool exhaustion.",
	suspectedCause: "Connection pool saturation in payments-api.",
	severityAssessment: "high",
	affectedScope: "checkout-api",
	evidence: [
		{
			traceIds: ["0af7651916cd43dd8448eb211c80319c"],
			logPatterns: ["timeout acquiring connection"],
			relatedServices: ["payments-api"],
			note: "92% of failing spans block on acquisition.",
		},
	],
	suggestedActions: ["Raise the pool size."],
	confidence: "high",
}

const lensOutput = (lensId: LensId) => ({
	claim: `${lensId} candidate`,
	mechanism: "mechanism",
	confidence: "medium" as const,
	selfDoubt: "would be falsified by X",
	suggestedActions: ["do the thing"],
	evidence: [],
	model: "cheap-model",
	inputTokens: 100,
	outputTokens: 20,
	toolCount: 3,
})

interface Harness {
	readonly db: MaplePgClient
	readonly investigationId: InvestigationId
	readonly issueId: ErrorIssueId
	readonly payload: InvestigationFanoutWorkflowPayload
}

let harness: Harness

beforeEach(async () => {
	const testDb = createTestDb(createdDbs)
	await runMigrations(testDb.pglite)
	const db = createMaplePgliteClient(testDb.pglite) as unknown as MaplePgClient
	const investigationId = asInvestigationId(randomUUID())
	const issueId = asIssueId(randomUUID())
	const now = new Date(FIXED_NOW)

	await db.insert(errorIssues).values({
		id: issueId,
		orgId: ORG,
		fingerprintHash: "98765432109876543210",
		serviceName: "checkout-api",
		exceptionType: "TimeoutError",
		exceptionMessage: "upstream timed out",
		topFrame: "",
		firstSeenAt: now,
		lastSeenAt: now,
		createdAt: now,
		updatedAt: now,
	} as never)

	await db.insert(investigations).values({
		id: investigationId,
		orgId: ORG,
		status: "investigating",
		seededBy: "user",
		subjectJson: { type: "incident", incidentKind: "error", incidentId: randomUUID(), issueId },
		snapshotJson: {
			title: "Checkout timeouts",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [],
			references: [],
			incidentStartedAt: null,
			incidentEndedAt: null,
		},
		issueId,
		fanoutState: "queued",
		fanoutSize: LENSES.length,
		startedAt: now,
		autonomousTurns: 4,
		createdAt: now,
		updatedAt: now,
	} as never)

	harness = {
		db,
		investigationId,
		issueId,
		payload: { orgId: ORG, investigationId, lensIds: LENSES, attempt: 0 },
	}
})

const env = { MAPLE_DB: undefined }

const baseDeps = (overrides: Partial<InvestigationFanoutDeps> = {}): InvestigationFanoutDeps => ({
	db: harness.db,
	now: () => FIXED_NOW,
	makeRuntime: async () => ({ runPromise: async () => undefined, dispose: async () => undefined }) as never,
	seedTranscript: async () => undefined,
	invokeLens: async ({ lensId }) => lensOutput(lensId),
	invokeValidator: async ({ candidates }) => ({
		promotedLensId: "deploy_correlation",
		report,
		rivals: candidates
			.filter((candidate) => candidate.lensId !== "deploy_correlation")
			.map((candidate) => ({
				lensId: candidate.lensId,
				verdict: "ruled_out" as const,
				reason: `${candidate.lensId} did not explain the onset.`,
			})),
		note: "1 promoted · 0 merged · 2 ruled out",
		model: "strong-model",
		inputTokens: 900,
		outputTokens: 150,
	}),
	...overrides,
})

const run = (deps: InvestigationFanoutDeps) =>
	runInvestigationFanout(env, { payload: harness.payload }, fakeStep, deps)

const loadInvestigation = async () => {
	const rows = await harness.db
		.select()
		.from(investigations)
		.where(eq(investigations.id, harness.investigationId))
	return rows[0]!
}

const loadLanes = async () =>
	harness.db
		.select()
		.from(investigationLensRuns)
		.where(eq(investigationLensRuns.investigationId, harness.investigationId))
		.orderBy(investigationLensRuns.ordinal)

describe("runInvestigationFanout", () => {
	it("promotes one candidate and gives every rival a reason", async () => {
		const result = await run(baseDeps())
		expect(result.status).toBe("ranked")

		const row = await loadInvestigation()
		expect(row.status).toBe("diagnosed")
		expect(row.fanoutState).toBe("ranked")
		expect(row.reportJson).toMatchObject({ suspectedCause: report.suspectedCause })

		const lanes = await loadLanes()
		expect(lanes.map((lane) => lane.lensId)).toEqual(LENSES)
		expect(lanes.filter((lane) => lane.verdict === "promoted")).toHaveLength(1)
		// The trust payload: a verdict without a reason proves nothing.
		for (const lane of lanes) {
			expect(lane.reason).toBeTruthy()
			expect(lane.status).toBe("reported")
		}
	})

	/**
	 * The regression this file exists for. `Promise.all` rejects if any member
	 * rejects, so a lens that throws would otherwise take the whole instance with
	 * it — losing four healthy passes to one bad one.
	 */
	it("completes the run when a single lens throws", async () => {
		const result = await run(
			baseDeps({
				invokeLens: async ({ lensId }) => {
					if (lensId === "downstream_dependency") throw new Error("model exploded")
					return lensOutput(lensId)
				},
			}),
		)
		expect(result.status).toBe("ranked")

		const lanes = await loadLanes()
		const failed = lanes.find((lane) => lane.lensId === "downstream_dependency")!
		expect(failed.status).toBe("no_finding")
		expect(failed.error).toContain("model exploded")
		// The others are unaffected.
		expect(lanes.filter((lane) => lane.status === "reported")).toHaveLength(2)
		expect((await loadInvestigation()).status).toBe("diagnosed")
	})

	it("records validation_inconclusive when the validator promotes nothing", async () => {
		const result = await run(
			baseDeps({
				invokeValidator: async ({ candidates }) => ({
					promotedLensId: null,
					report: null,
					rivals: candidates.map((candidate) => ({
						lensId: candidate.lensId,
						verdict: "rejected" as const,
						reason: "contradicted by another lens",
					})),
					note: "no candidate survived",
					model: "strong-model",
					inputTokens: 500,
					outputTokens: 80,
				}),
			}),
		)
		expect(result.status).toBe("inconclusive")

		const row = await loadInvestigation()
		expect(row.status).toBe("failed")
		expect(row.fanoutState).toBe("rejected_all")
		expect(row.error).toContain("validation_inconclusive")
		expect(row.reportJson).toBeNull()
	})

	it("bills every pass, not just the validator's", async () => {
		await run(baseDeps())
		const row = await loadInvestigation()
		// 3 lenses × (100 in / 20 out) + the validator's 900 / 150.
		expect(row.inputTokens).toBe(3 * 100 + 900)
		expect(row.outputTokens).toBe(3 * 20 + 150)
	})

	it("writes the issue-linked ai_triage event exactly once across a retried persist", async () => {
		await run(baseDeps())
		await run(baseDeps())
		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		expect(events.filter((event) => event.type === "ai_triage")).toHaveLength(1)
	})

	it("does not grow duplicate lanes when claim is replayed", async () => {
		await run(baseDeps())
		// The row is `ranked` now, so a replayed instance must bail rather than
		// re-seeding lanes over a finished run.
		const second = await run(baseDeps())
		expect(second.status).toBe("skipped")
		expect(await loadLanes()).toHaveLength(LENSES.length)
	})

	/**
	 * The review caught this dead: the step called `append({ events: [...] })` with
	 * an `assistant-message` type, neither of which exists — `append` takes one
	 * `ChatEventInput` and that union has no such member. An `as never` cast got it
	 * past the compiler and a bare `catch` swallowed the throw, so the Transcript
	 * tab was empty and Chat follow-ups were ungrounded, silently.
	 *
	 * This runs the REAL seedTranscript against a fake session, so the shape is
	 * checked rather than stubbed away.
	 */
	it("seeds a valid turn into the chat session", async () => {
		const appended: Array<Record<string, unknown>> = []
		const namespace = {
			idFromName: (name: string) => name,
			get: () => ({
				history: async () => [],
				append: async (event: Record<string, unknown>) => {
					appended.push(event)
					return appended.length
				},
			}),
		}
		const { seedTranscript, ...rest } = baseDeps()
		void seedTranscript
		await runInvestigationFanout(
			{ ...env, CHAT_SESSION: namespace },
			{ payload: harness.payload },
			fakeStep,
			rest,
		)

		expect(appended.map((event) => event.type)).toEqual([
			"user-message",
			"turn-start",
			"text-delta",
			"turn-end",
		])
		const delta = appended.find((event) => event.type === "text-delta")!
		expect(String(delta.text)).toContain("Reconstructed summary")
		// Telemetry-derived claims become assistant text, so they carry provenance —
		// a follow-up turn must not read them as its own conclusions.
		expect(String(delta.text)).toContain("not instructions")
	})

	it("skips a run whose investigation is no longer investigating", async () => {
		await harness.db
			.update(investigations)
			.set({ status: "resolved" })
			.where(eq(investigations.id, harness.investigationId))
		expect((await run(baseDeps())).status).toBe("skipped")
		expect(await loadLanes()).toHaveLength(0)
	})
})
