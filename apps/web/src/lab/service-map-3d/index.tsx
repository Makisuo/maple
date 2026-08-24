import { useMemo, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Separator } from "@maple/ui/components/ui/separator"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

import { healthColor, nodeColor, type ColorMode3D } from "./color"
import { SERVICE_MAP_3D_TOPOLOGY } from "./fixture"
import { computeTiers, type Layout3DMode } from "./layout"
import { ServiceMap3D } from "./scene"

/**
 * `/lab/service-map-3d` — the 3D service-map experiment.
 *
 * The 2D map flattens a request path into a mess of crossing edges as soon as a
 * graph has both breadth and depth. This tries the other axis: tiers become
 * storeys, calls become pipes between them, and traffic becomes packets moving
 * through those pipes at the edge's own rate and latency. Fixture-driven and
 * DEV-only — it is a look at whether depth buys legibility, not a replacement.
 */

const formatRate = (value: number): string =>
	value >= 100 ? `${Math.round(value)}/s` : `${value.toFixed(1)}/s`

const formatMs = (value: number): string => (value >= 100 ? `${Math.round(value)}ms` : `${value.toFixed(1)}ms`)

const formatPct = (value: number): string => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`

export function ServiceMap3DLab() {
	const [layoutMode, setLayoutMode] = useState<Layout3DMode>("floors")
	const [colorMode, setColorMode] = useState<ColorMode3D>("service")
	const [flowing, setFlowing] = useState(true)
	const [autoRotate, setAutoRotate] = useState(false)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [hoveredId, setHoveredId] = useState<string | null>(null)

	const topology = SERVICE_MAP_3D_TOPOLOGY
	const tiers = useMemo(() => computeTiers(topology.nodes, topology.edges), [topology])

	const activeId = hoveredId ?? selectedId
	const active = useMemo(
		() => topology.nodes.find((node) => node.id === activeId) ?? null,
		[topology, activeId],
	)
	const activeEdges = useMemo(() => {
		if (!activeId) return { upstream: [], downstream: [] }
		return {
			upstream: topology.edges.filter((edge) => edge.target === activeId),
			downstream: topology.edges.filter((edge) => edge.source === activeId),
		}
	}, [topology, activeId])

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Service map 3D" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
							<Select
								items={[
									{ value: "floors", label: "Storeys" },
									{ value: "rings", label: "Rings" },
								]}
								value={layoutMode}
								onValueChange={(value) => setLayoutMode(value as Layout3DMode)}
							>
								<SelectTrigger size="sm" className="min-w-0" aria-label="Layout">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="floors">Storeys</SelectItem>
									<SelectItem value="rings">Rings</SelectItem>
								</SelectContent>
							</Select>
							<Select
								items={[
									{ value: "service", label: "Color: service" },
									{ value: "health", label: "Color: health" },
									{ value: "platform", label: "Color: platform" },
								]}
								value={colorMode}
								onValueChange={(value) => setColorMode(value as ColorMode3D)}
							>
								<SelectTrigger size="sm" className="min-w-0" aria-label="Color by">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="service">Color: service</SelectItem>
									<SelectItem value="health">Color: health</SelectItem>
									<SelectItem value="platform">Color: platform</SelectItem>
								</SelectContent>
							</Select>
							<Separator orientation="vertical" className="mx-1 h-5" />
							<Toggle
								variant="outline"
								size="sm"
								className="px-2.5"
								pressed={flowing}
								onPressedChange={setFlowing}
							>
								Traffic
							</Toggle>
							<Toggle
								variant="outline"
								size="sm"
								className="px-2.5"
								pressed={autoRotate}
								onPressedChange={setAutoRotate}
							>
								Auto-orbit
							</Toggle>
							<span className="ml-auto text-xs text-muted-foreground">
								Drag to orbit · scroll to zoom · click a node to isolate its calls
							</span>
						</div>

						<div className="relative min-h-0 flex-1">
							<ServiceMap3D
								topology={topology}
								layoutMode={layoutMode}
								colorMode={colorMode}
								flowing={flowing}
								autoRotate={autoRotate}
								selectedId={selectedId}
								onSelect={setSelectedId}
								onHover={setHoveredId}
							/>

							{active && (
								<div className="pointer-events-none absolute top-3 left-3 w-72 rounded-xl border border-white/10 bg-black/70 p-3 text-xs text-white/90 backdrop-blur-sm">
									<div className="flex items-center gap-2">
										<span
											className="size-2.5 shrink-0 rounded-full"
											style={{ background: nodeColor(active, colorMode) }}
										/>
										<span className="truncate font-semibold text-sm">{active.label}</span>
										<span className="ml-auto shrink-0 text-[10px] text-white/50 uppercase">
											{active.kind}
										</span>
									</div>
									<div className="mt-2 grid grid-cols-3 gap-2 font-mono">
										<Stat label="rate" value={formatRate(active.throughput)} />
										<Stat
											label="errors"
											value={formatPct(active.errorRate)}
											color={healthColor(active.errorRate)}
										/>
										<Stat label="p95" value={formatMs(active.p95LatencyMs)} />
									</div>
									<div className="mt-2 space-y-0.5 text-white/60">
										<div>
											tier {tiers.get(active.id) ?? 0} · {active.namespace}
											{active.system ? ` · ${active.system}` : ""}
										</div>
										<div>
											{activeEdges.upstream.length} inbound · {activeEdges.downstream.length}{" "}
											outbound
										</div>
									</div>
									{activeEdges.downstream.length > 0 && (
										<ul className="mt-2 space-y-0.5 border-t border-white/10 pt-2 font-mono text-[10px] text-white/70">
											{activeEdges.downstream.slice(0, 6).map((edge) => (
												<li key={edge.target} className="flex items-center gap-2">
													<span className="truncate">→ {edge.target}</span>
													<span className="ml-auto shrink-0 text-white/45">
														{formatRate(edge.callsPerSecond)}
													</span>
												</li>
											))}
										</ul>
									)}
								</div>
							)}
						</div>
					</div>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
	return (
		<div>
			<div className="text-[10px] text-white/45 uppercase">{label}</div>
			<div style={color ? { color } : undefined}>{value}</div>
		</div>
	)
}
