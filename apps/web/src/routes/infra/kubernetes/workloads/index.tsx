import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Input } from "@maple/ui/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { GridIcon, MagnifierIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { cn } from "@maple/ui/lib/utils"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { WorkloadTable, WorkloadTableLoading, type WorkloadRow } from "@/components/infra/workload-table"
import { WorkloadsFilterSidebarView, type WorkloadFilters } from "@/components/infra/k8s-filter-sidebar"
import { listWorkloadsResultAtom, workloadFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { WorkloadKind } from "@/api/tinybird/infra"

const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset"])

const workloadsSearchSchema = Schema.Struct({
	kind: Schema.optional(WorkloadKindLiteral),
	search: Schema.optional(Schema.String),
	workloadNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export type WorkloadsSearchParams = Schema.Schema.Type<typeof workloadsSearchSchema>

export const Route = effectRoute(createFileRoute("/infra/kubernetes/workloads/"))({
	component: WorkloadsPage,
	validateSearch: Schema.toStandardSchemaV1(workloadsSearchSchema),
})

function WorkloadsPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <WorkloadsPageContent />
}

const KIND_LABEL: Record<WorkloadKind, string> = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
}

function WorkloadsPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const kind: WorkloadKind = search.kind ?? "deployment"

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const filters: WorkloadFilters = {
		workloadNames: search.workloadNames,
		namespaces: search.namespaces,
		clusters: search.clusters,
		environments: search.environments,
		computeTypes: search.computeTypes,
	}

	const wlResult = useAtomValue(
		listWorkloadsResultAtom({
			data: {
				kind,
				startTime,
				endTime,
				search: search.search?.trim() || undefined,
				...filters,
			},
		}),
	)

	const facetsResult = useAtomValue(
		workloadFacetsResultAtom({
			data: {
				kind,
				startTime,
				endTime,
				search: search.search?.trim() || undefined,
			},
		}),
	)

	const onFilterChange = <K extends keyof WorkloadFilters>(key: K, value: WorkloadFilters[K]) => {
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
				kind: search.kind,
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
					{ label: "Workloads" },
				]}
				filterSidebar={
					<WorkloadsFilterSidebarView
						facetsResult={facetsResult}
						filters={filters}
						workloadLabel={KIND_LABEL[kind]}
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
						title="Workloads"
						description="Aggregated pod metrics by deployment, statefulset, and daemonset."
					/>

					<div className="flex items-center gap-1 rounded-md border bg-background p-0.5 self-start w-fit">
						{(["deployment", "statefulset", "daemonset"] as const).map((k) => {
							const active = kind === k
							return (
								<button
									key={k}
									type="button"
									onClick={() =>
										navigate({
											search: (prev) => ({
												...prev,
												kind: k,
												workloadNames: undefined,
											}),
										})
									}
									className={cn(
										"rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors",
										active
											? "bg-foreground text-background"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{KIND_LABEL[k]}
								</button>
							)
						})}
					</div>

					{Result.builder(wlResult)
						.onInitial(() => <WorkloadTableLoading />)
						.onError((err) => (
							<div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
								<p className="font-medium text-destructive">Failed to load workloads</p>
								<pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
									{err.message}
								</pre>
							</div>
						))
						.onSuccess((response, result) => {
							const wls = response.data as ReadonlyArray<WorkloadRow>
							const hasAnyFilter =
								!!search.search?.trim() ||
								(filters.workloadNames?.length ?? 0) > 0 ||
								(filters.namespaces?.length ?? 0) > 0 ||
								(filters.clusters?.length ?? 0) > 0 ||
								(filters.environments?.length ?? 0) > 0 ||
								(filters.computeTypes?.length ?? 0) > 0

							if (wls.length === 0 && !hasAnyFilter) {
								return (
									<Empty className="py-16">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<GridIcon size={16} />
											</EmptyMedia>
											<EmptyTitle>No workloads reporting yet</EmptyTitle>
											<EmptyDescription>
												Maple aggregates pod metrics by k8s.deployment.name,
												k8s.statefulset.name, and k8s.daemonset.name. Install the Helm
												chart so the k8sattributes processor can enrich pod metrics
												with workload identity.
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
												placeholder="Search…"
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
											{wls.length} {wls.length === 1 ? "workload" : "workloads"}
										</span>
									</div>
									<WorkloadTable
										workloads={wls}
										kind={kind}
										waiting={result.waiting}
										referenceTime={endTime}
									/>
								</div>
							)
						})
						.render()}
				</div>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
