import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AiTriageResult } from "@maple/domain/http"
import { ErrorIssueId, OrgId } from "@maple/domain/primitives"
import { actors, errorIssues, errorIssueEvents, issueEscalations, runMigrations } from "@maple/db"
import { createMaplePgliteClient, type MaplePgClient } from "@maple/db/client"
import { eq } from "drizzle-orm"
import { Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { applyTriageSeverity, escalationReasonFor, severityRank, TRIAGE_AGENT_NAME } from "./issue-severity"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeTriageResult = Schema.decodeUnknownSync(AiTriageResult)

const ORG = asOrgId("org_severity_test")

let db: MaplePgClient
let issueId: ErrorIssueId

beforeEach(async () => {
	const testDb = createTestDb(createdDbs)
	await runMigrations(testDb.pglite)
	// Same shared drizzle query-builder surface as the postgres.js client.
	db = createMaplePgliteClient(testDb.pglite) as unknown as MaplePgClient
	issueId = asIssueId(randomUUID())
	const now = new Date()
	await db.insert(errorIssues).values({
		id: issueId,
		orgId: ORG,
		fingerprintHash: "12345678901234567890",
		serviceName: "checkout-api",
		exceptionType: "TimeoutError",
		exceptionMessage: "upstream timed out",
		topFrame: "",
		firstSeenAt: now,
		lastSeenAt: now,
		createdAt: now,
		updatedAt: now,
	})
})

const baseInput = (overrides: Partial<Parameters<typeof applyTriageSeverity>[1]> = {}) => ({
	orgId: ORG,
	issueId,
	runId: "run-1",
	severity: "high" as const,
	confidence: "medium" as const,
	timestamp: Date.now(),
	...overrides,
})

const loadIssue = async () => {
	const rows = await db.select().from(errorIssues).where(eq(errorIssues.id, issueId))
	return rows[0]
}

describe("severityRank / escalationReasonFor", () => {
	it("ranks severities and treats unset as lowest", () => {
		expect(severityRank("critical")).toBeGreaterThan(severityRank("high"))
		expect(severityRank("high")).toBeGreaterThan(severityRank("medium"))
		expect(severityRank("medium")).toBeGreaterThan(severityRank("low"))
		expect(severityRank("low")).toBeGreaterThan(severityRank(null))
	})

	it("escalates only on first set or strict upgrade", () => {
		expect(escalationReasonFor(null, "low")).toBe("severity_set")
		expect(escalationReasonFor("medium", "critical")).toBe("severity_escalated")
		expect(escalationReasonFor("medium", "medium")).toBeNull()
		expect(escalationReasonFor("critical", "low")).toBeNull()
	})
})

describe("applyTriageSeverity", () => {
	it("applies severity, writes the timeline event, and queues an escalation", async () => {
		const outcome = await applyTriageSeverity(db, baseInput())
		expect(outcome.applied).toBe(true)
		expect(outcome.actorId).not.toBeNull()

		const issue = await loadIssue()
		expect(issue?.severity).toBe("high")
		expect(issue?.severitySource).toBe("ai")

		const events = await db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId))
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("severity_change")
		expect(events[0]?.payloadJson).toMatchObject({ from: null, to: "high", source: "ai" })

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(1)
		expect(escalations[0]?.reason).toBe("severity_set")
		expect(escalations[0]?.status).toBe("queued")

		const agentRows = await db.select().from(actors).where(eq(actors.orgId, ORG))
		expect(agentRows).toHaveLength(1)
		expect(agentRows[0]?.agentName).toBe(TRIAGE_AGENT_NAME)
	})

	it("stamps the triage agent actor with the input timestamp, not wall clock", async () => {
		const timestamp = 1_765_432_100_000
		await applyTriageSeverity(db, baseInput({ timestamp }))

		const agentRows = await db.select().from(actors).where(eq(actors.orgId, ORG))
		expect(agentRows).toHaveLength(1)
		expect(agentRows[0]?.createdAt.getTime()).toBe(timestamp)
		expect(agentRows[0]?.lastActiveAt?.getTime()).toBe(timestamp)
	})

	it("is idempotent across persist retries", async () => {
		await applyTriageSeverity(db, baseInput())
		await applyTriageSeverity(db, baseInput())

		const events = await db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId))
		expect(events).toHaveLength(1)
		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(1)
	})

	it("never clobbers a manual override", async () => {
		await db
			.update(errorIssues)
			.set({ severity: "low", severitySource: "manual" })
			.where(eq(errorIssues.id, issueId))

		const outcome = await applyTriageSeverity(db, baseInput())
		expect(outcome.applied).toBe(false)

		const issue = await loadIssue()
		expect(issue?.severity).toBe("low")
		expect(issue?.severitySource).toBe("manual")

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(0)
	})

	it("does not queue an escalation for a non-upward assessment", async () => {
		await db
			.update(errorIssues)
			.set({ severity: "critical", severitySource: "detector" })
			.where(eq(errorIssues.id, issueId))

		const outcome = await applyTriageSeverity(db, baseInput({ severity: "medium" }))
		expect(outcome.applied).toBe(true)

		const issue = await loadIssue()
		expect(issue?.severity).toBe("medium")
		expect(issue?.severitySource).toBe("ai")

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(0)
	})

	it("flips the source detector->ai without a severity_change event when severity is unchanged", async () => {
		await db
			.update(errorIssues)
			.set({ severity: "high", severitySource: "detector" })
			.where(eq(errorIssues.id, issueId))

		const outcome = await applyTriageSeverity(db, baseInput({ severity: "high" }))
		expect(outcome.applied).toBe(true)

		const issue = await loadIssue()
		expect(issue?.severity).toBe("high")
		expect(issue?.severitySource).toBe("ai")

		const events = await db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId))
		expect(events.some((e) => e.type === "severity_change")).toBe(false)

		// Same-level confirmation: no escalation either (upward-only rule).
		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(0)
	})

	it("snapshots the full triage result into the escalation payload", async () => {
		const plainResult = {
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
			confidence: "medium",
		}
		const outcome = await applyTriageSeverity(db, baseInput({ result: decodeTriageResult(plainResult) }))
		expect(outcome.applied).toBe(true)

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId))
		expect(escalations).toHaveLength(1)
		expect(escalations[0]?.payloadJson).toMatchObject({
			confidence: "medium",
			triage: plainResult,
		})
	})

	it("returns applied=false when the issue does not exist", async () => {
		const outcome = await applyTriageSeverity(db, baseInput({ issueId: asIssueId(randomUUID()) }))
		expect(outcome.applied).toBe(false)
		expect(outcome.actorId).toBeNull()
	})
})
