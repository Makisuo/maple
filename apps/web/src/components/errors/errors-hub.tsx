import { useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { ErrorIssueDocument } from "@maple/domain/http"
import { warehouseDateTimeToIso } from "@maple/query-engine"

import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomValue } from "@/lib/effect-atom"
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
 * Everything the join produces is handed to `ErrorsHubView`, which is also what
 * `/lab/errors` renders over fixtures.
 */

/** How many buckets the row sparkline gets. Enough to show a shape, few enough
 *  that 50 of them stay cheap to render. */
const SPARK_BUCKETS = 32
const PAGE_LIMIT = 100

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
	range: { startTime: string; endTime: string }
	services?: ReadonlyArray<string>
	deploymentEnvs?: ReadonlyArray<string>
	errorTypes?: ReadonlyArray<string>
	serviceVersions?: ReadonlyArray<string>
	excludedServices?: ReadonlyArray<string>
	excludedDeploymentEnvs?: ReadonlyArray<string>
	excludedErrorTypes?: ReadonlyArray<string>
	excludedServiceVersions?: ReadonlyArray<string>
	/** Drops every excluded* param at once, for the empty state's hint. Owned by the route, which
	 *  is where navigation lives. */
	onClearExclusions: () => void
	rootOnly?: boolean
	showSpam?: boolean
}

export function ErrorsHub(props: ErrorsHubProps) {
	// Volume-ranked lists run warehouse-first: rank fingerprints by occurrences
	// in the window, then fetch exactly those issues. The other sorts run
	// issue-first, because Postgres already orders them and the warehouse only
	// knows about the window.
	const warehouseFilters = useMemo(
		() => ({
			startTime: props.range.startTime,
			endTime: props.range.endTime,
			services: props.services ? [...props.services] : undefined,
			deploymentEnvs: props.deploymentEnvs ? [...props.deploymentEnvs] : undefined,
			errorLabels: props.errorTypes ? [...props.errorTypes] : undefined,
			serviceVersions: props.serviceVersions ? [...props.serviceVersions] : undefined,
			excludedServices: props.excludedServices ? [...props.excludedServices] : undefined,
			excludedDeploymentEnvs: props.excludedDeploymentEnvs
				? [...props.excludedDeploymentEnvs]
				: undefined,
			excludedErrorLabels: props.excludedErrorTypes ? [...props.excludedErrorTypes] : undefined,
			excludedServiceVersions: props.excludedServiceVersions
				? [...props.excludedServiceVersions]
				: undefined,
			showSpam: props.showSpam,
			rootOnly: props.rootOnly !== false,
			limit: PAGE_LIMIT,
		}),
		[
			props.range.startTime,
			props.range.endTime,
			props.services,
			props.deploymentEnvs,
			props.errorTypes,
			props.serviceVersions,
			props.excludedServices,
			props.excludedDeploymentEnvs,
			props.excludedErrorTypes,
			props.excludedServiceVersions,
			props.showSpam,
			props.rootOnly,
		],
	)

	const volumeResult = useRefreshableAtomValue(getErrorsByTypeResultAtom({ data: warehouseFilters }))
	const volumeRows = Result.isSuccess(volumeResult) ? (volumeResult.value.data ?? []) : []

	const isVolumeSort = props.sort === "volume"

	/**
	 * The sidebar filters (service, environment, error type, version) are
	 * warehouse columns — Postgres has no idea which deploy an issue was seen on.
	 * The only way they can filter the ROWS, rather than just the ranking, is to
	 * resolve them to a fingerprint set here and ask for exactly those issues.
	 *
	 * So the list goes warehouse-first whenever a facet is active, and stays
	 * issue-first (Postgres orders, no cap) when nothing is filtered. The cost of
	 * warehouse-first is that the row set is capped to the window's top
	 * PAGE_LIMIT fingerprints by volume — which is also the URL budget, since
	 * these hashes travel as a query param.
	 */
	// An empty list under an exclusion cannot explain itself — see `ExcludedEmptyHint`.
	const excludedValues = [
		...(props.excludedServices ?? []),
		...(props.excludedDeploymentEnvs ?? []),
		...(props.excludedErrorTypes ?? []),
		...(props.excludedServiceVersions ?? []),
	]

	// Exclusions count here too. They are warehouse predicates like the rest, so a page left
	// issue-first would order by Postgres and never apply them — the excluded rows would simply
	// stay on screen.
	const hasFacetFilter =
		(props.services?.length ?? 0) > 0 ||
		(props.deploymentEnvs?.length ?? 0) > 0 ||
		(props.errorTypes?.length ?? 0) > 0 ||
		(props.serviceVersions?.length ?? 0) > 0 ||
		(props.excludedServices?.length ?? 0) > 0 ||
		(props.excludedDeploymentEnvs?.length ?? 0) > 0 ||
		(props.excludedErrorTypes?.length ?? 0) > 0 ||
		(props.excludedServiceVersions?.length ?? 0) > 0
	const warehouseFirst = isVolumeSort || hasFacetFilter
	// Wait for the ranking before asking for issues, or the first render would
	// request an unfiltered page and then immediately discard it.
	const volumeReady = !warehouseFirst || Result.isSuccess(volumeResult)

	const listQuery = useMemo(() => {
		return {
			limit: PAGE_LIMIT,
			// The page's range is warehouse format ("YYYY-MM-DD HH:mm:ss"); the v2
			// contract takes ISO. Handing the raw range over fails to encode, and
			// the request never leaves the browser.
			start_time: warehouseDateTimeToIso(props.range.startTime),
			end_time: warehouseDateTimeToIso(props.range.endTime),
			sort: props.sort === "severity" ? ("severity" as const) : ("last_seen" as const),
			...(props.severity !== "all" ? { severity: props.severity } : undefined),
			// One state per request is all the API takes, so multi-state views are
			// filtered client-side from the window's page. `actionable` covers the
			// common triage+active case server-side so that page is the right one.
			...(ACTIONABLE_VIEWS.includes(props.view) ? { actionable: "true" as const } : undefined),
			...(warehouseFirst && volumeReady
				? { fingerprint_hash: volumeRows.map((row) => row.fingerprintHash).join(",") }
				: undefined),
		}
	}, [
		props.view,
		props.sort,
		props.severity,
		props.range.startTime,
		props.range.endTime,
		warehouseFirst,
		volumeReady,
		volumeRows,
	])

	const issuesResult = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: listQuery,
			reactivityKeys: ["errorIssues"],
		}),
	)

	const issues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
		if (!Result.isSuccess(issuesResult)) return []
		const all = issuesResult.value.data.map(errorIssueFromV2)
		return all.filter((issue) => viewCovers(props.view, issue.workflowState))
	}, [issuesResult, props.view])

	// The sparkline set follows the rows actually on screen, so a filtered view
	// never pays for fingerprints it will not draw.
	const fingerprintHashes = useMemo(() => sparkFingerprintHashes(issues), [issues])

	const bucketSeconds = useMemo(() => {
		const startMs = Date.parse(props.range.startTime.replace(" ", "T") + "Z")
		const endMs = Date.parse(props.range.endTime.replace(" ", "T") + "Z")
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 3600
		return Math.max(60, Math.round((endMs - startMs) / 1000 / SPARK_BUCKETS))
	}, [props.range.startTime, props.range.endTime])

	const sparkResult = useRefreshableAtomValue(
		getErrorsSparkResultAtom({
			data: {
				fingerprintHashes: [...fingerprintHashes],
				startTime: props.range.startTime,
				endTime: props.range.endTime,
				services: props.services ? [...props.services] : undefined,
				deploymentEnvs: props.deploymentEnvs ? [...props.deploymentEnvs] : undefined,
				errorLabels: props.errorTypes ? [...props.errorTypes] : undefined,
				serviceVersions: props.serviceVersions ? [...props.serviceVersions] : undefined,
				excludedServices: props.excludedServices ? [...props.excludedServices] : undefined,
				excludedDeploymentEnvs: props.excludedDeploymentEnvs
					? [...props.excludedDeploymentEnvs]
					: undefined,
				excludedErrorLabels: props.excludedErrorTypes ? [...props.excludedErrorTypes] : undefined,
				excludedServiceVersions: props.excludedServiceVersions
					? [...props.excludedServiceVersions]
					: undefined,
				bucketSeconds,
			},
		}),
	)

	const investigationsResult = useAtomValue(
		retainedQueryV2("investigations", "list", {
			query: { limit: PAGE_LIMIT },
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
			status={
				Result.isInitial(issuesResult)
					? "loading"
					: Result.isFailure(issuesResult)
						? "failed"
						: "ready"
			}
			signals={signals}
			sparkWindow={sparkWindow}
			view={props.view}
			sort={props.sort}
			severity={props.severity}
			onViewChange={(value) => setSearch({ view: value === "open" ? undefined : value })}
			onSortChange={(value) => setSearch({ sort: value === "volume" ? undefined : value })}
			onSeverityChange={(value) => setSearch({ severity: value === "all" ? undefined : value })}
			stats={<ErrorsStatStrip filters={warehouseFilters} />}
			excludedValues={excludedValues}
			onClearExclusions={props.onClearExclusions}
			onRetry={() => window.location.reload()}
		/>
	)
}
