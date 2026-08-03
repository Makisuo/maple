import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	aiTriageRuns,
	aiTriageSettings,
	anomalyIncidents,
	errorIssues,
	errorIssueEvents,
	issueEscalations,
	runMigrations,
} from "@maple/db"
import { createMaplePgliteClient, type MaplePgClient } from "@maple/db/client"
import { AiTriageRunId, AnomalyIncidentId, ErrorIssueId, OrgId } from "@maple/domain/primitives"
import { eq } from "drizzle-orm"
import { Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { type AiTriageRunDeps, runAiTriage, type AiTriageWorkflowPayload } from "./AiTriageWorkflow.run"
import type { WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

const createdDbs: TestDb[] = []

afterEach(async () => {
	await cleanupTestDbs(createdDbs)
	vi.unstubAllGlobals()
})

// Pass-through step harness: every step.do just runs its callback.
const fakeStep: WorkflowStepLike = {
	do: (async (_name: string, configOrCb: unknown, cb?: () => Promise<unknown>) =>
		(cb ?? (configOrCb as () => Promise<unknown>))()) as WorkflowStepLike["do"],
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asRunId = Schema.decodeUnknownSync(AiTriageRunId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asAnomalyIncidentId = Schema.decodeUnknownSync(AnomalyIncidentId)

const ORG = asOrgId("org_triage_test")
const FIXED_NOW = 1_765_432_100_000

const validResult = {
	summary: "Error rate spike caused by a bad deploy.",
	suspectedCause: "Regression in payment-service v2.3.1.",
	severityAssessment: "high",
	affectedScope: "checkout-api, ~10% of requests",
	evidence: [
		{
			traceIds: ["0af7651916cd43dd8448eb211c80319c"],
			logPatterns: ["timeout after <num>ms"],
			relatedServices: ["payment-service"],
			note: "Consistent failure span.",
		},
	],
	suggestedActions: ["Roll back payment-service."],
	confidence: "high",
}

/** Stub the Flue triage invocation: return a fixed structured result + usage. */
const fakeInvokeTriage =
	(result: unknown = validResult): AiTriageRunDeps["invokeTriage"] =>
	async () => ({
		result,
		model: { provider: "cloudflare", id: "@cf/moonshotai/kimi-k2.6" },
		usage: { input: 120, output: 60 },
	})

interface Harness {
	readonly db: MaplePgClient
	readonly runId: AiTriageRunId
	readonly issueId: ErrorIssueId
	readonly incidentId: AnomalyIncidentId
	readonly payload: AiTriageWorkflowPayload
}

let harness: Harness

beforeEach(async () => {
	const testDb = createTestDb(createdDbs)
	await runMigrations(testDb.pglite)
	// The workflow only uses the shared drizzle query-builder surface, which the
	// PGlite and postgres.js clients implement identically.
	const db = createMaplePgliteClient(testDb.pglite) as unknown as MaplePgClient
	const runId = asRunId(randomUUID())
	const issueId = asIssueId(randomUUID())
	const incidentId = asAnomalyIncidentId(randomUUID())
	const now = new Date()

	await db.insert(aiTriageSettings).values({
		orgId: ORG,
		enabled: true,
		maxRunsPerDay: 20,
		updatedAt: now,
	})
	await db.insert(aiTriageRuns).values({
		id: runId,
		orgId: ORG,
		incidentKind: "error",
		incidentId,
		issueId,
		status: "queued",
		contextJson: { kind: "error", serviceName: "checkout-api" },
		createdAt: now,
		updatedAt: now,
	})

	harness = {
		db,
		runId,
		issueId,
		incidentId,
		payload: {
			orgId: ORG,
			incidentKind: "error",
			incidentId,
			issueId,
			runId,
		},
	}
})

// The gate checks for the CHAT_FLUE service binding (the investigation runs on
// chat-flue); a stub `fetch` satisfies it. The actual call is stubbed via
// `deps.invokeTriage`, so the binding is never exercised in these tests.
const env = {
	MAPLE_DB: undefined,
	INTERNAL_SERVICE_TOKEN: "test-token",
	CHAT_FLUE: { fetch: (async () => new Response("{}")) as typeof fetch },
}

const loadRun = async () => {
	const rows = await harness.db
		.select()
		.from(aiTriageRuns)
		.where(eq(aiTriageRuns.id, harness.runId))
		.limit(1)
	return rows[0]
}

const insertAnomalyIncident = async () => {
	const now = new Date()
	await harness.db.insert(anomalyIncidents).values({
		id: harness.incidentId,
		orgId: ORG,
		detectorKey: "latency_p95::checkout-api",
		signalType: "latency_p95",
		serviceName: "checkout-api",
		status: "open",
		severity: "warning",
		openedValue: 1200,
		baselineMedian: 300,
		baselineSigma: 40,
		thresholdValue: 600,
		lastObservedValue: 1200,
		firstTriggeredAt: now,
		lastTriggeredAt: now,
		triageStatus: "pending",
		dedupeKey: `anom:${harness.incidentId}`,
		createdAt: now,
		updatedAt: now,
	})
}

const loadAnomalyIncident = async () => {
	const rows = await harness.db
		.select()
		.from(anomalyIncidents)
		.where(eq(anomalyIncidents.id, harness.incidentId))
		.limit(1)
	return rows[0]
}

describe("runAiTriage", () => {
	it("completes the run, stores the result, and writes the issue timeline event", async () => {
		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			invokeTriage: fakeInvokeTriage(),
		})
		expect(result.status).toBe("completed")

		const run = await loadRun()
		expect(run?.status).toBe("completed")
		expect(run?.inputTokens).toBe(120)
		expect(run?.outputTokens).toBe(60)
		expect(run?.model).toBe("@cf/moonshotai/kimi-k2.6")
		expect(run?.resultJson).toMatchObject({ summary: expect.stringContaining("bad deploy") })

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("ai_triage")
		expect(events[0]?.payloadJson).toMatchObject({ runId: harness.runId })
	})

	it("does not duplicate the timeline event when persist re-runs", async () => {
		const deps = { db: harness.db, invokeTriage: fakeInvokeTriage() }
		await runAiTriage(env, { payload: harness.payload }, fakeStep, deps)
		// Simulate a replayed/retried execution reaching persist again for the
		// same run: the deterministic event id + onConflictDoNothing must absorb
		// the second insert.
		await harness.db
			.update(aiTriageRuns)
			.set({ status: "queued" })
			.where(eq(aiTriageRuns.id, harness.runId))
		await runAiTriage(env, { payload: harness.payload }, fakeStep, deps)

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		expect(events).toHaveLength(1)
	})

	it("is a no-op replay when the run already progressed", async () => {
		await harness.db
			.update(aiTriageRuns)
			.set({ status: "completed" })
			.where(eq(aiTriageRuns.id, harness.runId))

		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			invokeTriage: fakeInvokeTriage(),
		})
		expect(result.status).toBe("skipped")
	})

	it("applies the assessed severity to a real issue and queues an escalation", async () => {
		const now = new Date()
		await harness.db.insert(errorIssues).values({
			id: harness.issueId,
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
		})

		await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			invokeTriage: fakeInvokeTriage(),
		})

		const issues = await harness.db.select().from(errorIssues).where(eq(errorIssues.id, harness.issueId))
		expect(issues[0]?.severity).toBe("high")
		expect(issues[0]?.severitySource).toBe("ai")

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		const triageEvent = events.find((e) => e.type === "ai_triage")
		expect(triageEvent?.payloadJson).toMatchObject({ applied: true })
		expect(events.some((e) => e.type === "severity_change")).toBe(true)

		const escalations = await harness.db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, harness.issueId))
		expect(escalations).toHaveLength(1)
		expect(escalations[0]?.severity).toBe("high")
		expect(escalations[0]?.source).toBe("ai")
	})

	it("does not clobber a manual severity and records applied=false", async () => {
		const now = new Date()
		await harness.db.insert(errorIssues).values({
			id: harness.issueId,
			orgId: ORG,
			fingerprintHash: "98765432109876543210",
			serviceName: "checkout-api",
			exceptionType: "TimeoutError",
			exceptionMessage: "upstream timed out",
			topFrame: "",
			severity: "low",
			severitySource: "manual",
			firstSeenAt: now,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		})

		await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			invokeTriage: fakeInvokeTriage(),
		})

		const issues = await harness.db.select().from(errorIssues).where(eq(errorIssues.id, harness.issueId))
		expect(issues[0]?.severity).toBe("low")
		expect(issues[0]?.severitySource).toBe("manual")

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		const triageEvent = events.find((e) => e.type === "ai_triage")
		expect(triageEvent?.payloadJson).toMatchObject({ applied: false })
		expect(events.some((e) => e.type === "severity_change")).toBe(false)
	})

	it("writes the timeline event for alert-kind runs too", async () => {
		await harness.db
			.update(aiTriageRuns)
			.set({ incidentKind: "alert" })
			.where(eq(aiTriageRuns.id, harness.runId))

		const result = await runAiTriage(
			env,
			{ payload: { ...harness.payload, incidentKind: "alert" } },
			fakeStep,
			{ db: harness.db, invokeTriage: fakeInvokeTriage() },
		)
		expect(result.status).toBe("completed")

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId))
		expect(events.some((e) => e.type === "ai_triage")).toBe(true)
	})

	it("marks the anomaly incident triage-skipped when the run fails", async () => {
		await insertAnomalyIncident()
		await harness.db
			.update(aiTriageRuns)
			.set({ incidentKind: "anomaly" })
			.where(eq(aiTriageRuns.id, harness.runId))

		const result = await runAiTriage(
			env,
			{ payload: { ...harness.payload, incidentKind: "anomaly" } },
			fakeStep,
			{
				db: harness.db,
				invokeTriage: async () => {
					throw new Error("flue_unreachable")
				},
				now: () => FIXED_NOW,
			},
		)
		expect(result.status).toBe("failed")

		const run = await loadRun()
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("flue_unreachable")
		expect(run?.completedAt?.getTime()).toBe(FIXED_NOW)
		expect(run?.updatedAt.getTime()).toBe(FIXED_NOW)

		const incident = await loadAnomalyIncident()
		expect(incident?.triageStatus).toBe("skipped")
		expect(incident?.updatedAt.getTime()).toBe(FIXED_NOW)
	})

	it("marks the anomaly incident triage-completed when persist succeeds", async () => {
		await insertAnomalyIncident()
		await harness.db
			.update(aiTriageRuns)
			.set({ incidentKind: "anomaly" })
			.where(eq(aiTriageRuns.id, harness.runId))

		const result = await runAiTriage(
			env,
			{ payload: { ...harness.payload, incidentKind: "anomaly" } },
			fakeStep,
			{ db: harness.db, invokeTriage: fakeInvokeTriage(), now: () => FIXED_NOW },
		)
		expect(result.status).toBe("completed")

		const run = await loadRun()
		expect(run?.status).toBe("completed")
		expect(run?.completedAt?.getTime()).toBe(FIXED_NOW)

		const incident = await loadAnomalyIncident()
		expect(incident?.triageStatus).toBe("completed")
		expect(incident?.updatedAt.getTime()).toBe(FIXED_NOW)
	})

	it("tracks token usage against Autumn with run-scoped idempotency keys", async () => {
		const trackCalls: Array<{ url: string; body: Record<string, unknown> }> = []
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			trackCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
			return new Response("{}", { status: 200 })
		})

		const result = await runAiTriage(
			{ ...env, AUTUMN_SECRET_KEY: "autumn-test-key" },
			{ payload: harness.payload },
			fakeStep,
			{ db: harness.db, invokeTriage: fakeInvokeTriage() },
		)
		expect(result.status).toBe("completed")

		expect(trackCalls).toHaveLength(2)
		expect(trackCalls.every((call) => call.url.endsWith("/v1/track"))).toBe(true)
		expect(trackCalls.every((call) => call.body.customer_id === ORG)).toBe(true)
		const byFeature = new Map(trackCalls.map((call) => [call.body.feature_id, call.body]))
		expect(byFeature.get("ai_input_tokens")?.value).toBe(120)
		expect(byFeature.get("ai_input_tokens")?.idempotency_key).toBe(`${harness.runId}:triage:input`)
		expect(byFeature.get("ai_output_tokens")?.value).toBe(60)
		expect(byFeature.get("ai_output_tokens")?.idempotency_key).toBe(`${harness.runId}:triage:output`)
	})

	it("fails the run when the Flue investigation errors", async () => {
		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			invokeTriage: async () => {
				throw new Error("flue_triage_no_result")
			},
		})
		expect(result.status).toBe("failed")
		const run = await loadRun()
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("flue_triage_no_result")
	})

	it("fails the run when the CHAT_FLUE binding is unavailable", async () => {
		const result = await runAiTriage(
			{ MAPLE_DB: undefined, INTERNAL_SERVICE_TOKEN: "test-token" },
			{ payload: harness.payload },
			fakeStep,
			{ db: harness.db, invokeTriage: fakeInvokeTriage() },
		)
		expect(result.status).toBe("failed")
		const run = await loadRun()
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("chat_flue_unavailable")
	})
})
