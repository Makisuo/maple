import { Result } from "@/lib/effect-atom"

import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { Separator } from "@maple/ui/components/ui/separator"
import type { PodFacetsResponse, NodeFacetsResponse, WorkloadFacetsResponse } from "@maple/domain/http"

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

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
		.onInitial(() => <FilterSidebarLoading sectionCount={6} sticky />)
		.onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame sticky waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title="Pod"
							options={f.pods as Array<{ name: string; count: number }>}
							selected={filters.podNames ? [...filters.podNames] : []}
							onChange={(val) => onFilterChange("podNames", val)}
							defaultOpen
						/>
						<Separator className="my-2" />
						<FilterSection
							title="Namespace"
							options={f.namespaces as Array<{ name: string; count: number }>}
							selected={filters.namespaces ? [...filters.namespaces] : []}
							onChange={(val) => onFilterChange("namespaces", val)}
						/>
						{f.nodes.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Node"
									options={f.nodes as Array<{ name: string; count: number }>}
									selected={filters.nodeNames ? [...filters.nodeNames] : []}
									onChange={(val) => onFilterChange("nodeNames", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.clusters.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Cluster"
									options={f.clusters as Array<{ name: string; count: number }>}
									selected={filters.clusters ? [...filters.clusters] : []}
									onChange={(val) => onFilterChange("clusters", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.deployments.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Deployment"
									options={f.deployments as Array<{ name: string; count: number }>}
									selected={filters.deployments ? [...filters.deployments] : []}
									onChange={(val) => onFilterChange("deployments", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.statefulsets.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="StatefulSet"
									options={f.statefulsets as Array<{ name: string; count: number }>}
									selected={filters.statefulsets ? [...filters.statefulsets] : []}
									onChange={(val) => onFilterChange("statefulsets", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.daemonsets.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="DaemonSet"
									options={f.daemonsets as Array<{ name: string; count: number }>}
									selected={filters.daemonsets ? [...filters.daemonsets] : []}
									onChange={(val) => onFilterChange("daemonsets", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.jobs.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Job"
									options={f.jobs as Array<{ name: string; count: number }>}
									selected={filters.jobs ? [...filters.jobs] : []}
									onChange={(val) => onFilterChange("jobs", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.environments.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Environment"
									options={f.environments as Array<{ name: string; count: number }>}
									selected={filters.environments ? [...filters.environments] : []}
									onChange={(val) => onFilterChange("environments", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.computeTypes.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Compute Type"
									options={f.computeTypes as Array<{ name: string; count: number }>}
									selected={filters.computeTypes ? [...filters.computeTypes] : []}
									onChange={(val) => onFilterChange("computeTypes", val)}
									defaultOpen={false}
								/>
							</>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

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
		.onInitial(() => <FilterSidebarLoading sectionCount={3} sticky />)
		.onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame sticky waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title="Node"
							options={f.nodes as Array<{ name: string; count: number }>}
							selected={filters.nodeNames ? [...filters.nodeNames] : []}
							onChange={(val) => onFilterChange("nodeNames", val)}
							defaultOpen
						/>
						{f.clusters.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Cluster"
									options={f.clusters as Array<{ name: string; count: number }>}
									selected={filters.clusters ? [...filters.clusters] : []}
									onChange={(val) => onFilterChange("clusters", val)}
								/>
							</>
						)}
						{f.environments.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Environment"
									options={f.environments as Array<{ name: string; count: number }>}
									selected={filters.environments ? [...filters.environments] : []}
									onChange={(val) => onFilterChange("environments", val)}
								/>
							</>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

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
		.onInitial(() => <FilterSidebarLoading sectionCount={4} sticky />)
		.onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
		.onSuccess((facetsResponse, result) => {
			const f = facetsResponse.data

			return (
				<FilterSidebarFrame sticky waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={onClearFilters} />
					<FilterSidebarBody>
						<SearchableFilterSection
							title={workloadLabel}
							options={f.workloads as Array<{ name: string; count: number }>}
							selected={filters.workloadNames ? [...filters.workloadNames] : []}
							onChange={(val) => onFilterChange("workloadNames", val)}
							defaultOpen
						/>
						<Separator className="my-2" />
						<FilterSection
							title="Namespace"
							options={f.namespaces as Array<{ name: string; count: number }>}
							selected={filters.namespaces ? [...filters.namespaces] : []}
							onChange={(val) => onFilterChange("namespaces", val)}
						/>
						{f.clusters.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Cluster"
									options={f.clusters as Array<{ name: string; count: number }>}
									selected={filters.clusters ? [...filters.clusters] : []}
									onChange={(val) => onFilterChange("clusters", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.environments.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Environment"
									options={f.environments as Array<{ name: string; count: number }>}
									selected={filters.environments ? [...filters.environments] : []}
									onChange={(val) => onFilterChange("environments", val)}
									defaultOpen={false}
								/>
							</>
						)}
						{f.computeTypes.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Compute Type"
									options={f.computeTypes as Array<{ name: string; count: number }>}
									selected={filters.computeTypes ? [...filters.computeTypes] : []}
									onChange={(val) => onFilterChange("computeTypes", val)}
									defaultOpen={false}
								/>
							</>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
