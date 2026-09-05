import { useMemo, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { Button } from "@maple/ui/components/ui/button"
import {
	ArrowRotateAnticlockwiseIcon,
	CubeIcon,
	LayersIcon,
	MediaPauseIcon,
	MediaPlayIcon,
} from "@/components/icons"
import { resolveMachineBadge } from "./factory-badge"
import { ServiceMap3D, type CameraCommand } from "./scene"
import type { Topology3D, Edge3D } from "./types"
import { MAP_MATERIALS } from "./appearance"
import { factoryRoutes, decorateRoutes, type RoutingTopology } from "./factory-routing"
import {
	connectedIds,
	formatRate,
	formatLatency,
	HEALTH_COLOR,
	spatialLayout,
	type SpatialView,
	type SpatialTopology,
} from "./spatial-layout"

const VIEW_COPY = {
	atlas: {
		title: "Atlas",
		description: "Infrastructure, organized by namespace.",
		encoding: "Machine height · request volume",
	},
	cascade: {
		title: "Cascade",
		description: "Layers follow the longest dependency path.",
		encoding: "Layer height · dependency depth",
	},
} as const

function edgeLatency(edge: Edge3D) {
	return edge.p95LatencyMs !== undefined
		? `${formatLatency(edge.p95LatencyMs)} p95`
		: `${formatLatency(edge.avgLatencyMs)} avg · ${formatLatency(edge.maxLatencyMs)} max`
}

export function ServiceMap3DViewport({
	topology,
	selectedId,
	onSelect,
	sample = false,
}: {
	topology: Topology3D
	selectedId: string | null
	onSelect: (id: string | null) => void
	sample?: boolean
}) {
	const [view, setView] = useState<SpatialView>("atlas")
	const [traffic, setTraffic] = useState(true)
	const [command, setCommand] = useState<CameraCommand>({ action: "reset", serial: 0 })
	const labels = useRef(new Map<string, HTMLElement>())
	const reducedMotion = useReducedMotion()
	const { theme } = useTheme()
	const dark = theme === "dark"
	const flowing = traffic && !reducedMotion
	// Metrics can refresh without replacing the layout or resetting the user's camera.
	const topologyKey = JSON.stringify({
		nodes: topology.nodes
			.map(({ id, namespace, kind }) => ({ id, namespace, kind }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		edges: topology.edges
			.map(({ source, target }) => ({ source, target }))
			.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
	})
	// SAFETY: topologyKey is serialized immediately above from typed renderer nodes and edges.
	const layoutTopology = useMemo(
		() => JSON.parse(topologyKey) as SpatialTopology & RoutingTopology,
		[topologyKey],
	)
	const layout = useMemo(() => spatialLayout(layoutTopology, view), [layoutTopology, view])
	const routes = useMemo(() => factoryRoutes(layoutTopology, layout), [layoutTopology, layout])
	const links = useMemo(() => decorateRoutes(routes, topology.edges), [routes, topology.edges])
	const nodesById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology.nodes])
	const related = connectedIds(topology, selectedId)
	const copy = VIEW_COPY[view]
	const camera = (action: CameraCommand["action"]) =>
		setCommand((current) => ({ action, serial: current.serial + 1 }))
	return (
		<div className="flex h-full min-h-0 flex-col" data-service-map-renderer="3d">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
				<fieldset className="flex gap-1 rounded-lg bg-muted/60 p-1" aria-label="Map perspective">
					<Button
						size="sm"
						variant={view === "atlas" ? "secondary" : "ghost"}
						aria-pressed={view === "atlas"}
						onClick={() => setView("atlas")}
					>
						<CubeIcon size={14} />
						Atlas
					</Button>
					<Button
						size="sm"
						variant={view === "cascade" ? "secondary" : "ghost"}
						aria-pressed={view === "cascade"}
						onClick={() => setView("cascade")}
					>
						<LayersIcon size={14} />
						Cascade
					</Button>
				</fieldset>
				<span className="ml-3 hidden text-[11px] text-muted-foreground sm:block">
					{copy.encoding}
				</span>
				<Button
					size="sm"
					variant="ghost"
					className="ml-auto text-xs"
					aria-pressed={flowing}
					disabled={Boolean(reducedMotion)}
					onClick={() => setTraffic((current) => !current)}
				>
					{flowing ? <MediaPauseIcon size={12} /> : <MediaPlayIcon size={12} />}
					{reducedMotion ? "Reduced motion" : flowing ? "Pause traffic" : "Resume traffic"}
				</Button>
			</div>
			<section
				className="relative min-h-0 flex-1 overflow-hidden"
				aria-label={`${copy.title} 3D service map`}
				style={{ backgroundColor: MAP_MATERIALS[dark ? "dark" : "light"].air }}
			>
				<ServiceMap3D
					topology={topology}
					layout={layout}
					links={links}
					view={view}
					selectedId={selectedId}
					onSelect={onSelect}
					flowing={flowing}
					dark={dark}
					command={command}
					labels={labels}
				/>
				<div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Map nodes">
					{topology.nodes.map((node) => {
						const badge = resolveMachineBadge(node)
						return (
							<button
								key={node.id}
								type="button"
								ref={(element) => {
									if (element) labels.current.set(node.id, element)
									else labels.current.delete(node.id)
								}}
								title={badge ? `${node.label} · ${badge.label}` : node.label}
								className={`pointer-events-auto absolute top-0 left-0 max-w-40 truncate rounded px-1.5 py-1 text-[10px] leading-none whitespace-nowrap transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-ring ${selectedId === node.id ? "bg-background text-foreground ring-1 ring-primary" : "text-foreground/90"}`}
								style={{
									visibility: "hidden",
									opacity: node.dimmed || (related && !related.has(node.id)) ? 0.25 : 1,
									backgroundColor:
										selectedId === node.id ? undefined : dark ? "#242321e6" : "#e5e5dfe6",
								}}
								onClick={() => onSelect(selectedId === node.id ? null : node.id)}
								aria-label={`Select ${node.label}${badge ? `, ${badge.label}` : ""}`}
								aria-pressed={selectedId === node.id}
							>
								{node.label}
							</button>
						)
					})}
					{links
						.filter((link) => !link.edge.relation)
						.filter((link) =>
							selectedId
								? link.edge.source === selectedId || link.edge.target === selectedId
								: link.prominent,
						)
						.map((link) => (
							<button
								key={link.id}
								type="button"
								ref={(element) => {
									if (element) labels.current.set(link.id, element)
									else labels.current.delete(link.id)
								}}
								className="pointer-events-auto absolute top-0 left-0 flex h-5 min-w-14 cursor-pointer items-center justify-center gap-1 rounded-[3px] border-2 border-[#747766] bg-[#e1d5a9] px-2 font-mono text-[9px] font-bold text-[#30362c] shadow-[0_2px_0_#3a4034] hover:bg-[#f4e8bc] focus-visible:outline-2 focus-visible:outline-ring"
								style={{ visibility: "hidden" }}
								title={`${nodesById.get(link.edge.source)?.label} → ${nodesById.get(link.edge.target)?.label} · ${link.edge.callsPerSecond} calls/s · ${edgeLatency(link.edge)}`}
								aria-label={`Inspect connection to ${nodesById.get(link.edge.target)?.label}, ${formatRate(link.edge.callsPerSecond, link.edge.hasSampling)}`}
								onClick={() => onSelect(link.edge.target)}
							>
								<span className="absolute left-0.5 size-0.5 rounded-full bg-[#666e57]" />
								{formatRate(link.edge.callsPerSecond, link.edge.hasSampling)}
								<span className="absolute right-0.5 size-0.5 rounded-full bg-[#666e57]" />
							</button>
						))}
					{layout.districts.map((district) => (
						<span
							key={`${view}:${district.id}`}
							ref={(element) => {
								if (element) labels.current.set(`district:${district.id}`, element)
								else labels.current.delete(`district:${district.id}`)
							}}
							className="absolute top-0 left-0 rounded-sm bg-background/80 px-1 py-0.5 text-[9px] uppercase tracking-widest text-foreground/85"
							style={{ visibility: "hidden" }}
						>
							{district.label}
						</span>
					))}
				</div>
				<div
					ref={(element) => {
						if (element) labels.current.set("overlay:hud", element)
						else labels.current.delete("overlay:hud")
					}}
					className="pointer-events-none absolute top-4 left-4 rounded-md bg-background/90 px-3 py-2"
				>
					<h2 className="font-display text-base font-medium">{copy.title}</h2>
					<p className="mt-1 text-[11px] text-muted-foreground">{copy.description}</p>
				</div>
				<div
					ref={(element) => {
						if (element) labels.current.set("overlay:legend", element)
						else labels.current.delete("overlay:legend")
					}}
					className="pointer-events-none absolute bottom-14 left-4 flex flex-wrap gap-3 rounded-md sm:bottom-4 bg-background/95 px-3 py-2 text-[10px] text-foreground/85"
				>
					{(["healthy", "elevated", "degraded"] as const).map((status) => (
						<span key={status} className="flex items-center gap-1.5 capitalize">
							<span
								className="size-1.5 rounded-full"
								style={{ backgroundColor: HEALTH_COLOR[status] }}
							/>
							{status}
						</span>
					))}
				</div>
				<fieldset
					ref={(element) => {
						if (element) labels.current.set("overlay:controls", element)
						else labels.current.delete("overlay:controls")
					}}
					className="absolute right-4 bottom-4 flex gap-1 rounded-lg border bg-background p-1"
					aria-label="Camera controls"
				>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Zoom out"
						onClick={() => camera("out")}
					>
						−
					</Button>
					<Button variant="ghost" size="icon-xs" aria-label="Zoom in" onClick={() => camera("in")}>
						+
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Reset camera"
						onClick={() => camera("reset")}
					>
						<ArrowRotateAnticlockwiseIcon size={14} />
					</Button>
				</fieldset>
			</section>
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[10px] text-muted-foreground">
				<span>Drag to orbit · scroll to zoom · right-drag to pan</span>
				<span>
					{selectedId
						? `${related?.size ?? 0} connected nodes · click the canvas to clear`
						: sample
							? "Pipes · calls / Conveyors · queues · sample traffic"
							: "Rates from selected time range · ~ sampled estimate"}
				</span>
			</div>
		</div>
	)
}
