import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { IssueSeverity, OrgId, WorkflowState } from "@maple/domain/http"
import { ActorId, ErrorIssueEventId, ErrorIssueId } from "@maple/domain/primitives"
import { actors, errorIssues, errorIssueEvents, type ErrorIssueRow } from "@maple/db"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { Database, type DatabaseError } from "../../lib/DatabaseLive"

/**
 * PlanetScale webhook event handling: signature verification, payload decode,
 * event → action classification, and the issue-hub upsert for events that
 * warrant triage (OOM restarts, storage thresholds, anomalies). Mirrors
 * `lib/issue-hub.ts` (alert incidents → kind="alert" issues) but standalone,
 * with kind="integration" and the `planetscale:{database}:{event}` fingerprint
 * so repeated firings dedupe into one issue that re-opens.
 */

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** Verify PlanetScale's `X-PlanetScale-Signature`: HMAC-SHA256 hex of the raw body. */
export const verifyPlanetScaleSignature = (
	rawBody: string,
	secret: string,
	signatureHeader: string | undefined,
): boolean => {
	if (!signatureHeader) return false
	const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
	const provided = signatureHeader.trim().toLowerCase()
	if (provided.length !== expected.length) return false
	return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"))
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export const PlanetScaleWebhookPayload = Schema.Struct({
	/** Unix epoch seconds. */
	timestamp: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	event: Schema.String,
	organization: Schema.optionalKey(Schema.NullOr(Schema.String)),
	database: Schema.optionalKey(Schema.NullOr(Schema.String)),
	resource: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})
export type PlanetScaleWebhookPayload = Schema.Schema.Type<typeof PlanetScaleWebhookPayload>

export const decodePlanetScaleWebhookPayload = Schema.decodeUnknownEffect(
	Schema.fromJsonString(PlanetScaleWebhookPayload),
)

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type PlanetScaleEventAction =
	| {
			readonly action: "issue"
			readonly severity: IssueSeverity
			readonly title: string
			readonly describe: (payload: PlanetScaleWebhookPayload) => string
	  }
	| { readonly action: "log" }
	| { readonly action: "test" }

const branchName = (payload: PlanetScaleWebhookPayload): string => {
	const name = payload.resource?.name
	return typeof name === "string" && name.length > 0 ? name : "unknown-branch"
}

/**
 * Exhaustive event map. Health events become triage issues; lifecycle events
 * (deploys, branch state changes) are observability noise at issue granularity
 * and are logged only — surfacing them as deploy-timeline annotations is a
 * follow-up once a generic annotation store exists.
 */
export const classifyPlanetScaleEvent = (event: string): PlanetScaleEventAction => {
	switch (event) {
		case "branch.out_of_memory":
			return {
				action: "issue",
				severity: "high",
				title: "PlanetScale branch out of memory",
				describe: (payload) =>
					`Branch ${branchName(payload)} of ${payload.database ?? "unknown"} was restarted after running out of memory.`,
			}
		case "branch.anomaly":
			return {
				action: "issue",
				severity: "high",
				title: "PlanetScale detected an anomaly",
				describe: (payload) =>
					`PlanetScale detected a performance anomaly on branch ${branchName(payload)} of ${payload.database ?? "unknown"}.`,
			}
		case "cluster.storage":
		case "keyspace.storage":
			return {
				action: "issue",
				severity: "medium",
				title: "PlanetScale storage threshold reached",
				describe: (payload) =>
					`${payload.database ?? "A database"} crossed a storage usage threshold — review retention or scale the cluster.`,
			}
		case "deploy_request.opened":
		case "deploy_request.queued":
		case "deploy_request.in_progress":
		case "deploy_request.pending_cutover":
		case "deploy_request.schema_applied":
		case "deploy_request.errored":
		case "deploy_request.reverted":
		case "deploy_request.closed":
		case "branch.ready":
		case "branch.sleeping":
		case "branch.primary_promoted":
		case "branch.start_maintenance":
		case "database.access_request":
			return { action: "log" }
		case "webhook.test":
			return { action: "test" }
		default:
			// Forward-compatible: unknown events are acknowledged and logged, never
			// rejected — PlanetScale retries failing deliveries.
			return { action: "log" }
	}
}

// ---------------------------------------------------------------------------
// Issue upsert (kind="integration")
// ---------------------------------------------------------------------------

const SYSTEM_INTEGRATIONS_AGENT_NAME = "system-integrations"

const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeActorId = Schema.decodeUnknownSync(ActorId)

/**
 * Synthetic dedupe key for webhook-backed issues. Real error fingerprints are
 * decimal UInt64 strings, so the `planetscale:` prefix can never collide inside
 * the UNIQUE(orgId, fingerprintHash) index.
 */
export const planetScaleIssueFingerprint = (database: string, event: string) =>
	`planetscale:${database}:${event}`

export interface UpsertPlanetScaleIssueInput {
	readonly orgId: OrgId
	readonly payload: PlanetScaleWebhookPayload
	readonly severity: IssueSeverity
	readonly title: string
	readonly description: string
	readonly timestamp: number
}

export interface UpsertPlanetScaleIssueResult {
	readonly issueId: ErrorIssueId
	readonly action: "created" | "reopened" | "refreshed" | "skipped"
}

/**
 * Create-or-refresh the triage issue backing a PlanetScale health event.
 * Database failures stay typed so the durable queue consumer can retry the
 * delivery. The fingerprint makes successful redelivery idempotent.
 */
export const upsertPlanetScaleIssue: (
	input: UpsertPlanetScaleIssueInput,
) => Effect.Effect<UpsertPlanetScaleIssueResult, DatabaseError, Database> = Effect.fn(
	"planetscaleWebhook.upsertIssue",
)(function* (input: UpsertPlanetScaleIssueInput) {
	const database = yield* Database
	const databaseName = input.payload.database ?? "unknown"
	const fingerprintHash = planetScaleIssueFingerprint(databaseName, input.payload.event)
	const serviceName = `planetscale/${databaseName}`
	const actorTimestamp = yield* Clock.currentTimeMillis
	const sourceRefJson = {
		provider: "planetscale",
		event: input.payload.event,
		database: databaseName,
		organization: input.payload.organization ?? null,
		resource: input.payload.resource ?? null,
	}

	return yield* database.execute((db) =>
		db.transaction(async (tx) => {
			const ensureActor = async (): Promise<ActorId> => {
				const selectActor = () =>
					tx
						.select()
						.from(actors)
						.where(
							and(
								eq(actors.orgId, input.orgId),
								eq(actors.type, "agent"),
								eq(actors.agentName, SYSTEM_INTEGRATIONS_AGENT_NAME),
							),
						)
						.limit(1)
				const existing = await selectActor()
				if (existing[0]) return existing[0].id
				await tx
					.insert(actors)
					.values({
						id: decodeActorId(randomUUID()),
						orgId: input.orgId,
						type: "agent",
						userId: null,
						agentName: SYSTEM_INTEGRATIONS_AGENT_NAME,
						model: null,
						capabilitiesJson: ["system", "integration-issues"],
						createdBy: null,
						createdAt: new Date(actorTimestamp),
						lastActiveAt: new Date(actorTimestamp),
					})
					.onConflictDoNothing()
				const row = (await selectActor())[0]
				if (!row) throw new Error("Failed to ensure system-integrations actor row")
				return row.id
			}

			const recordEvent = (
				issueId: ErrorIssueId,
				actorId: ActorId,
				type: "created" | "state_change" | "regression",
				opts: {
					readonly fromState?: WorkflowState
					readonly toState?: WorkflowState
					readonly payload?: Record<string, unknown>
				},
			) =>
				tx.insert(errorIssueEvents).values({
					id: decodeEventId(randomUUID()),
					orgId: input.orgId,
					issueId,
					actorId,
					type,
					fromState: opts.fromState ?? null,
					toState: opts.toState ?? null,
					payloadJson: opts.payload ?? {},
					createdAt: new Date(input.timestamp),
				})

			const prior: ErrorIssueRow | undefined = (
				await tx
					.select()
					.from(errorIssues)
					.where(
						and(
							eq(errorIssues.orgId, input.orgId),
							eq(errorIssues.fingerprintHash, fingerprintHash),
						),
					)
					.limit(1)
			)[0]

			if (prior === undefined) {
				const issueId = decodeIssueId(randomUUID())
				await tx.insert(errorIssues).values({
					id: issueId,
					orgId: input.orgId,
					kind: "integration",
					sourceRefJson,
					fingerprintHash,
					serviceName,
					exceptionType: input.title,
					exceptionMessage: input.description,
					errorLabel: input.title,
					topFrame: "",
					workflowState: "triage",
					priority: 3,
					severity: input.severity,
					severitySource: "detector",
					assignedActorId: null,
					leaseHolderActorId: null,
					leaseExpiresAt: null,
					claimedAt: null,
					notes: null,
					firstSeenAt: new Date(input.timestamp),
					lastSeenAt: new Date(input.timestamp),
					occurrenceCount: 1,
					resolvedAt: null,
					resolvedByActorId: null,
					snoozeUntil: null,
					archivedAt: null,
					createdAt: new Date(input.timestamp),
					updatedAt: new Date(input.timestamp),
				})
				const actorId = await ensureActor()
				await recordEvent(issueId, actorId, "created", {
					toState: "triage",
					payload: sourceRefJson,
				})
				return { issueId, action: "created" as const }
			}

			const issueId = prior.id
			// A wontfix issue with an active or indefinite snooze stays untouched.
			const snoozeActive =
				prior.workflowState === "wontfix" &&
				(prior.snoozeUntil == null || prior.snoozeUntil.getTime() > input.timestamp)
			if (snoozeActive) return { issueId, action: "skipped" as const }

			await tx
				.update(errorIssues)
				.set({
					lastSeenAt: new Date(input.timestamp),
					occurrenceCount: sql`${errorIssues.occurrenceCount} + 1`,
					exceptionMessage: input.description,
					sourceRefJson,
					updatedAt: new Date(input.timestamp),
				})
				.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, prior.id)))

			const reopenFrom: WorkflowState | null =
				prior.workflowState === "done" || prior.workflowState === "wontfix"
					? prior.workflowState
					: null
			if (reopenFrom === null) return { issueId, action: "refreshed" as const }

			await tx
				.update(errorIssues)
				.set({
					workflowState: "triage",
					resolvedAt: null,
					resolvedByActorId: null,
					snoozeUntil: null,
					updatedAt: new Date(input.timestamp),
				})
				.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, prior.id)))
			const actorId = await ensureActor()
			await recordEvent(issueId, actorId, "state_change", {
				fromState: reopenFrom,
				toState: "triage",
				payload: { viaRegression: true, event: input.payload.event },
			})
			await recordEvent(issueId, actorId, "regression", {
				payload: { event: input.payload.event, database: databaseName },
			})
			return { issueId, action: "reopened" as const }
		}),
	)
})
