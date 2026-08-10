import { Result } from "@/lib/effect-atom"

import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import type { PodFacetsResponse, NodeFacetsResponse, WorkloadFacetsResponse } from "@maple/domain/http"

// Pods

export interface PodFilters {
	podNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	deployments?: ReadonlyArray<string>
	statefulsets?: ReadonlyArray<string>
	daemonsets?: ReadonlyArray<string>
	jobs?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
}

interface PodsFilterSidebarViewProps {
	facetsResult: Result.Result<PodFacetsResponse, unknown>
	filters: PodFilters
	onFilterChange: <K extends keyof PodFilters>(key: K, value: PodFilters[K]) => void
	onClearFilters: () => void
}

export function PodsFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: PodsFilterSidebarViewProps) {
	const hasActiveFilters =
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

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={6} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title="Pod"
							options={f.pods}
							selected={filters.podNames ?? []}
							onChange={(val) => onFilterChange("podNames", val)}
							defaultOpen
						/>
						<FilterSection
							title="Namespace"
							options={f.namespaces}
							selected={filters.namespaces ?? []}
							onChange={(val) => onFilterChange("namespaces", val)}
						/>
						<SearchableFilterSection
							title="Node"
							options={f.nodes}
							selected={filters.nodeNames ?? []}
							onChange={(val) => onFilterChange("nodeNames", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Cluster"
							options={f.clusters}
							selected={filters.clusters ?? []}
							onChange={(val) => onFilterChange("clusters", val)}
							defaultOpen={false}
						/>
						<SearchableFilterSection
							title="Deployment"
							options={f.deployments}
							selected={filters.deployments ?? []}
							onChange={(val) => onFilterChange("deployments", val)}
							defaultOpen={false}
						/>
						<SearchableFilterSection
							title="StatefulSet"
							options={f.statefulsets}
							selected={filters.statefulsets ?? []}
							onChange={(val) => onFilterChange("statefulsets", val)}
							defaultOpen={false}
						/>
						<SearchableFilterSection
							title="DaemonSet"
							options={f.daemonsets}
							selected={filters.daemonsets ?? []}
							onChange={(val) => onFilterChange("daemonsets", val)}
							defaultOpen={false}
						/>
						<SearchableFilterSection
							title="Job"
							options={f.jobs}
							selected={filters.jobs ?? []}
							onChange={(val) => onFilterChange("jobs", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Environment"
							options={f.environments}
							selected={filters.environments ?? []}
							onChange={(val) => onFilterChange("environments", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Compute Type"
							options={f.computeTypes}
							selected={filters.computeTypes ?? []}
							onChange={(val) => onFilterChange("computeTypes", val)}
							defaultOpen={false}
						/>
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// Nodes

export interface NodeFilters {
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
}

interface NodesFilterSidebarViewProps {
	facetsResult: Result.Result<NodeFacetsResponse, unknown>
	filters: NodeFilters
	onFilterChange: <K extends keyof NodeFilters>(key: K, value: NodeFilters[K]) => void
	onClearFilters: () => void
}

export function NodesFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: NodesFilterSidebarViewProps) {
	const hasActiveFilters =
		(filters.nodeNames?.length ?? 0) > 0 ||
		(filters.clusters?.length ?? 0) > 0 ||
		(filters.environments?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={3} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title="Node"
							options={f.nodes}
							selected={filters.nodeNames ?? []}
							onChange={(val) => onFilterChange("nodeNames", val)}
							defaultOpen
						/>
						<FilterSection
							title="Cluster"
							options={f.clusters}
							selected={filters.clusters ?? []}
							onChange={(val) => onFilterChange("clusters", val)}
						/>
						<FilterSection
							title="Environment"
							options={f.environments}
							selected={filters.environments ?? []}
							onChange={(val) => onFilterChange("environments", val)}
						/>
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// Workloads

export interface WorkloadFilters {
	workloadNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
}

interface WorkloadsFilterSidebarViewProps {
	facetsResult: Result.Result<WorkloadFacetsResponse, unknown>
	filters: WorkloadFilters
	workloadLabel: string
	onFilterChange: <K extends keyof WorkloadFilters>(key: K, value: WorkloadFilters[K]) => void
	onClearFilters: () => void
}

export function WorkloadsFilterSidebarView({
	facetsResult,
	filters,
	workloadLabel,
	onFilterChange,
	onClearFilters,
}: WorkloadsFilterSidebarViewProps) {
	const hasActiveFilters =
		(filters.workloadNames?.length ?? 0) > 0 ||
		(filters.namespaces?.length ?? 0) > 0 ||
		(filters.clusters?.length ?? 0) > 0 ||
		(filters.environments?.length ?? 0) > 0 ||
		(filters.computeTypes?.length ?? 0) > 0

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={4} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title={workloadLabel}
							options={f.workloads}
							selected={filters.workloadNames ?? []}
							onChange={(val) => onFilterChange("workloadNames", val)}
							defaultOpen
						/>
						<FilterSection
							title="Namespace"
							options={f.namespaces}
							selected={filters.namespaces ?? []}
							onChange={(val) => onFilterChange("namespaces", val)}
						/>
						<FilterSection
							title="Cluster"
							options={f.clusters}
							selected={filters.clusters ?? []}
							onChange={(val) => onFilterChange("clusters", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Environment"
							options={f.environments}
							selected={filters.environments ?? []}
							onChange={(val) => onFilterChange("environments", val)}
							defaultOpen={false}
						/>
						<FilterSection
							title="Compute Type"
							options={f.computeTypes}
							selected={filters.computeTypes ?? []}
							onChange={(val) => onFilterChange("computeTypes", val)}
							defaultOpen={false}
						/>
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
