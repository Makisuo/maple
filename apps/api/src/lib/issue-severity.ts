/**
 * Plain-drizzle severity helpers shared by the AI triage workflow's persist
 * step (which runs on a raw D1 client with no Effect services) and the
 * Effect-side services. Every write is idempotent: deterministic runId-derived
 * ids + onConflictDoNothing, or guarded UPDATEs — the workflow persist step
 * retries and must not duplicate events or escalations.
 */
import { createHash, randomUUID } from "node:crypto"
import type { AiTriageResult, IssueSeverity } from "@maple/domain/http"
import {
	ActorId,
	ErrorIssueEventId,
	ErrorIssueId,
	type InvestigationId,
	IssueEscalationId,
	OrgId,
} from "@maple/domain/primitives"
import { actors, errorIssues, errorIssueEvents, issueEscalations } from "@maple/db"
import type { MapleDatabaseTransaction, MaplePgClient } from "@maple/db/client"
import { and, eq, ne, isNull, or } from "drizzle-orm"
import { Schema } from "effect"
import { TRIAGE_AGENT_NAME } from "./system-actors"

export { TRIAGE_AGENT_NAME } from "./system-actors"

/**
 * Accepts either a top-level client or an open transaction so callers can run
 * the severity write atomically alongside their own writes (e.g. the
 * `submit_diagnosis` timeline event) in a single transaction.
 */
export type TriageSeverityDb = MaplePgClient | MapleDatabaseTransaction

const decodeActorId = Schema.decodeUnknownSync(ActorId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeEscalationId = Schema.decodeUnknownSync(IssueEscalationId)

const SEVERITY_RANK: Record<IssueSeverity, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
}

export const severityRank = (severity: IssueSeverity | null): number =>
	severity === null ? 0 : SEVERITY_RANK[severity]

/** At-most-once per issue+level (unique index on the escalation outbox). */
export const escalationDedupeKey = (orgId: string, issueId: string, severity: IssueSeverity) =>
	`esc:${orgId}:${issueId}:${severity}`

/**
 * UUIDv5-style id derived from a seed so retried writers regenerate the SAME
 * id and the primary key (+ onConflictDoNothing) absorbs the duplicate.
 * Same construction as the ai_triage timeline event id in AiTriageWorkflow.run.
 */
const deterministicUuid = (seed: string): string => {
	const hex = createHash("sha256").update(seed).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

/**
 * Upward-only escalation rule: a severity routes to destinations only when it
 * is newly set or strictly escalates. Downgrades and same-level confirmations
 * route nothing (detection-time noise is already covered by alert rule
 * destinations and the error notification policy).
 */
export const escalationReasonFor = (
	from: IssueSeverity | null,
	to: IssueSeverity,
): "severity_set" | "severity_escalated" | null => {
	if (from === null) return "severity_set"
	return severityRank(to) > severityRank(from) ? "severity_escalated" : null
}

const ensureTriageAgentActor = async (
	db: TriageSeverityDb,
	orgId: OrgId,
	timestamp: number,
): Promise<ActorId> => {
	const select = () =>
		db
			.select()
			.from(actors)
			.where(
				and(
					eq(actors.orgId, orgId),
					eq(actors.type, "agent"),
					eq(actors.agentName, TRIAGE_AGENT_NAME),
				),
			)
			.limit(1)
	const existing = await select()
	if (existing[0]) return existing[0].id
	await db
		.insert(actors)
		.values({
			id: decodeActorId(randomUUID()),
			orgId,
			type: "agent",
			userId: null,
			agentName: TRIAGE_AGENT_NAME,
			model: null,
			capabilitiesJson: ["auto-triage"],
			createdBy: null,
			createdAt: new Date(timestamp),
			lastActiveAt: new Date(timestamp),
		})
		.onConflictDoNothing()
	const after = await select()
	const row = after[0]
	if (!row) throw new Error("Failed to ensure maple-triage-agent actor row")
	return row.id
}

export interface ApplyTriageSeverityInput {
	readonly orgId: OrgId
	readonly issueId: ErrorIssueId
	readonly runId: string
	/** Durable investigation id; omitted by the short-lived legacy workflow. */
	readonly investigationId?: InvestigationId
	readonly severity: IssueSeverity
	readonly confidence: AiTriageResult["confidence"]
	readonly timestamp: number
	/** Full triage result; snapshotted into the escalation payload. */
	readonly result?: AiTriageResult
}

export interface ApplyTriageSeverityOutcome {
	readonly applied: boolean
	readonly actorId: ActorId | null
}

/**
 * Apply an AI triage severity assessment to an issue: guarded severity write
 * (manual override always wins), `severity_change` timeline event, and an
 * escalation-outbox row when the severity newly sets or strictly escalates.
 */
export const applyTriageSeverity = async (
	db: TriageSeverityDb,
	input: ApplyTriageSeverityInput,
): Promise<ApplyTriageSeverityOutcome> => {
	const issueRows = await db
		.select()
		.from(errorIssues)
		.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, input.issueId)))
		.limit(1)
	const issue = issueRows[0]
	if (!issue) return { applied: false, actorId: null }

	const actorId = await ensureTriageAgentActor(db, input.orgId, input.timestamp)
	const from = issue.severity ?? null

	if (issue.severitySource === "manual") {
		return { applied: false, actorId }
	}

	// Guard repeated in SQL so a concurrent manual write between the read above
	// and this update still wins.
	const updated = await db
		.update(errorIssues)
		.set({ severity: input.severity, severitySource: "ai", updatedAt: new Date(input.timestamp) })
		.where(
			and(
				eq(errorIssues.orgId, input.orgId),
				eq(errorIssues.id, input.issueId),
				or(isNull(errorIssues.severitySource), ne(errorIssues.severitySource, "manual")),
			),
		)
		// The returned row is the guard outcome: empty means a concurrent
		// manual severity write won.
		.returning({ id: errorIssues.id })
	if (updated.length === 0) {
		return { applied: false, actorId }
	}

	if (from !== input.severity) {
		await db
			.insert(errorIssueEvents)
			.values({
				id: decodeEventId(deterministicUuid(`ai-triage-severity:${input.runId}`)),
				orgId: input.orgId,
				issueId: input.issueId,
				actorId,
				type: "severity_change",
				fromState: null,
				toState: null,
				payloadJson: {
					from,
					to: input.severity,
					source: "ai",
					runId: input.runId,
					confidence: input.confidence,
				},
				createdAt: new Date(input.timestamp),
			})
			.onConflictDoNothing()
	}

	const reason = escalationReasonFor(from, input.severity)
	if (reason !== null) {
		await db
			.insert(issueEscalations)
			.values({
				id: decodeEscalationId(deterministicUuid(`ai-triage-escalation:${input.runId}`)),
				orgId: input.orgId,
				issueId: input.issueId,
				severity: input.severity,
				source: "ai",
				reason,
				runId: input.runId,
				investigationId: input.investigationId ?? null,
				payloadJson: {
					confidence: input.confidence,
					...(input.result ? { triage: input.result } : {}),
				},
				deliveryResultsJson: [],
				status: "queued",
				attempts: 0,
				dedupeKey: escalationDedupeKey(input.orgId, input.issueId, input.severity),
				error: null,
				createdAt: new Date(input.timestamp),
				processedAt: null,
			})
			.onConflictDoNothing()
	}

	await db
		.update(actors)
		.set({ lastActiveAt: new Date(input.timestamp) })
		.where(eq(actors.id, actorId))

	return { applied: true, actorId }
}
