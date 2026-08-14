import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { showErrorToast } from "@/lib/error-toast"
import type { AnomalyIncidentId, ErrorIssueId } from "@maple/domain/http"

export function useAnomalyMutations() {
	const resolve = useAtomSet(MapleApiV2AtomClient.mutation("anomalies", "resolveIncident"), {
		mode: "promiseExit",
	})
	const setIssue = useAtomSet(MapleApiV2AtomClient.mutation("anomalies", "setIncidentIssue"), {
		mode: "promiseExit",
	})

	const resolveIncident = async (incidentId: AnomalyIncidentId) => {
		const result = await resolve({
			params: { id: incidentId },
			reactivityKeys: ["anomalyIncidents", `anomalyIncident:${incidentId}`],
		})
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: "Anomaly resolved", type: "success" })
		} else {
			showErrorToast(result, { title: "Resolve failed" })
		}
		return result
	}

	/**
	 * Link the incident to an issue (or unlink with null). `previousIssueId`
	 * keeps the old issue's related-anomalies section fresh after a relink.
	 */
	const linkIssue = async (
		incidentId: AnomalyIncidentId,
		issueId: ErrorIssueId | null,
		previousIssueId?: ErrorIssueId | null,
	) => {
		const issueKeys = [issueId, previousIssueId]
			.filter((id): id is ErrorIssueId => id != null)
			.flatMap((id) => [`errorIssue:${id}`, `errorIssue:${id}:anomalies`, `errorIssue:${id}:events`])
		const result = await setIssue({
			params: { id: incidentId },
			payload: { issue_id: issueId },
			reactivityKeys: ["anomalyIncidents", `anomalyIncident:${incidentId}`, ...issueKeys],
		})
		if (Exit.isSuccess(result)) {
			toastManager.add({
				title: issueId === null ? "Issue unlinked" : "Linked to issue",
				type: "success",
			})
		} else {
			showErrorToast(result, { title: issueId === null ? "Unlink failed" : "Link failed" })
		}
		return result
	}

	return { resolveIncident, linkIssue }
}
