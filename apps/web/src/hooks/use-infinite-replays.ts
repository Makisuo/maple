import * as React from "react"
import { Effect } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { listReplays } from "@/api/warehouse/replays"
import { listReplaysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { SessionRow } from "@/components/replays/sessions-list"

const PAGE_SIZE = 50
export const MAX_RETAINED_REPLAYS = 500

/**
 * The filter inputs the replays route already assembles (time window from
 * `useEffectiveTimeRange` + sidebar/search filters). Pagination params are added
 * by this hook — callers must not set `limit`/`offset` themselves.
 */
export interface ReplaysFilterInputs {
	startTime: string
	endTime: string
	serviceName?: string
	browser?: string
	country?: string
	deviceType?: string
	userId?: string
	hasErrors?: boolean
	search?: string
	durationMinMs?: number
	durationMaxMs?: number
	activeTimeMinMs?: number
	activeTimeMaxMs?: number
}

interface ReplaysPage {
	data: ReadonlyArray<SessionRow>
}

/**
 * Offset-based infinite scroll for the session-replays list, mirroring
 * `useInfiniteTraces`. The first page flows through the cached result atom (so it
 * shares the route's skeleton/refresh semantics); later pages are fetched
 * imperatively and accumulated. Pages reset whenever the filter inputs change.
 */
export function useInfiniteReplays(filterInputs: ReplaysFilterInputs) {
	const filterKey = React.useMemo(() => JSON.stringify(filterInputs), [filterInputs])

	const firstPageResult = useAtomValue(
		listReplaysResultAtom({ data: { ...filterInputs, limit: PAGE_SIZE, offset: 0 } }),
	)

	const [additionalPages, setAdditionalPages] = React.useState<ReplaysPage[]>([])
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

	const allData = React.useMemo<ReadonlyArray<SessionRow>>(() => {
		const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
		const additionalData = additionalPages.flatMap((p) => p.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_REPLAYS)
	}, [firstPageResult, additionalPages])
	const isCapped = allData.length >= MAX_RETAINED_REPLAYS

	const hasNextPage = React.useMemo(() => {
		if (isCapped) return false
		if (paginationStopped) return false
		if (!Result.isSuccess(firstPageResult)) return false
		if (additionalPages.length === 0) {
			return firstPageResult.value.data.length === PAGE_SIZE
		}
		const lastPage = additionalPages[additionalPages.length - 1]
		return lastPage.data.length === PAGE_SIZE
	}, [firstPageResult, additionalPages, paginationStopped, isCapped])

	const fetchNextPage = React.useCallback(() => {
		if (isFetchingRef.current || !hasNextPage) return
		isFetchingRef.current = true
		setIsFetchingNextPage(true)

		const currentKey = filterKeyRef.current
		const offset = allData.length

		Effect.runPromise(listReplays({ data: { ...filterInputs, limit: PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => [...prev, { data: result.data }])
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Surface the failure by terminating pagination so the caller stops
				// asking for more pages. Without this, hasNextPage stays true and the
				// UI loops on a backend offset cap.
				setPaginationStopped(true)
				console.error("Replay pagination failed", error)
			})
			.finally(() => {
				if (filterKeyRef.current === currentKey) {
					setIsFetchingNextPage(false)
				}
				isFetchingRef.current = false
			})
	}, [filterInputs, allData.length, hasNextPage])

	return {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		fetchNextPage,
	}
}
