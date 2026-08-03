import { OAuthStatePersistenceError } from "@maple/domain/http"
import { oauthAuthStates, type OAuthAuthStateInsert, type OAuthAuthStateRow } from "@maple/db"
import { eq, lt } from "drizzle-orm"
import { Context, Effect, Layer, Option } from "effect"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"

// ---------------------------------------------------------------------------
// Generic, provider-agnostic repo over the shared `oauth_auth_states` table —
// the short-lived CSRF nonce store for any OAuth / App-install redirect flow.
// Callers supply `provider` in the insert row and verify it on read, so this
// repo is reusable across integrations (GitHub install, Hazel OAuth, …).
// ---------------------------------------------------------------------------

const toPersistenceError = (error: DatabaseError) =>
	new OAuthStatePersistenceError({ message: error.message })

export interface OAuthStateRepositoryShape {
	readonly purgeExpired: (now: number) => Effect.Effect<void, OAuthStatePersistenceError>
	readonly insert: (row: OAuthAuthStateInsert) => Effect.Effect<void, OAuthStatePersistenceError>
	readonly findByState: (
		state: string,
	) => Effect.Effect<Option.Option<OAuthAuthStateRow>, OAuthStatePersistenceError>
	readonly deleteByState: (state: string) => Effect.Effect<void, OAuthStatePersistenceError>
}

export class OAuthStateRepository extends Context.Service<OAuthStateRepository, OAuthStateRepositoryShape>()(
	"@maple/api/services/OAuthStateRepository",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const purgeExpired = Effect.fn("OAuthStateRepository.purgeExpired")(function* (now: number) {
				yield* database
					.execute((db) =>
						db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, new Date(now))),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const insert = Effect.fn("OAuthStateRepository.insert")(function* (row: OAuthAuthStateInsert) {
				yield* database
					.execute((db) => db.insert(oauthAuthStates).values(row))
					.pipe(Effect.mapError(toPersistenceError))
			})

			const findByState = Effect.fn("OAuthStateRepository.findByState")(function* (state: string) {
				const rows = yield* database
					.execute((db) =>
						db.select().from(oauthAuthStates).where(eq(oauthAuthStates.state, state)).limit(1),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return Option.fromNullishOr(rows[0])
			})

			const deleteByState = Effect.fn("OAuthStateRepository.deleteByState")(function* (state: string) {
				yield* database
					.execute((db) => db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)))
					.pipe(Effect.mapError(toPersistenceError))
			})

			return { purgeExpired, insert, findByState, deleteByState } satisfies OAuthStateRepositoryShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
