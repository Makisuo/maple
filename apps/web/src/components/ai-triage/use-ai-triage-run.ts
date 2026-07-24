import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	AiTriageRunCreateRequest,
	type AiTriageIncidentKind,
	type AiTriageResult,
	type AiTriageRunDocument,
	type ErrorIssueId,
} from "@maple/domain/http"

export interface UseAiTriageRunParams {
	incidentKind: AiTriageIncidentKind
	/** Incident to (re-)run triage against; null disables the run. */
	incidentId: string | null
	issueId?: ErrorIssueId
}

export interface AiTriageRunState {
	runsLoading: boolean
	runsFailed: boolean
	/** Latest run for this incident/issue, or null if none has been created. */
	run: AiTriageRunDocument | null
	/** Structured result of a completed run, or null while pending/failed. */
	result: AiTriageResult | null
	/** True while a run is queued or running (drives the investigating state + poll). */
	runActive: boolean
	/**
	 * Whether a run can actually be started. False when there's no incident to run
	 * against (e.g. an error issue that has never opened an incident) — triage needs
	 * an `incidentId`, so the UI must show a terminal state, not an endless spinner.
	 */
	canRun: boolean
	/** True between clicking "Diagnose"/"Re-run" and the create mutation settling. */
	isStarting: boolean
	startRun: () => Promise<void>
	refreshRuns: () => void
}

/**
 * Owns the AI-triage run lifecycle for one incident/issue: fetches the latest
 * run, polls it while active, and exposes `startRun` to (re-)trigger a diagnosis.
 *
 * Lifted out of `AiTriageCard` so a page can drive several surfaces (a scorecard
 * rail + a report body) from a single run, instead of the card owning it all.
 */
export function useAiTriageRun({
	incidentKind,
	incidentId,
	issueId,
}: UseAiTriageRunParams): AiTriageRunState {
	const reactivityKeys = ["aiTriageRuns", `aiTriage:${incidentKind}:${incidentId ?? issueId ?? ""}`]
	const runsQueryAtom = MapleApiAtomClient.query("aiTriage", "listRuns", {
		query:
			issueId !== undefined
				? { issueId, limit: 1 }
				: { incidentKind, incidentId: incidentId ?? "", limit: 1 },
		reactivityKeys,
	})
	const runsResult = useAtomValue(runsQueryAtom)
	const refreshRuns = useAtomRefresh(runsQueryAtom)

	const createRun = useAtomSet(MapleApiAtomClient.mutation("aiTriage", "createRun"), {
		mode: "promiseExit",
	})
	const [isStarting, setIsStarting] = useState(false)

	const runsFailed = Result.isFailure(runsResult)
	const runsLoading = Result.isInitial(runsResult)
	const run: AiTriageRunDocument | null = Result.builder(runsResult)
		.onSuccess((value) => value.runs[0] ?? null)
		.orElse(() => null)

	const runActive = run?.status === "queued" || run?.status === "running"

	// Poll the background run while it's active.
	useIntervalRefresh(refreshRuns, { intervalMs: 3000, enabled: runActive })

	const startRun = async () => {
		// Block re-entry until the first runs fetch resolves — otherwise a click
		// during the initial load can race a run that already exists.
		if (incidentId === null || runsLoading) return
		setIsStarting(true)
		const result = await createRun({
			payload: new AiTriageRunCreateRequest({
				incidentKind,
				incidentId,
				...(issueId !== undefined ? { issueId } : {}),
			}),
			reactivityKeys,
		})
		setIsStarting(false)
		if (Exit.isSuccess(result)) {
			toast.success("Diagnosis started")
		} else {
			toast.error("Couldn't start the diagnosis")
		}
	}

	return {
		runsLoading,
		runsFailed,
		run,
		result: run?.result ?? null,
		runActive,
		canRun: incidentId !== null,
		isStarting,
		startRun,
		refreshRuns,
	}
}
