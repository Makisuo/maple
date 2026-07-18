import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { Array as Arr, Effect, Ref } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

const MAX_PAGES = 20
const PAGE_LIMIT = 100

interface PageState {
	readonly cursor: string | undefined
	readonly data: ReadonlyArray<V2ScrapeTarget>
	readonly done: boolean
}

/** Shared complete target list for settings and integration-status surfaces. */
export const scrapeTargetsListAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		const state = yield* Ref.make<PageState>({ cursor: undefined, data: [], done: false })

		yield* Effect.forEach(Arr.range(0, MAX_PAGES - 1), () =>
			Ref.get(state).pipe(
				Effect.flatMap((current) => {
					if (current.done) return Effect.void
					return client.scrapeTargets
						.list({
							query: {
								limit: PAGE_LIMIT,
								...(current.cursor !== undefined ? { cursor: current.cursor } : {}),
							},
						})
						.pipe(
							Effect.flatMap((response) =>
								Ref.set(state, {
									cursor: response.next_cursor ?? undefined,
									data: Arr.appendAll(current.data, response.data),
									done: !response.has_more || response.next_cursor === null,
								}),
							),
						)
				}),
			),
		)

		const result = yield* Ref.get(state)
		return { data: result.data }
	}),
)
