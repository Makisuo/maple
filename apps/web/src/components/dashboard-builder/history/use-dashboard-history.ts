import { useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"

const dashboardVersionsKey = (dashboardId: DashboardId) => `dashboard:${dashboardId}:versions`

export function useDashboardVersions(dashboardId: DashboardId) {
	const queryAtom = MapleApiAtomClient.query("dashboards", "listVersions", {
		params: { dashboardId },
		query: { limit: 100 },
		reactivityKeys: [dashboardVersionsKey(dashboardId)],
	})
	return useAtomValue(queryAtom)
}

/**
 * Fetch a single version's full snapshot. The parent must conditionally
 * mount the consuming component — this hook is always called on mount.
 */
export function useDashboardVersionDetail(dashboardId: DashboardId, versionId: DashboardVersionId) {
	const queryAtom = MapleApiAtomClient.query("dashboards", "getVersion", {
		params: {
			dashboardId,
			versionId,
		},
		reactivityKeys: [`dashboard:${dashboardId}:version:${versionId}`],
	})
	return useAtomValue(queryAtom)
}

export function useRestoreDashboardVersion() {
	return useAtomSet(MapleApiAtomClient.mutation("dashboards", "restoreVersion"), { mode: "promiseExit" })
}

export const buildRestorePayload = (dashboardId: DashboardId, versionId: DashboardVersionId) => ({
	params: {
		dashboardId,
		versionId,
	},
	reactivityKeys: ["dashboards", dashboardVersionsKey(dashboardId)] as const,
})
