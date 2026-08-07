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

/** Planner-written ids, deliberately not catalogue tokens. */
const HYPOTHESIS_IDS = ["payments_pool_exhaustion", "checkout_rollout_1402", "upstream_dns_flap"]

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
	ruledOut: ["Deploy: service.version unchanged across the window."],
}

const plan = (ids: ReadonlyArray<string> = HYPOTHESIS_IDS, collapseReason: string | null = null) => ({
	scopeSummary: "payments-api error rate rose from 0.1% to 14% at 14:03; checkout-api stayed flat.",
	incidentStartedAt: "2026-08-06T14:00:00.000Z",
	incidentEndedAt: null,
	collapseReason,
	hypotheses: ids.map((id, index) => ({
		id,
		name: `Hypothesis ${index + 1}`,
		question: `Did ${id} cause it?`,
		claimToTest: `${id} is the cause.`,
		rationale: "The sweep saw the error rate move at 14:03.",
		toolNames: ["error_detail", "query_data"],
		priority: index + 1,
		seedLensId: null,
	})),
})

const hypothesisOutput = (id: string) => ({
	claim: `${id} candidate`,
	mechanism: "mechanism",
	confidence: "medium" as const,
	selfDoubt: "would be falsified by X",
	suggestedActions: ["do the thing"],
	evidence: [],
	report: null,
	model: "cheap-model",
	inputTokens: 100,
	outputTokens: 20,
	toolCount: 3,
	deadlineHit: false,
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
		severity: "critical",
		incidentKind: "error",
		fanoutState: "queued",
		// What the caller reserved before the planner could know the real width.
		fanoutSize: 5,
		startedAt: now,
		autonomousTurns: 7,
		createdAt: now,
		updatedAt: now,
	} as never)

	harness = {
		db,
		investigationId,
		issueId,
		payload: { orgId: ORG, investigationId, maxWidth: 5, reservedPasses: 7, attempt: 0 },
	}
})

const env = { MAPLE_DB: undefined }

const baseDeps = (overrides: Partial<InvestigationFanoutDeps> = {}): InvestigationFanoutDeps => ({
	db: harness.db,
	now: () => FIXED_NOW,
	makeRuntime: async () => ({ runPromise: async () => undefined, dispose: async () => undefined }) as never,
	seedTranscript: async () => undefined,
	invokePlanner: async () => ({
		plan: plan(),
		model: "strong-model",
		inputTokens: 400,
		outputTokens: 60,
		toolCount: 4,
	}),
	invokeHypothesis: async ({ hypothesis }) => hypothesisOutput(hypothesis.id),
	invokeValidator: async ({ candidates }) => ({
		promotedLensId: HYPOTHESIS_IDS[0]!,
		report,
		rivals: candidates
			.filter((candidate) => candidate.lensId !== HYPOTHESIS_IDS[0])
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
	it("dispatches the planner's hypotheses, with its names on the lanes", async () => {
		const result = await run(baseDeps())
		expect(result.status).toBe("ranked")

		const row = await loadInvestigation()
		expect(row.status).toBe("diagnosed")
		expect(row.fanoutState).toBe("ranked")
		expect(row.reportJson).toMatchObject({ suspectedCause: report.suspectedCause })
		expect(row.planJson).toMatchObject({ scopeSummary: plan().scopeSummary })
		expect(row.plannerModel).toBe("strong-model")

		const lanes = await loadLanes()
		// Planner-written ids and copy reach the row. Without this the web falls back
		// to a static catalogue that cannot name an incident-specific hypothesis.
		expect(lanes.map((lane) => lane.lensId)).toEqual(HYPOTHESIS_IDS)
		expect(lanes.map((lane) => lane.lensName)).toEqual(["Hypothesis 1", "Hypothesis 2", "Hypothesis 3"])
		expect(lanes.map((lane) => lane.priority)).toEqual([1, 2, 3])
		expect(lanes.filter((lane) => lane.verdict === "promoted")).toHaveLength(1)
		// The trust payload: a verdict without a reason proves nothing.
		for (const lane of lanes) {
			expect(lane.reason).toBeTruthy()
			expect(lane.status).toBe("reported")
		}
	})

	/**
	 * The reservation is made before the planner runs, so it is deliberately high.
	 * Left unreconciled, an org's daily pass budget drains at the ceiling rather
	 * than at what its investigations actually cost.
	 */
	it("reconciles the pass reservation down to the real width", async () => {
		await run(baseDeps())
		const row = await loadInvestigation()
		expect(row.fanoutSize).toBe(3)
		// Reserved 7 (5 + planner + validator), spent 5 (3 + planner + validator).
		expect(row.autonomousTurns).toBe(5)
	})

	/**
	 * A planner that dies must not take the investigation with it. Falling back to
	 * the seed catalogue degrades to the pre-planner behaviour, which is a worse
	 * investigation but still an investigation.
	 */
	it("falls back to the seed catalogue when the planner produces nothing", async () => {
		const result = await run(
			baseDeps({
				invokePlanner: async () => {
					throw new Error("planner exploded")
				},
			}),
		)
		expect(result.status).toBe("ranked")

		const lanes = await loadLanes()
		expect(lanes.length).toBeGreaterThan(0)
		// Seed ids, and every lane carries the provenance that says so.
		expect(lanes[0]!.lensId).toBe("downstream_dependency")
		expect(lanes[0]!.hypothesisJson).toMatchObject({ seedLensId: "downstream_dependency" })
	})

	/**
	 * The whole point of collapsing: when planning found one unambiguous cause
	 * there are no rivals, so a validator pass would be a strong-model call
	 * comparing one candidate against nothing.
	 */
	it("skips the validator when the plan collapses to one hypothesis", async () => {
		let validatorCalls = 0
		const result = await run(
			baseDeps({
				invokePlanner: async () => ({
					plan: plan(
						[HYPOTHESIS_IDS[0]!],
						"One exception type, one service, visible in the trace.",
					),
					model: "strong-model",
					inputTokens: 400,
					outputTokens: 60,
					toolCount: 4,
				}),
				invokeHypothesis: async ({ hypothesis, solo }) => ({
					...hypothesisOutput(hypothesis.id),
					report: solo ? report : null,
				}),
				invokeValidator: async () => {
					validatorCalls += 1
					throw new Error("the validator must not run on a collapsed plan")
				},
			}),
		)
		expect(result.status).toBe("ranked")
		expect(validatorCalls).toBe(0)

		const row = await loadInvestigation()
		expect(row.status).toBe("diagnosed")
		expect(row.fanoutSize).toBe(1)
		expect(row.reportJson).toMatchObject({ suspectedCause: report.suspectedCause })
		// Reserved 7, spent 2 (one hypothesis + planner).
		expect(row.autonomousTurns).toBe(2)

		const lanes = await loadLanes()
		expect(lanes).toHaveLength(1)
		expect(lanes[0]!.verdict).toBe("promoted")
	})

	/**
	 * "Checked and found nothing" and "ran out of clock" are different reports, and
	 * the validator's ranking rules turn on the difference. `deadlineHit` used to be
	 * produced by the pass and then dropped at the workflow boundary.
	 */
	it("persists deadlineHit and shows it to the validator", async () => {
		let sawCutShort = false
		await run(
			baseDeps({
				invokeHypothesis: async ({ hypothesis }) => ({
					...hypothesisOutput(hypothesis.id),
					deadlineHit: hypothesis.id === HYPOTHESIS_IDS[1],
				}),
				invokeValidator: async ({ candidates }) => {
					sawCutShort = candidates.some((candidate) => candidate.deadlineHit)
					return {
						promotedLensId: HYPOTHESIS_IDS[0]!,
						report,
						rivals: [],
						note: "ok",
						model: "strong-model",
						inputTokens: 900,
						outputTokens: 150,
					}
				},
			}),
		)
		expect(sawCutShort).toBe(true)
		const lanes = await loadLanes()
		expect(lanes.map((lane) => lane.deadlineHit)).toEqual([false, true, false])
	})

	/**
	 * The regression this file exists for. `Promise.all` rejects if any member
	 * rejects, so a lane that throws would otherwise take the whole instance with
	 * it — losing the healthy passes to one bad one.
	 */
	it("completes the run when a single hypothesis throws", async () => {
		const result = await run(
			baseDeps({
				invokeHypothesis: async ({ hypothesis }) => {
					if (hypothesis.id === HYPOTHESIS_IDS[1]) throw new Error("model exploded")
					return hypothesisOutput(hypothesis.id)
				},
			}),
		)
		expect(result.status).toBe("ranked")

		const lanes = await loadLanes()
		const failed = lanes.find((lane) => lane.lensId === HYPOTHESIS_IDS[1])!
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
						reason: "contradicted by another candidate",
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

	/**
	 * The passes really ran, so their cost is real whether or not anything ranked
	 * them. Before this, a validator that exhausted its retries killed the instance
	 * and the run consumed N model passes while metering nothing.
	 */
	it("still bills the hypothesis passes when the validator dies", async () => {
		const result = await run(
			baseDeps({
				invokeValidator: async () => {
					throw new Error("validator exploded")
				},
			}),
		)
		expect(result.status).toBe("failed")

		const row = await loadInvestigation()
		expect(row.status).toBe("failed")
		expect(row.error).toContain("validation_failed")
		// Three lanes at 100/20 each plus the planner's 400/60; no validator tokens
		// because it never answered.
		expect(row.inputTokens).toBe(3 * 100 + 400)
		expect(row.outputTokens).toBe(3 * 20 + 60)
	})

	it("bills every pass, including the planner's", async () => {
		await run(baseDeps())
		const row = await loadInvestigation()
		// 3 lanes × (100 / 20) + planner 400 / 60 + validator 900 / 150.
		expect(row.inputTokens).toBe(3 * 100 + 400 + 900)
		expect(row.outputTokens).toBe(3 * 20 + 60 + 150)
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

	it("does not grow duplicate lanes when the plan step is replayed", async () => {
		await run(baseDeps())
		// The row is `ranked` now, so a replayed instance must bail rather than
		// re-seeding lanes over a finished run.
		const second = await run(baseDeps())
		expect(second.status).toBe("skipped")
		expect(await loadLanes()).toHaveLength(HYPOTHESIS_IDS.length)
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
