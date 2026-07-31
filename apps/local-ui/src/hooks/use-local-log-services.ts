import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"

/**
 * Distinct services that emitted logs in the selected window. This deliberately
 * uses the logs-specific facet instead of the trace-derived services facet so a
 * logs-only service remains selectable on the Logs tab.
 */
export function compileLocalLogServicesQuery(startTime: string, endTime: string) {
	return CH.compileUnion(CH.logsFacetsQuery({}, "service"), {
		orgId: LOCAL_ORG_ID,
		startTime,
		endTime,
	})
}

export function useLocalLogServices(range: string | undefined) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "logs", "services", range],
		staleTime: 60_000,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = compileLocalLogServicesQuery(startTime, endTime)
			const rows = await executeLocalCompiledQuery(compiled)
			return rows
				.filter((row) => row.facetType === "service" && row.serviceName)
				.map((row) => ({ name: row.serviceName, count: Number(row.count) }))
		},
	})
}
