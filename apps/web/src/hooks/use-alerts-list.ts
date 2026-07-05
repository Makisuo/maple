import { AlertIncidentsListResponse, AlertRulesListResponse } from "@maple/domain/http"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@/lib/collections/alerts"
import { ELECTRIC_SYNC_ENABLED } from "@/lib/collections/config"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"
import { listIncidentsAtom, listRulesAtom } from "@/lib/services/atoms/alerts-atoms"

// The error channel each list carries — extracted from the shared atom so the
// synthesized Electric-branch Result lines up exactly with the atom branch (the
// consumers read `error.message` in their `.onError` handlers).
type RulesListError = Atom.Failure<typeof listRulesAtom>
type IncidentsListError = Atom.Failure<typeof listIncidentsAtom>

/**
 * The result shape the alert-rules consumers already handle: an effect-atom
 * `Result` carrying an {@link AlertRulesListResponse}, plus a `refresh` handle.
 * The ElectricSQL branch synthesizes a `Result.success` (the live query is always
 * current, so `refresh` is a no-op); the atom branch returns the shared atom's
 * result + `useAtomRefresh`. Both dispatch at build time on `ELECTRIC_SYNC_ENABLED`.
 */
export interface AlertRulesListHook {
	readonly result: Result.Result<AlertRulesListResponse, RulesListError>
	readonly refresh: () => void
}

export interface AlertIncidentsListHook {
	readonly result: Result.Result<AlertIncidentsListResponse, IncidentsListError>
	readonly refresh: () => void
}

const noop = () => {}

function useAlertRulesListAtoms(): AlertRulesListHook {
	const result = useAtomValue(listRulesAtom)
	const refresh = useAtomRefresh(listRulesAtom)
	return { result, refresh }
}

function useAlertRulesListCollection(): AlertRulesListHook {
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
		// edited rules stay at the top, as the atom path does.
		(q) => q.from({ r: rulesCollection }).orderBy(({ r }) => r.updated_at, "desc"),
		[rulesCollection],
	)
	const { data: stateRows } = useLiveQuery((q) => q.from({ s: statesCollection }), [statesCollection])

	const result = useMemo<Result.Result<AlertRulesListResponse, RulesListError>>(() => {
		if (rulesLoading && (ruleRows?.length ?? 0) === 0) return Result.initial(true)
		const statesByRuleId = buildRuleStatesByRuleId(stateRows ?? [])
		const rules = (ruleRows ?? []).map((row) => rowToAlertRuleDocument(row, statesByRuleId))
		return Result.success(new AlertRulesListResponse({ rules }))
	}, [ruleRows, stateRows, rulesLoading])

	return { result, refresh: noop }
}

function useAlertIncidentsListAtoms(): AlertIncidentsListHook {
	const result = useAtomValue(listIncidentsAtom)
	const refresh = useAtomRefresh(listIncidentsAtom)
	return { result, refresh }
}

function useAlertIncidentsListCollection(): AlertIncidentsListHook {
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

	const result = useMemo<Result.Result<AlertIncidentsListResponse, IncidentsListError>>(() => {
		if (isLoading && (rows?.length ?? 0) === 0) return Result.initial(true)
		const incidents = (rows ?? []).map(rowToAlertIncidentDocument)
		return Result.success(new AlertIncidentsListResponse({ incidents }))
	}, [rows, isLoading])

	return { result, refresh: noop }
}

// Build-time dispatch — `ELECTRIC_SYNC_ENABLED` is a compile-time constant, so
// exactly one branch survives bundling and hook order is stable per build.

export function useAlertRulesList(): AlertRulesListHook {
	if (ELECTRIC_SYNC_ENABLED) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useAlertRulesListCollection()
	}
	// eslint-disable-next-line react-hooks/rules-of-hooks
	return useAlertRulesListAtoms()
}

export function useAlertIncidentsList(): AlertIncidentsListHook {
	if (ELECTRIC_SYNC_ENABLED) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useAlertIncidentsListCollection()
	}
	// eslint-disable-next-line react-hooks/rules-of-hooks
	return useAlertIncidentsListAtoms()
}
