import * as React from "react"
import { Effect } from "effect"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { listJourneys, type ListJourneysInput } from "@/api/warehouse/genai"
import { listJourneysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { logClientError } from "@/lib/services/common/telemetry"
import type { JourneyRow } from "./journey-row"

/** Exported so the route loader prefetches the exact first-page key this hook reads. */
export const JOURNEYS_PAGE_SIZE = 50
export const MAX_RETAINED_JOURNEYS = 500

interface JourneysPage {
	data: ReadonlyArray<JourneyRow>
}

/**
 * Offset-based infinite scroll for the journeys list, mirroring
 * `useInfiniteReplays`: the first page flows through the cached result atom (so
 * it shares the route's skeleton/refresh semantics), later pages are fetched
 * imperatively and accumulated, and everything resets when the inputs change.
 *
 * `inputs` must not carry `limit`/`offset` — this hook owns them.
 */
export function useInfiniteJourneys(inputs: Omit<ListJourneysInput, "limit" | "offset">) {
	const filterKey = React.useMemo(() => JSON.stringify(inputs), [inputs])

	const firstPageResult = useAtomValue(
		listJourneysResultAtom({
			data: { ...inputs, limit: JOURNEYS_PAGE_SIZE, offset: 0 },
		}),
	)

	const [additionalPages, setAdditionalPages] = React.useState<JourneysPage[]>([])
	const [isFetchingNextPage, setIsFetchingNextPage] = React.useState(false)
	const [paginationStopped, setPaginationStopped] = React.useState(false)
	const filterKeyRef = React.useRef(filterKey)
	const isFetchingRef = React.useRef(false)

	React.useEffect(() => {
		filterKeyRef.current = filterKey
		setAdditionalPages([])
		setIsFetchingNextPage(false)
		setPaginationStopped(false)
		isFetchingRef.current = false
	}, [filterKey])

	const allData = React.useMemo<ReadonlyArray<JourneyRow>>(() => {
		const firstPageData: ReadonlyArray<JourneyRow> = Result.isSuccess(firstPageResult)
			? firstPageResult.value.data
			: []
		const additionalData = additionalPages.flatMap((page) => page.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_JOURNEYS)
	}, [firstPageResult, additionalPages])
	const isCapped = allData.length >= MAX_RETAINED_JOURNEYS

	const hasNextPage = React.useMemo(() => {
		if (isCapped || paginationStopped) return false
		if (!Result.isSuccess(firstPageResult)) return false
		if (additionalPages.length === 0) {
			return firstPageResult.value.data.length === JOURNEYS_PAGE_SIZE
		}
		return additionalPages[additionalPages.length - 1]!.data.length === JOURNEYS_PAGE_SIZE
	}, [firstPageResult, additionalPages, paginationStopped, isCapped])

	const fetchNextPage = React.useCallback(() => {
		if (isFetchingRef.current || !hasNextPage) return
		isFetchingRef.current = true
		setIsFetchingNextPage(true)

		const currentKey = filterKeyRef.current
		const offset = allData.length

		Effect.runPromise(listJourneys({ data: { ...inputs, limit: JOURNEYS_PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => [...prev, { data: result.data }])
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Stop asking for more pages rather than looping on a backend offset cap.
				setPaginationStopped(true)
				logClientError("journey.pagination_failed", error)
			})
			.finally(() => {
				if (filterKeyRef.current === currentKey) setIsFetchingNextPage(false)
				isFetchingRef.current = false
			})
	}, [inputs, allData.length, hasNextPage])

	return {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		fetchNextPage,
	}
}
