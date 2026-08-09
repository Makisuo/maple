/**
 * The investigation detail page's data, live.
 *
 * This replaced `MapleApiV2AtomClient.query("investigations", "retrieve")` plus a
 * 3s `useIntervalRefresh`. Two Electric shapes — the investigation row and its
 * lens lanes — are recombined into the same `V2Investigation` the page already
 * rendered, so every consumer below it is unchanged; what changed is that a lane
 * reaching `checking`, a progress note, or the verdict landing now arrives when
 * it happens rather than on the next tick.
 */
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import type { V2Investigation } from "@maple/domain/http/v2"

import { getInvestigationCollections } from "@/lib/collections/investigation-collections"
import { useCollectionLoadFailed } from "@/lib/collections/collection-load"
import { useActiveOrgId, useCollectionsGeneration } from "@/lib/collections/org-collections"
import { rowsToInvestigation } from "@/lib/collections/investigations"

export type InvestigationSync =
	| { readonly state: "loading" }
	/** The shapes synced and the org has no such investigation — a real 404. */
	| { readonly state: "missing" }
	/** The stream gave up, or never loaded. Distinct from "no such row". */
	| { readonly state: "failed" }
	| { readonly state: "ready"; readonly investigation: V2Investigation }

export function useInvestigation(investigationId: string): InvestigationSync {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collections = useMemo(
		() => getInvestigationCollections(orgKey, investigationId),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation, investigationId],
	)

	const { data: rows, isLoading: rowLoading } = useLiveQuery(
		(q) => q.from({ i: collections.investigation }),
		[collections],
	)
	const { data: lenses, isLoading: lensLoading } = useLiveQuery(
		(q) => q.from({ l: collections.lensRuns }),
		[collections],
	)

	const isLoading = rowLoading || lensLoading
	const rowFailed = useCollectionLoadFailed(collections.investigation.id, rowLoading)
	const lensFailed = useCollectionLoadFailed(collections.lensRuns.id, lensLoading)

	return useMemo((): InvestigationSync => {
		if (rowFailed || lensFailed) return { state: "failed" }
		if (isLoading) return { state: "loading" }
		// The shape is already narrowed to this id server-side, so this is a
		// presence check rather than a lookup — but it stays a `find` so a stale
		// row from a previous scope could never be rendered as this one.
		const row = (rows ?? []).find((candidate) => candidate.id === investigationId)
		if (!row) return { state: "missing" }
		const investigation = rowsToInvestigation(row, lenses ?? [])
		// A row that will not decode is a data problem, not a missing investigation
		// — "failed" keeps the retry affordance instead of claiming it is gone.
		if (investigation === null) return { state: "failed" }
		return { state: "ready", investigation }
	}, [rows, lenses, isLoading, rowFailed, lensFailed, investigationId])
}
