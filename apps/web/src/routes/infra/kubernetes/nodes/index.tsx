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

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { MagnifierIcon, ServerIcon, XmarkIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { NodeTable, NodeTableLoading } from "@/components/infra/node-table"
import { NodeSummaryBand, type NodeStatusCounts } from "@/components/infra/node-summary-band"
import { deriveHostStatus, type HostStatus } from "@/components/infra/format"
import { NodesFilterSidebarView, type NodeFilters } from "@/components/infra/k8s-filter-sidebar"
import { listNodesResultAtom, nodeFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const NodeStatusParam = Schema.optional(Schema.Literals(["active", "idle", "down"]))

const nodesSearchSchema = Schema.Struct({
	// In the URL rather than component state, so a filtered node list survives a
	// reload and can be linked to — the same contract the pods route already has.
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
		search.timePreset ?? "12h",
	)

	const filters: NodeFilters = {
		nodeNames: search.nodeNames,
		clusters: search.clusters,
		environments: search.environments,
	}

	const nodesResult = useAtomValue(
		listNodesResultAtom({
			data: {
				startTime,
				endTime,
				...filters,
			},
		}),
	)

	const facetsResult = useAtomValue(
		nodeFacetsResultAtom({
			data: {
				startTime,
				endTime,
			},
		}),
	)

	const onFilterChange = <K extends keyof NodeFilters>(key: K, value: NodeFilters[K]) => {
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

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		void navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Infrastructure", href: "/infra" },
						{ label: "Kubernetes" },
						{ label: "Nodes" },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<NodesFilterSidebarView
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
									title="Nodes"
									description="Kubelet-reported per-node CPU, memory, and lifecycle metrics."
								/>
								{Result.builder(nodesResult)
									.onInitial(() => <NodeTableLoading />)
									.onError((err) => <QueryErrorState error={err} />)
									.onSuccess((response, result) => {
										const nodes = response.data
										const hasStructuredFilter =
											(filters.nodeNames?.length ?? 0) > 0 ||
											(filters.clusters?.length ?? 0) > 0 ||
											(filters.environments?.length ?? 0) > 0

										if (nodes.length === 0 && !hasStructuredFilter) {
											return (
												<Empty className="py-16">
													<EmptyHeader>
														<EmptyMedia variant="icon">
															<ServerIcon size={16} />
														</EmptyMedia>
														<EmptyTitle>No nodes reporting yet</EmptyTitle>
														<EmptyDescription>
															Install the Maple Kubernetes Helm chart so the
															kubelet stats receiver can start collecting
															per-node metrics.
														</EmptyDescription>
													</EmptyHeader>
												</Empty>
											)
										}

										const q = searchText.trim().toLowerCase()
										const named = q
											? nodes.filter((n) => n.nodeName.toLowerCase().includes(q))
											: nodes
										// The band counts the whole scope, so it keeps saying what
										// the search and the status cell just hid.
										const counts = statusCounts(nodes, endTime)
										const filtered = statusScope
											? named.filter(
													(n) =>
														deriveHostStatus(n.lastSeen, endTime) === statusScope,
												)
											: named

										return (
											<div
												className={`space-y-4 transition-opacity ${
													result.waiting ? "opacity-60" : ""
												}`}
											>
												<NodeSummaryBand
													counts={counts}
													activeScope={statusScope}
													onScopeChange={(next) => patchSearch({ status: next })}
													waiting={result.waiting}
												/>
												<div className="flex items-center justify-between gap-3">
													<InputGroup className="w-64">
														<InputGroupAddon>
															<MagnifierIcon />
														</InputGroupAddon>
														<InputGroupInput
															size="sm"
															placeholder="Search nodes…"
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
													<span className="text-xs text-muted-foreground">
														{filtered.length}{" "}
														{filtered.length === 1 ? "node" : "nodes"}
													</span>
												</div>
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

/** Fleet counts for the band, taken as of the window's end rather than the wall clock. */
function statusCounts(nodes: ReadonlyArray<{ lastSeen: string }>, referenceTime: string): NodeStatusCounts {
	let active = 0
	let idle = 0
	let down = 0
	for (const node of nodes) {
		const status: HostStatus = deriveHostStatus(node.lastSeen, referenceTime)
		if (status === "active") active++
		else if (status === "idle") idle++
		else down++
	}
	return { total: nodes.length, active, idle, down }
}
