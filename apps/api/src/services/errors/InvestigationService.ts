import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	AiTriageResult,
	type InvestigationConfidence,
	InvestigationCreateRequest,
	InvestigationDocument,
	InvestigationFanout,
	InvestigationLensRun,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationQuotaError,
	InvestigationRejectedError,
	InvestigationSnapshotFact,
	InvestigationSubjectSnapshot,
	InvestigationUnavailableError,
	InvestigationValidator,
	InvestigationsListResponse,
	type InvestigationStatus,
	InvestigationSubject,
	type OrgId,
	type SubmitDiagnosisRequest,
	type UserId,
} from "@maple/domain/http"
import { ErrorIssueId, InvestigationId, UserId as UserIdSchema } from "@maple/domain/primitives"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import { encodeChatTurnTenant } from "@maple/domain/chat-session"
import { chatSessionStub } from "@/chat/session"
import type { TenantContext } from "@/services/auth/tenant-context"
import {
	aiTriageSettings,
	investigationLensRuns,
	investigations,
	type InvestigationLensRunRow,
	type InvestigationRow,
} from "@maple/db"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import { Cause, Clock, Context, Data, Duration, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { trackTokenUsage } from "@/services/billing/autumn-tracker"
import { applyDiagnosisWrites } from "@/services/errors/apply-diagnosis"
import { AUTONOMOUS_KICKOFF_LEAD, buildIncidentContextMessage } from "@/workflows/incident-context"
import {
	routeInvestigation,
	type InvestigationRoute,
} from "@/services/errors/investigation-route"
import { evaluateInvestigationQuota, selectInvestigationUsage } from "@/services/errors/investigation-quota"
import {
	STALE_BUDGETS,
	isInvestigationStale,
	staleTimeoutMessage,
} from "@/services/errors/investigation-stale"
import { Database, DatabaseError, type DatabaseClient } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"

/**
 * Cloudflare Workflow binding that runs a fan-out. Named here rather than read
 * off `Env` because the binding is only present inside a Worker isolate — the
 * same reason `CHAT_SESSION` is resolved this way.
 */
export const FANOUT_WORKFLOW_BINDING = "INVESTIGATION_FANOUT_WORKFLOW"

class FanoutStartError extends Data.TaggedError("FanoutStartError")<{ readonly cause: string }> {}

interface FanoutWorkflowBinding {
	readonly create: (options: { id: string; params: unknown }) => Promise<{ id: string }>
	readonly get?: (id: string) => Promise<{ terminate: () => Promise<unknown> }>
}

const decodeIdSync = Schema.decodeUnknownSync(InvestigationId)
const decodeSubjectSync = Schema.decodeUnknownSync(InvestigationSubject)
const decodeSnapshotOption = Schema.decodeUnknownOption(InvestigationSubjectSnapshot)
const decodeResultOption = Schema.decodeUnknownOption(AiTriageResult)
const decodeIsoSync = Schema.decodeUnknownSync(InvestigationDocument.fields.createdAt)

export const newInvestigationId = () => decodeIdSync(randomUUID())

/**
 * Milliseconds are what the column stores — seconds are a display unit, and the
 * boards render one decimal. Rounding here rather than in five components keeps
 * two lanes of the same run from disagreeing by a tenth.
 */
const elapsedSeconds = (ms: number | null): number | null =>
	ms === null ? null : Math.round((ms / 1000) * 10) / 10

const lensRowToDocument = (row: InvestigationLensRunRow): InvestigationLensRun =>
	new InvestigationLensRun({
		lensId: row.lensId,
		status: row.status,
		verdict: row.verdict,
		claim: row.claim ?? null,
		reason: row.reason ?? null,
		progressNote: row.progressNote ?? null,
		confidence: row.confidence ?? null,
		toolCount: row.toolCount,
		elapsedSeconds: elapsedSeconds(row.elapsedMs ?? null),
		// Null on lanes written before the planner. The client falls back to the seed
		// catalogue for those, so a null here is a real "no copy", not a gap to fill
		// with the id.
		name: row.lensName ?? null,
		question: row.lensQuestion ?? null,
		priority: row.priority ?? null,
		deadlineHit: row.deadlineHit,
	})

/**
 * The validator lane, derived rather than stored: its status is a function of
 * how far the run got, and deriving it is what stops the rail from claiming a
 * ranking that the lens rows contradict.
 *
 * Null on the single-pass path — there were never rivals to rank.
 */
const validatorFor = (
	row: InvestigationRow,
	lensRows: ReadonlyArray<InvestigationLensRunRow>,
): InvestigationValidator | null => {
	if (lensRows.length === 0) return null
	const elapsed = elapsedSeconds(row.validatorElapsedMs ?? null)
	if (row.fanoutState === "ranked" || row.fanoutState === "superseded") {
		const promoted = lensRows.filter((lens) => lens.verdict === "promoted").length
		const merged = lensRows.filter((lens) => lens.verdict === "merged").length
		const ruledOut = lensRows.filter((lens) => lens.verdict === "ruled_out").length
		return new InvestigationValidator({
			status: "ranked",
			note: row.validatorNote ?? `${promoted} promoted · ${merged} merged · ${ruledOut} ruled out`,
			elapsedSeconds: elapsed,
		})
	}
	if (row.fanoutState === "rejected_all") {
		return new InvestigationValidator({
			status: "rejected_all",
			note:
				row.validatorNote ??
				"No candidate survived: each was contradicted by at least one other lens",
			elapsedSeconds: elapsed,
		})
	}
	const reported = lensRows.filter((lens) => lens.status === "reported").length
	return new InvestigationValidator({
		status: "blocked",
		note:
			row.validatorNote ??
			`Starts once all ${lensRows.length} lenses report — then ranks the candidates and promotes one (${reported} in)`,
		elapsedSeconds: elapsed,
	})
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

/** Identity an autonomous investigation turn runs as — the same one the internal MCP RPC uses. */
const internalServiceUserId = Schema.decodeUnknownSync(UserIdSchema)("internal-service")

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

			/**
			 * Lens rows arrive as a parameter rather than being fetched here: this runs
			 * once per row from `listInvestigations`, so a query inside it is an N+1 on
			 * every page load. The callers batch by `investigationId IN (…)`.
			 */
			const rowToDocument = Effect.fnUntraced(function* (
				row: InvestigationRow,
				lensRows: ReadonlyArray<InvestigationLensRunRow> = [],
			) {
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
					startedAt: row.startedAt ? iso(row.startedAt) : null,
					diagnosedAt: row.diagnosedAt ? iso(row.diagnosedAt) : null,
					updatedAt: iso(row.updatedAt),
					lensRuns: lensRows.map(lensRowToDocument),
					validator: validatorFor(row, lensRows),
					fanout: new InvestigationFanout({ state: row.fanoutState, size: row.fanoutSize }),
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

			/**
			 * Lens lanes for a set of investigations, in dispatch order. Ordering is a
			 * contract — `LENS_DISPATCH_ORDER` decides which lenses a narrow run gets —
			 * so it belongs in SQL rather than in each of the five components that
			 * render a lane.
			 *
			 * Skips the query entirely when nothing in the set fanned out, which is the
			 * common case on a list page.
			 */
			const loadLensRows = (orgId: OrgId, rows: ReadonlyArray<InvestigationRow>) => {
				const fanned = rows.filter((row) => row.fanoutState !== "none")
				if (fanned.length === 0) return Effect.succeed([] as ReadonlyArray<InvestigationLensRunRow>)
				const ids = fanned.map((row) => row.id)
				const attemptById = new Map(fanned.map((row) => [row.id as string, row.fanoutAttempt]))
				return dbExecute((db) =>
					db
						.select()
						.from(investigationLensRuns)
						.where(
							and(
								eq(investigationLensRuns.orgId, orgId),
								inArray(investigationLensRuns.investigationId, ids),
							),
						)
						.orderBy(investigationLensRuns.investigationId, investigationLensRuns.ordinal),
				).pipe(
					// Only the attempt the row is on. A terminated instance can still be
					// draining, and its lanes must not appear beside the retry's.
					Effect.map((lanes) =>
						lanes.filter((lane) => lane.attempt === attemptById.get(lane.investigationId)),
					),
				)
			}

			/** `rowToDocument` for a single row, fetching its lanes if it has any. */
			const documentFor = Effect.fnUntraced(function* (orgId: OrgId, row: InvestigationRow) {
				const lensRows = yield* loadLensRows(orgId, [row])
				return yield* rowToDocument(row, lensRows)
			})

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

			/**
			 * A row still claiming to be investigating long after its autonomous pass
			 * should have submitted a diagnosis. Checked before sweeping so a read
			 * doesn't issue an UPDATE that would match nothing — the investigation
			 * detail page polls every 3s, which otherwise turns every read into a write.
			 */
			const isStale = (row: InvestigationRow, nowMs: number): boolean =>
				isInvestigationStale(row, nowMs)

			const failStaleInvestigations = Effect.fnUntraced(function* (orgId: OrgId, nowMs: number) {
				// Two budgets, applied as two statements: a healthy five-lens fan-out
				// legitimately outlives the single-pass timeout, and sweeping it on the
				// short budget would mark the row `failed` moments before the workflow
				// wrote a diagnosis onto it — leaving `diagnosed` next to a
				// `diagnosis_timeout` error and a failure card over a real finding.
				for (const [budget, states] of STALE_BUDGETS) {
					yield* dbExecute((db) =>
						db
							.update(investigations)
							.set({
								status: "failed",
								error: staleTimeoutMessage(budget),
								updatedAt: new Date(nowMs),
							})
							.where(
								and(
									eq(investigations.orgId, orgId),
									eq(investigations.status, "investigating"),
									inArray(investigations.fanoutState, states),
									lt(investigations.startedAt, new Date(nowMs - budget)),
								),
							),
					).pipe(Effect.asVoid)
				}
			})

			/**
			 * Settings drive two independent decisions: whether an automatic start is
			 * allowed at all, and whether the org has budget left. How an investigation
			 * *runs* is deliberately not among them — see `investigation-route.ts`.
			 */
			const loadSettings = (orgId: OrgId) =>
				dbExecute((db) =>
					db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
				).pipe(Effect.map((rows) => rows[0]))

			const ensureStartAllowed = Effect.fnUntraced(function* (
				orgId: OrgId,
				automatic: boolean,
				nowMs: number,
				/** Model passes this start will consume. A fan-out of five is six. */
				passCount: number,
			) {
				const settings = yield* loadSettings(orgId)
				if (automatic && (settings === undefined || !settings.enabled)) {
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "Automatic investigations are disabled for this organization.",
							reason: "automation_disabled",
							retryable: false,
						}),
					)
				}

				// Two ceilings counted in two different units, which is the whole point
				// of having two columns. Both the query and the verdict live in
				// `investigation-quota.ts` so the enqueue path cannot drift back into
				// comparing passes against the runs limit — see that module's header.
				const usage = yield* dbExecute((db) => selectInvestigationUsage(db, orgId, nowMs))
				const verdict = evaluateInvestigationQuota({
					usage,
					limits: settings,
					passCount,
					nowMs,
				})
				if (verdict.kind === "exceeded") {
					yield* Effect.annotateCurrentSpan({
						"maple.investigation.start_result": "quota_skipped",
						"maple.investigation.quota_dimension": verdict.dimension,
						"maple.investigation.quota_limit": verdict.limit,
					})
					return yield* Effect.fail(
						new InvestigationQuotaError({
							message:
								verdict.dimension === "runs"
									? `Daily investigation budget of ${verdict.limit} runs has been reached.`
									: `Daily investigation budget of ${verdict.limit} model passes has been reached.`,
							limit: verdict.limit,
							retryableAt: decodeIsoSync(new Date(verdict.retryableAtMs).toISOString()),
						}),
					)
				}
			})

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

			/**
			 * Kick off a fan-out run on the Cloudflare Workflow.
			 *
			 * Mirrors `sendAutonomousTurn`'s failure discipline exactly, because the
			 * caller cannot tell which path it took: a missing binding writes
			 * `agent_unavailable` onto the row and fails retryably, and a duplicate
			 * instance id (Cloudflare throws on collision) becomes `start_failed` —
			 * the same signal `beginTurn` returning `undefined` produces.
			 *
			 * The instance id carries the attempt so a restart can claim a fresh one;
			 * without it Cloudflare would reject every retry of a finished run.
			 */
			const startFanout = Effect.fnUntraced(function* (
				orgId: OrgId,
				doc: InvestigationDocument,
				route: Extract<InvestigationRoute, { kind: "planned" }>,
				attempt: number,
				nowMs: number,
			) {
				const env = Option.getOrUndefined(workerEnv)
				const binding = env?.[FANOUT_WORKFLOW_BINDING] as FanoutWorkflowBinding | undefined
				if (!binding || typeof binding.create !== "function") {
					yield* markStartFailed(
						orgId,
						doc.id,
						"agent_unavailable: the investigation fan-out workflow is not configured; retry",
						nowMs,
					)
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "The investigation fan-out workflow is not configured.",
							reason: "agent_unavailable",
							retryable: true,
						}),
					)
				}

				// Cloudflare rejects a colon in an instance id ("Workflow instance has
				// invalid id"), so the attempt is appended with a dash. Attempt 0 keeps
				// the bare investigation id, which is what gives a first start free
				// duplicate-detection against a live instance.
				const instanceId = attempt === 0 ? doc.id : `${doc.id}-a${attempt}`
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							fanoutState: "queued",
							// Provisional. The planner may return fewer hypotheses than the
							// ceiling, and the workflow's `plan` step corrects this — along with
							// the reservation — once the real width exists.
							fanoutSize: route.maxWidth,
							workflowInstanceId: instanceId,
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(investigations.orgId, orgId), eq(investigations.id, doc.id))),
				)

				// `Exit`, not `Effect.option`: the reason matters and used to be dropped
				// on the floor. An id collision means a live instance already owns this
				// investigation — a bug signal — while a network error means retry, and
				// both used to produce the same unlogged `start_failed`.
				const started = yield* Effect.exit(
					Effect.tryPromise({
						try: () =>
							binding.create({
								id: instanceId,
								params: {
									orgId,
									investigationId: doc.id,
									maxWidth: route.maxWidth,
									reservedPasses: route.reservedPasses,
									attempt,
								},
							}),
						catch: (cause) => new FanoutStartError({ cause: String(cause) }),
					}),
				)

				if (Exit.isFailure(started)) {
					yield* Effect.logWarning("Investigation fan-out could not be started").pipe(
						Effect.annotateLogs({
							orgId,
							investigationId: doc.id,
							instanceId,
							error: Cause.pretty(started.cause),
						}),
					)
					yield* markStartFailed(
						orgId,
						doc.id,
						"start_failed: the investigation fan-out could not be started; retry",
						nowMs,
					)
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "The investigation fan-out could not be started.",
							reason: "start_failed",
							retryable: true,
						}),
					)
				}

				yield* Effect.annotateCurrentSpan({
					"maple.investigation.id": doc.id,
					"maple.investigation.start_result": "fanout_started",
					"maple.investigation.fanout_max_width": route.maxWidth,
				})
			})

			/**
			 * Kick off the investigation's autonomous first turn.
			 *
			 * This used to POST `/agents/maple-chat/<orgId>:inv-<id>` back out over the `CHAT_FLUE`
			 * service binding with an internal service token — a Worker-to-Worker round trip that
			 * existed only because the agent lived in another Worker. The agent runs here now, so
			 * this claims the turn on the `ChatSession` Durable Object, which runs it inside itself
			 * — the same path `POST /api/chat/sessions/:id/messages` takes. Nothing here keeps the
			 * turn alive, which is what makes it survive: this call is often reached from a cron
			 * tick under `runScheduledEffect`, whose runtime is disposed as soon as the tick ends.
			 */
			const sendAutonomousTurn = Effect.fnUntraced(function* (
				orgId: OrgId,
				doc: InvestigationDocument,
				nowMs: number,
			) {
				const env = Option.getOrUndefined(workerEnv)
				const sessionId = `${orgId}:inv-${doc.id}`
				const stub = env ? chatSessionStub(env, sessionId) : undefined
				if (!stub) {
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

				// Fenced in full: this prompt is machine-written, and the transcript replays user
				// turns to everyone who opens the investigation. Unfenced it renders as a wall of
				// JSON attributed to whoever started the thread.
				const message = wrapChatContext(
					buildIncidentContextMessage(AUTONOMOUS_KICKOFF_LEAD, doc.subject, doc.snapshot),
					"",
				)

				const messageId = crypto.randomUUID()
				const claimed = yield* Effect.tryPromise({
					try: () =>
						stub.beginTurn({
							sessionId,
							messageId,
							text: message,
							tenant: encodeChatTurnTenant({
								orgId,
								userId: internalServiceUserId,
								roles: [],
								authMode: "self_hosted",
							}),
						}),
					catch: () => undefined,
				}).pipe(Effect.orElseSucceed(() => undefined))

				if (!claimed) {
					// Either a turn is already running for this session — which for an investigation
					// means the pass is already under way — or the Durable Object could not be
					// reached. Both are retryable: the caller's restart path sees the row next time.
					return yield* Effect.fail(
						new InvestigationUnavailableError({
							message: "This investigation already has a turn in flight.",
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
				const conditions = [
					eq(investigations.orgId, orgId),
					opts.issueId ? eq(investigations.issueId, opts.issueId) : undefined,
					opts.incidentKind ? eq(investigations.incidentKind, opts.incidentKind) : undefined,
					opts.incidentId ? eq(investigations.incidentId, opts.incidentId) : undefined,
					opts.status ? eq(investigations.status, opts.status) : undefined,
				].filter((c): c is NonNullable<typeof c> => c !== undefined)
				const selectPage = dbExecute((db) =>
					db
						.select()
						.from(investigations)
						.where(and(...conditions))
						.orderBy(desc(investigations.createdAt), desc(investigations.id))
						.limit(opts.limit ?? 50)
						.offset(opts.offset ?? 0),
				)
				let rows = yield* selectPage
				const nowMs = yield* Clock.currentTimeMillis
				// Sweep only when this page actually contains a timed-out run, then
				// re-read so the caller sees the corrected status.
				if (rows.some((row) => isStale(row, nowMs))) {
					yield* failStaleInvestigations(orgId, nowMs)
					rows = yield* selectPage
				}
				// One extra query for the whole page, and none at all when nothing on it
				// fanned out — the alternative is a query per row inside `rowToDocument`.
				const lensRows = yield* loadLensRows(orgId, rows)
				const byInvestigation = new Map<string, InvestigationLensRunRow[]>()
				for (const lens of lensRows) {
					const bucket = byInvestigation.get(lens.investigationId)
					if (bucket) bucket.push(lens)
					else byInvestigation.set(lens.investigationId, [lens])
				}
				return new InvestigationsListResponse({
					investigations: yield* Effect.forEach(rows, (row) =>
						rowToDocument(row, byInvestigation.get(row.id) ?? []),
					),
				})
			})

			const getInvestigation: InvestigationServiceShape["getInvestigation"] = Effect.fn(
				"InvestigationService.getInvestigation",
			)(function* (orgId, id) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.investigation.id": id })
				const row = yield* loadRow(orgId, id)
				if (!row) {
					return yield* Effect.fail(
						new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }),
					)
				}
				const nowMs = yield* Clock.currentTimeMillis
				if (!isStale(row, nowMs)) return yield* documentFor(orgId, row)
				// This run timed out: settle it, then report the corrected status.
				yield* failStaleInvestigations(orgId, nowMs)
				const settled = yield* loadRow(orgId, id)
				return yield* documentFor(orgId, settled ?? row)
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
					if (existing) return yield* documentFor(orgId, existing)
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
						if (winner) return yield* documentFor(orgId, winner)
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
				return yield* documentFor(orgId, row)
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
								return yield* documentFor(orgId, existing)
							}
						}
						// The route decides the cost, so it has to be known before the quota
						// check and before the claim increments the counter.
						const settings = yield* loadSettings(orgId)
						const route = routeInvestigation({
							subject: request.subject,
							snapshot: request.snapshot ?? null,
						})
						const reservedPasses = route.kind === "planned" ? route.reservedPasses : 1
						yield* ensureStartAllowed(orgId, options.automatic, nowMs, reservedPasses)
						const doc = yield* createInvestigation(orgId, userId, request)
						const claimed = yield* dbExecute((db) =>
							db
								.update(investigations)
								.set({
									startedAt: new Date(nowMs),
									// Counted in passes, not runs: a planned investigation costs
									// planner + N + validator model calls and must burn that many units
									// of the daily budget. Reserved high here and reconciled downward by
									// the workflow, because the real width is not knowable until the
									// planner has run.
									autonomousTurns: sql`${investigations.autonomousTurns} + ${reservedPasses}`,
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
						if (route.kind === "planned") yield* startFanout(orgId, doc, route, 0, nowMs)
						else yield* sendAutonomousTurn(orgId, doc, nowMs)
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
				const existing = yield* getInvestigation(orgId, id)
				const row = yield* loadRow(orgId, id)
				const settings = yield* loadSettings(orgId)
				const route = routeInvestigation({
					subject: existing.subject,
					snapshot: existing.snapshot,
				})
				const reservedPasses = route.kind === "planned" ? route.reservedPasses : 1
				yield* ensureStartAllowed(orgId, false, nowMs, reservedPasses)

				const attempt = (row?.fanoutAttempt ?? 0) + 1

				// Stop the run we are replacing. Without this the old instance keeps
				// going and can publish a diagnosis over a live run — a board assembled
				// from two interleaved attempts.
				if (row?.workflowInstanceId) {
					const env = Option.getOrUndefined(workerEnv)
					const binding = env?.[FANOUT_WORKFLOW_BINDING] as FanoutWorkflowBinding | undefined
					if (binding?.get) {
						yield* Effect.exit(
							Effect.tryPromise({
								try: async () => {
									const instance = await binding.get!(row.workflowInstanceId!)
									await instance.terminate()
								},
								catch: (cause) => new FanoutStartError({ cause: String(cause) }),
							}),
						).pipe(
							// An instance that already finished cannot be terminated, and
							// that is the common case — never fail a restart over it.
							Effect.tap((exit) =>
								Exit.isFailure(exit)
									? Effect.logDebug(
											"Previous fan-out instance could not be terminated",
										).pipe(
											Effect.annotateLogs({
												investigationId: id,
												instanceId: row.workflowInstanceId,
											}),
										)
									: Effect.void,
							),
						)
					}
				}
				// Prior lanes are NOT deleted. They are scoped by `attempt` and the reads
				// filter to the row's current one, so the retry starts clean while a
				// straggler from the terminated instance can only write into its own
				// attempt's rows — where nothing renders them.
				yield* dbExecute((db) =>
					db
						.update(investigations)
						.set({
							status: "investigating",
							error: null,
							startedAt: new Date(nowMs),
							autonomousTurns: sql`${investigations.autonomousTurns} + ${reservedPasses}`,
							fanoutState: "none",
							fanoutSize: route.kind === "planned" ? route.maxWidth : 1,
							fanoutAttempt: attempt,
							validatorNote: null,
							validatorElapsedMs: null,
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
				if (route.kind === "planned") yield* startFanout(orgId, restarting, route, attempt, nowMs)
				else yield* sendAutonomousTurn(orgId, restarting, nowMs)
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
				return yield* documentFor(orgId, row)
			})

			/**
			 * The `submit_diagnosis` write path. Persists the structured
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

				// Shared with the fan-out workflow's `persist` step so a diagnosis means
				// the same thing whichever path produced it — same status transition, same
				// severity application, same deterministically-keyed timeline event.
				yield* dbExecute((db) =>
					applyDiagnosisWrites(db, {
						orgId,
						investigationId: id,
						report: result,
						issueId: row.issueId ?? null,
						model: request.model ?? row.model ?? null,
						inputTokens: request.inputTokens ?? row.inputTokens ?? null,
						outputTokens: request.outputTokens ?? row.outputTokens ?? null,
						nowMs,
						// A human follow-up that re-diagnoses a ranked fan-out orphans the lens
						// verdicts: they explain a cause that is no longer on screen.
						...(row.fanoutState === "ranked" ? { fanoutState: "superseded" as const } : {}),
					}),
				)

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
				return yield* documentFor(orgId, updated ?? row)
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
