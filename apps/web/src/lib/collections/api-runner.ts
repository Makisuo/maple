import { Effect } from "effect"
import { mapleRuntime } from "@/lib/registry"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

/**
 * The generated typed HTTP API client. `MapleApiAtomClient` is a
 * `Context.Service` whose value IS the `HttpApiClient` (see AtomHttpApi), so
 * yielding it gives the client with `.dashboards.upsert(...)` etc.
 */
export type MapleApiClient = Effect.Success<typeof MapleApiAtomClient>
export type MapleApiV2Client = Effect.Success<typeof MapleApiV2AtomClient>

/**
 * Runs a typed API call outside React and returns the decoded success value.
 * TanStack DB collection write handlers use this to persist a mutation and read
 * the `txid` back off the response. Errors reject the promise, which is exactly
 * what the handlers want — a rejected handler tells TanStack DB to roll the
 * optimistic mutation back.
 *
 * We call the client directly (rather than the `.mutation()` atom) because the
 * handler needs the decoded response synchronously to return `{ txid }`; the
 * live query on the collection is what replaces the old reactivity-key
 * invalidation of the list.
 *
 * Runs on the shared {@link mapleRuntime} (built once from `mapleApiClientLayer`)
 * rather than rebuilding the layer per call.
 */
export const runMapleApi = <A, E, R>(use: (client: MapleApiClient) => Effect.Effect<A, E, R>): Promise<A> =>
	mapleRuntime.runPromise(
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* use(client)
		}) as Effect.Effect<A, E, MapleApiAtomClient>,
	)

/** Runs a public v2 API call on the same shared runtime used by Electric writes. */
export const runMapleApiV2 = <A, E, R>(
	use: (client: MapleApiV2Client) => Effect.Effect<A, E, R>,
): Promise<A> =>
	mapleRuntime.runPromise(
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* use(client)
		}) as Effect.Effect<A, E, MapleApiV2AtomClient>,
	)
