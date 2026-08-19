import {
	AiTriagePersistenceError,
	AiTriageSettingsDocument,
	type AiTriageSettingsUpdateRequest,
	AiTriageUsage,
	AiTriageValidationError,
	IsoDateTimeString,
	type IssueSeverity,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { aiTriageSettings, type AiTriageSettingsRow } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { widthFor } from "@/workflows/plan-normalize"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import {
	DEFAULT_MAX_PASSES_PER_DAY,
	DEFAULT_MAX_RUNS_PER_DAY,
	evaluateInvestigationQuota,
	type InvestigationUsage,
	selectInvestigationUsage,
} from "@/services/errors/investigation-quota"

const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)

const makePersistenceError = makePersistenceErrorMapper(
	AiTriagePersistenceError,
	"Investigation settings persistence failure",
)

export interface AiTriageServiceApi {
	readonly getSettings: (orgId: OrgId) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError>
	readonly updateSettings: (
		orgId: OrgId,
		userId: UserId,
		request: AiTriageSettingsUpdateRequest,
	) => Effect.Effect<AiTriageSettingsDocument, AiTriagePersistenceError | AiTriageValidationError>
}

export class AiTriageService extends Context.Service<AiTriageService, AiTriageServiceApi>()(
	"@maple/api/services/AiTriageService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const dbExecute = makeDbExecute(database, "AiTriageService", makePersistenceError)

			const loadSettingsRow = Effect.fn("AiTriageService.loadSettingsRow")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
				)
				return rows[0]
			})

			const loadUsage = Effect.fn("AiTriageService.loadUsage")(function* (orgId: OrgId, nowMs: number) {
				return yield* dbExecute((db) => selectInvestigationUsage(db, orgId, nowMs))
			})

			/**
			 * What a start of this severity would actually reserve.
			 *
			 * Derived from `widthFor` rather than pinned to a constant, because the
			 * enqueue path judges a start against its *reservation* (`width + 2`), not
			 * against what the run eventually settles at. Probing with the settled
			 * cost reported triage as healthy across the last two passes of the
			 * budget — exactly the window in which starts were already being refused.
			 */
			const probeCost = (severity: IssueSeverity) => widthFor(severity, "error") + 2

			/**
			 * Pause state is asked of the same verdict the enqueue path uses, twice:
			 * once as an ordinary incident and once as a critical. One probe cannot
			 * answer both questions — with a reserve configured, a medium-severity
			 * probe reports `passes_reserved` whether the reserve is untouched or long
			 * gone, so it can never say whether criticals are still starting.
			 */
			const settingsToDocument = (
				row: AiTriageSettingsRow | undefined,
				usage: InvestigationUsage,
				nowMs: number,
			): AiTriageSettingsDocument => {
				const probe = (severity: IssueSeverity) =>
					evaluateInvestigationQuota({
						usage,
						limits: row,
						passCount: probeCost(severity),
						nowMs,
						severity,
					})
				const ordinary = probe("medium")
				const priority = probe("critical")
				// The runs ceiling is checked before any pass arithmetic and has no
				// reserve, so it refuses both — reporting it as a pass problem would
				// send the reader to raise a number that was never the constraint.
				const paused = ordinary.kind === "exceeded" ? ordinary : null
				return new AiTriageSettingsDocument({
					enabled: row?.enabled ?? false,
					maxRunsPerDay: row?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
					maxPassesPerDay: row?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY,
					usage: new AiTriageUsage({ runs: usage.runs, passes: usage.passes }),
					ordinaryPaused: ordinary.kind === "exceeded",
					priorityPaused: priority.kind === "exceeded",
					pausedDimension: paused?.dimension ?? null,
					resumesAt:
						paused === null ? null : decodeIsoSync(new Date(paused.retryableAtMs).toISOString()),
					updatedAt: row?.updatedAt ? decodeIsoSync(row.updatedAt.toISOString()) : null,
					updatedBy: row?.updatedBy ?? null,
				})
			}

			const getSettings: AiTriageServiceApi["getSettings"] = Effect.fn("AiTriageService.getSettings")(
				function* (orgId) {
					yield* Effect.annotateCurrentSpan({ orgId })
					const nowMs = yield* Clock.currentTimeMillis
					const row = yield* loadSettingsRow(orgId)
					return settingsToDocument(row, yield* loadUsage(orgId, nowMs), nowMs)
				},
			)

			const updateSettings: AiTriageServiceApi["updateSettings"] = Effect.fn(
				"AiTriageService.updateSettings",
			)(function* (orgId, userId, request) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const nowMs = yield* Clock.currentTimeMillis
				const existing = yield* loadSettingsRow(orgId)
				const next = {
					enabled: request.enabled ?? existing?.enabled ?? false,
					maxRunsPerDay:
						request.maxRunsPerDay ?? existing?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
					maxPassesPerDay:
						request.maxPassesPerDay ?? existing?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY,
					updatedAt: new Date(nowMs),
					updatedBy: userId,
				}
				yield* dbExecute((db) =>
					db
						.insert(aiTriageSettings)
						.values({ orgId, ...next })
						.onConflictDoUpdate({ target: aiTriageSettings.orgId, set: next }),
				)
				return settingsToDocument(
					yield* loadSettingsRow(orgId),
					yield* loadUsage(orgId, nowMs),
					nowMs,
				)
			})

			return { getSettings, updateSettings } satisfies AiTriageServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
