import { useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

const PAGE_SIZE = 25

export interface TraceFilters {
	/**
	 * Exact root service name match — the trace's entry service, which is what
	 * the trace_list_mv-backed Service facet lists.
	 */
	service?: string
	/** Substring match on the root span name (toolbar search). */
	search?: string
	/**
	 * Exact root span name (sidebar facet). Wins over `search` — the engine
	 * accepts a single spanName, and the facet pick is the more specific intent.
	 * The facet serves trace_list_mv's derived HTTP span names ("GET /route")
	 * while `traces` stores the raw name ("http.server GET"); the query matches
	 * either spelling, so a facet pick selects rows.
	 */
	span?: string
	/** When true, restrict to traces whose root span errored. `false` is not a filter. */
	errorsOnly?: boolean
	/** Exact `http.method` span attribute on the root span. */
	method?: string
	/** Exact `http.status_code` span attribute on the root span. */
	status?: string
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `service.namespace` resource attribute. */
	ns?: string
	/** Minimum root span duration in milliseconds. */
	minDurationMs?: number
	/** Maximum root span duration in milliseconds. */
	maxDurationMs?: number
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

/** Keyset cursor — root span timestamp plus TraceId, which breaks timestamp ties. */
interface TraceCursor {
	timestamp: string
	traceId: string
}

/**
 * Infinite list of traces, newest first — one row per TraceId, carrying the
 * trace's real span count and every service it touched. Uses keyset (cursor)
 * pagination on the root span `Timestamp` + `TraceId`.
 */
export function useLocalTraces(filters: TraceFilters) {
	return useInfiniteQuery({
		queryKey: ["local", "traces", filters],
		initialPageParam: undefined as TraceCursor | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = boundsForRange(filters.range)
			// HTTP method/status have no first-class list opts — the web app
			// filters them via span attribute filters too (`http.method` /
			// `http.status_code`, old-semconv keys only, matching prod).
			const attributeFilters = [
				...(filters.method
					? [{ key: "http.method", value: filters.method, mode: "equals" as const }]
					: []),
				...(filters.status
					? [{ key: "http.status_code", value: filters.status, mode: "equals" as const }]
					: []),
			]
			const compiled = CH.compile(
				CH.traceListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					serviceName: filters.service,
					spanName: filters.span ?? filters.search,
					matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
					// `errorsOnly` is tri-state in the engine: `false` means "only
					// non-errored", which would silently hide every errored trace
					// while the checkbox reads as off. Same coercion as the facets hook.
					errorsOnly: filters.errorsOnly || undefined,
					environments: filters.env ? [filters.env] : undefined,
					namespaces: filters.ns ? [filters.ns] : undefined,
					minDurationMs: filters.minDurationMs,
					maxDurationMs: filters.maxDurationMs,
					attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
		getNextPageParam: (lastPage) => {
			if (lastPage.length < PAGE_SIZE) return undefined
			const last = lastPage[lastPage.length - 1]
			return last ? { timestamp: last.startTime, traceId: last.traceId } : undefined
		},
	})
}
