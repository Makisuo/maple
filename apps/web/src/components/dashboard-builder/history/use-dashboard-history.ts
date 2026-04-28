import { Schema } from "effect"
import { useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asDashboardVersionId = Schema.decodeUnknownSync(DashboardVersionId)

export const dashboardVersionsKey = (dashboardId: string) => `dashboard:${dashboardId}:versions`

export function useDashboardVersions(dashboardId: string) {
	const queryAtom = MapleApiAtomClient.query("dashboards", "listVersions", {
		params: { dashboardId: asDashboardId(dashboardId) },
		query: { limit: 100 },
		reactivityKeys: [dashboardVersionsKey(dashboardId)],
	})
	return useAtomValue(queryAtom)
}

/**
 * Fetch a single version's full snapshot. The parent must conditionally
 * mount the consuming component — this hook is always called on mount.
 */
export function useDashboardVersionDetail(dashboardId: string, versionId: string) {
	const queryAtom = MapleApiAtomClient.query("dashboards", "getVersion", {
		params: {
			dashboardId: asDashboardId(dashboardId),
			versionId: asDashboardVersionId(versionId),
		},
		reactivityKeys: [`dashboard:${dashboardId}:version:${versionId}`],
	})
	return useAtomValue(queryAtom)
}

export function useRestoreDashboardVersion() {
	return useAtomSet(MapleApiAtomClient.mutation("dashboards", "restoreVersion"), { mode: "promiseExit" })
}

export const buildRestorePayload = (dashboardId: string, versionId: string) => ({
	params: {
		dashboardId: asDashboardId(dashboardId),
		versionId: asDashboardVersionId(versionId),
	},
	reactivityKeys: ["dashboards", dashboardVersionsKey(dashboardId)] as const,
})
