import { useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"

const dashboardVersionsKey = (dashboardId: DashboardId) => `dashboard:${dashboardId}:versions`

export function useDashboardVersions(dashboardId: DashboardId) {
	const queryAtom = MapleApiV2AtomClient.query("dashboards", "listVersions", {
		params: { id: dashboardId },
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
	const queryAtom = MapleApiV2AtomClient.query("dashboards", "retrieveVersion", {
		params: {
			id: dashboardId,
			version_id: versionId,
		},
		reactivityKeys: [`dashboard:${dashboardId}:version:${versionId}`],
	})
	return useAtomValue(queryAtom)
}

export function useRestoreDashboardVersion() {
	return useAtomSet(MapleApiV2AtomClient.mutation("dashboards", "restoreVersion"), { mode: "promiseExit" })
}

export const buildRestorePayload = (dashboardId: DashboardId, versionId: DashboardVersionId) => ({
	params: {
		id: dashboardId,
		version_id: versionId,
	},
	reactivityKeys: ["dashboards", dashboardVersionsKey(dashboardId)] as const,
})
