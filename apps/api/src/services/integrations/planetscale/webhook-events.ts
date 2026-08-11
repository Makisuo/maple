import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { IssueSeverity, OrgId, WorkflowState } from "@maple/domain/http"
import { ActorId, ErrorIssueEventId, ErrorIssueId } from "@maple/domain/primitives"
import {
	actors,
	errorIssues,
	errorIssueEvents,
	planetscaleDatabases,
	planetscaleEvents,
	type ErrorIssueRow,
} from "@maple/db"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"

/**
 * PlanetScale webhook event handling: signature verification, payload decode,
 * event → action classification, and the issue-hub upsert for events that
 * warrant triage (OOM restarts, storage thresholds, anomalies). Mirrors
 * `lib/issue-hub.ts` (alert incidents → kind="alert" issues) but standalone,
 * with kind="integration" and the `planetscale:{database}:{event}` fingerprint
 * so repeated firings dedupe into one issue that re-opens.
 */

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

/** Where an event belongs on the timeline. Mirrored by the web vocabulary table. */
export type PlanetScaleEventCategory = "deploy_request" | "branch" | "database" | "cluster" | "keyspace"

export interface PlanetScaleTimelineSpec {
	readonly category: PlanetScaleEventCategory
	/** Normalized lifecycle state; null when the event isn't a state transition. */
	readonly state: string | null
	readonly title: (payload: PlanetScaleWebhookPayload) => string
}

/**
 * `issue` carries a `timeline` too: a branch running out of memory belongs in
 * the triage hub *and* on the chart next to the CPU spike it caused.
 */
export type PlanetScaleEventAction =
	| {
			readonly action: "issue"
			readonly severity: IssueSeverity
			readonly title: string
			readonly describe: (payload: PlanetScaleWebhookPayload) => string
			readonly timeline: PlanetScaleTimelineSpec
	  }
	| { readonly action: "timeline"; readonly timeline: PlanetScaleTimelineSpec }
	| { readonly action: "log" }
	| { readonly action: "test" }

export const planetScaleBranchName = (payload: PlanetScaleWebhookPayload): string => {
	const name = payload.resource?.name
	return typeof name === "string" && name.length > 0 ? name : "unknown-branch"
}

const branchName = planetScaleBranchName

/**
 * Deploy-request identity, so a webhook delivery and the REST backfill of the
 * same transition collapse onto one timeline row. `number` is what PlanetScale
 * shows in its UI; `id` is the fallback for payload shapes that omit it.
 */
export const deployRequestNumber = (payload: PlanetScaleWebhookPayload): string => {
	const number = payload.resource?.number
	if (typeof number === "number" || typeof number === "string") return String(number)
	const id = payload.resource?.id
	return typeof id === "string" || typeof id === "number" ? String(id) : ""
}

/** The lifecycle state a `deploy_request.*` / `branch.*` event represents. */
const stateFromEvent = (event: string): string | null => {
	const dot = event.indexOf(".")
	return dot === -1 ? null : event.slice(dot + 1)
}

/**
 * Exhaustive event map.
 *
 * Health events become triage issues *and* timeline markers. Lifecycle events
 * (deploys, branch state changes) are too low-signal to be issues but are
 * exactly what makes a chart readable — "CPU tripled" is noise until it sits
 * next to "schema applied" — so they are persisted as timeline rows.
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
				timeline: {
					category: "branch",
					state: "out_of_memory",
					title: (payload) => `${branchName(payload)} restarted — out of memory`,
				},
			}
		case "branch.anomaly":
			return {
				action: "issue",
				severity: "high",
				title: "PlanetScale detected an anomaly",
				describe: (payload) =>
					`PlanetScale detected a performance anomaly on branch ${branchName(payload)} of ${payload.database ?? "unknown"}.`,
				timeline: {
					category: "branch",
					state: "anomaly",
					title: (payload) => `Anomaly detected on ${branchName(payload)}`,
				},
			}
		case "cluster.storage":
		case "keyspace.storage":
			return {
				action: "issue",
				severity: "medium",
				title: "PlanetScale storage threshold reached",
				describe: (payload) =>
					`${payload.database ?? "A database"} crossed a storage usage threshold — review retention or scale the cluster.`,
				timeline: {
					category: event === "cluster.storage" ? "cluster" : "keyspace",
					state: "storage_threshold",
					title: () => "Storage threshold crossed",
				},
			}
		case "deploy_request.opened":
		case "deploy_request.queued":
		case "deploy_request.in_progress":
		case "deploy_request.pending_cutover":
		case "deploy_request.schema_applied":
		case "deploy_request.errored":
		case "deploy_request.reverted":
		case "deploy_request.closed":
			return {
				action: "timeline",
				timeline: {
					category: "deploy_request",
					state: stateFromEvent(event),
					title: (payload) => {
						const number = deployRequestNumber(payload)
						const label = number === "" ? "Deploy request" : `Deploy request #${number}`
						return `${label} ${DEPLOY_STATE_VERB[event] ?? stateFromEvent(event)}`
					},
				},
			}
		case "branch.ready":
		case "branch.sleeping":
		case "branch.primary_promoted":
		case "branch.start_maintenance":
			return {
				action: "timeline",
				timeline: {
					category: "branch",
					state: stateFromEvent(event),
					title: (payload) =>
						`${branchName(payload)} ${BRANCH_STATE_VERB[event] ?? stateFromEvent(event)}`,
				},
			}
		case "database.access_request":
			return {
				action: "timeline",
				timeline: {
					category: "database",
					state: "access_request",
					title: (payload) => `Access requested for ${payload.database ?? "the database"}`,
				},
			}
		case "webhook.test":
			return { action: "test" }
		default:
			// Forward-compatible: unknown events are acknowledged and logged, never
			// rejected — PlanetScale retries failing deliveries.
			return { action: "log" }
	}
}

const DEPLOY_STATE_VERB: Record<string, string> = {
	"deploy_request.opened": "opened",
	"deploy_request.queued": "queued",
	"deploy_request.in_progress": "deploying",
	"deploy_request.pending_cutover": "pending cutover",
	"deploy_request.schema_applied": "applied its schema",
	"deploy_request.errored": "failed",
	"deploy_request.reverted": "was reverted",
	"deploy_request.closed": "closed",
}

const BRANCH_STATE_VERB: Record<string, string> = {
	"branch.ready": "is ready",
	"branch.sleeping": "went to sleep",
	"branch.primary_promoted": "was promoted to primary",
	"branch.start_maintenance": "entered maintenance",
}

/**
 * PlanetScale webhook `timestamp` is epoch SECONDS; the deploy-request REST
 * backfill carries milliseconds. Both are truncated to the second so the same
 * transition from either source lands on one row under the dedupe index.
 */
export const truncateToSecond = (epochMs: number): Date => new Date(Math.floor(epochMs / 1000) * 1000)

export interface InsertPlanetScaleEventInput {
	readonly orgId: OrgId
	readonly databaseName: string
	readonly branchName: string
	readonly category: PlanetScaleEventCategory
	readonly eventType: string
	readonly state: string | null
	readonly externalId: string
	readonly title: string
	readonly source: "webhook" | "backfill"
	readonly actorLogin?: string | null
	readonly url?: string | null
	readonly payload?: Record<string, unknown> | null
	readonly occurredAtMs: number
	readonly createdAtMs: number
}

/**
 * Append one lifecycle event, idempotently. Queue redelivery and repeated
 * backfills both land on the dedupe index and become no-ops, so callers can
 * retry freely — `inserted` reports whether the row was new.
 *
 * `databaseId` is resolved best-effort from the inventory; a miss leaves it ""
 * because the read path keys on `databaseName` anyway, and the webhook payload
 * carries only the name.
 */
export const insertPlanetScaleEvent: (
	input: InsertPlanetScaleEventInput,
) => Effect.Effect<{ readonly inserted: boolean }, DatabaseError, Database> = Effect.fn(
	"planetscaleWebhook.insertEvent",
)(function* (input: InsertPlanetScaleEventInput) {
	const database = yield* Database
	return yield* database.execute(async (db) => {
		const known = await db
			.select({ databaseId: planetscaleDatabases.databaseId })
			.from(planetscaleDatabases)
			.where(
				and(
					eq(planetscaleDatabases.orgId, input.orgId),
					eq(planetscaleDatabases.name, input.databaseName),
				),
			)
			.limit(1)

		const rows = await db
			.insert(planetscaleEvents)
			.values({
				id: randomUUID(),
				orgId: input.orgId,
				databaseId: known[0]?.databaseId ?? "",
				databaseName: input.databaseName,
				branchName: input.branchName,
				category: input.category,
				eventType: input.eventType,
				state: input.state,
				externalId: input.externalId,
				title: input.title,
				source: input.source,
				actorLogin: input.actorLogin ?? null,
				url: input.url ?? null,
				payloadJson: input.payload ?? null,
				occurredAt: truncateToSecond(input.occurredAtMs),
				createdAt: new Date(input.createdAtMs),
			})
			.onConflictDoNothing()
			.returning({ id: planetscaleEvents.id })

		return { inserted: rows.length > 0 }
	})
})

// Issue upsert (kind="integration")

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
				const candidateId = decodeIssueId(randomUUID())
				// READ COMMITTED does not hold the gap between the select above and
				// this insert, so a concurrent webhook for the same event can slip in
				// and raise `error_issues_org_fp_idx`.
				const claimed = await tx
					.insert(errorIssues)
					.values({
						id: candidateId,
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
					.onConflictDoNothing({
						target: [errorIssues.orgId, errorIssues.fingerprintHash],
					})
					.returning({ id: errorIssues.id })

				const insertedId = claimed[0]?.id
				if (insertedId !== undefined) {
					const actorId = await ensureActor()
					await recordEvent(insertedId, actorId, "created", {
						toState: "triage",
						payload: sourceRefJson,
					})
					return { issueId: insertedId, action: "created" as const }
				}
				// The concurrent writer won and already emitted `created`; report the
				// sighting against their issue rather than duplicating the history.
				const winner = (
					await tx
						.select({ id: errorIssues.id })
						.from(errorIssues)
						.where(
							and(
								eq(errorIssues.orgId, input.orgId),
								eq(errorIssues.fingerprintHash, fingerprintHash),
							),
						)
						.limit(1)
				)[0]
				return { issueId: winner?.id ?? candidateId, action: "skipped" as const }
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
