import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import type { WorkloadKind } from "@/api/warehouse/infra"
import { OptionalStringArrayParam } from "@/lib/search-params"
import { QueryErrorState } from "@/components/common/query-error-state"
import { GridIcon, MagnifierIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { deriveHostStatus, severityLevel } from "@/components/infra/format"
import { WorkloadTable, WorkloadTableLoading, type WorkloadRow } from "@/components/infra/workload-table"
import { WorkloadsFilterSidebarView, type WorkloadFilters } from "@/components/infra/k8s-filter-sidebar"
import { FleetBand, type FleetBandCell } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { listWorkloadsResultAtom, workloadFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"

const DEFAULT_PRESET = "12h"

const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset"])

/** A one-click scope from the band. `undefined` means every workload. */
type WorkloadScope = "saturated" | "elevated" | "stale"
const ScopeParam = Schema.optional(Schema.Literals(["saturated", "elevated", "stale"]))

const workloadsSearchSchema = Schema.Struct({
	kind: Schema.optional(WorkloadKindLiteral),
	// In the URL, like the other two lists, so a filtered view survives a reload.
	q: Schema.optional(Schema.String),
	scope: ScopeParam,
	workloadNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export type WorkloadsSearchParams = Schema.Schema.Type<typeof workloadsSearchSchema>

export const Route = createFileRoute("/infra/kubernetes/workloads/")({
	component: WorkloadsPage,
	validateSearch: Schema.toStandardSchemaV1(workloadsSearchSchema),
})

const KIND_OPTIONS = [
	{ value: "deployment", label: "Deployments" },
	{ value: "statefulset", label: "StatefulSets" },
	{ value: "daemonset", label: "DaemonSets" },
] as const satisfies ReadonlyArray<{ value: WorkloadKind; label: string }>

/**
 * The workload list is average-over-window, not peak: the query aggregates per
 * workload and only carries the mean. So the band says "average", and a
 * workload that spikes without moving its mean stays out of the red here — the
 * pods view is where a spike shows.
 */
function scopeOf(workload: WorkloadRow, referenceTime: string): WorkloadScope | null {
	if (deriveHostStatus(workload.lastSeen, referenceTime) === "ended") return "stale"
	const level = severityLevel(Math.max(workload.avgCpuLimitPct, workload.avgMemoryLimitPct))
	if (level === "crit") return "saturated"
	if (level === "warn") return "elevated"
	return null
}

function WorkloadsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const kind: WorkloadKind = search.kind ?? "deployment"
	const searchText = search.q ?? ""
	const scope = search.scope

	const patchSearch = (patch: Partial<WorkloadsSearchParams>) => {
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const timeSearch = pickTimeRangeSearch(search)

	const filters: WorkloadFilters = {
		workloadNames: search.workloadNames,
		namespaces: search.namespaces,
		clusters: search.clusters,
		environments: search.environments,
		computeTypes: search.computeTypes,
	}

	const wlResult = useAtomValue(listWorkloadsResultAtom({ data: { kind, startTime, endTime, ...filters } }))
	const facetsResult = useAtomValue(workloadFacetsResultAtom({ data: { kind, startTime, endTime } }))

	const onFilterChange = <K extends keyof WorkloadFilters>(key: K, value: WorkloadFilters[K]) => {
		patchSearch({
			[key]: value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
		})
	}

	const onClearFilters = () => {
		void navigate({ search: { ...timeSearch, kind: search.kind } })
	}

	const kindOption = KIND_OPTIONS.find((option) => option.value === kind) ?? KIND_OPTIONS[0]

	return (
		<KubernetesShell
			view="workloads"
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
				<WorkloadsFilterSidebarView
					facetsResult={facetsResult}
					filters={filters}
					workloadLabel={kindOption.label.replace(/s$/, "")}
					onFilterChange={onFilterChange}
					onClearFilters={onClearFilters}
				/>
			}
		>
			{Result.builder(wlResult)
				.onInitial(() => <WorkloadTableLoading />)
				.onError((err) => <QueryErrorState error={err} />)
				.onSuccess((response, result) => {
					const workloads = response.data
					const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)

					if (workloads.length === 0 && !hasStructuredFilter) {
						return (
							<Empty className="py-16">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<GridIcon size={16} />
									</EmptyMedia>
									<EmptyTitle>No workloads reporting yet</EmptyTitle>
									<EmptyDescription>
										Maple aggregates pod metrics by k8s.deployment.name,
										k8s.statefulset.name, and k8s.daemonset.name. Install the Helm chart
										so the k8sattributes processor can enrich pod metrics with workload
										identity.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						)
					}

					// The band counts the whole kind, so it keeps saying what the search
					// and the scope just hid.
					const scoped = workloads.map((workload) => ({
						workload,
						scope: scopeOf(workload, endTime),
					}))
					const count = (target: WorkloadScope) =>
						scoped.filter((entry) => entry.scope === target).length
					const saturated = count("saturated")
					const elevated = count("elevated")
					const stale = count("stale")
					const healthy = Math.max(workloads.length - saturated - elevated, 0)

					const cells: ReadonlyArray<FleetBandCell<WorkloadScope>> = [
						{
							scope: "saturated",
							label: "Saturated",
							hint: "avg ≥90%",
							value: saturated,
							tone: "crit",
						},
						{
							scope: "elevated",
							label: "Elevated",
							hint: "avg ≥60%",
							value: elevated,
							tone: "warn",
						},
						{
							scope: "stale",
							label: "Stale collector",
							hint: ">5m",
							value: stale,
							tone: "neutral",
						},
					]

					const q = searchText.trim().toLowerCase()
					const filtered = scoped
						.filter((entry) => !scope || entry.scope === scope)
						.map((entry) => entry.workload)
						.filter((workload) => !q || workload.workloadName.toLowerCase().includes(q))

					return (
						<div className={`space-y-5 transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
							<FleetBand
								total={workloads.length}
								noun={kindOption.label.slice(0, -1).toLowerCase()}
								caption="share of the fleet by average utilization"
								segments={[
									{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
									{
										key: "elevated",
										count: elevated,
										className: "bg-[var(--severity-warn)]",
									},
									{
										key: "saturated",
										count: saturated,
										className: "bg-[var(--severity-error)]",
									},
								]}
								cells={cells}
								activeScope={scope}
								onScopeChange={(next) => patchSearch({ scope: next })}
								waiting={result.waiting}
							/>
							<div className="space-y-3">
								<ListToolbar
									value={searchText}
									onChange={(value) => patchSearch({ q: value || undefined })}
									placeholder="Search workloads…"
									trailing={countLabel(filtered.length, filtered.length, "workload")}
								>
									<SegmentPivot
										ariaLabel="Workload kind"
										options={KIND_OPTIONS}
										value={kind}
										onChange={(next) =>
											patchSearch({ kind: next, workloadNames: undefined })
										}
									/>
								</ListToolbar>
								{(q || scope) && filtered.length === 0 ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<MagnifierIcon size={16} />
											</EmptyMedia>
											<EmptyTitle>No workloads match</EmptyTitle>
											<EmptyDescription>
												{q
													? `Nothing named “${searchText}” in this scope.`
													: "Nothing in this scope right now — which is good news."}
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : (
									<WorkloadTable
										workloads={filtered}
										kind={kind}
										waiting={result.waiting}
										referenceTime={endTime}
									/>
								)}
							</div>
						</div>
					)
				})
				.render()}
		</KubernetesShell>
	)
}
