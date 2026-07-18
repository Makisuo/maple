import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { collectV2Pages } from "@/lib/services/common/v2-pagination"

const PAGE_LIMIT = 100

/** Shared complete target list for settings and integration-status surfaces. */
export const scrapeTargetsListAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		const data: ReadonlyArray<V2ScrapeTarget> = yield* collectV2Pages((cursor) =>
			client.scrapeTargets.list({
				query: {
					limit: PAGE_LIMIT,
					...(cursor !== undefined ? { cursor } : {}),
				},
			}),
		)
		return { data }
	}),
)
