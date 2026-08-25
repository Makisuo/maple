import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ActorId as ActorIdSchema,
	ActorNotFoundError,
	ActorsListResponse,
	ErrorPersistenceError,
	ErrorValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { actors, type ActorInsert, type ActorRow } from "@maple/db"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { isReservedAgentName, SYSTEM_ERRORS_AGENT_NAME } from "@/services/auth/system-actors"
import { makeErrorDatabaseExecute } from "./error-persistence"
import { summarizeCause } from "@/platform/describe-cause"

const decodeActorIdSync = Schema.decodeUnknownSync(ActorIdSchema)
const decodeActorDateTimeSync = Schema.decodeUnknownSync(ActorDocument.fields.lastActiveAt)
const decodeStoredJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

const parseCapabilities = (raw: unknown): ReadonlyArray<string> =>
	Option.getOrElse(decodeStoredJsonArray(raw), (): ReadonlyArray<unknown> => []).filter(
		(value): value is string => typeof value === "string",
	)

export const actorRowToDocument = (row: ActorRow): ActorDocument =>
	new ActorDocument({
		id: row.id,
		type: row.type,
		userId: row.userId ?? null,
		agentName: row.agentName ?? null,
		model: row.model ?? null,
		capabilities: parseCapabilities(row.capabilitiesJson),
		lastActiveAt:
			row.lastActiveAt == null ? null : decodeActorDateTimeSync(row.lastActiveAt.toISOString()),
	})

export interface ErrorActorsPublicApi {
	readonly registerAgent: (
		orgId: OrgId,
		byUserId: UserId,
		request: {
			readonly name: string
			readonly model?: string
			readonly capabilities?: ReadonlyArray<string>
		},
	) => Effect.Effect<ActorDocument, ErrorPersistenceError | ErrorValidationError>
	readonly listAgents: (orgId: OrgId) => Effect.Effect<ActorsListResponse, ErrorPersistenceError>
	readonly lookupActor: (
		orgId: OrgId,
		actorId: ActorId,
	) => Effect.Effect<ActorDocument, ErrorPersistenceError | ActorNotFoundError>
	readonly ensureUserActor: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<ActorDocument, ErrorPersistenceError>
}

export interface ErrorActorsServiceApi extends ErrorActorsPublicApi {
	/** Existence check used by assignment without changing its span topology. */
	readonly actorExists: (orgId: OrgId, actorId: ActorId) => Effect.Effect<boolean, ErrorPersistenceError>
	/** Compatibility-facade support for the scheduled error workflow. */
	readonly ensureSystemActor: (orgId: OrgId) => Effect.Effect<ActorDocument, ErrorPersistenceError>
	/**
	 * Idempotent get-or-create of an agent actor by name. Unlike
	 * `registerAgent` this reuses an existing row instead of failing, and it
	 * does NOT guard reserved names — callers passing externally supplied
	 * names must validate with `isReservedAgentName` first.
	 */
	readonly ensureAgentActor: (
		orgId: OrgId,
		agentName: string,
		opts?: {
			readonly createdBy?: UserId
			readonly capabilities?: ReadonlyArray<string>
		},
	) => Effect.Effect<ActorDocument, ErrorPersistenceError>
	/** Best-effort activity bookkeeping for issue mutations. */
	readonly touchActor: (orgId: OrgId, actorId: ActorId, timestamp: number) => Effect.Effect<void>
	/** Batch hydration used by issue and event response mapping. */
	readonly collectActorDocs: (
		orgId: OrgId,
		actorIds: ReadonlyArray<ActorId | null>,
	) => Effect.Effect<Map<ActorId, ActorDocument>, ErrorPersistenceError>
}

const make: Effect.Effect<ErrorActorsServiceApi, never, Database> = Effect.gen(function* () {
	const database = yield* Database
	const dbExecute = makeErrorDatabaseExecute(database, "ErrorActorsService")
	const newActorId = () => decodeActorIdSync(randomUUID())

	const selectActorRow = (orgId: OrgId, actorId: ActorId) =>
		dbExecute((db) =>
			db
				.select()
				.from(actors)
				.where(and(eq(actors.orgId, orgId), eq(actors.id, actorId)))
				.limit(1),
		).pipe(Effect.map((rows) => rows[0] ?? null))

	const lookupActor: ErrorActorsServiceApi["lookupActor"] = Effect.fn("ErrorsService.lookupActor")(
		function* (orgId, actorId) {
			const row = yield* selectActorRow(orgId, actorId)
			if (!row) {
				return yield* Effect.fail(
					new ActorNotFoundError({
						message: `Actor '${actorId}' not found`,
						actorId,
					}),
				)
			}
			return actorRowToDocument(row)
		},
	)

	const actorExists: ErrorActorsServiceApi["actorExists"] = (orgId, actorId) =>
		selectActorRow(orgId, actorId).pipe(Effect.map((row) => row !== null))

	// Best-effort: a failed lastActiveAt bump must never fail the calling
	// mutation, but persistent failures should still be diagnosable.
	const touchActor: ErrorActorsServiceApi["touchActor"] = (orgId, actorId, timestamp) =>
		dbExecute((db) =>
			db
				.update(actors)
				.set({ lastActiveAt: msToDate(timestamp) })
				.where(and(eq(actors.orgId, orgId), eq(actors.id, actorId))),
		).pipe(
			Effect.tapCause((cause) =>
				Effect.logWarning("ErrorsService.touchActor failed to update lastActiveAt").pipe(
					Effect.annotateLogs({ orgId, actorId, cause: summarizeCause(cause) }),
				),
			),
			Effect.ignore,
		)

	const ensureUserActor: ErrorActorsServiceApi["ensureUserActor"] = Effect.fn(
		"ErrorsService.ensureUserActor",
	)(function* (orgId, userId) {
		const existing = yield* dbExecute((db) =>
			db
				.select()
				.from(actors)
				.where(and(eq(actors.orgId, orgId), eq(actors.type, "user"), eq(actors.userId, userId)))
				.limit(1),
		)
		if (existing[0]) return actorRowToDocument(existing[0])

		const timestamp = yield* Clock.currentTimeMillis
		const id = newActorId()
		const insert: ActorInsert = {
			id,
			orgId,
			type: "user",
			userId,
			agentName: null,
			model: null,
			capabilitiesJson: [],
			createdBy: userId,
			createdAt: msToDate(timestamp),
			lastActiveAt: msToDate(timestamp),
		}
		yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())
		const after = yield* dbExecute((db) =>
			db
				.select()
				.from(actors)
				.where(and(eq(actors.orgId, orgId), eq(actors.type, "user"), eq(actors.userId, userId)))
				.limit(1),
		)
		const row = after[0]
		if (!row) {
			return yield* Effect.fail(
				new ErrorPersistenceError({ message: "Failed to ensure user actor row" }),
			)
		}
		return actorRowToDocument(row)
	})

	const ensureAgentActor: ErrorActorsServiceApi["ensureAgentActor"] = Effect.fn(
		"ErrorsService.ensureAgentActor",
	)(function* (orgId, agentName, opts) {
		const selectByName = dbExecute((db) =>
			db
				.select()
				.from(actors)
				.where(
					and(eq(actors.orgId, orgId), eq(actors.type, "agent"), eq(actors.agentName, agentName)),
				)
				.limit(1),
		)
		const existing = yield* selectByName
		if (existing[0]) return actorRowToDocument(existing[0])

		const timestamp = yield* Clock.currentTimeMillis
		const id = newActorId()
		const insert: ActorInsert = {
			id,
			orgId,
			type: "agent",
			userId: null,
			agentName,
			model: null,
			capabilitiesJson: opts?.capabilities ?? [],
			createdBy: opts?.createdBy ?? null,
			createdAt: msToDate(timestamp),
			lastActiveAt: msToDate(timestamp),
		}
		yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())
		const after = yield* selectByName
		const row = after[0]
		if (!row) {
			return yield* Effect.fail(
				new ErrorPersistenceError({ message: `Failed to ensure agent actor row '${agentName}'` }),
			)
		}
		return actorRowToDocument(row)
	})

	const ensureSystemActor: ErrorActorsServiceApi["ensureSystemActor"] = (orgId) =>
		ensureAgentActor(orgId, SYSTEM_ERRORS_AGENT_NAME, { capabilities: ["system", "auto-triage"] })

	const registerAgent: ErrorActorsServiceApi["registerAgent"] = Effect.fn("ErrorsService.registerAgent")(
		function* (orgId, byUserId, request) {
			const name = request.name.trim()
			if (name.length === 0) {
				return yield* Effect.fail(
					new ErrorValidationError({
						message: "Agent name must not be empty",
						details: [request.name],
					}),
				)
			}
			if (isReservedAgentName(name)) {
				return yield* Effect.fail(
					new ErrorValidationError({
						message: `Agent name '${name}' is reserved`,
						details: [name],
					}),
				)
			}

			const timestamp = yield* Clock.currentTimeMillis
			const id = newActorId()
			const capabilities = request.capabilities ?? []
			const insert: ActorInsert = {
				id,
				orgId,
				type: "agent",
				userId: null,
				agentName: name,
				model: request.model ?? null,
				capabilitiesJson: capabilities,
				createdBy: byUserId,
				createdAt: msToDate(timestamp),
				lastActiveAt: msToDate(timestamp),
			}

			yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "agent"), eq(actors.agentName, name)))
					.limit(1),
			)
			const row = rows[0]
			if (!row) {
				return yield* Effect.fail(new ErrorPersistenceError({ message: "Failed to register agent" }))
			}
			if (row.id !== id) {
				return yield* Effect.fail(
					new ErrorValidationError({
						message: `An agent named '${name}' already exists for this org`,
						details: [name],
					}),
				)
			}
			return actorRowToDocument(row)
		},
	)

	const listAgents: ErrorActorsServiceApi["listAgents"] = Effect.fn("ErrorsService.listAgents")(
		function* (orgId) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "agent")))
					.orderBy(desc(actors.createdAt)),
			)
			return new ActorsListResponse({ actors: rows.map(actorRowToDocument) })
		},
	)

	const collectActorDocs: ErrorActorsServiceApi["collectActorDocs"] = (orgId, actorIds) => {
		const filtered = Array.from(new Set(actorIds.filter((value): value is ActorId => value != null)))
		if (filtered.length === 0) return Effect.succeed(new Map<ActorId, ActorDocument>())
		return dbExecute((db) =>
			db
				.select()
				.from(actors)
				.where(and(eq(actors.orgId, orgId), inArray(actors.id, filtered))),
		).pipe(
			Effect.map((rows) => {
				const map = new Map<ActorId, ActorDocument>()
				for (const row of rows) map.set(row.id, actorRowToDocument(row))
				return map
			}),
		)
	}

	return ErrorActorsService.of({
		registerAgent,
		listAgents,
		lookupActor,
		actorExists,
		ensureUserActor,
		ensureSystemActor,
		ensureAgentActor,
		touchActor,
		collectActorDocs,
	})
})

export class ErrorActorsService extends Context.Service<ErrorActorsService, ErrorActorsServiceApi>()(
	"@maple/api/services/errors/ErrorActorsService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
