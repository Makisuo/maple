import { Effect } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

// Module-level singleton so every surface shares one fetch and one refresh.
//
// The audit is recomputed server-side on each request — it runs a dozen warehouse reads, two of them
// cross-span joins — so it is deliberately fetched on demand rather than polled. Refresh it from the
// user's explicit action, never on an interval.
export const setupAuditAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		return yield* client.instrumentationAudit.retrieve()
	}),
)
