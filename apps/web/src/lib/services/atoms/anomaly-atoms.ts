import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

/**
 * Shared open-incident read for service health surfaces. A module-level atom
 * ensures the dashboard summary, dashboard list, and services page all observe
 * the same request/cache entry and invalidate together.
 */
export const openAnomalyIncidentsAtom = MapleApiAtomClient.query("anomalies", "listIncidents", {
	query: { status: "open", limit: 500 },
	reactivityKeys: ["anomalyIncidents"],
})
