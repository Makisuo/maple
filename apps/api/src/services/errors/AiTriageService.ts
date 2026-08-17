import {
	AiTriagePersistenceError,
	AiTriageSettingsDocument,
	type AiTriageSettingsUpdateRequest,
	AiTriageValidationError,
	IsoDateTimeString,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { aiTriageSettings, type AiTriageSettingsRow } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import { DEFAULT_MAX_PASSES_PER_DAY, DEFAULT_MAX_RUNS_PER_DAY } from "@/services/errors/investigation-quota"

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

			const settingsToDocument = (row: AiTriageSettingsRow | undefined): AiTriageSettingsDocument =>
				new AiTriageSettingsDocument({
					enabled: row?.enabled ?? false,
					maxRunsPerDay: row?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
					maxPassesPerDay: row?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY,
					updatedAt: row?.updatedAt ? decodeIsoSync(row.updatedAt.toISOString()) : null,
					updatedBy: row?.updatedBy ?? null,
				})

			const getSettings: AiTriageServiceApi["getSettings"] = Effect.fn("AiTriageService.getSettings")(
				function* (orgId) {
					yield* Effect.annotateCurrentSpan({ orgId })
					return settingsToDocument(yield* loadSettingsRow(orgId))
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
				return settingsToDocument(yield* loadSettingsRow(orgId))
			})

			return { getSettings, updateSettings } satisfies AiTriageServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
