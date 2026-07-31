import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import type { TimeBounds } from "../lib/time"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"

/**
 * Distinct services that emitted logs in the selected window. This deliberately
 * scans the same raw table and exact timestamp bounds as the rendered list, so
 * neither partial hourly buckets nor longer-lived aggregates can add or hide a
 * service option.
 */
export function compileLocalLogServicesQuery(startTime: string, endTime: string) {
	return CH.compile(CH.logsBreakdownQuery({ groupBy: "service", limit: null, source: "raw" }), {
		orgId: LOCAL_ORG_ID,
		startTime,
		endTime,
	})
}

export function useLocalLogServices(bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "logs", "services", bounds.startTime, bounds.endTime],
		staleTime: 60_000,
		queryFn: async () => {
			const compiled = compileLocalLogServicesQuery(bounds.startTime, bounds.endTime)
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: Number(row.count) }))
		},
	})
}
