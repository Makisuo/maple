import { AlertIncidentsListResponse, AlertRulesListResponse } from "@maple/domain/http"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { Result } from "@/lib/effect-atom"
import {
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@/lib/collections/alerts"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"

// The error channel the consumers handle — the live-query path never fails, but
// the Result type keeps the shape the `.onError(e => e.message)` handlers expect.
type ListError = { readonly message: string }

/**
 * The result shape the alert-rules consumers already handle: an effect-atom
 * `Result` carrying an {@link AlertRulesListResponse}, plus a `refresh` handle.
 * The live query is always current, so `refresh` is a no-op.
 */
export interface AlertRulesListHook {
	readonly result: Result.Result<AlertRulesListResponse, ListError>
	readonly refresh: () => void
}

export interface AlertIncidentsListHook {
	readonly result: Result.Result<AlertIncidentsListResponse, ListError>
	readonly refresh: () => void
}

const noop = () => {}

export function useAlertRulesList(): AlertRulesListHook {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const rulesCollection = useMemo(
		() => getOrgCollections(orgKey).alertRules,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)
	const statesCollection = useMemo(
		() => getOrgCollections(orgKey).alertRuleStates,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: ruleRows, isLoading: rulesLoading } = useLiveQuery(
		// Match the server's `listRules` ordering (desc updatedAt) so recently
		// edited rules stay at the top.
		(q) => q.from({ r: rulesCollection }).orderBy(({ r }) => r.updated_at, "desc"),
		[rulesCollection],
	)
	const { data: stateRows } = useLiveQuery((q) => q.from({ s: statesCollection }), [statesCollection])

	const result = useMemo<Result.Result<AlertRulesListResponse, ListError>>(() => {
		if (rulesLoading && (ruleRows?.length ?? 0) === 0) return Result.initial(true)
		const statesByRuleId = buildRuleStatesByRuleId(stateRows ?? [])
		const rules = (ruleRows ?? []).map((row) => rowToAlertRuleDocument(row, statesByRuleId))
		return Result.success(new AlertRulesListResponse({ rules }))
	}, [ruleRows, stateRows, rulesLoading])

	return { result, refresh: noop }
}

export function useAlertIncidentsList(): AlertIncidentsListHook {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collection = useMemo(
		() => getOrgCollections(orgKey).alertIncidents,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: rows, isLoading } = useLiveQuery(
		(q) => q.from({ i: collection }).orderBy(({ i }) => i.last_triggered_at, "desc"),
		[collection],
	)

	const result = useMemo<Result.Result<AlertIncidentsListResponse, ListError>>(() => {
		if (isLoading && (rows?.length ?? 0) === 0) return Result.initial(true)
		const incidents = (rows ?? []).map(rowToAlertIncidentDocument)
		return Result.success(new AlertIncidentsListResponse({ incidents }))
	}, [rows, isLoading])

	return { result, refresh: noop }
}
