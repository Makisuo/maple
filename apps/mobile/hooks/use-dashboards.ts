import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchDashboards, type DashboardDocument } from "../lib/api"
import {
  getQueryErrorMessage,
  mobileQueryKeys,
  mobileQueryStaleTimes,
  preservePreviousData,
} from "../lib/query"

type DashboardsState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: DashboardDocument[] }

async function fetchSortedDashboards(): Promise<DashboardDocument[]> {
	const dashboards = await fetchDashboards()
	return [...dashboards].sort((a, b) =>
		b.updatedAt.localeCompare(a.updatedAt),
	)
}

export function useDashboards() {
	const query = useQuery({
		queryKey: mobileQueryKeys.dashboards(),
		queryFn: fetchSortedDashboards,
		staleTime: mobileQueryStaleTimes.dashboards,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: DashboardsState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return { state, refresh }
}
