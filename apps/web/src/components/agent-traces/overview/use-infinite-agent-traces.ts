import * as React from "react"
import { Effect } from "effect"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { listAgentTraces, type ListAgentTracesInput } from "@/api/warehouse/genai"
import { listAgentTracesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { logClientError } from "@/lib/services/common/telemetry"
import type { AgentTraceRow } from "./agent-trace-row"

/** Exported so the route loader prefetches the exact first-page key this hook reads. */
export const AGENT_TRACES_PAGE_SIZE = 50
export const MAX_RETAINED_AGENT_TRACES = 500

interface AgentTracesPage {
	data: ReadonlyArray<AgentTraceRow>
}

/**
 * Offset-based infinite scroll for the agent traces list, mirroring
 * `useInfiniteReplays`: the first page flows through the cached result atom (so
 * it shares the route's skeleton/refresh semantics), later pages are fetched
 * imperatively and accumulated, and everything resets when the inputs change.
 *
 * `inputs` must not carry `limit`/`offset` — this hook owns them.
 */
export function useInfiniteAgentTraces(inputs: Omit<ListAgentTracesInput, "limit" | "offset">) {
	const filterKey = React.useMemo(() => JSON.stringify(inputs), [inputs])

	const firstPageResult = useAtomValue(
		listAgentTracesResultAtom({
			data: { ...inputs, limit: AGENT_TRACES_PAGE_SIZE, offset: 0 },
		}),
	)

	const [additionalPages, setAdditionalPages] = React.useState<AgentTracesPage[]>([])
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

	const allData = React.useMemo<ReadonlyArray<AgentTraceRow>>(() => {
		const firstPageData: ReadonlyArray<AgentTraceRow> = Result.isSuccess(firstPageResult)
			? firstPageResult.value.data
			: []
		const additionalData = additionalPages.flatMap((page) => page.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_AGENT_TRACES)
	}, [firstPageResult, additionalPages])
	const isCapped = allData.length >= MAX_RETAINED_AGENT_TRACES

	const hasNextPage = React.useMemo(() => {
		if (isCapped || paginationStopped) return false
		if (!Result.isSuccess(firstPageResult)) return false
		if (additionalPages.length === 0) {
			return firstPageResult.value.data.length === AGENT_TRACES_PAGE_SIZE
		}
		return additionalPages[additionalPages.length - 1]!.data.length === AGENT_TRACES_PAGE_SIZE
	}, [firstPageResult, additionalPages, paginationStopped, isCapped])

	const fetchNextPage = React.useCallback(() => {
		if (isFetchingRef.current || !hasNextPage) return
		isFetchingRef.current = true
		setIsFetchingNextPage(true)

		const currentKey = filterKeyRef.current
		const offset = allData.length

		Effect.runPromise(listAgentTraces({ data: { ...inputs, limit: AGENT_TRACES_PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => [...prev, { data: result.data }])
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Stop asking for more pages rather than looping on a backend offset cap.
				setPaginationStopped(true)
				logClientError("agentTrace.pagination_failed", error)
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
