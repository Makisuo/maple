import {
	type AiTriageIncidentKind,
	AiTriageNotFoundError,
	AiTriagePersistenceError,
	AiTriageResult,
	AiTriageRunDocument,
	type AiTriageRunCreateRequest,
	AiTriageRunsListResponse,
	AiTriageSettingsDocument,
	type AiTriageSettingsUpdateRequest,
	AiTriageValidationError,
	AlertIncidentId,
	AnomalyIncidentId,
	ErrorIncidentId,
	type ErrorIssueId,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	aiTriageRuns,
	type AiTriageRunRow,
	aiTriageSettings,
	type AiTriageSettingsRow,
	alertIncidents,
	alertRules,
	anomalyIncidents,
	errorIncidents,
	errorIssues,
} from "@maple/db"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, DatabaseError, type DatabaseClient } from "@/platform/DatabaseLive"
import {
	AI_TRIAGE_WORKFLOW_BINDING,
	isAiTriageWorkflowBinding,
	newAiTriageRunId,
} from "@/services/errors/ai-triage-enqueue"

const decodeIsoSync = Schema.decodeUnknownSync(AiTriageRunDocument.fields.createdAt)
const decodeResultSync = Schema.decodeUnknownSync(AiTriageResult)
const decodeAnomalyIncidentId = Schema.decodeUnknownOption(AnomalyIncidentId)
const decodeErrorIncidentId = Schema.decodeUnknownOption(ErrorIncidentId)
const decodeAlertIncidentId = Schema.decodeUnknownOption(AlertIncidentId)

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

const makePersistenceError = (error: unknown): AiTriagePersistenceError => {
	const message =
		error instanceof DatabaseError || error instanceof Error
			? error.message
			: "AI triage persistence failure"
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return cause === undefined
		? new AiTriagePersistenceError({ message })
		: new AiTriagePersistenceError({ message, cause })
}

export interface AiTriageServiceShape {
	readonly getSettings: (orgId: OrgId) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError>
	readonly updateSettings: (
		orgId: OrgId,
		userId: UserId,
		request: AiTriageSettingsUpdateRequest,
	) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError | AiTriageValidationError>
	readonly listRuns: (
		orgId: OrgId,
		opts: {
			readonly issueId?: ErrorIssueId
			readonly incidentId?: string
			readonly incidentKind?: AiTriageIncidentKind
			readonly limit?: number
		},
	) => Effect.Effect<AiTriageRunsListResponse, AiTriagePersistenceError>
	readonly createRun: (
		orgId: OrgId,
		request: AiTriageRunCreateRequest,
	) => Effect.Effect<
		AiTriageRunDocument,
		AiTriagePersistenceError | AiTriageValidationError | AiTriageNotFoundError
	>
}

export class AiTriageService extends Context.Service<AiTriageService, AiTriageServiceShape>()(
	"@maple/api/services/AiTriageService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(makePersistenceError))

			const isoFromEpoch = (ms: number) => decodeIsoSync(new Date(ms).toISOString())

			const parseResult = (raw: unknown): AiTriageResult | null => {
				if (raw == null) return null
				try {
					return decodeResultSync(raw)
				} catch {
					return null
				}
			}

			const runToDocument = (row: AiTriageRunRow): AiTriageRunDocument =>
				new AiTriageRunDocument({
					id: Schema.decodeUnknownSync(AiTriageRunDocument.fields.id)(row.id),
					incidentKind: row.incidentKind,
					incidentId: row.incidentId,
					issueId: row.issueId ?? null,
					status: row.status,
					result: parseResult(row.resultJson),
					model: row.model ?? null,
					inputTokens: row.inputTokens ?? null,
					outputTokens: row.outputTokens ?? null,
					error: row.error ?? null,
					createdAt: isoFromEpoch(row.createdAt.getTime()),
					startedAt: row.startedAt ? isoFromEpoch(row.startedAt.getTime()) : null,
					completedAt: row.completedAt ? isoFromEpoch(row.completedAt.getTime()) : null,
				})

			const loadSettingsRow = Effect.fn("AiTriageService.loadSettingsRow")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
				)
				return rows[0]
			})

			const settingsToDocument = (row: AiTriageSettingsRow | undefined): AiTriageSettingsDocument =>
				new AiTriageSettingsDocument({
					enabled: row?.enabled ?? false,
					maxRunsPerDay: row?.maxRunsPerDay ?? 20,
					updatedAt: row?.updatedAt ? isoFromEpoch(row.updatedAt.getTime()) : null,
					updatedBy: row?.updatedBy ?? null,
				})

			const getSettings: AiTriageServiceShape["getSettings"] = Effect.fn("AiTriageService.getSettings")(
				function* (orgId) {
					yield* Effect.annotateCurrentSpan({ orgId })
					return settingsToDocument(yield* loadSettingsRow(orgId))
				},
			)

			const updateSettings: AiTriageServiceShape["updateSettings"] = Effect.fn(
				"AiTriageService.updateSettings",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const nowMs = yield* Clock.currentTimeMillis
				const existing = yield* loadSettingsRow(orgId)

				// Triage runs on the chat-flue Flue workflow (Cloudflare Workers AI) since
				// the Flue cutover — it no longer needs a per-org OpenRouter key, so
				// enabling it is unconditional.
				const nextEnabled =
					request.enabled === undefined ? (existing?.enabled ?? false) : request.enabled

				const next = {
					enabled: nextEnabled,
					maxRunsPerDay: request.maxRunsPerDay ?? existing?.maxRunsPerDay ?? 20,
					updatedAt: new Date(nowMs),
					updatedBy: userId,
				}
				yield* dbExecute((db) =>
					db
						.insert(aiTriageSettings)
						.values({ orgId, ...next })
						.onConflictDoUpdate({ target: aiTriageSettings.orgId, set: next }),
				)
				return settingsToDocument(yield* loadSettingsRow(orgId))
			})

			const listRuns: AiTriageServiceShape["listRuns"] = Effect.fn("AiTriageService.listRuns")(
				function* (orgId, opts) {
					yield* Effect.annotateCurrentSpan({ orgId })
					const conditions = [
						eq(aiTriageRuns.orgId, orgId),
						opts.issueId ? eq(aiTriageRuns.issueId, opts.issueId) : undefined,
						opts.incidentId ? eq(aiTriageRuns.incidentId, opts.incidentId) : undefined,
						opts.incidentKind ? eq(aiTriageRuns.incidentKind, opts.incidentKind) : undefined,
					].filter((c): c is NonNullable<typeof c> => c !== undefined)
					const rows = yield* dbExecute((db) =>
						db
							.select()
							.from(aiTriageRuns)
							.where(and(...conditions))
							.orderBy(desc(aiTriageRuns.createdAt))
							.limit(opts.limit ?? 20),
					)
					return new AiTriageRunsListResponse({ runs: rows.map(runToDocument) })
				},
			)

			/**
			 * Build the prompt context blob for a manual run from the incident rows.
			 * The automatic path (ErrorsService / AnomalyDetectionService) builds
			 * richer context inline at incident-open time.
			 */
			const buildContext = Effect.fn("AiTriageService.buildContext")(function* (
				orgId: OrgId,
				request: AiTriageRunCreateRequest,
			) {
				if (request.incidentKind === "anomaly") {
					const incidentId = Option.getOrUndefined(decodeAnomalyIncidentId(request.incidentId))
					const rows = incidentId
						? yield* dbExecute((db) =>
								db
									.select()
									.from(anomalyIncidents)
									.where(
										and(
											eq(anomalyIncidents.orgId, orgId),
											eq(anomalyIncidents.id, incidentId),
										),
									)
									.limit(1),
							)
						: []
					const incident = rows[0]
					if (!incident) {
						return yield* Effect.fail(
							new AiTriageNotFoundError({
								message: `No such anomaly incident: '${request.incidentId}'`,
							}),
						)
					}
					return {
						issueId: undefined as ErrorIssueId | undefined,
						context: {
							kind: "anomaly",
							signalType: incident.signalType,
							serviceName: incident.serviceName,
							deploymentEnv: incident.deploymentEnv,
							fingerprintHash: incident.fingerprintHash,
							severity: incident.severity,
							openedValue: incident.openedValue,
							baselineMedian: incident.baselineMedian,
							baselineSigma: incident.baselineSigma,
							thresholdValue: incident.thresholdValue,
							firstTriggeredAt: incident.firstTriggeredAt.toISOString(),
							lastTriggeredAt: incident.lastTriggeredAt.toISOString(),
							status: incident.status,
						},
					}
				}

				if (request.incidentKind === "alert") {
					const incidentId = Option.getOrUndefined(decodeAlertIncidentId(request.incidentId))
					const rows = incidentId
						? yield* dbExecute((db) =>
								db
									.select()
									.from(alertIncidents)
									.where(
										and(
											eq(alertIncidents.orgId, orgId),
											eq(alertIncidents.id, incidentId),
										),
									)
									.limit(1),
							)
						: []
					const incident = rows[0]
					if (!incident) {
						return yield* Effect.fail(
							new AiTriageNotFoundError({
								message: `No such alert incident: '${request.incidentId}'`,
							}),
						)
					}
					const ruleRows = yield* dbExecute((db) =>
						db
							.select()
							.from(alertRules)
							.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, incident.ruleId)))
							.limit(1),
					)
					const rule = ruleRows[0]
					return {
						issueId: incident.errorIssueId ?? undefined,
						context: {
							kind: "alert",
							ruleName: incident.ruleName,
							signalType: incident.signalType,
							comparator: incident.comparator,
							threshold: incident.threshold,
							thresholdUpper: incident.thresholdUpper,
							groupKey: incident.groupKey,
							observedValue: incident.lastObservedValue,
							sampleCount: incident.lastSampleCount,
							windowMinutes: rule?.windowMinutes,
							serviceNames: rule?.serviceNamesJson?.join(", "),
							severity: incident.severity,
							status: incident.status,
							firstTriggeredAt: incident.firstTriggeredAt.toISOString(),
							lastTriggeredAt: incident.lastTriggeredAt.toISOString(),
						},
					}
				}

				const errorIncidentId = Option.getOrUndefined(decodeErrorIncidentId(request.incidentId))
				const incidentRows = errorIncidentId
					? yield* dbExecute((db) =>
							db
								.select()
								.from(errorIncidents)
								.where(
									and(
										eq(errorIncidents.orgId, orgId),
										eq(errorIncidents.id, errorIncidentId),
									),
								)
								.limit(1),
						)
					: []
				const incident = incidentRows[0]
				if (!incident) {
					return yield* Effect.fail(
						new AiTriageNotFoundError({
							message: `No such error incident: '${request.incidentId}'`,
						}),
					)
				}
				const issueRows = yield* dbExecute((db) =>
					db
						.select()
						.from(errorIssues)
						.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, incident.issueId)))
						.limit(1),
				)
				const issue = issueRows[0]
				return {
					issueId: incident.issueId,
					context: {
						kind: "error",
						reason: incident.reason,
						serviceName: issue?.serviceName,
						exceptionType: issue?.exceptionType,
						exceptionMessage: issue?.exceptionMessage,
						errorLabel: issue?.errorLabel,
						topFrame: issue?.topFrame,
						fingerprintHash: issue?.fingerprintHash,
						occurrenceCount: incident.occurrenceCount,
						firstTriggeredAt: incident.firstTriggeredAt.toISOString(),
						lastTriggeredAt: incident.lastTriggeredAt.toISOString(),
						issueId: incident.issueId,
					},
				}
			})

			const createRun: AiTriageServiceShape["createRun"] = Effect.fn("AiTriageService.createRun")(
				function* (orgId, request) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						incidentKind: request.incidentKind,
						incidentId: request.incidentId,
					})
					const nowMs = yield* Clock.currentTimeMillis

					// No OpenRouter-key gate since the Flue cutover — triage runs on
					// chat-flue (Cloudflare Workers AI).
					const { issueId, context } = yield* buildContext(orgId, request)

					// Manual re-run: replace any prior run for this incident.
					yield* dbExecute((db) =>
						db
							.delete(aiTriageRuns)
							.where(
								and(
									eq(aiTriageRuns.orgId, orgId),
									eq(aiTriageRuns.incidentKind, request.incidentKind),
									eq(aiTriageRuns.incidentId, request.incidentId),
								),
							),
					)

					const runId = newAiTriageRunId()
					yield* dbExecute((db) =>
						db.insert(aiTriageRuns).values({
							id: runId,
							orgId,
							incidentKind: request.incidentKind,
							incidentId: request.incidentId,
							issueId: request.issueId ?? issueId ?? null,
							status: "queued",
							contextJson: context,
							createdAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						}),
					)

					const binding = Option.match(workerEnv, {
						onNone: () => undefined,
						onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
					})
					if (!isAiTriageWorkflowBinding(binding)) {
						yield* Effect.logWarning(
							"AI triage workflow binding unavailable; marking run failed",
						).pipe(Effect.annotateLogs({ orgId, runId }))
						yield* dbExecute((db) =>
							db
								.update(aiTriageRuns)
								.set({
									status: "failed",
									error: "workflow_binding_unavailable",
									updatedAt: new Date(nowMs),
								})
								.where(eq(aiTriageRuns.id, runId)),
						)
					} else {
						// Mirror the automatic enqueue path: a create failure must mark the
						// run failed, or the row stays "queued" and its dedupe index blocks
						// all future triage for this incident.
						yield* Effect.tryPromise({
							try: () =>
								binding.create({
									id: runId,
									params: {
										orgId,
										incidentKind: request.incidentKind,
										incidentId: request.incidentId,
										issueId: request.issueId ?? issueId,
										runId,
									},
								}),
							catch: (error) => {
								const message = `Failed to start AI triage workflow: ${error instanceof Error ? error.message : String(error)}`
								const cause = describeCause(error)
								return cause === undefined
									? new AiTriagePersistenceError({ message })
									: new AiTriagePersistenceError({ message, cause })
							},
						}).pipe(
							Effect.tapError((error) =>
								dbExecute((db) =>
									db
										.update(aiTriageRuns)
										.set({
											status: "failed",
											error: `workflow_create_failed: ${error.message}`,
											updatedAt: new Date(nowMs),
										})
										.where(eq(aiTriageRuns.id, runId)),
								).pipe(Effect.ignore),
							),
						)
					}

					const rows = yield* dbExecute((db) =>
						db.select().from(aiTriageRuns).where(eq(aiTriageRuns.id, runId)).limit(1),
					)
					const row = rows[0]
					if (!row) {
						return yield* Effect.fail(
							new AiTriagePersistenceError({ message: "Triage run row missing after insert" }),
						)
					}
					return runToDocument(row)
				},
			)

			return {
				getSettings,
				updateSettings,
				listRuns,
				createRun,
			} satisfies AiTriageServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
