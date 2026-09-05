import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { SERVICE_MAP_3D_TOPOLOGY } from "./fixture"
import type { Node3D } from "@/components/service-map/three/types"
import { resolveMachineBadge } from "@/components/service-map/three/factory-badge"
import { ServiceMap3DViewport } from "@/components/service-map/three/viewport"
import {
	formatError,
	formatLatency,
	formatRate,
	health,
	HEALTH_COLOR,
} from "@/components/service-map/three/spatial-layout"

/**
 * THESIS: A service map should be a readable instrument. Two spatial models
 * expose ownership (Atlas) and dependency depth (Cascade) over the same graph.
 * OWN-WORLD: Maple's warm surfaces and Geist Mono, mineral green infrastructure,
 * amber elevated errors, clay degraded errors. Maple-branded enamel machinery in
 * a square cartoon meadow cutaway, painted foliage, flanged pipes and working conveyors.
 * STORY: Survey the system, select a service, follow an actual inbound/outbound call.
 * FIRST VIEWPORT: A large orthographic map with a compact service inventory at
 * right. The two view controls lead; the inspector never covers the map.
 * FORM: Extend the lab with namespace districts and solid dependency terraces. Request volume drives Atlas height; Cascade height encodes graph depth.
 */
const topology = SERVICE_MAP_3D_TOPOLOGY
const nodesById = new Map(topology.nodes.map((node) => [node.id, node]))
function HealthDot({ node }: { node: Node3D }) {
	return (
		<span
			className="inline-block size-1.5 shrink-0 rounded-full"
			style={{ backgroundColor: HEALTH_COLOR[health(node.errorRate)] }}
		/>
	)
}

function ServiceInventory({
	selectedId,
	onSelect,
}: {
	selectedId: string | null
	onSelect: (id: string | null) => void
}) {
	const [query, setQuery] = useState("")
	const selected = selectedId ? nodesById.get(selectedId) : undefined
	const selectedBadge = selected && resolveMachineBadge(selected)
	const filtered = topology.nodes.filter((node) =>
		`${node.label} ${node.namespace} ${node.kind}`.includes(query.trim().toLowerCase()),
	)
	const sorted = [...filtered].sort((a, b) => b.errorRate - a.errorRate)
	const degraded = topology.nodes.filter((node) => health(node.errorRate) === "degraded").length
	if (selected)
		return (
			<aside
				className="flex max-h-120 min-h-80 flex-col overflow-y-auto border-t bg-background xl:max-h-none xl:min-h-0 xl:border-t-0 xl:border-l"
				aria-label="Service inspector"
			>
				<div className="border-b p-4">
					<Button
						variant="ghost"
						size="xs"
						className="-ml-2 mb-4 text-muted-foreground"
						onClick={() => onSelect(null)}
					>
						← All services
					</Button>
					<div className="mb-1 flex items-center gap-2">
						<HealthDot node={selected} />
						<h2 className="min-w-0 break-all text-sm font-semibold">{selected.label}</h2>
					</div>
					<p className="text-xs text-muted-foreground">
						{selected.namespace}
						{selectedBadge && ` / ${selectedBadge.label}`}
					</p>
					<div
						className="mt-4 inline-flex items-center gap-1.5 text-xs capitalize"
						style={{
							color: `var(--severity-${health(selected.errorRate) === "healthy" ? "info" : health(selected.errorRate) === "elevated" ? "warn" : "error"})`,
						}}
					>
						{health(selected.errorRate)}
						<span className="text-muted-foreground">
							· {formatError(selected.errorRate)} errors
						</span>
					</div>
				</div>
				<dl className="grid grid-cols-2 gap-4 border-b p-4 text-xs">
					<div>
						<dt className="mb-1.5 text-muted-foreground">Throughput</dt>
						<dd className="text-base tabular-nums">{formatRate(selected.throughput)}</dd>
					</div>
					<div>
						<dt className="mb-1.5 text-muted-foreground">p95 latency</dt>
						<dd className="text-base tabular-nums">{formatLatency(selected.p95LatencyMs)}</dd>
					</div>
				</dl>
				{(["Inbound", "Outbound"] as const).map((direction) => {
					const edges = topology.edges.filter((edge) =>
						direction === "Inbound" ? edge.target === selected.id : edge.source === selected.id,
					)
					return (
						<section key={direction} className="border-b py-4">
							<h3 className="mb-2 flex justify-between px-4 text-xs text-muted-foreground">
								<span>{direction} calls</span>
								<span>{edges.length}</span>
							</h3>
							{edges.length === 0 && (
								<p className="px-4 py-2 text-xs text-muted-foreground">
									No {direction.toLowerCase()} calls in this sample.
								</p>
							)}
							{edges.map((edge) => {
								const node = nodesById.get(
									direction === "Inbound" ? edge.source : edge.target,
								)
								return (
									node && (
										<button
											key={`${edge.source}:${edge.target}`}
											type="button"
											className="flex w-full flex-col gap-1.5 px-4 py-2.5 text-left text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
											onClick={() => onSelect(node.id)}
										>
											<span className="flex w-full items-center gap-2">
												<HealthDot node={node} />
												<span className="truncate">{node.label}</span>
												<span className="ml-auto text-muted-foreground">→</span>
											</span>
											<span className="pl-3.5 text-muted-foreground">
												{formatRate(edge.callsPerSecond)} ·{" "}
												{formatLatency(edge.p95LatencyMs)} p95
											</span>
										</button>
									)
								)
							})}
						</section>
					)
				})}
				<p className="mt-auto p-4 text-[11px] leading-relaxed text-muted-foreground">
					Select a connected service to follow the request path.
				</p>
			</aside>
		)
	return (
		<aside
			className="flex h-96 min-h-0 flex-col overflow-hidden border-t bg-background xl:h-auto xl:border-t-0 xl:border-l"
			aria-label="Service inventory"
		>
			<div className="border-b p-4">
				<div className="flex items-center justify-between">
					<h2 className="text-xs font-semibold">Services & dependencies</h2>
					<span className="text-xs text-muted-foreground">{topology.nodes.length}</span>
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">Select a node to inspect its calls.</p>
				<Input
					aria-label="Find a service"
					placeholder="Find a service…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="mt-4 h-8 text-xs"
				/>
			</div>
			<div className="flex items-center justify-between border-b px-4 py-2.5 text-[11px] text-muted-foreground">
				<span>Sorted by error rate</span>
				<span className="text-severity-error">{degraded} degraded</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{sorted.length === 0 && (
					<p className="p-4 text-xs text-muted-foreground">No services match “{query}”.</p>
				)}
				{sorted.map((node) => (
					<button
						key={node.id}
						type="button"
						onClick={() => onSelect(node.id)}
						className="group flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
						aria-label={`Inspect ${node.label}`}
					>
						<HealthDot node={node} />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs">{node.label}</span>
							<span className="mt-0.5 block text-[10px] text-muted-foreground">
								{node.kind === "service" ? node.namespace : node.kind}
							</span>
						</span>
						<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
							{formatError(node.errorRate)}
						</span>
					</button>
				))}
			</div>
			<p className="border-t px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">
				Sample health thresholds
				<br />
				Elevated &gt; 1% · Degraded &gt; 5% errors
			</p>
		</aside>
	)
}

export function ServiceMap3DLab() {
	const [selectedId, setSelectedId] = useState<string | null>(null)
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Lab", href: "/lab" }, { label: "Service map 3D" }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<div className="flex h-full min-h-0 flex-col overflow-y-auto xl:overflow-hidden">
						<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
							<div>
								<div className="flex items-center gap-3">
									<h1 className="font-display text-lg font-semibold tracking-tight">
										Service map
									</h1>
									<span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
										3D lab
									</span>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									One system. Two working landscapes.
								</p>
							</div>
							<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
								<span className="size-1.5 rounded-full bg-muted-foreground" />
								Sample topology
								<span className="ml-2 border-l pl-3">
									{topology.nodes.length} nodes · {topology.edges.length} connections
								</span>
							</div>
						</div>

						<div className="grid flex-1 grid-cols-1 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_256px]">
							<div className="h-[600px] min-h-0 xl:h-auto">
								<ServiceMap3DViewport
									topology={topology}
									selectedId={selectedId}
									onSelect={setSelectedId}
									sample
								/>
							</div>
							<ServiceInventory selectedId={selectedId} onSelect={setSelectedId} />
						</div>
					</div>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
