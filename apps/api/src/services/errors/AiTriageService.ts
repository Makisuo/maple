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
import { Database, DatabaseError, type DatabaseClient } from "@/platform/DatabaseLive"
import { DEFAULT_MAX_PASSES_PER_DAY, DEFAULT_MAX_RUNS_PER_DAY } from "@/services/errors/investigation-quota"

const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)

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
			: "Investigation settings persistence failure"
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
}

export class AiTriageService extends Context.Service<AiTriageService, AiTriageServiceShape>()(
	"@maple/api/services/AiTriageService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(makePersistenceError))

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

			return { getSettings, updateSettings } satisfies AiTriageServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
