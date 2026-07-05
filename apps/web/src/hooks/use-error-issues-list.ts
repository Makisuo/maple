import { ErrorIssuesListResponse } from "@maple/domain/http"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { ELECTRIC_SYNC_ENABLED } from "@/lib/collections/config"
import { rowToActor, rowToIssue, type ActorRow, type ErrorIssueRow } from "@/lib/collections/errors"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import type { ActorDocument } from "@maple/domain/http"

const ISSUES_PAGE_LIMIT = 100

// A representative atom used only to derive the list's error channel, so the
// synthesized Electric-branch Result lines up with the atom branch (the route reads
// `error.message` in its `.onError` handler).
const listIssuesErrorProbeAtom = MapleApiAtomClient.query("errors", "listIssues", {
	query: { limit: ISSUES_PAGE_LIMIT },
	reactivityKeys: ["errorIssues"],
})
type IssuesListError = Atom.Failure<typeof listIssuesErrorProbeAtom>

/**
 * Filters the errors-issues list consumer already applies server-side. `severity`
 * is either an {@link IssueSeverity} value, the literal `"unset"` (NULL severity),
 * or `undefined` (any); mirrored client-side in the ElectricSQL branch.
 */
export interface ErrorIssuesListFilters {
	readonly workflowState?: string
	readonly severity?: string
	readonly kind?: string
}

/** Effect-atom `Result` carrying an {@link ErrorIssuesListResponse}, matching the atom path. */
export type ErrorIssuesListResult = Result.Result<ErrorIssuesListResponse, IssuesListError>

function useErrorIssuesListAtoms(filters: ErrorIssuesListFilters): ErrorIssuesListResult {
	// Same inline atom the route used before the swap: filters map straight to the
	// server query, capped to the same limit.
	const issuesQueryAtom = MapleApiAtomClient.query("errors", "listIssues", {
		query: {
			...(filters.workflowState ? { workflowState: filters.workflowState as never } : {}),
			...(filters.severity ? { severity: filters.severity as never } : {}),
			...(filters.kind ? { kind: filters.kind as never } : {}),
			limit: ISSUES_PAGE_LIMIT,
		},
		reactivityKeys: ["errorIssues"],
	})
	return useAtomValue(issuesQueryAtom)
}

function useErrorIssuesListCollection(filters: ErrorIssuesListFilters): ErrorIssuesListResult {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collections = useMemo(
		() => getOrgCollections(orgKey),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: issueRows, isLoading } = useLiveQuery(
		(q) => q.from({ e: collections.errorIssues }),
		[collections.errorIssues],
	)
	const { data: actorRows } = useLiveQuery((q) => q.from({ a: collections.actors }), [collections.actors])
	const { data: incidentRows } = useLiveQuery(
		(q) => q.from({ i: collections.openErrorIncidents }),
		[collections.openErrorIncidents],
	)

	return useMemo<ErrorIssuesListResult>(() => {
		if (isLoading && (issueRows?.length ?? 0) === 0) return Result.initial(true)

		const actorMap = new Map<string, ActorDocument>()
		for (const row of (actorRows ?? []) as ReadonlyArray<ActorRow>) {
			actorMap.set(row.id, rowToActor(row))
		}
		// An issue has an open incident when the open_error_incidents shape (server
		// filters status='open') carries a row for its id.
		const openIssueIds = new Set<string>()
		for (const row of incidentRows ?? []) openIssueIds.add(row.issue_id)

		const issues = ((issueRows ?? []) as ReadonlyArray<ErrorIssueRow>)
			// Client-side mirror of the server's WHERE clause. `error_issues` is
			// already archived-filtered server-side (archived_at IS NULL).
			.filter((row) => {
				if (filters.workflowState && row.workflow_state !== filters.workflowState) return false
				if (filters.severity === "unset") {
					if (row.severity != null) return false
				} else if (filters.severity && row.severity !== filters.severity) {
					return false
				}
				if (filters.kind && row.kind !== filters.kind) return false
				return true
			})
			// Mirror the server order: most recently seen first.
			.toSorted((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : a.last_seen_at > b.last_seen_at ? -1 : 0))
			.slice(0, ISSUES_PAGE_LIMIT)
			.map((row) => rowToIssue(row, openIssueIds.has(row.id), actorMap))

		return Result.success(new ErrorIssuesListResponse({ issues }))
	}, [issueRows, actorRows, incidentRows, isLoading, filters.workflowState, filters.severity, filters.kind])
}

/**
 * Errors-issues list, dispatching at build time on {@link ELECTRIC_SYNC_ENABLED}.
 * The atom branch is the existing inline `errors.listIssues` query; the Electric
 * branch reads the synced `error_issues` + `actors` + `open_error_incidents`
 * collections and reproduces the server's filter/sort/limit + actor + open-incident
 * joins client-side.
 */
export function useErrorIssuesList(filters: ErrorIssuesListFilters): ErrorIssuesListResult {
	if (ELECTRIC_SYNC_ENABLED) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useErrorIssuesListCollection(filters)
	}
	// eslint-disable-next-line react-hooks/rules-of-hooks
	return useErrorIssuesListAtoms(filters)
}
