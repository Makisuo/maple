import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

/**
 * Shared open-incident rollup for service health surfaces. A module-level atom
 * ensures the dashboard summary, dashboard list, and services page all observe
 * the same request/cache entry and invalidate together.
 *
 * This is the `service_counts` aggregate rather than a list: the readers only
 * ever shaded per-(service, environment) rows, and v2 lists cap at 100 while
 * the old v1 call took 500 in one shot.
 */
export const openAnomalyServiceCountsAtom = retainedQueryV2("anomalies", "serviceCounts", {
	query: { status: "open" },
	reactivityKeys: ["anomalyIncidents"],
})
