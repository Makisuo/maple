import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { executeLocalCompiledFirstRow, executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

export interface ErrorsFilters {
	/** Exact service name match. */
	service?: string
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Restrict to root-span errors. */
	rootOnly?: boolean
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

function commonOpts(filters: ErrorsFilters) {
	return {
		rootOnly: filters.rootOnly,
		services: filters.service ? [filters.service] : undefined,
		deploymentEnvs: filters.env ? [filters.env] : undefined,
	}
}

/** Headline stats for the errors view (error_events × service_usage). */
export function useLocalErrorsSummary(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "summary", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<CH.ErrorsSummaryOutput | null> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const row = await executeLocalCompiledFirstRow(
				CH.compile(CH.errorsSummaryQuery(commonOpts(filters)), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			return Option.getOrNull(row)
		},
	})
}

/** Fingerprint-grouped error types, most frequent first. */
export function useLocalErrorsByType(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "by-type", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<CH.ErrorsByTypeOutput>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			return executeLocalCompiledQuery(
				CH.compile(CH.errorsByTypeQuery({ ...commonOpts(filters), limit: 50 }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

export interface ErrorsFacets {
	services: Array<{ name: string; count: number }>
	environments: Array<{ name: string; count: number }>
}

/** Service + environment facet counts for the sidebar (UNION query). */
export function useLocalErrorsFacets(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "facets", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ErrorsFacets> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(CH.errorsFacetsQuery({ rootOnly: filters.rootOnly }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			const pick = (facetType: string) =>
				rows
					.filter((r) => r.facetType === facetType)
					.map((r) => ({ name: r.name, count: Number(r.count) }))
			return { services: pick("service"), environments: pick("environment") }
		},
	})
}

/** Most recently errored traces for one fingerprint (expanded row). */
export function useLocalErrorTraces(
	fingerprintHash: string | undefined,
	filters: ErrorsFilters,
) {
	return useQuery({
		queryKey: ["local", "errors", "traces", fingerprintHash, filters],
		enabled: !!fingerprintHash,
		queryFn: async (): Promise<ReadonlyArray<CH.ErrorDetailTracesOutput>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			return executeLocalCompiledQuery(
				CH.compile(
					CH.errorDetailTracesQuery({
						fingerprintHash: fingerprintHash!,
						rootOnly: filters.rootOnly,
						services: filters.service ? [filters.service] : undefined,
						limit: 10,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime },
				),
			)
		},
	})
}
