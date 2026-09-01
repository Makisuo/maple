import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FolderIcon, MagnifierIcon, XmarkIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { PodTable, PodTableLoading } from "@/components/infra/pod-table"
import { PodSummaryBand, PodSummaryBandLoading, type PodScope } from "@/components/infra/pod-summary-band"
import { PodsFilterSidebarView, type PodFilters } from "@/components/infra/k8s-filter-sidebar"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { podFilterChips } from "@/lib/infra/pod-filter-chips"
import {
	listPodsResultAtom,
	podFacetsResultAtom,
	podsSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useDebouncedValue } from "@maple/ui/hooks/use-debounced-value"
import type { PodSortKey, SortDirection } from "@/api/warehouse/infra"

const PAGE_SIZE = 50

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
		search.timePreset ?? "12h",
	)

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
	// above hid, so narrowing it by those same filters would defeat the point.
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

	const facetsResult = useAtomValue(
		podFacetsResultAtom({
			data: {
				startTime,
				endTime,
			},
		}),
	)

	const patchSearch = (patch: Partial<PodsSearchParams>) => {
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const onFilterChange = <K extends keyof PodFilters>(key: K, value: PodFilters[K]) => {
		void navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onClearFilters = () => {
		void navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
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

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		void navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)
	const hasAnyNarrowing = hasStructuredFilter || Boolean(searchText.trim()) || Boolean(scope)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Kubernetes" },
						{ label: "Pods" },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<PodsFilterSidebarView
							facetsResult={facetsResult}
							filters={filters}
							onFilterChange={onFilterChange}
							onClearFilters={onClearFilters}
						/>
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="Pods"
									description="Sorted worst-first by peak utilization against the pod's own limits."
								/>

								<ActiveFilterChips
									chips={podFilterChips(search).map((chip) => ({
										id: chip.param,
										label: chip.label,
										values: chip.values,
										negated: chip.negated,
										onRemove: () =>
											void navigate({
												search: (prev) => ({ ...prev, [chip.param]: undefined }),
											}),
									}))}
								/>

								{Result.builder(summaryResult)
									.onInitial(() => <PodSummaryBandLoading />)
									.onError(() => null)
									.onSuccess((counts, result) => (
										<PodSummaryBand
											counts={counts}
											activeScope={scope}
											onScopeChange={(next) => patchSearch({ scope: next })}
											waiting={result.waiting}
										/>
									))
									.render()}

								{Result.builder(podsResult)
									.onInitial(() => <PodTableLoading />)
									.onError((err) => <QueryErrorState error={err} />)
									.onSuccess((response, result) => {
										const pods = response.data
										const total = response.totalCount

										if (pods.length === 0 && !hasAnyNarrowing) {
											return (
												<Empty className="py-16">
													<EmptyHeader>
														<EmptyMedia variant="icon">
															<FolderIcon size={16} />
														</EmptyMedia>
														<EmptyTitle>No pods reporting yet</EmptyTitle>
														<EmptyDescription>
															Install the Maple Kubernetes Helm chart so the
															kubelet stats receiver can start collecting
															per-pod CPU and memory metrics.
														</EmptyDescription>
													</EmptyHeader>
												</Empty>
											)
										}

										return (
											<div
												className={`space-y-4 transition-opacity ${
													result.waiting ? "opacity-60" : ""
												}`}
											>
												<div className="flex flex-wrap items-center justify-between gap-3">
													<InputGroup className="w-64">
														<InputGroupAddon>
															<MagnifierIcon />
														</InputGroupAddon>
														<InputGroupInput
															size="sm"
															placeholder="Search all pods…"
															value={searchText}
															onChange={(e) =>
																patchSearch({
																	q: e.target.value || undefined,
																})
															}
														/>
														{searchText && (
															<InputGroupAddon align="inline-end">
																<InputGroupButton
																	aria-label="Clear search"
																	onClick={() =>
																		patchSearch({ q: undefined })
																	}
																>
																	<XmarkIcon />
																</InputGroupButton>
															</InputGroupAddon>
														)}
													</InputGroup>
													{/* The count is the truth, not the page size. */}
													<span className="text-xs text-muted-foreground tabular-nums">
														{total > pods.length
															? `Top ${pods.length} of ${total.toLocaleString()} pods`
															: `${total.toLocaleString()} ${total === 1 ? "pod" : "pods"}`}
													</span>
												</div>

												{pods.length === 0 ? (
													<Empty className="py-12">
														<EmptyHeader>
															<EmptyMedia variant="icon">
																<MagnifierIcon size={16} />
															</EmptyMedia>
															<EmptyTitle>
																No pods match these filters
															</EmptyTitle>
															<EmptyDescription>
																{scope
																	? `Nothing is ${SCOPE_LABEL[scope]} in this window — which is good news.`
																	: "Try a different name, or clear the filters to see the whole fleet."}
															</EmptyDescription>
														</EmptyHeader>
														<Button
															variant="outline"
															size="sm"
															onClick={onClearFilters}
														>
															Clear all filters
														</Button>
													</Empty>
												) : (
													<PodTable
														pods={pods}
														sortBy={sortBy}
														sortDir={sortDir}
														onSortChange={onSortChange}
														waiting={result.waiting}
														referenceTime={endTime}
													/>
												)}
											</div>
										)
									})
									.render()}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
