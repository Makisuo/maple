import * as React from "react"
import { Result } from "@/lib/effect-atom"

import { listAiSessions } from "@/api/warehouse/ai-sessions"
import { listAiSessionsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { logClientError } from "@/lib/services/common/telemetry"
import { mapleRuntime } from "@/lib/registry"

export const AI_SESSIONS_PAGE_SIZE = 50
const PAGE_SIZE = AI_SESSIONS_PAGE_SIZE
export const MAX_RETAINED_AI_SESSIONS = 500

/**
 * The filter inputs the agent-sessions route assembles (resolved time window +
 * sidebar filters). Pagination params are added by this hook — callers must not
 * set `limit`/`offset` themselves.
 */
export interface AiSessionsFilterInputs {
	startTime: string
	endTime: string
	vendorIds?: ReadonlyArray<string>
	serviceNames?: ReadonlyArray<string>
}

interface AiSessionsPage {
	data: ReadonlyArray<AgentSessionRow>
}

/**
 * Offset-based infinite scroll for the agent-sessions list, mirroring
 * `useInfiniteReplays`. The first page flows through the cached result atom (so
 * it shares the route's skeleton/refresh semantics); later pages are fetched
 * imperatively and accumulated. Pages reset whenever the filter inputs change.
 */
export function useInfiniteAiSessions(filterInputs: AiSessionsFilterInputs) {
	const filterKey = React.useMemo(() => JSON.stringify(filterInputs), [filterInputs])

	// Refreshable AND retained: on an absolute time range the atom key never
	// rolls, so Reload only works through the refresh subscription; and a filter
	// change builds a new key whose first read is `Initial`, which retention
	// turns into a dimmed list rather than a skeleton flash.
	const firstPageResult = useRefreshableAtomValue(
		listAiSessionsResultAtom({ data: { ...filterInputs, limit: PAGE_SIZE, offset: 0 } }),
	)

	const [additionalPages, setAdditionalPages] = React.useState<AiSessionsPage[]>([])
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

	const allData = React.useMemo<ReadonlyArray<AgentSessionRow>>(() => {
		const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
		const additionalData = additionalPages.flatMap((p) => p.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_AI_SESSIONS)
	}, [firstPageResult, additionalPages])
	const isCapped = allData.length >= MAX_RETAINED_AI_SESSIONS

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

		mapleRuntime
			.runPromise(listAiSessions({ data: { ...filterInputs, limit: PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => [...prev, { data: result.data }])
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Terminate pagination on failure so the sentinel stops asking;
				// otherwise hasNextPage stays true and the list loops on the error.
				setPaginationStopped(true)
				logClientError("ai_session.pagination_failed", error)
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
