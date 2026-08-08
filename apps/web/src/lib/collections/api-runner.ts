import { Effect } from "effect"
import { mapleRuntime } from "@/lib/registry"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

export type MapleApiV2Client = Effect.Success<typeof MapleApiV2AtomClient>

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
