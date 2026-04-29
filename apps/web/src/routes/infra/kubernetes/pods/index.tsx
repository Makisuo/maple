import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Input } from "@maple/ui/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FolderIcon, MagnifierIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { PodTable, PodTableLoading, type PodRow } from "@/components/infra/pod-table"
import { PodsFilterSidebarView, type PodFilters } from "@/components/infra/k8s-filter-sidebar"
import { listPodsResultAtom, podFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const podsSearchSchema = Schema.Struct({
	search: Schema.optional(Schema.String),
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
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export type PodsSearchParams = Schema.Schema.Type<typeof podsSearchSchema>

export const Route = effectRoute(createFileRoute("/infra/kubernetes/pods/"))({
	component: PodsPage,
	validateSearch: Schema.toStandardSchemaV1(podsSearchSchema),
})

function PodsPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <PodsPageContent />
}

function PodsPageContent() {
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
	}

	const podsResult = useAtomValue(
		listPodsResultAtom({
			data: {
				startTime,
				endTime,
				search: search.search?.trim() || undefined,
				...filters,
			},
		}),
	)

	const facetsResult = useAtomValue(
		podFacetsResultAtom({
			data: {
				startTime,
				endTime,
				search: search.search?.trim() || undefined,
			},
		}),
	)

	const onFilterChange = <K extends keyof PodFilters>(key: K, value: PodFilters[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
	}

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout
				breadcrumbs={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "Kubernetes" },
					{ label: "Pods" },
				]}
				filterSidebar={
					<PodsFilterSidebarView
						facetsResult={facetsResult}
						filters={filters}
						onFilterChange={onFilterChange}
						onClearFilters={onClearFilters}
					/>
				}
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime ?? startTime}
						endTime={search.endTime ?? endTime}
						presetValue={search.timePreset ?? "12h"}
						onTimeChange={handleTimeChange}
					/>
				}
			>
				<div className="space-y-6">
					<PageHero
						title="Pods"
						description="Per-pod CPU and memory utilization — request and limit thresholds."
					/>
					{Result.builder(podsResult)
						.onInitial(() => <PodTableLoading />)
						.onError((err) => <QueryErrorState error={err} />)
						.onSuccess((response, result) => {
							const pods = response.data as ReadonlyArray<PodRow>
							const hasAnyFilter =
								!!search.search?.trim() ||
								(filters.podNames?.length ?? 0) > 0 ||
								(filters.namespaces?.length ?? 0) > 0 ||
								(filters.nodeNames?.length ?? 0) > 0 ||
								(filters.clusters?.length ?? 0) > 0 ||
								(filters.deployments?.length ?? 0) > 0 ||
								(filters.statefulsets?.length ?? 0) > 0 ||
								(filters.daemonsets?.length ?? 0) > 0 ||
								(filters.jobs?.length ?? 0) > 0 ||
								(filters.environments?.length ?? 0) > 0 ||
								(filters.computeTypes?.length ?? 0) > 0

							if (pods.length === 0 && !hasAnyFilter) {
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
									className={`space-y-4 transition-opacity ${
										result.waiting ? "opacity-60" : ""
									}`}
								>
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div className="relative">
											<MagnifierIcon
												size={12}
												className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
											/>
											<Input
												placeholder="Search pods…"
												value={search.search ?? ""}
												onChange={(e) =>
													navigate({
														search: (prev) => ({
															...prev,
															search: e.target.value || undefined,
														}),
													})
												}
												className="h-8 w-64 pl-7 text-xs"
											/>
										</div>
										<span className="text-xs text-muted-foreground">
											{pods.length} {pods.length === 1 ? "pod" : "pods"}
										</span>
									</div>
									<PodTable pods={pods} waiting={result.waiting} referenceTime={endTime} />
								</div>
							)
						})
						.render()}
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
