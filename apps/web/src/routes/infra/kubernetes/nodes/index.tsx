import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { QueryErrorState } from "@/components/common/query-error-state"
import { MagnifierIcon, ServerIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { NodeTable, NodeTableLoading } from "@/components/infra/node-table"
import { deriveHostStatus, type HostStatus } from "@/components/infra/format"
import { NodesFilterSidebarView, type NodeFilters } from "@/components/infra/k8s-filter-sidebar"
import { FleetBand, type FleetBandCell } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import { statusLabel } from "@/components/infra/severity-tokens"
import { listNodesResultAtom, nodeFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"

const DEFAULT_PRESET = "12h"

const NodeStatusParam = Schema.optional(Schema.Literals(["active", "idle", "down"]))

const nodesSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	status: NodeStatusParam,
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export type NodesSearchParams = Schema.Schema.Type<typeof nodesSearchSchema>

export const Route = createFileRoute("/infra/kubernetes/nodes/")({
	component: NodesPage,
	validateSearch: Schema.toStandardSchemaV1(nodesSearchSchema),
})

/**
 * The states are collector freshness, not Kubernetes conditions: a node is
 * "Down" here when no kubelet metric has arrived recently, which is a fact about
 * the collector as much as about the node. `k8s.node.condition_ready` is
 * collected but unqueried — when it lands, it belongs beside these, not instead.
 */
const STATUS_CELLS: ReadonlyArray<{
	status: HostStatus
	hint: string
	tone: FleetBandCell<HostStatus>["tone"]
}> = [
	{ status: "active", hint: "reporting", tone: "info" },
	{ status: "idle", hint: "quiet >1m", tone: "warn" },
	{ status: "down", hint: "silent >5m", tone: "crit" },
]

const STATUS_SEGMENT: Record<HostStatus, string> = {
	active: "bg-[var(--severity-info)]",
	idle: "bg-[var(--severity-warn)]",
	down: "bg-[var(--severity-error)]",
} satisfies Record<HostStatus, string>

function NodesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const searchText = search.q ?? ""
	const statusScope = search.status

	const patchSearch = (patch: Partial<NodesSearchParams>) => {
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const timeSearch = pickTimeRangeSearch(search)

	const filters: NodeFilters = {
		nodeNames: search.nodeNames,
		clusters: search.clusters,
		environments: search.environments,
	}

	const nodesResult = useAtomValue(listNodesResultAtom({ data: { startTime, endTime, ...filters } }))
	const facetsResult = useAtomValue(nodeFacetsResultAtom({ data: { startTime, endTime } }))

	const onFilterChange = <K extends keyof NodeFilters>(key: K, value: NodeFilters[K]) => {
		patchSearch({
			[key]: value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
		})
	}

	const onClearFilters = () => {
		void navigate({ search: timeSearch })
	}

	return (
		<KubernetesShell
			view="nodes"
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
				<NodesFilterSidebarView
					facetsResult={facetsResult}
					filters={filters}
					onFilterChange={onFilterChange}
					onClearFilters={onClearFilters}
				/>
			}
		>
			{Result.builder(nodesResult)
				.onInitial(() => <NodeTableLoading />)
				.onError((err) => <QueryErrorState error={err} />)
				.onSuccess((response, result) => {
					const nodes = response.data
					const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)

					if (nodes.length === 0 && !hasStructuredFilter) {
						return (
							<Empty className="py-16">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<ServerIcon size={16} />
									</EmptyMedia>
									<EmptyTitle>No nodes reporting yet</EmptyTitle>
									<EmptyDescription>
										Install the Maple Kubernetes Helm chart so the kubelet stats receiver
										can start collecting per-node metrics.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						)
					}

					// The band counts the whole scope as of the window's end, so it keeps
					// saying what the search and the status cell just hid.
					const counts = { active: 0, idle: 0, down: 0 } satisfies Record<HostStatus, number>
					for (const node of nodes) counts[deriveHostStatus(node.lastSeen, endTime)]++

					const q = searchText.trim().toLowerCase()
					const named = q ? nodes.filter((n) => n.nodeName.toLowerCase().includes(q)) : nodes
					const filtered = statusScope
						? named.filter((n) => deriveHostStatus(n.lastSeen, endTime) === statusScope)
						: named

					return (
						<div className={`space-y-5 transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
							<FleetBand
								total={nodes.length}
								noun="node"
								caption="share of the fleet by collector freshness"
								segments={STATUS_CELLS.map(({ status }) => ({
									key: statusLabel(status).toLowerCase(),
									count: counts[status],
									className: STATUS_SEGMENT[status],
								}))}
								cells={STATUS_CELLS.map(({ status, hint, tone }) => ({
									scope: status,
									label: statusLabel(status),
									hint,
									value: counts[status],
									tone,
								}))}
								activeScope={statusScope}
								onScopeChange={(next) => patchSearch({ status: next })}
								waiting={result.waiting}
							/>
							<div className="space-y-3">
								<ListToolbar
									value={searchText}
									onChange={(value) => patchSearch({ q: value || undefined })}
									placeholder="Search nodes…"
									trailing={countLabel(filtered.length, filtered.length, "node")}
								/>
								{(q || statusScope) && filtered.length === 0 ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<MagnifierIcon size={16} />
											</EmptyMedia>
											<EmptyTitle>No nodes match</EmptyTitle>
											<EmptyDescription>
												{q
													? `Nothing named “${searchText}” in this scope.`
													: "Nothing in this scope right now — which is good news."}
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : (
									<NodeTable
										nodes={filtered}
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
