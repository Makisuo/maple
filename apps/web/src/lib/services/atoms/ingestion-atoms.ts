import type { V2AttributeMapping, V2Recommendation } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

// Module-level singletons. Every consumer must import these exact atoms to share
// one fetch (and so a refresh from one surface invalidates the data everywhere
// it's read).
//
// These two lists are data-coupled: the recommendation list is reconciled
// server-side against the attribute mappings (creating a mapping that covers a
// recommendation flips it to `applied`; applying a recommendation creates a
// mapping). Mutations on either side must refresh both atoms so the ingestion
// settings page stays consistent — see attribute-mappings-section.tsx and
// recommended-mappings-section.tsx.
//
// v2 lists are cursor-paginated (100/page), so both atoms follow `next_cursor`
// to page through the full set — the settings surfaces render every row. Capped
// at 20 pages (2000 items) as a runaway guard; these lists are far smaller in
// practice.
const MAX_PAGES = 20
const PAGE_LIMIT = 100

export const ingestAttributeMappingsListAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		const data: V2AttributeMapping[] = []
		let cursor: string | undefined
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = yield* client.attributeMappings.list({
				query: { limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) },
			})
			for (const mapping of response.data) data.push(mapping)
			if (!response.has_more || response.next_cursor === null) break
			cursor = response.next_cursor
		}
		return { data }
	}),
)

export const recommendationIssuesListAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		const data: V2Recommendation[] = []
		let cursor: string | undefined
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = yield* client.recommendations.list({
				query: { limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) },
			})
			for (const recommendation of response.data) data.push(recommendation)
			if (!response.has_more || response.next_cursor === null) break
			cursor = response.next_cursor
		}
		return { data }
	}),
)
