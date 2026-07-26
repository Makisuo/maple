import { createHash, randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	AiTriageResult,
	type InvestigationConfidence,
	InvestigationCreateRequest,
	InvestigationDocument,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationQuotaError,
	InvestigationRejectedError,
	InvestigationSnapshotFact,
	InvestigationSubjectSnapshot,
	InvestigationUnavailableError,
	InvestigationsListResponse,
	type InvestigationStatus,
	InvestigationSubject,
	type OrgId,
	type SubmitDiagnosisRequest,
	type UserId,
} from "@maple/domain/http"
import { ErrorIssueEventId, ErrorIssueId, InvestigationId } from "@maple/domain/primitives"
import { aiTriageSettings, errorIssueEvents, investigations, type InvestigationRow } from "@maple/db"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { trackTokenUsage } from "../lib/autumn-tracker"
import { applyTriageSeverity } from "../lib/issue-severity"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"

const decodeIdSync = Schema.decodeUnknownSync(InvestigationId)
const decodeSubjectSync = Schema.decodeUnknownSync(InvestigationSubject)
const decodeSnapshotOption = Schema.decodeUnknownOption(InvestigationSubjectSnapshot)
const decodeResultOption = Schema.decodeUnknownOption(AiTriageResult)
const decodeIsoSync = Schema.decodeUnknownSync(InvestigationDocument.fields.createdAt)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)

export const newInvestigationId = () => decodeIdSync(randomUUID())

/**
 * Deterministic UUIDv5-style id derived from the investigation id, so the
 * `submit_diagnosis` timeline-event insert is idempotent across re-diagnosis:
 * the same investigation regenerates the SAME id and the primary key (+
 * onConflictDoNothing) absorbs the duplicate. Mirrors the legacy triage path.
 */
const deterministicEventId = (investigationId: string): string => {
	const hex = createHash("sha256").update(`investigation-event:${investigationId}`).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

const makePersistenceError = (error: DatabaseError): InvestigationPersistenceError => {
	const cause = describeCause(error.cause)
	return cause === undefined
		? new InvestigationPersistenceError({ message: error.message })
		: new InvestigationPersistenceError({ message: error.message, cause })
}

export interface ListInvestigationsOptions {
	readonly issueId?: ErrorIssueId
	readonly incidentKind?: AiTriageIncidentKind
	readonly incidentId?: string
	readonly status?: InvestigationStatus
	readonly limit?: number
	readonly offset?: number
}

export interface StartInvestigationOptions {
	/** Automatic incident-open starts respect the per-org enabled flag. */
	readonly automatic: boolean
}

export interface InvestigationServiceShape {
	readonly listInvestigations: (
		orgId: OrgId,
		opts: ListInvestigationsOptions,
	) => Effect.Effect<InvestigationsListResponse, InvestigationPersistenceError>
	readonly getInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
	readonly createInvestigation: (
		orgId: OrgId,
		userId: UserId | null,
		request: InvestigationCreateRequest,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError>
	readonly createAndStartInvestigation: (
		orgId: OrgId,
		userId: UserId | null,
		request: InvestigationCreateRequest,
		options: StartInvestigationOptions,
	) => Effect.Effect<
		InvestigationDocument,
		| InvestigationPersistenceError
		| InvestigationQuotaError
		| InvestigationRejectedError
		| InvestigationUnavailableError
	>
	readonly restartInvestigation: (
		orgId: OrgId,
		id: InvestigationId,
	) => Effect.Effect<
		InvestigationDocument,
		| InvestigationPersistenceError
		| InvestigationNotFoundError
		| InvestigationQuotaError
		| InvestigationRejectedError
		| InvestigationUnavailableError
	>
	readonly updateStatus: (
		orgId: OrgId,
		id: InvestigationId,
		status: InvestigationStatus,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
	readonly submitDiagnosis: (
		orgId: OrgId,
		id: InvestigationId,
		request: SubmitDiagnosisRequest,
	) => Effect.Effect<InvestigationDocument, InvestigationPersistenceError | InvestigationNotFoundError>
}

export class InvestigationService extends Context.Service<InvestigationService, InvestigationServiceShape>()(
	"@maple/api/services/InvestigationService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(makePersistenceError))

			const iso = (date: Date) => decodeIsoSync(date.toISOString())
			const staleBeforeMs = 15 * 60 * 1000

			const fallbackSnapshot = (subject: InvestigationSubject) =>
				new InvestigationSubjectSnapshot({
					title:
						subject.type === "freeform"
							? subject.title
							: `${subject.incidentKind[0]?.toUpperCase() ?? ""}${subject.incidentKind.slice(1)} incident`,
					scope: null,
					status: "open",
					severity: null,
					facts:
						subject.type === "incident"
							? [
									new InvestigationSnapshotFact({
										label: "Incident",
										value: subject.incidentId,
									}),
								]
							: [],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				})

			const parseReport = Effect.fnUntraced(function* (raw: unknown, investigationId: string) {
				if (raw == null) return null
				const decoded = decodeResultOption(raw)
				if (Option.isNone(decoded)) {
					// A stored report that no longer decodes (e.g. an `AiTriageResult`
					// schema change) would otherwise blank silently — surface it on the
					// Effect log/OTLP path so the data loss is observable rather than invisible.
					yield* Effect.logWarning("report_json failed to decode; rendering report-less").pipe(
						Effect.annotateLogs({ investigationId }),
					)
					return null
				}
				return decoded.value
			})

			const rowToDocument = Effect.fnUntraced(function* (row: InvestigationRow) {
				const subject = decodeSubjectSync(row.subjectJson)
				const storedSnapshot = decodeSnapshotOption(row.snapshotJson)
				return new InvestigationDocument({
					id: decodeIdSync(row.id),
					status: row.status,
					subject,
					snapshot: Option.match(storedSnapshot, {
						onNone: () => fallbackSnapshot(subject),
						onSome: (snapshot) => snapshot,
					}),
					report: yield* parseReport(row.reportJson, row.id),
					model: row.model ?? null,
					severity: row.severity ?? null,
					confidence: row.confidence ?? null,
					seededBy: row.seededBy,
					createdBy: row.createdBy ?? null,
					inputTokens: row.inputTokens ?? null,
					outputTokens: row.outputTokens ?? null,
					error: row.error ?? null,
					createdAt: iso(row.createdAt),
					diagnosedAt: row.diagnosedAt ? iso(row.diagnosedAt) : null,
					updatedAt: iso(row.updatedAt),
				})
			})

			const loadRow = (orgId: OrgId, id: InvestigationId) =>
				dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id)))
						.limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			// Look up the single incident-anchored row (the partial unique index key).
			// Used for both the dedup fast-path and the concurrent-insert race loser.
			const loadIncidentRow = (orgId: OrgId, incidentKind: AiTriageIncidentKind, incidentId: string) =>
				dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(
							and(
								eq(investigations.orgId, orgId),
								eq(investigations.incidentKind, incidentKind),
								eq(investigations.incidentId, incidentId),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			const failStaleInvestigations = Effect.fnUntraced(function* (orgId: OrgId, nowMs: number) {
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							error: "diagnosis_timeout: no diagnosis was submitted within 15 minutes; retry",
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(investigations.orgId, orgId),
								eq(investigations.status, "investigating"),
								lt(investigations.startedAt, new Date(nowMs - staleBeforeMs)),
							),
						),
				).pipe(Effect.asVoid)
			})

			const startOfUtcDay = (nowMs: number) => {
				const date = new Date(nowMs)
				return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
			}

			const ensureStartAllowed = Effect.fnUntraced(function* (
				orgId: OrgId,
				automatic: boolean,
				nowMs: number,
			) {
				const settingsRows = yield* dbExecute((db) =>
					db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
				)
				const settings = settingsRows[0]
				if (automatic && (settings === undefined || !settings.enabled)) {
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "Automatic investigations are disabled for this organization.",
							reason: "automation_disabled",
							retryable: false,
						}),
					)
				}

				const dailyLimit = settings?.maxRunsPerDay ?? 20
				const usageRows = yield* dbExecute((db) =>
					db
						.select({
							count: sql<number>`coalesce(sum(${investigations.autonomousTurns}), 0)::int`,
						})
						.from(investigations)
						.where(
							and(
								eq(investigations.orgId, orgId),
								gte(investigations.createdAt, new Date(startOfUtcDay(nowMs))),
							),
						),
				)
				if ((usageRows[0]?.count ?? 0) >= dailyLimit) {
					const retryableAtMs = startOfUtcDay(nowMs) + 24 * 60 * 60 * 1000
					yield* Effect.annotateCurrentSpan({
						"maple.investigation.start_result": "quota_skipped",
						"maple.investigation.daily_limit": dailyLimit,
					})
					return yield* Effect.fail(
						new InvestigationQuotaError({
							message: `Daily investigation budget of ${dailyLimit} has been reached.`,
							limit: dailyLimit,
							retryableAt: decodeIsoSync(new Date(retryableAtMs).toISOString()),
						}),
					)
				}
			})

			const agentBinding = () => {
				const raw = Option.getOrUndefined(workerEnv) as
					| {
							readonly CHAT_FLUE?: unknown
					  }
					| undefined
				const binding = raw?.CHAT_FLUE
				if (
					typeof binding !== "object" ||
					binding === null ||
					typeof (binding as { fetch?: unknown }).fetch !== "function"
				) {
					return undefined
				}
				return { fetch: (binding as { fetch: typeof fetch }).fetch.bind(binding) }
			}

			const markStartFailed = Effect.fnUntraced(function* (
				orgId: OrgId,
				id: InvestigationId,
				reason: string,
				nowMs: number,
			) {
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({ status: "failed", error: reason, updatedAt: new Date(nowMs) })
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id))),
				).pipe(Effect.asVoid)
			})

			const sendAutonomousTurn = Effect.fnUntraced(function* (
				orgId: OrgId,
				doc: InvestigationDocument,
				nowMs: number,
			) {
				const agent = agentBinding()
				if (!agent) {
					yield* markStartFailed(
						orgId,
						doc.id,
						"agent_unavailable: the investigation agent is not configured; retry",
						nowMs,
					)
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "The investigation agent is temporarily unavailable.",
							reason: "agent_unavailable",
							retryable: true,
						}),
					)
				}

				const token = Option.getOrUndefined(env.INTERNAL_SERVICE_TOKEN)
				if (token === undefined) {
					yield* markStartFailed(
						orgId,
						doc.id,
						"agent_unavailable: the internal service token is not configured",
						nowMs,
					)
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "The investigation agent is not configured.",
							reason: "agent_unavailable",
							retryable: false,
						}),
					)
				}

				const instanceId = `${orgId}:inv-${doc.id}`
				const message = [
					"Begin the autonomous investigation now.",
					"Use the preserved subject snapshot below as the source context, gather evidence with tools, and call submit_diagnosis exactly once.",
					JSON.stringify({ subject: doc.subject, snapshot: doc.snapshot }),
				].join("\n\n")
				const response = yield* Effect.tryPromise({
					try: (signal) =>
						agent.fetch(
							new Request(
								`https://chat-flue.internal/agents/maple-chat/${encodeURIComponent(instanceId)}`,
								{
									method: "POST",
									headers: {
										authorization: `Bearer maple_svc_${Redacted.value(token)}`,
										"content-type": "application/json",
									},
									body: JSON.stringify({ message }),
									signal,
								},
							),
						),
					catch: (cause) =>
						new InvestigationUnavailableError({
							message:
								cause instanceof Error ? cause.message : "Unable to start investigation.",
							reason: "start_failed",
							retryable: true,
						}),
				}).pipe(
					Effect.timeoutOrElse({
						duration: Duration.seconds(15),
						orElse: () =>
							Effect.fail(
								new InvestigationUnavailableError({
									message: "The investigation agent timed out after 15 seconds.",
									reason: "start_failed",
									retryable: true,
								}),
							),
					}),
					Effect.tapError(() =>
						markStartFailed(
							orgId,
							doc.id,
							"start_failed: the investigation agent could not be reached; retry",
							nowMs,
						),
					),
				)
				if (!response.ok) {
					const retryable = response.status === 429 || response.status >= 500
					yield* markStartFailed(
						orgId,
						doc.id,
						retryable
							? `start_failed: agent returned HTTP ${response.status}; retry`
							: `start_rejected: agent returned HTTP ${response.status}`,
						nowMs,
					)
					if (!retryable) {
						return yield* Effect.fail(
							new InvestigationRejectedError({
								message: `The investigation agent rejected the start request (${response.status}).`,
								status: response.status,
							}),
						)
					}
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: `The investigation agent rejected the start request (${response.status}).`,
							reason: "start_failed",
							retryable: true,
						}),
					)
				}
				yield* Effect.annotateCurrentSpan({
					"maple.investigation.start_result": "started",
					"maple.investigation.id": doc.id,
				})
			})

			const listInvestigations: InvestigationServiceShape["listInvestigations"] = Effect.fn(
				"InvestigationService.listInvestigations",
			)(function* (orgId, opts) {
				yield* Effect.annotateCurrentSpan({ orgId })
				yield* failStaleInvestigations(orgId, yield* Clock.currentTimeMillis)
				const conditions = [
					eq(investigations.orgId, orgId),
					opts.issueId ? eq(investigations.issueId, opts.issueId) : undefined,
					opts.incidentKind ? eq(investigations.incidentKind, opts.incidentKind) : undefined,
					opts.incidentId ? eq(investigations.incidentId, opts.incidentId) : undefined,
					opts.status ? eq(investigations.status, opts.status) : undefined,
				].filter((c): c is NonNullable<typeof c> => c !== undefined)
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(...conditions))
						.orderBy(desc(investigations.createdAt), desc(investigations.id))
						.limit(opts.limit ?? 50)
						.offset(opts.offset ?? 0),
				)
				return new InvestigationsListResponse({
					investigations: yield* Effect.forEach(rows, rowToDocument),
				})
			})

			const getInvestigation: InvestigationServiceShape["getInvestigation"] = Effect.fn(
				"InvestigationService.getInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				yield* failStaleInvestigations(orgId, yield* Clock.currentTimeMillis)
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				return yield* rowToDocument(row)
			})

			const createInvestigation: InvestigationServiceShape["createInvestigation"] = Effect.fn(
				"InvestigationService.createInvestigation",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.investigation.subject_type": request.subject.type,
				})
				const nowMs = yield* Clock.currentTimeMillis
				const subject = request.subject

				// Incident-anchored investigations dedup to one row per incident: if one
				// already exists, return it (re-opening the same war-room) instead of
				// creating a duplicate. Free-form investigations are always new.
				if (subject.type === "incident") {
					const existing = yield* loadIncidentRow(orgId, subject.incidentKind, subject.incidentId)
					if (existing) return yield* rowToDocument(existing)
				}

				const id = newInvestigationId()
				const incidentColumns =
					subject.type === "incident"
						? {
								incidentKind: subject.incidentKind,
								incidentId: subject.incidentId,
								issueId: subject.issueId ?? null,
							}
						: { incidentKind: null, incidentId: null, issueId: null }

				// `onConflictDoNothing` makes the dedup race-safe: two concurrent
				// incident-open seeds both pass the SELECT above, but the partial unique
				// index (org, kind, incident_id) lets only one INSERT win. The loser gets
				// no returned row and re-reads the winner instead of surfacing a 503.
				const inserted = yield* dbExecute((db) =>
					db
						.insert(investigations)
						.values({
							id,
							orgId,
							status: "investigating",
							seededBy: userId ? "user" : "system",
							subjectJson: subject,
							snapshotJson: request.snapshot ?? fallbackSnapshot(subject),
							...incidentColumns,
							createdBy: userId,
							createdAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						})
						.onConflictDoNothing()
						.returning({ id: investigations.id }),
				)

				if (inserted.length === 0) {
					if (subject.type === "incident") {
						const winner = yield* loadIncidentRow(orgId, subject.incidentKind, subject.incidentId)
						if (winner) return yield* rowToDocument(winner)
					}
					return yield* Effect.fail(
						new InvestigationPersistenceError({
							message: "Investigation insert conflicted with no resolvable row",
						}),
					)
				}

				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationPersistenceError({
							message: "Investigation row missing after insert",
						}),
					)
				}
				return yield* rowToDocument(row)
			})

			const createAndStartInvestigation: InvestigationServiceShape["createAndStartInvestigation"] =
				Effect.fn("InvestigationService.createAndStartInvestigation")(
					function* (orgId, userId, request, options) {
						yield* Effect.annotateCurrentSpan({
							orgId,
							"maple.investigation.subject_type": request.subject.type,
							"maple.investigation.creation_source": options.automatic ? "automatic" : "manual",
						})
						const nowMs = yield* Clock.currentTimeMillis
						yield* failStaleInvestigations(orgId, nowMs)
						if (request.subject.type === "incident") {
							const existing = yield* loadIncidentRow(
								orgId,
								request.subject.incidentKind,
								request.subject.incidentId,
							)
							if (
								existing &&
								(existing.status !== "investigating" || existing.startedAt !== null)
							) {
								return yield* rowToDocument(existing)
							}
						}
						yield* ensureStartAllowed(orgId, options.automatic, nowMs)
						const doc = yield* createInvestigation(orgId, userId, request)
						const claimed = yield* dbExecute((db) =>
							db
								.update(investigations)
								.set({
									startedAt: new Date(nowMs),
									autonomousTurns: sql`${investigations.autonomousTurns} + 1`,
									updatedAt: new Date(nowMs),
								})
								.where(
									and(
										eq(investigations.orgId, orgId),
										eq(investigations.id, doc.id),
										eq(investigations.status, "investigating"),
										isNull(investigations.startedAt),
									),
								)
								.returning({ id: investigations.id }),
						)
						if (claimed.length === 0) return doc
						yield* sendAutonomousTurn(orgId, doc, nowMs)
						return yield* getInvestigation(orgId, doc.id).pipe(
							Effect.catchTag("@maple/http/investigations/InvestigationNotFoundError", () =>
								Effect.fail(
									new InvestigationPersistenceError({
										message: "Investigation row disappeared after autonomous start",
									}),
								),
							),
						)
					},
				)

			const restartInvestigation: InvestigationServiceShape["restartInvestigation"] = Effect.fn(
				"InvestigationService.restartInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const nowMs = yield* Clock.currentTimeMillis
				yield* ensureStartAllowed(orgId, false, nowMs)
				const existing = yield* getInvestigation(orgId, id)
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "investigating",
							error: null,
							startedAt: new Date(nowMs),
							autonomousTurns: sql`${investigations.autonomousTurns} + 1`,
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id))),
				)
				const restarting = new InvestigationDocument({
					...existing,
					status: "investigating",
					error: null,
					updatedAt: decodeIsoSync(new Date(nowMs).toISOString()),
				})
				yield* sendAutonomousTurn(orgId, restarting, nowMs)
				return yield* getInvestigation(orgId, id)
			})

			const updateStatus: InvestigationServiceShape["updateStatus"] = Effect.fn(
				"InvestigationService.updateStatus",
			)(function* (orgId, id, status) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.investigation.id": id,
					"maple.investigation.status": status,
				})
				const nowMs = yield* Clock.currentTimeMillis
				const updated = yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({ status, updatedAt: new Date(nowMs) })
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id)))
						.returning({ id: investigations.id }),
				)
				if (updated.length === 0) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				return yield* rowToDocument(row)
			})

			/**
			 * The chat-flue `submit_diagnosis` write path. Persists the structured
			 * report onto the investigation row, then applies the incident-side
			 * effects (severity + issue timeline) and tracks token usage — all
			 * idempotent on the investigation id so a re-diagnosis or retry can't
			 * duplicate them. Ported from the legacy AiTriageWorkflow persist step.
			 */
			const submitDiagnosis: InvestigationServiceShape["submitDiagnosis"] = Effect.fn(
				"InvestigationService.submitDiagnosis",
			)(function* (orgId, id, request) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const nowMs = yield* Clock.currentTimeMillis
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}

				const result = request.report
				const confidence: InvestigationConfidence = result.confidence

				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "diagnosed",
							reportJson: result,
							severity: result.severityAssessment,
							confidence,
							model: request.model ?? row.model ?? null,
							inputTokens: request.inputTokens ?? row.inputTokens ?? null,
							outputTokens: request.outputTokens ?? row.outputTokens ?? null,
							error: null,
							diagnosedAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, id))),
				)

				// Linked error issue (error fingerprint / alert-backed / anomaly-linked)
				// gets the diagnosis applied: severity (respecting manual override) +
				// a timeline event, both idempotent via the investigation-derived ids.
				const issueId = row.issueId
				if (issueId) {
					const decodedIssueId = decodeIssueId(issueId)
					// Severity write + timeline event commit atomically: a crash between
					// them must not leave the issue escalated without its audit event.
					yield* dbExecute((db) =>
						db.transaction(async (tx) => {
							const applied = await applyTriageSeverity(tx, {
								orgId,
								issueId: decodedIssueId,
								runId: id,
								investigationId: id,
								severity: result.severityAssessment,
								confidence,
								timestamp: nowMs,
								result,
							})
							await tx
								.insert(errorIssueEvents)
								.values({
									id: decodeEventId(deterministicEventId(id)),
									orgId,
									issueId: decodedIssueId,
									actorId: applied.actorId,
									type: "ai_triage",
									payloadJson: {
										investigationId: id,
										summary: result.summary,
										severityAssessment: result.severityAssessment,
										confidence,
										applied: applied.applied,
									},
									createdAt: new Date(nowMs),
								})
								.onConflictDoNothing()
						}),
					)
				}

				const env = Option.getOrUndefined(workerEnv)
				if (env && (request.inputTokens || request.outputTokens)) {
					// Keyed on the investigation id (one diagnosis per investigation): a
					// re-diagnosis updates the report but is intentionally NOT re-billed,
					// matching the once-per-investigation timeline event above. A tracking
					// failure must not fail the diagnosis write, but is surfaced as a log.
					yield* Effect.tryPromise(() =>
						trackTokenUsage(env, {
							orgId,
							inputTokens: request.inputTokens ?? 0,
							outputTokens: request.outputTokens ?? 0,
							idempotencyKey: id,
							source: "triage",
						}),
					).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("token usage tracking failed").pipe(
								Effect.annotateLogs({ investigationId: id, cause: Cause.pretty(cause) }),
							),
						),
					)
				}

				const updated = yield* loadRow(orgId, id)
				return yield* rowToDocument(updated ?? row)
			})

			return {
				listInvestigations,
				getInvestigation,
				createInvestigation,
				createAndStartInvestigation,
				restartInvestigation,
				updateStatus,
				submitDiagnosis,
			} satisfies InvestigationServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
