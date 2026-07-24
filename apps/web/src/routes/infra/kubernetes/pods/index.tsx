import { useState } from "react"
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FolderIcon, MagnifierIcon, XmarkIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { PodTable, PodTableLoading } from "@/components/infra/pod-table"
import { PodHoneycomb } from "@/components/infra/pod-honeycomb"
import { PodsFilterSidebarView, type PodFilters } from "@/components/infra/k8s-filter-sidebar"
import { listPodsResultAtom, podFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const podsSearchSchema = Schema.Struct({
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

export const Route = createFileRoute("/infra/kubernetes/pods/")({
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
	const [searchText, setSearchText] = useState("")

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
				...filters,
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
		setSearchText("")
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
						presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
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
							const pods = response.data
							const hasStructuredFilter =
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

							if (pods.length === 0 && !hasStructuredFilter) {
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

							const q = searchText.trim().toLowerCase()
							const filtered = q
								? pods.filter((p) => p.podName.toLowerCase().includes(q))
								: pods

							return (
								<div
									className={`space-y-4 transition-opacity ${
										result.waiting ? "opacity-60" : ""
									}`}
								>
									{filtered.length >= 4 && (
										<PodHoneycomb pods={filtered} referenceTime={endTime} />
									)}
									<div className="flex flex-wrap items-center justify-between gap-3">
										<InputGroup className="w-64">
											<InputGroupAddon>
												<MagnifierIcon />
											</InputGroupAddon>
											<InputGroupInput
												size="sm"
												placeholder="Search pods…"
												value={searchText}
												onChange={(e) => setSearchText(e.target.value)}
											/>
											{searchText && (
												<InputGroupAddon align="inline-end">
													<InputGroupButton
														aria-label="Clear search"
														onClick={() => setSearchText("")}
													>
														<XmarkIcon />
													</InputGroupButton>
												</InputGroupAddon>
											)}
										</InputGroup>
										<span className="text-xs text-muted-foreground">
											{filtered.length} {filtered.length === 1 ? "pod" : "pods"}
										</span>
									</div>
									{q && filtered.length === 0 ? (
										<Empty className="py-12">
											<EmptyHeader>
												<EmptyMedia variant="icon">
													<MagnifierIcon size={16} />
												</EmptyMedia>
												<EmptyTitle>No pods match “{searchText}”</EmptyTitle>
												<EmptyDescription>
													Try a different name, or clear the search to see all pods.
												</EmptyDescription>
											</EmptyHeader>
										</Empty>
									) : (
										<PodTable
											pods={filtered}
											waiting={result.waiting}
											referenceTime={endTime}
										/>
									)}
								</div>
							)
						})
						.render()}
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
