import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { ErrorIssueDocument, IssueKind } from "@maple/domain/http"

import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	getErrorsByTypeResultAtom,
	getErrorsSparkResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { errorIssueFromV2 } from "@/lib/services/error-issues"
import {
	buildErrorSignals,
	indexInvestigationsByIssue,
	sparkFingerprintHashes,
} from "@/lib/models/error-signal"

import {
	ACTIONABLE_VIEWS,
	ErrorsHubView,
	type HubPaging,
	type HubSort,
	type HubView,
	type SeverityFilter,
	viewCovers,
} from "./errors-hub-view"
import { ErrorsStatStrip } from "./errors-stat-strip"

/**
 * The unified errors list, and what feeds it.
 *
 * `/errors` grouped error events by fingerprint and knew nothing about triage;
 * `/errors/issues` listed the same fingerprints from Postgres and knew nothing
 * about volume; investigations sat on a third route. This joins them, so one
 * row answers the whole triage question. See `lib/models/error-signal.ts` for
 * why the fingerprint is the join key and why the issue table is the spine.
 *
 * The list is not a time-range view. It is every issue, newest activity first,
 * paged back through older ones on demand, and every filter is one the issues
 * API applies itself. The only windowed things on the page are the trend, the
 * count and the totals, which look back a fixed `ERRORS_WINDOW`. The one
 * exception is the volume sort, which only the warehouse can answer and so is
 * scoped to that window too (see `warehouseFirst` below).
 *
 * Everything the join produces is handed to `ErrorsHubView`, which is also what
 * `/lab/errors` renders over fixtures.
 */

/**
 * How far back the trend, count and totals look. A day, because a sparkline of
 * the last twelve hours reads as silence for anything that errors nightly, and
 * a week flattens a burst into a tick. Not a URL param: the list does not
 * change with it, and a picker on a list that ignores it is what this replaced.
 */
export const ERRORS_WINDOW = "24h"

/** How many buckets the row sparkline gets. Enough to show a shape, few enough
 *  that a page of them stays cheap to render. */
const SPARK_BUCKETS = 32
/** Rows per page. The v2 list caps at 100; half that keeps a page's sparklines
 *  cheap and puts "Load more" a scroll away rather than a scroll and a half. */
const PAGE_LIMIT = 50
/** How many fingerprints a volume-ranked list considers. Also the URL budget:
 *  these hashes travel to the issues endpoint as a query param. */
const VOLUME_RANK_LIMIT = 100
const INVESTIGATIONS_LIMIT = 100

const NO_CURSORS: ReadonlyArray<string> = []
const NO_HASHES: Array<string> = []

export {
	HUB_SORTS,
	HUB_VIEWS,
	SEVERITY_FILTERS,
	type HubSort,
	type HubView,
	type SeverityFilter,
} from "./errors-hub-view"

export interface ErrorsHubProps {
	view: HubView
	sort: HubSort
	severity: SeverityFilter
	/** The trend window — see `ERRORS_WINDOW`. Warehouse format. */
	range: { startTime: string; endTime: string }
	service?: string
	env?: string
	kind?: IssueKind
	regressed?: boolean
	/** Present while a sidebar filter is on, for the empty state's way out.
	 *  Owned by the route, which is where navigation lives. */
	onClearFilters?: () => void
}

export function ErrorsHub(props: ErrorsHubProps) {
	// The sidebar's service and environment narrow the warehouse side too, so a
	// row's count and trend are about the same slice as the rows themselves.
	// Every span counts: the issue's own occurrence count does not stop at root
	// spans, and a 24h number that did would never add up to it.
	const warehouseFilters = useMemo(
		() => ({
			startTime: props.range.startTime,
			endTime: props.range.endTime,
			services: props.service ? [props.service] : undefined,
			deploymentEnvs: props.env ? [props.env] : undefined,
		}),
		[props.range.startTime, props.range.endTime, props.service, props.env],
	)

	/**
	 * Only the warehouse can rank by occurrences in the window, so the volume
	 * sort goes warehouse-first: rank fingerprints, then ask for exactly those
	 * issues. Everything else is issue-first — Postgres orders, nothing is
	 * capped, and every page is reachable. The cost of warehouse-first is that
	 * the row set is the window's top VOLUME_RANK_LIMIT fingerprints by volume,
	 * paged from there.
	 */
	const warehouseFirst = props.sort === "volume"

	// The ranking is only consulted warehouse-first. A hook cannot be skipped, but an
	// explicit empty fingerprint list is "rank nothing", which `getErrorsByType`
	// answers without a round-trip — so an issue-first page never scans the window.
	const rankData = useMemo(
		() => ({
			...warehouseFilters,
			limit: VOLUME_RANK_LIMIT,
			...(warehouseFirst ? undefined : { fingerprintHashes: NO_HASHES }),
		}),
		[warehouseFilters, warehouseFirst],
	)
	const rankResult = useRefreshableAtomValue(getErrorsByTypeResultAtom({ data: rankData }))
	const rankedHashes = useMemo(
		() =>
			Result.isSuccess(rankResult)
				? (rankResult.value.data ?? []).map((row) => row.fingerprintHash)
				: NO_HASHES,
		[rankResult],
	)
	// A ranking still `waiting` with no rows is not a ranking: it is the previous
	// mode's "rank nothing" answer, or a window that had nothing, kept on screen by
	// retention. Asking the issues endpoint for it fetches an empty page and then
	// the real one. An empty ranking loses nothing by waiting for the fresh one.
	const rankReady =
		!warehouseFirst ||
		(Result.isSuccess(rankResult) && !(rankResult.waiting && rankedHashes.length === 0))

	const listQuery = useMemo(() => {
		return {
			limit: PAGE_LIMIT,
			sort: props.sort === "severity" ? ("severity" as const) : ("last_seen" as const),
			...(props.severity !== "all" ? { severity: props.severity } : undefined),
			...(props.service ? { service_name: props.service } : undefined),
			...(props.env ? { deployment_environment: props.env } : undefined),
			...(props.kind ? { kind: props.kind } : undefined),
			// One state per request is all the API takes, so multi-state views are
			// filtered client-side from the page. `actionable` covers the common
			// triage+active case server-side so that page is the right one; the
			// regression toggle is a single state and replaces it outright.
			...(props.regressed
				? { workflow_state: "regressed" as const }
				: ACTIONABLE_VIEWS.includes(props.view)
					? { actionable: "true" as const }
					: undefined),
			...(warehouseFirst ? { fingerprint_hash: rankedHashes.join(",") } : undefined),
		}
	}, [
		props.view,
		props.sort,
		props.severity,
		props.service,
		props.env,
		props.kind,
		props.regressed,
		warehouseFirst,
		rankedHashes,
	])

	/**
	 * Pages beyond the first, as the cursors that fetched them.
	 *
	 * Keyed by the query they extend: a change of view, sort or filter is a new
	 * list, and the old pages must not be appended to it. Each page is its own
	 * query atom under the `errorIssues` reactivity key, so a triage action on
	 * page three refreshes page three in place rather than collapsing the list
	 * back to page one.
	 */
	const listKey = JSON.stringify(listQuery)
	const [loaded, setLoaded] = useState<{ key: string; cursors: ReadonlyArray<string> }>({
		key: listKey,
		cursors: NO_CURSORS,
	})
	const cursors = loaded.key === listKey ? loaded.cursors : NO_CURSORS

	const pageAtoms = useMemo(() => {
		// Wait for the ranking before asking for issues, or the first render would
		// request an unranked page and then immediately discard it.
		if (!rankReady) return []
		return [undefined, ...cursors].map((cursor) =>
			retainedQueryV2("errorIssues", "list", {
				query: cursor === undefined ? listQuery : { ...listQuery, cursor },
				reactivityKeys: ["errorIssues"],
			}),
		)
	}, [listQuery, cursors, rankReady])

	// One subscription over every open page, however many there are.
	const pagesAtom = useMemo(() => Atom.make((get) => pageAtoms.map((atom) => get(atom))), [pageAtoms])
	const pages = useAtomValue(pagesAtom)
	// Retrying a failed "Load more" refreshes that page's atom; the derived atom
	// stands in only so the hook has something to hold before any page exists.
	const lastPageAtom: Atom.Atom<unknown> = pageAtoms[pageAtoms.length - 1] ?? pagesAtom
	const retryLastPage = useAtomRefresh(lastPageAtom)

	const firstPage = pages[0]
	const lastPage = pages[pages.length - 1]
	const status =
		firstPage === undefined || Result.isInitial(firstPage)
			? "loading"
			: Result.isFailure(firstPage)
				? "failed"
				: "ready"

	const nextCursor =
		lastPage !== undefined && Result.isSuccess(lastPage) && lastPage.value.has_more
			? lastPage.value.next_cursor
			: null
	const loadingMore = pages.length > 1 && lastPage !== undefined && Result.isInitial(lastPage)
	const failedMore = pages.length > 1 && lastPage !== undefined && Result.isFailure(lastPage)

	const paging: HubPaging = {
		state: failedMore ? "failed" : loadingMore ? "loading" : nextCursor !== null ? "more" : "end",
		onLoadMore: () => {
			if (failedMore) {
				retryLastPage()
				return
			}
			if (nextCursor === null || loadingMore || cursors.includes(nextCursor)) return
			setLoaded({ key: listKey, cursors: [...cursors, nextCursor] })
		},
	}

	const issues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
		const byId = new Map<string, ErrorIssueDocument>()
		for (const page of pages) {
			if (!Result.isSuccess(page)) continue
			for (const raw of page.value.data) {
				const issue = errorIssueFromV2(raw)
				// An issue seen again while its page was loading can appear on two
				// pages; it keeps the slot it was first given.
				if (!byId.has(issue.id)) byId.set(issue.id, issue)
			}
		}
		return [...byId.values()].filter((issue) => viewCovers(props.view, issue.workflowState))
	}, [pages, props.view])

	// The warehouse sets follow the rows actually on screen, so a filtered view
	// never pays for fingerprints it will not draw.
	const fingerprintHashes = useMemo(() => sparkFingerprintHashes(issues), [issues])

	// Window counts for the rows on screen, asked for by fingerprint. The ranking
	// only knows the window's top VOLUME_RANK_LIMIT fingerprints, and a
	// recency-ordered list is mostly not those — an issue seen a minute ago would
	// read as quiet in the very window it was just seen in.
	const volumeData = useMemo(
		() => ({
			...warehouseFilters,
			fingerprintHashes: [...fingerprintHashes],
			limit: Math.max(1, fingerprintHashes.length),
		}),
		[warehouseFilters, fingerprintHashes],
	)
	const volumeResult = useRefreshableAtomValue(getErrorsByTypeResultAtom({ data: volumeData }))
	const volumeRows = useMemo(
		() => (Result.isSuccess(volumeResult) ? (volumeResult.value.data ?? []) : []),
		[volumeResult],
	)

	const bucketSeconds = useMemo(() => {
		const startMs = Date.parse(props.range.startTime.replace(" ", "T") + "Z")
		const endMs = Date.parse(props.range.endTime.replace(" ", "T") + "Z")
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 3600
		return Math.max(60, Math.round((endMs - startMs) / 1000 / SPARK_BUCKETS))
	}, [props.range.startTime, props.range.endTime])

	const sparkResult = useRefreshableAtomValue(
		getErrorsSparkResultAtom({
			data: { ...warehouseFilters, fingerprintHashes: [...fingerprintHashes], bucketSeconds },
		}),
	)

	const investigationsResult = useAtomValue(
		retainedQueryV2("investigations", "list", {
			query: { limit: INVESTIGATIONS_LIMIT },
			reactivityKeys: ["investigations"],
		}),
	)

	const signals = useMemo(
		() =>
			buildErrorSignals({
				issues,
				warehouse: volumeRows,
				spark: Result.isSuccess(sparkResult) ? (sparkResult.value.data ?? []) : [],
				investigations: indexInvestigationsByIssue(
					Result.isSuccess(investigationsResult) ? investigationsResult.value.data : [],
				),
			}),
		[issues, volumeRows, sparkResult, investigationsResult],
	)

	const sparkWindow = useMemo(() => {
		const startMs = Date.parse(props.range.startTime.replace(" ", "T") + "Z")
		const endMs = Date.parse(props.range.endTime.replace(" ", "T") + "Z")
		return {
			startMs: Number.isFinite(startMs) ? startMs : 0,
			endMs: Number.isFinite(endMs) ? endMs : 0,
			bucketMs: bucketSeconds * 1000,
		}
	}, [props.range.startTime, props.range.endTime, bucketSeconds])

	const navigate = useNavigate()
	const setSearch = (patch: Record<string, unknown>) => {
		navigate({ to: "/errors", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) })
	}

	return (
		<ErrorsHubView
			status={status}
			signals={signals}
			sparkWindow={sparkWindow}
			view={props.view}
			sort={props.sort}
			severity={props.severity}
			onViewChange={(value) => setSearch({ view: value === "open" ? undefined : value })}
			onSortChange={(value) => setSearch({ sort: value === "last_seen" ? undefined : value })}
			onSeverityChange={(value) => setSearch({ severity: value === "all" ? undefined : value })}
			stats={<ErrorsStatStrip filters={warehouseFilters} />}
			paging={paging}
			onClearFilters={props.onClearFilters}
			onRetry={() => window.location.reload()}
		/>
	)
}
