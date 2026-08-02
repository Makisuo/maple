import {
	AlertDestinationsListResponse,
	AlertIncidentsListResponse,
	AlertRulesListResponse,
} from "@maple/domain/http"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { Result } from "@/lib/effect-atom"
import {
	buildRuleStatesByRuleId,
	rowToAlertDestinationDocument,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@/lib/collections/alerts"
import { useCollectionLoadFailed } from "@/lib/collections/collection-load"
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

export interface AlertDestinationsListHook {
	readonly result: Result.Result<AlertDestinationsListResponse, ListError>
	readonly refresh: () => void
}

const noop = () => {}

/**
 * The failure every one of these hooks reports when its shape stream never
 * arrives. A live query has no bounded load of its own, so without this an
 * unreachable sync endpoint keeps `isLoading` true forever and the alerts pages
 * render skeletons that never resolve.
 */
const SYNC_UNAVAILABLE: ListError = {
	message: "Live sync is unavailable, so alerts couldn’t be loaded. Reload to try again.",
}

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

	const pending = rulesLoading && (ruleRows?.length ?? 0) === 0
	const syncFailed = useCollectionLoadFailed(rulesCollection.id, pending)

	const result = useMemo<Result.Result<AlertRulesListResponse, ListError>>(() => {
		if (syncFailed) return Result.fail(SYNC_UNAVAILABLE)
		if (pending) return Result.initial(true)
		const statesByRuleId = buildRuleStatesByRuleId(stateRows ?? [])
		const rules = (ruleRows ?? []).map((row) => rowToAlertRuleDocument(row, statesByRuleId))
		return Result.success(new AlertRulesListResponse({ rules }))
	}, [ruleRows, stateRows, pending, syncFailed])

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

	const pending = isLoading && (rows?.length ?? 0) === 0
	const syncFailed = useCollectionLoadFailed(collection.id, pending)

	const result = useMemo<Result.Result<AlertIncidentsListResponse, ListError>>(() => {
		if (syncFailed) return Result.fail(SYNC_UNAVAILABLE)
		if (pending) return Result.initial(true)
		const incidents = (rows ?? []).map(rowToAlertIncidentDocument)
		return Result.success(new AlertIncidentsListResponse({ incidents }))
	}, [rows, pending, syncFailed])

	return { result, refresh: noop }
}

export function useAlertDestinationsList(): AlertDestinationsListHook {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collection = useMemo(
		() => getOrgCollections(orgKey).alertDestinations,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: rows, isLoading } = useLiveQuery(
		// Match the server's `listDestinations` ordering (desc updatedAt).
		(q) => q.from({ d: collection }).orderBy(({ d }) => d.updated_at, "desc"),
		[collection],
	)

	const pending = isLoading && (rows?.length ?? 0) === 0
	const syncFailed = useCollectionLoadFailed(collection.id, pending)

	const result = useMemo<Result.Result<AlertDestinationsListResponse, ListError>>(() => {
		if (syncFailed) return Result.fail(SYNC_UNAVAILABLE)
		if (pending) return Result.initial(true)
		const destinations = (rows ?? []).map(rowToAlertDestinationDocument)
		return Result.success(new AlertDestinationsListResponse({ destinations }))
	}, [rows, pending, syncFailed])

	return { result, refresh: noop }
}
