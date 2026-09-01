import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { useDebouncedValue } from "@maple/ui/hooks/use-debounced-value"

import type { PodSortKey, SortDirection } from "@/api/warehouse/infra"
import { OptionalStringArrayParam } from "@/lib/search-params"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FolderIcon, MagnifierIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { PodPeekSheet } from "@/components/infra/kubernetes/pod-peek-sheet"
import { PodsFilterSidebarView, type PodFilters } from "@/components/infra/k8s-filter-sidebar"
import { PodTable, PodTableLoading, podKey } from "@/components/infra/pod-table"
import { FleetBand, FleetBandLoading, type FleetBandCell } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import { podFilterChips } from "@/lib/infra/pod-filter-chips"
import {
	listPodsResultAtom,
	podFacetsResultAtom,
	podsSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"

const PAGE_SIZE = 50
const DEFAULT_PRESET = "12h"

/** A one-click scope from the band. `undefined` means the whole fleet. */
type PodScope = "saturated" | "elevated" | "unbounded" | "stale"

const PodSortKeyParam = Schema.optional(
	Schema.Literals(["saturation", "cpuUsage", "cpuLimitPct", "memoryLimitPct", "podName", "lastSeen"]),
)
const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))
const ScopeParam = Schema.optional(Schema.Literals(["saturated", "elevated", "unbounded", "stale"]))

const podsSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: ScopeParam,
	sortBy: PodSortKeyParam,
	sortDir: SortDirParam,
	/** The row open in the peek sheet, as `namespace/pod`. In the URL so it survives a reload and a share. */
	peek: Schema.optional(Schema.String),
	podNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	deployments: OptionalStringArrayParam,
	statefulsets: OptionalStringArrayParam,
	daemonsets: OptionalStringArrayParam,
	jobs: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	excludedPodNames: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedNodeNames: OptionalStringArrayParam,
	excludedClusters: OptionalStringArrayParam,
	excludedDeployments: OptionalStringArrayParam,
	excludedStatefulsets: OptionalStringArrayParam,
	excludedDaemonsets: OptionalStringArrayParam,
	excludedJobs: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	excludedComputeTypes: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export type PodsSearchParams = Schema.Schema.Type<typeof podsSearchSchema>

export const Route = createFileRoute("/infra/kubernetes/pods/")({
	component: PodsPage,
	validateSearch: Schema.toStandardSchemaV1(podsSearchSchema),
})

const SCOPE_LABEL: Record<PodScope, string> = {
	saturated: "at or above 90% of a limit",
	elevated: "at or above 60% of a limit",
	unbounded: "running with no limits set",
	stale: "whose collector has gone quiet",
} satisfies Record<PodScope, string>

function PodsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const timeSearch = pickTimeRangeSearch(search)

	const filters: PodFilters = {
		podNames: search.podNames,
		namespaces: search.namespaces,
		nodeNames: search.nodeNames,
		clusters: search.clusters,
		deployments: search.deployments,
		statefulsets: search.statefulsets,
		daemonsets: search.daemonsets,
		jobs: search.jobs,
		environments: search.environments,
		computeTypes: search.computeTypes,
		excludedPodNames: search.excludedPodNames,
		excludedNamespaces: search.excludedNamespaces,
		excludedNodeNames: search.excludedNodeNames,
		excludedClusters: search.excludedClusters,
		excludedDeployments: search.excludedDeployments,
		excludedStatefulsets: search.excludedStatefulsets,
		excludedDaemonsets: search.excludedDaemonsets,
		excludedJobs: search.excludedJobs,
		excludedEnvironments: search.excludedEnvironments,
		excludedComputeTypes: search.excludedComputeTypes,
	}

	const sortBy: PodSortKey = search.sortBy ?? "saturation"
	const sortDir: SortDirection = search.sortDir ?? (sortBy === "podName" ? "asc" : "desc")
	const scope = search.scope
	// The server filters by name, so typing must not fire a query per keystroke.
	const searchText = search.q ?? ""
	const debouncedSearch = useDebouncedValue(searchText, 300)

	const podsResult = useAtomValue(
		listPodsResultAtom({
			data: {
				startTime,
				endTime,
				...filters,
				search: debouncedSearch.trim() || undefined,
				scope,
				sortBy,
				sortDir,
				limit: PAGE_SIZE,
			},
		}),
	)

	// Scope-only: the band is what tells you how much of the fleet the filters
	// hid, so narrowing it by those same filters would defeat the point.
	const summaryResult = useAtomValue(
		podsSummaryResultAtom({
			data: {
				startTime,
				endTime,
				clusters: filters.clusters,
				environments: filters.environments,
				namespaces: filters.namespaces,
			},
		}),
	)

	const facetsResult = useAtomValue(podFacetsResultAtom({ data: { startTime, endTime } }))

	const patchSearch = (patch: Partial<PodsSearchParams>, options?: { replace?: boolean }) => {
		void navigate({ replace: options?.replace, search: (prev) => ({ ...prev, ...patch }) })
	}

	const onFilterChange = <K extends keyof PodFilters>(key: K, value: PodFilters[K]) => {
		patchSearch({
			[key]: value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
		})
	}

	const onClearFilters = () => {
		void navigate({ search: timeSearch })
	}

	// Clicking a header cycles desc → asc on the same key, and starts a new key at
	// the direction that puts the interesting rows first.
	const onSortChange = (key: PodSortKey) => {
		if (key === sortBy) {
			patchSearch({ sortDir: sortDir === "desc" ? "asc" : "desc" })
			return
		}
		patchSearch({ sortBy: key, sortDir: key === "podName" ? "asc" : "desc" })
	}

	const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)
	const hasAnyNarrowing = hasStructuredFilter || Boolean(searchText.trim()) || Boolean(scope)

	// The peek resolves against the page that's on screen. A key that no longer
	// matches a row (the filter changed under it) just means the sheet is closed.
	const pods = Result.builder(podsResult)
		.onSuccess((response) => response.data)
		.orElse(() => [])
	const peekIndex = search.peek ? pods.findIndex((pod) => podKey(pod) === search.peek) : -1
	const peekPod = peekIndex >= 0 ? (pods[peekIndex] ?? null) : null
	// Stepping and closing replace history: walking fifty rows must not leave
	// fifty entries behind the back button.
	const stepPeek = (delta: 1 | -1) => {
		const next = pods[peekIndex + delta]
		if (next) patchSearch({ peek: podKey(next) }, { replace: true })
	}

	return (
		<KubernetesShell
			view="pods"
			timeSearch={search}
			startTime={startTime}
			endTime={endTime}
			defaultPreset={DEFAULT_PRESET}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
			filters={
				<PodsFilterSidebarView
					facetsResult={facetsResult}
					filters={filters}
					onFilterChange={onFilterChange}
					onClearFilters={onClearFilters}
				/>
			}
		>
			<div className="space-y-5">
				{Result.builder(summaryResult)
					.onInitial(() => <FleetBandLoading cells={4} />)
					.onError(() => null)
					.onSuccess((counts, result) => {
						const cells: ReadonlyArray<FleetBandCell<PodScope>> = [
							{
								scope: "saturated",
								label: "Saturated",
								hint: "≥90%",
								value: counts.saturatedPods,
								tone: "crit",
							},
							{
								scope: "elevated",
								label: "Elevated",
								hint: "≥60%",
								value: counts.elevatedPods,
								tone: "warn",
							},
							{
								scope: "unbounded",
								label: "No limits set",
								hint: "unbounded",
								value: counts.unboundedPods,
								tone: "warn",
							},
							{
								scope: "stale",
								label: "Stale collector",
								hint: ">5m",
								value: counts.stalePods,
								tone: "neutral",
							},
						]
						const healthy = Math.max(
							counts.totalPods - counts.saturatedPods - counts.elevatedPods,
							0,
						)
						return (
							<FleetBand
								total={counts.totalPods}
								noun="pod"
								caption="share of the fleet by peak utilization"
								segments={[
									{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
									{
										key: "elevated",
										count: counts.elevatedPods,
										className: "bg-[var(--severity-warn)]",
									},
									{
										key: "saturated",
										count: counts.saturatedPods,
										className: "bg-[var(--severity-error)]",
									},
								]}
								cells={cells}
								activeScope={scope}
								onScopeChange={(next) => patchSearch({ scope: next, peek: undefined })}
								waiting={result.waiting}
							/>
						)
					})
					.render()}

				{Result.builder(podsResult)
					.onInitial(() => <PodTableLoading />)
					.onError((err) => <QueryErrorState error={err} />)
					.onSuccess((response, result) => {
						const page = response.data
						const total = response.totalCount

						if (page.length === 0 && !hasAnyNarrowing) {
							return (
								<Empty className="py-16">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<FolderIcon size={16} />
										</EmptyMedia>
										<EmptyTitle>No pods reporting yet</EmptyTitle>
										<EmptyDescription>
											Install the Maple Kubernetes Helm chart so the kubelet stats
											receiver can start collecting per-pod CPU and memory metrics.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							)
						}

						return (
							<div
								className={`space-y-3 transition-opacity ${result.waiting ? "opacity-60" : ""}`}
							>
								<ListToolbar
									value={searchText}
									onChange={(value) => patchSearch({ q: value || undefined })}
									placeholder="Search all pods…"
									trailing={countLabel(page.length, total, "pod")}
								/>

								<ActiveFilterChips
									className="mb-0"
									chips={podFilterChips(search).map((chip) => ({
										id: chip.param,
										label: chip.label,
										values: chip.values,
										negated: chip.negated,
										onRemove: () => patchSearch({ [chip.param]: undefined }),
									}))}
								/>

								{page.length === 0 ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<MagnifierIcon size={16} />
											</EmptyMedia>
											<EmptyTitle>No pods match these filters</EmptyTitle>
											<EmptyDescription>
												{scope
													? `Nothing is ${SCOPE_LABEL[scope]} in this window — which is good news.`
													: "Try a different name, or clear the filters to see the whole fleet."}
											</EmptyDescription>
										</EmptyHeader>
										<Button variant="outline" size="sm" onClick={onClearFilters}>
											Clear all filters
										</Button>
									</Empty>
								) : (
									<PodTable
										pods={page}
										sortBy={sortBy}
										sortDir={sortDir}
										onSortChange={onSortChange}
										onPeek={(pod) => patchSearch({ peek: podKey(pod) })}
										activeKey={search.peek}
										timeSearch={timeSearch}
										waiting={result.waiting}
										referenceTime={endTime}
									/>
								)}
							</div>
						)
					})
					.render()}
			</div>

			<PodPeekSheet
				pod={peekPod}
				position={peekPod ? { index: peekIndex, count: pods.length } : null}
				onStep={stepPeek}
				onClose={() => patchSearch({ peek: undefined }, { replace: true })}
				startTime={startTime}
				endTime={endTime}
				timeSearch={timeSearch}
				referenceTime={endTime}
			/>
		</KubernetesShell>
	)
}
