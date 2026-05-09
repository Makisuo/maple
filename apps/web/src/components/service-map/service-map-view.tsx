import { useMemo, useRef, useState, useCallback } from "react"
import {
	ReactFlow,
	Controls,
	MiniMap,
	Background,
	BackgroundVariant,
	applyNodeChanges,
	type Node,
	type NodeChange,
	type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { Result } from "@/lib/effect-atom"
import { Link } from "@tanstack/react-router"
import { formatBackendError } from "@/lib/error-messages"

import { cn } from "@maple/ui/utils"
import { getServiceLegendColor } from "@maple/ui/colors"
import { Popover, PopoverTrigger, PopoverContent } from "@maple/ui/components/ui/popover"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@maple/ui/components/ui/resizable"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ArrowRightIcon, CubeIcon, DatabaseIcon, NetworkNodesIcon, XmarkIcon } from "@/components/icons"
import {
	getServiceMapDbEdgesResultAtom,
	getServiceMapResultAtom,
	getServiceOverviewResultAtom,
	getServicePlatformsResultAtom,
	getServiceWorkloadsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import type {
	GetServiceMapInput,
	ServiceDbEdge,
	ServiceEdge,
	ServicePlatform,
} from "@/api/tinybird/service-map"
import type { GetServiceOverviewInput, ServiceOverview } from "@/api/tinybird/services"
import type { ServiceWorkload } from "@/api/tinybird/service-infra"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { ServiceMapNode } from "./service-map-node"
import { ServiceMapEdge } from "./service-map-edge"
import {
	buildFlowElements,
	DB_NODE_PREFIX,
	getPlatformColor,
	getServiceMapNodeColor,
	layoutNodes,
	DEFAULT_LAYOUT_CONFIG,
	type LayoutConfig,
	type ServiceMapColorMode,
	type ServiceNodeData,
} from "./service-map-utils"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

const nodeTypes = {
	serviceNode: ServiceMapNode,
}

// Custom MiniMap node that renders with the service's legend color
function ServiceMiniMapNode({
	x,
	y,
	width,
	height,
	color,
	borderRadius,
}: import("@xyflow/react").MiniMapNodeProps) {
	return (
		<rect
			x={x}
			y={y}
			width={width}
			height={height}
			rx={borderRadius}
			ry={borderRadius}
			fill={color}
			stroke="none"
		/>
	)
}

const edgeTypes = {
	serviceEdge: ServiceMapEdge,
}

// --- Detail Panel ---

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
	return `${ms.toFixed(1)}ms`
}

function getHealthDotClass(errorRate: number): string {
	if (errorRate > 0.05) return "bg-severity-error"
	if (errorRate > 0.01) return "bg-severity-warn"
	return "bg-severity-info"
}

interface ServiceDetailPanelProps {
	serviceId: string
	services: string[]
	edges: ServiceEdge[]
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	durationSeconds: number
	showInfraTab: boolean
	platforms: Map<string, ServicePlatform>
	colorMode: ServiceMapColorMode
	onClose: () => void
}

function ServiceDetailPanel({
	serviceId,
	services,
	edges,
	overviews,
	workloads,
	durationSeconds,
	showInfraTab,
	platforms,
	colorMode,
	onClose,
}: ServiceDetailPanelProps) {
	const overview = overviews.find((o) => o.serviceName === serviceId)
	const errorRate = overview?.errorRate ?? 0
	const accentColor = getServiceMapNodeColor(
		{
			label: serviceId,
			kind: "service",
			errorRate,
			platform: platforms.get(serviceId),
		},
		services,
		colorMode,
	)

	const throughput = overview?.throughput ?? 0
	const hasSampling = overview?.hasSampling ?? false
	const avgLatencyMs = overview?.p50LatencyMs ?? 0
	const p95LatencyMs = overview?.p95LatencyMs ?? 0

	const dependencies = edges.filter((e) => e.sourceService === serviceId)
	const calledBy = edges.filter((e) => e.targetService === serviceId)
	const serviceWorkloads = workloads.filter((w) => w.serviceName === serviceId)

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-[3px] h-[18px] rounded-sm shrink-0"
						style={{ backgroundColor: accentColor }}
					/>
					<div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getHealthDotClass(errorRate))} />
					<span className="text-sm font-semibold text-foreground truncate">{serviceId}</span>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Link
						to="/services/$serviceName"
						params={{ serviceName: serviceId }}
						className="text-[10px] text-primary hover:text-primary/80 transition-colors"
					>
						View service
					</Link>
					<Button variant="ghost" size="icon-xs" onClick={onClose}>
						<XmarkIcon size={14} />
					</Button>
				</div>
			</div>

			<Tabs defaultValue="service" className="flex flex-col flex-1 min-h-0">
				<TabsList variant="line" className="shrink-0 px-4 pt-2">
					<TabsTrigger value="service">
						<NetworkNodesIcon size={12} />
						Service
					</TabsTrigger>
					{showInfraTab && (
						<TabsTrigger value="infrastructure">
							<CubeIcon size={12} />
							Infrastructure
							{serviceWorkloads.length > 0 && (
								<span className="ml-1 text-[9px] tabular-nums text-muted-foreground/70">
									{serviceWorkloads.length}
								</span>
							)}
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="service" className="flex-1 min-h-0 mt-0">
					<ScrollArea className="h-full">
						<div className="p-4 space-y-5">
							{/* Metrics */}
							<div className="space-y-3">
								<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
									Metrics
								</h4>
								<div className="grid grid-cols-2 gap-x-6 gap-y-4">
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Throughput</span>
										<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
											{hasSampling ? "~" : ""}
											{formatRate(throughput)}
										</p>
										<span className="text-[10px] text-muted-foreground">req/s</span>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Error Rate</span>
										<p
											className={cn(
												"text-xl font-semibold tabular-nums font-mono",
												errorRate > 0.05
													? "text-severity-error"
													: errorRate > 0.01
														? "text-severity-warn"
														: "text-foreground",
											)}
										>
											{(errorRate * 100).toFixed(1)}%
										</p>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Avg Latency</span>
										<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
											{formatLatency(avgLatencyMs)}
										</p>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">P95 Latency</span>
										<p
											className={cn(
												"text-xl font-semibold tabular-nums font-mono",
												p95LatencyMs > avgLatencyMs * 3
													? "text-severity-warn"
													: "text-foreground",
											)}
										>
											{formatLatency(p95LatencyMs)}
										</p>
									</div>
								</div>
							</div>

							{/* Dependencies */}
							{dependencies.length > 0 && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
										Dependencies
									</h4>
									<div className="space-y-1.5">
										{dependencies.map((dep) => {
											const depColor = getServiceLegendColor(
												dep.targetService,
												services,
											)
											const depErrorRate = dep.errorRate
											const isError = depErrorRate > 0.05
											const safeDuration = Math.max(durationSeconds, 1)
											const depReqPerSec = dep.hasSampling
												? dep.estimatedCallCount / safeDuration
												: dep.callCount / safeDuration
											const depTracedReqPerSec = dep.callCount / safeDuration
											return (
												<div
													key={dep.targetService}
													className={cn(
														"flex items-center justify-between px-2.5 py-2 rounded-md border text-xs",
														isError
															? "bg-severity-error/[0.04] border-severity-error/[0.12]"
															: "bg-card border-border",
													)}
													title={
														dep.hasSampling
															? `Estimated x${dep.samplingWeight.toFixed(0)} from ${formatRate(depTracedReqPerSec)} traced req/s`
															: undefined
													}
												>
													<div className="flex items-center gap-1.5 min-w-0">
														<div
															className="w-[3px] h-3.5 rounded-sm shrink-0"
															style={{ backgroundColor: depColor }}
														/>
														<span className="text-foreground truncate">
															{dep.targetService}
														</span>
													</div>
													<div className="flex items-center gap-2 shrink-0 text-[10px]">
														<span className="text-muted-foreground tabular-nums font-mono">
															{dep.hasSampling ? "~" : ""}
															{formatRate(depReqPerSec)} req/s
														</span>
														<span
															className={cn(
																"tabular-nums font-mono",
																depErrorRate > 0.05
																	? "text-severity-error"
																	: depErrorRate > 0.01
																		? "text-severity-warn"
																		: "text-severity-info",
															)}
														>
															{(depErrorRate * 100).toFixed(1)}%
														</span>
													</div>
												</div>
											)
										})}
									</div>
								</div>
							)}

							{/* Called By */}
							{calledBy.length > 0 && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
										Called By
									</h4>
									<div className="space-y-1.5">
										{calledBy.map((caller) => {
											const callerColor = getServiceLegendColor(
												caller.sourceService,
												services,
											)
											const callerErrorRate = caller.errorRate
											const safeDuration = Math.max(durationSeconds, 1)
											const callerReqPerSec = caller.hasSampling
												? caller.estimatedCallCount / safeDuration
												: caller.callCount / safeDuration
											const callerTracedReqPerSec = caller.callCount / safeDuration
											return (
												<div
													key={caller.sourceService}
													className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-card border-border text-xs"
													title={
														caller.hasSampling
															? `Estimated x${caller.samplingWeight.toFixed(0)} from ${formatRate(callerTracedReqPerSec)} traced req/s`
															: undefined
													}
												>
													<div className="flex items-center gap-1.5 min-w-0">
														<div
															className="w-[3px] h-3.5 rounded-sm shrink-0"
															style={{ backgroundColor: callerColor }}
														/>
														<span className="text-foreground truncate">
															{caller.sourceService}
														</span>
													</div>
													<div className="flex items-center gap-2 shrink-0 text-[10px]">
														<span className="text-muted-foreground tabular-nums font-mono">
															{caller.hasSampling ? "~" : ""}
															{formatRate(callerReqPerSec)} req/s
														</span>
														<span
															className={cn(
																"tabular-nums font-mono",
																callerErrorRate > 0.05
																	? "text-severity-error"
																	: callerErrorRate > 0.01
																		? "text-severity-warn"
																		: "text-severity-info",
															)}
														>
															{(callerErrorRate * 100).toFixed(1)}%
														</span>
													</div>
												</div>
											)
										})}
									</div>
								</div>
							)}
						</div>
					</ScrollArea>
				</TabsContent>

				{showInfraTab && (
					<TabsContent value="infrastructure" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-4 space-y-4">
								{serviceWorkloads.length === 0 ? (
									<ServiceInfraEmptyState />
								) : (
									<div className="space-y-2">
										<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
											Kubernetes workloads
										</h4>
										<div className="space-y-2">
											{serviceWorkloads.map((wl) => (
												<ServiceWorkloadRow
													key={`${wl.workloadKind}/${wl.workloadName}/${wl.namespace}/${wl.clusterName}`}
													workload={wl}
												/>
											))}
										</div>
									</div>
								)}
							</div>
						</ScrollArea>
					</TabsContent>
				)}
			</Tabs>
		</div>
	)
}

function formatPercent(value: number | null): string {
	if (value == null) return "—"
	return `${(value * 100).toFixed(0)}%`
}

function ServiceWorkloadRow({ workload }: { workload: ServiceWorkload }) {
	const knownKind: "deployment" | "statefulset" | "daemonset" | null =
		workload.workloadKind === "deployment" ||
		workload.workloadKind === "statefulset" ||
		workload.workloadKind === "daemonset"
			? workload.workloadKind
			: null
	return (
		<div className="rounded-md border bg-card p-3 space-y-2.5">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
						<CubeIcon size={11} />
						<span>{workload.workloadKind}</span>
					</div>
					<p className="text-xs font-medium text-foreground truncate mt-0.5">
						{workload.workloadName}
					</p>
					<p className="text-[10px] text-muted-foreground mt-0.5 truncate">
						{workload.namespace || "default"}
						{workload.clusterName ? ` · ${workload.clusterName}` : ""}
					</p>
				</div>
				<div className="flex flex-col items-end gap-px shrink-0">
					<span className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">pods</span>
					<span className="text-sm font-semibold text-foreground tabular-nums font-mono">
						{workload.podCount}
					</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2 text-[10px]">
				<div className="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
					<span className="text-muted-foreground">CPU</span>
					<span className="font-mono tabular-nums text-foreground">
						{formatPercent(workload.avgCpuLimitUtilization)}
					</span>
				</div>
				<div className="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
					<span className="text-muted-foreground">Memory</span>
					<span className="font-mono tabular-nums text-foreground">
						{formatPercent(workload.avgMemoryLimitUtilization)}
					</span>
				</div>
			</div>

			<div className="flex items-center gap-3 pt-0.5">
				{knownKind && (
					<Link
						to="/infra/kubernetes/workloads/$kind/$workloadName"
						params={{ kind: knownKind, workloadName: workload.workloadName }}
						className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
					>
						View workload <ArrowRightIcon size={10} />
					</Link>
				)}
				<Link
					to="/infra/kubernetes/pods"
					search={
						knownKind
							? {
									[`${knownKind}s`]: [workload.workloadName],
									namespaces: workload.namespace ? [workload.namespace] : undefined,
								}
							: {
									namespaces: workload.namespace ? [workload.namespace] : undefined,
								}
					}
					className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
				>
					View pods <ArrowRightIcon size={10} />
				</Link>
			</div>
		</div>
	)
}

function ServiceInfraEmptyState() {
	return (
		<div className="rounded-md border border-dashed bg-muted/20 p-4 space-y-3">
			<div className="flex items-center gap-2">
				<CubeIcon size={14} className="text-muted-foreground/50" />
				<p className="text-xs font-medium text-foreground">No Kubernetes workloads found</p>
			</div>
			<p className="text-[11px] text-muted-foreground leading-relaxed">
				This service has no spans tagged with{" "}
				<code className="text-[10px] bg-muted px-1 py-0.5 rounded">k8s.deployment.name</code> in the
				selected window. Install the maple-k8s-infra Helm chart and label your namespace to enable
				infrastructure context:
			</p>
			<pre className="text-[10px] bg-muted px-2 py-1.5 rounded font-mono text-foreground overflow-x-auto">
				kubectl label namespace &lt;ns&gt; maple.io/instrument=true
			</pre>
		</div>
	)
}

interface DatabaseDetailPanelProps {
	dbSystem: string
	dbEdges: ServiceDbEdge[]
	services: string[]
	durationSeconds: number
	onClose: () => void
}

function DatabaseDetailPanel({
	dbSystem,
	dbEdges,
	services,
	durationSeconds,
	onClose,
}: DatabaseDetailPanelProps) {
	const callers = dbEdges.filter((e) => e.dbSystem === dbSystem)
	const totalCalls = callers.reduce((sum, e) => sum + e.callCount, 0)
	const totalErrors = callers.reduce((sum, e) => sum + e.errorCount, 0)
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const callsPerSecond = totalCalls / Math.max(durationSeconds, 1)
	const avgLatencyMs =
		totalCalls > 0
			? callers.reduce((sum, e) => sum + e.avgDurationMs * e.callCount, 0) / totalCalls
			: 0
	const p95LatencyMs = callers.reduce((max, e) => Math.max(max, e.p95DurationMs), 0)

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-[3px] h-[18px] rounded-sm shrink-0"
						style={{ backgroundColor: "oklch(0.55 0.05 250)" }}
					/>
					<DatabaseIcon size={14} className="text-muted-foreground/80 shrink-0" />
					<span className="text-sm font-semibold text-foreground truncate">{dbSystem}</span>
					<span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase shrink-0">
						database
					</span>
				</div>
				<Button variant="ghost" size="icon-xs" onClick={onClose}>
					<XmarkIcon size={14} />
				</Button>
			</div>

			<ScrollArea className="flex-1 min-h-0">
				<div className="p-4 space-y-5">
					<div className="space-y-3">
						<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
							Metrics
						</h4>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Throughput</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{formatRate(callsPerSecond)}
								</p>
								<span className="text-[10px] text-muted-foreground">calls/s</span>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Error Rate</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										errorRate > 0.05
											? "text-severity-error"
											: errorRate > 0.01
												? "text-severity-warn"
												: "text-foreground",
									)}
								>
									{(errorRate * 100).toFixed(1)}%
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Avg Latency</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{formatLatency(avgLatencyMs)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">P95 Latency</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										p95LatencyMs > avgLatencyMs * 3
											? "text-severity-warn"
											: "text-foreground",
									)}
								>
									{formatLatency(p95LatencyMs)}
								</p>
							</div>
						</div>
					</div>

					{callers.length > 0 && (
						<div className="space-y-3">
							<div className="h-px bg-border" />
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Called By
							</h4>
							<div className="space-y-1.5">
								{callers.map((caller) => {
									const callerColor = getServiceLegendColor(caller.sourceService, services)
									const safeDuration = Math.max(durationSeconds, 1)
									const reqPerSec = caller.hasSampling
										? caller.estimatedCallCount / safeDuration
										: caller.callCount / safeDuration
									return (
										<div
											key={caller.sourceService}
											className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-card border-border text-xs"
										>
											<div className="flex items-center gap-1.5 min-w-0">
												<div
													className="w-[3px] h-3.5 rounded-sm shrink-0"
													style={{ backgroundColor: callerColor }}
												/>
												<span className="text-foreground truncate">
													{caller.sourceService}
												</span>
											</div>
											<div className="flex items-center gap-2 shrink-0 text-[10px]">
												<span className="text-muted-foreground tabular-nums font-mono">
													{caller.hasSampling ? "~" : ""}
													{formatRate(reqPerSec)} calls/s
												</span>
												<span
													className={cn(
														"tabular-nums font-mono",
														caller.errorRate > 0.05
															? "text-severity-error"
															: caller.errorRate > 0.01
																? "text-severity-warn"
																: "text-severity-info",
													)}
												>
													{(caller.errorRate * 100).toFixed(1)}%
												</span>
											</div>
										</div>
									)
								})}
							</div>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	)
}

// --- Main Canvas ---

interface ServiceMapViewProps {
	startTime: string
	endTime: string
}

// --- Debug Layout Sliders ---

const SLIDER_DEFS: Array<{ key: keyof LayoutConfig; label: string; min: number; max: number; step: number }> =
	[
		{ key: "layerGapX", label: "Layer Gap X", min: 100, max: 800, step: 10 },
		{ key: "nodeGapY", label: "Node Gap Y", min: 0, max: 200, step: 5 },
		{ key: "componentGapY", label: "Component Gap Y", min: 20, max: 400, step: 10 },
		{ key: "disconnectedGapX", label: "Disconnected Gap X", min: 20, max: 300, step: 10 },
		{ key: "disconnectedMarginY", label: "Disconnected Margin Y", min: 20, max: 400, step: 10 },
		{ key: "nodeWidth", label: "Node Width (layout)", min: 100, max: 400, step: 10 },
		{ key: "nodeHeight", label: "Node Height (layout)", min: 30, max: 200, step: 5 },
	]

function LayoutDebugPanel({
	config,
	onChange,
}: {
	config: LayoutConfig
	onChange: (config: LayoutConfig) => void
}) {
	const [open, setOpen] = useState(false)

	return (
		<div className="absolute top-2 right-2 z-50">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="px-2 py-1 text-[10px] font-mono bg-card/90 backdrop-blur-sm border border-border rounded text-muted-foreground hover:text-foreground transition-colors"
			>
				{open ? "Close" : "Debug"}
			</button>
			{open && (
				<div className="absolute top-8 right-0 w-64 bg-card/95 backdrop-blur-sm border border-border rounded-lg p-3 space-y-3 shadow-lg">
					<div className="flex items-center justify-between">
						<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
							Layout Config
						</span>
						<button
							type="button"
							onClick={() => onChange({ ...DEFAULT_LAYOUT_CONFIG })}
							className="text-[10px] text-primary hover:text-primary/80 transition-colors"
						>
							Reset
						</button>
					</div>
					{SLIDER_DEFS.map(({ key, label, min, max, step }) => (
						<div key={key} className="space-y-1">
							<div className="flex items-center justify-between">
								<label className="text-[10px] text-muted-foreground">{label}</label>
								<span className="text-[10px] font-mono text-foreground tabular-nums">
									{config[key]}
								</span>
							</div>
							<input
								type="range"
								min={min}
								max={max}
								step={step}
								value={config[key]}
								onChange={(e) => onChange({ ...config, [key]: Number(e.target.value) })}
								className="w-full h-1 accent-primary"
							/>
						</div>
					))}
					<div className="pt-1 border-t border-border">
						<pre className="text-[9px] font-mono text-muted-foreground whitespace-pre-wrap select-all">
							{JSON.stringify(config, null, 2)}
						</pre>
					</div>
				</div>
			)}
		</div>
	)
}

function ServiceMapCanvas({
	edges: serviceEdges,
	dbEdges,
	platforms,
	runtimes,
	overviews,
	workloads,
	showInfraTab,
	durationSeconds,
}: {
	edges: ServiceEdge[]
	dbEdges: ServiceDbEdge[]
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	showInfraTab: boolean
	durationSeconds: number
}) {
	const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null)
	const [layoutConfig, setLayoutConfig] = useState<LayoutConfig>({ ...DEFAULT_LAYOUT_CONFIG })
	const [colorMode, setColorMode] = useState<ServiceMapColorMode>("service")

	const { layoutedNodes, flowEdges, services } = useMemo(() => {
		const { nodes: rawNodes, edges: rawEdges } = buildFlowElements({
			edges: serviceEdges,
			dbEdges,
			serviceOverviews: overviews,
			durationSeconds,
			serviceWorkloads: workloads,
			platforms,
			runtimes,
		})
		const positioned = layoutNodes(rawNodes, rawEdges, layoutConfig)
		// Service legend should only include real services, not synthetic db: nodes
		const allServices = Array.from(
			new Set(positioned.filter((n) => !n.id.startsWith(DB_NODE_PREFIX)).map((n) => n.id)),
		).toSorted()
		return { layoutedNodes: positioned, flowEdges: rawEdges, services: allServices }
	}, [serviceEdges, dbEdges, platforms, runtimes, overviews, workloads, durationSeconds, layoutConfig])

	// Merge layout positions with selection + color-mode state
	const nodesWithSelection = useMemo(() => {
		return layoutedNodes.map((node) => ({
			...node,
			data: {
				...node.data,
				selected: node.id === selectedServiceId,
				colorMode,
			},
		}))
	}, [layoutedNodes, selectedServiceId, colorMode])

	// Track nodes with full ReactFlow state (dimensions, positions from drag, etc.)
	const [nodes, setNodes] = useState(nodesWithSelection)

	// Sync layout changes into node state (preserving measured dimensions)
	const prevLayoutRef = useRef(nodesWithSelection)
	if (prevLayoutRef.current !== nodesWithSelection) {
		prevLayoutRef.current = nodesWithSelection
		setNodes((prev) => {
			// Preserve measured dimensions from previous nodes
			const dimMap = new Map<
				string,
				{ width?: number; height?: number; measured?: { width?: number; height?: number } }
			>()
			for (const n of prev) {
				dimMap.set(n.id, { width: n.width, height: n.height, measured: n.measured })
			}
			return nodesWithSelection.map((n) => {
				const dims = dimMap.get(n.id)
				return dims ? { ...n, width: dims.width, height: dims.height, measured: dims.measured } : n
			})
		})
	}

	// Programmatic fitView after ALL nodes are measured (the fitView prop fires too early)
	const rfInstance = useRef<ReactFlowInstance | null>(null)
	const hasFitView = useRef(false)

	const onNodesChange = useCallback((changes: NodeChange[]) => {
		setNodes((prev) => {
			const next = applyNodeChanges(changes, prev) as typeof prev

			if (!hasFitView.current && rfInstance.current && changes.some((c) => c.type === "dimensions")) {
				const allMeasured =
					next.length > 0 && next.every((n) => n.measured?.width && n.measured?.height)
				if (allMeasured) {
					hasFitView.current = true
					setTimeout(() => rfInstance.current?.fitView(), 0)
				}
			}

			return next
		})
	}, [])

	const handleNodeClick = useCallback((_: React.MouseEvent, node: Node<ServiceNodeData>) => {
		setSelectedServiceId((prev) => (prev === node.id ? null : node.id))
	}, [])

	const handlePaneClick = useCallback(() => {
		setSelectedServiceId(null)
	}, [])

	if (nodes.length === 0) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="text-center space-y-2">
					<p className="text-sm font-medium text-muted-foreground">No service dependencies found</p>
					<p className="text-xs text-muted-foreground/60">
						Service connections will appear when trace data with cross-service calls is ingested.
					</p>
				</div>
			</div>
		)
	}

	return (
		<div className="flex flex-col h-full">
			<ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
				<ResizablePanel defaultSize={selectedServiceId ? 65 : 100} minSize={40}>
					<div className="flex flex-col h-full">
						<div className="flex-1 min-h-0 relative">
							<LayoutDebugPanel config={layoutConfig} onChange={setLayoutConfig} />
							<div className="absolute top-2 left-2 z-50 flex items-center gap-2 bg-card/90 backdrop-blur-sm border border-border rounded-md px-2 py-1">
								<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
									Color by
								</span>
								<Select
									value={colorMode}
									onValueChange={(v) => setColorMode(v as ServiceMapColorMode)}
								>
									<SelectTrigger
										size="sm"
										className="h-6 text-[11px] capitalize border-0 bg-transparent px-1.5"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="service">Service</SelectItem>
										<SelectItem value="health">Health</SelectItem>
										<SelectItem value="platform">Platform</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<ReactFlow
								nodes={nodes}
								edges={flowEdges}
								onNodesChange={onNodesChange}
								onNodeClick={handleNodeClick}
								onPaneClick={handlePaneClick}
								onInit={(instance) => {
									rfInstance.current = instance as unknown as ReactFlowInstance
								}}
								nodeTypes={nodeTypes}
								edgeTypes={edgeTypes}
								nodesDraggable
								nodesConnectable={false}
								connectOnClick={false}
								elementsSelectable={false}
								minZoom={0.1}
								maxZoom={2}
								proOptions={{ hideAttribution: true }}
							>
								<Controls showInteractive={false} />
								<MiniMap
									nodeColor={(node: Node) => {
										const data = node.data as ServiceNodeData
										return getServiceMapNodeColor(data, data.services, colorMode)
									}}
									nodeComponent={ServiceMiniMapNode}
									nodeStrokeWidth={0}
									maskColor="oklch(0.15 0 0 / 0.8)"
									className="!bg-muted/50 !border-border"
									pannable={false}
									zoomable={false}
								/>
								<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
							</ReactFlow>
						</div>

						{/* Legend */}
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground shrink-0">
							<span className="font-medium">Drag nodes to arrange</span>
							<span className="text-foreground/30">|</span>
							<span className="font-medium">Scroll to zoom</span>
							{colorMode === "service" && services.length > 0 && (
								<>
									<span className="text-foreground/30">|</span>
									{services.slice(0, 3).map((service) => (
										<div key={service} className="flex items-center gap-1.5">
											<div
												className="size-2.5 rounded-sm shrink-0"
												style={{
													backgroundColor: getServiceMapNodeColor(
														{ label: service, kind: "service", errorRate: 0 },
														services,
														"service",
													),
												}}
											/>
											<span className="font-medium">{service}</span>
										</div>
									))}
									{services.length > 3 && (
										<Popover>
											<PopoverTrigger className="font-medium hover:text-foreground transition-colors cursor-pointer">
												+{services.length - 3} more
											</PopoverTrigger>
											<PopoverContent align="start" className="w-64 p-3" side="top">
												<div className="grid grid-cols-2 gap-2 text-[11px]">
													{services.map((service) => (
														<div
															key={service}
															className="flex items-center gap-1.5 min-w-0"
														>
															<div
																className="size-2.5 rounded-sm shrink-0"
																style={{
																	backgroundColor: getServiceMapNodeColor(
																		{
																			label: service,
																			kind: "service",
																			errorRate: 0,
																		},
																		services,
																		"service",
																	),
																}}
															/>
															<span className="truncate font-medium">
																{service}
															</span>
														</div>
													))}
												</div>
											</PopoverContent>
										</Popover>
									)}
								</>
							)}
							{colorMode === "platform" && (
								<>
									<span className="text-foreground/30">|</span>
									{(["kubernetes", "cloudflare", "lambda", "web", "unknown"] as const).map((p) => (
										<div key={p} className="flex items-center gap-1.5">
											<div
												className="size-2.5 rounded-sm shrink-0"
												style={{
													backgroundColor: getPlatformColor(
														p === "unknown" ? undefined : p,
													),
												}}
											/>
											<span className="font-medium capitalize">{p}</span>
										</div>
									))}
								</>
							)}
							<span className="flex-1" />
							<div className="flex items-center gap-3">
								<div className="flex items-center gap-1.5">
									<div className="size-2 rounded-full bg-severity-info" />
									<span>Healthy</span>
								</div>
								<div className="flex items-center gap-1.5">
									<div className="size-2 rounded-full bg-severity-warn" />
									<span>Degraded</span>
								</div>
								<div className="flex items-center gap-1.5">
									<div className="size-2 rounded-full bg-severity-error" />
									<span>Error</span>
								</div>
							</div>
						</div>
					</div>
				</ResizablePanel>

				{selectedServiceId &&
					(selectedServiceId.startsWith(DB_NODE_PREFIX) ? (
						<>
							<ResizableHandle withHandle />
							<ResizablePanel defaultSize={35} minSize={25}>
								<DatabaseDetailPanel
									dbSystem={selectedServiceId.slice(DB_NODE_PREFIX.length)}
									dbEdges={dbEdges}
									services={services}
									durationSeconds={durationSeconds}
									onClose={() => setSelectedServiceId(null)}
								/>
							</ResizablePanel>
						</>
					) : (
						<>
							<ResizableHandle withHandle />
							<ResizablePanel defaultSize={35} minSize={25}>
								<ServiceDetailPanel
									serviceId={selectedServiceId}
									services={services}
									edges={serviceEdges}
									overviews={overviews}
									workloads={workloads}
									showInfraTab={showInfraTab}
									platforms={platforms}
									colorMode={colorMode}
									durationSeconds={durationSeconds}
									onClose={() => setSelectedServiceId(null)}
								/>
							</ResizablePanel>
						</>
					))}
			</ResizablePanelGroup>
		</div>
	)
}

export function ServiceMapView({ startTime, endTime }: ServiceMapViewProps) {
	const infraEnabled = useInfraEnabled()
	const durationSeconds = useMemo(() => {
		const ms = new Date(endTime).getTime() - new Date(startTime).getTime()
		return Math.max(1, ms / 1000)
	}, [startTime, endTime])

	const mapInput: { data: GetServiceMapInput } = useMemo(
		() => ({ data: { startTime, endTime } }),
		[startTime, endTime],
	)

	const overviewInput: { data: GetServiceOverviewInput } = useMemo(
		() => ({ data: { startTime, endTime } }),
		[startTime, endTime],
	)

	const mapResult = useRefreshableAtomValue(getServiceMapResultAtom(mapInput))
	const overviewResult = useRefreshableAtomValue(getServiceOverviewResultAtom(overviewInput))
	const dbEdgesResult = useRefreshableAtomValue(getServiceMapDbEdgesResultAtom(mapInput))
	const platformsResult = useRefreshableAtomValue(getServicePlatformsResultAtom(mapInput))

	// Render map as soon as edges arrive — don't wait for overview metrics
	const overviews = Result.isSuccess(overviewResult) ? overviewResult.value.data : []
	const dbEdges = Result.isSuccess(dbEdgesResult) ? dbEdgesResult.value.edges : []
	const platforms = useMemo(() => {
		const map = new Map<string, ServicePlatform>()
		if (Result.isSuccess(platformsResult)) {
			for (const p of platformsResult.value.platforms) {
				map.set(p.serviceName, p.platform)
			}
		}
		return map
	}, [platformsResult])
	const runtimes = useMemo(() => {
		const map = new Map<string, string>()
		if (Result.isSuccess(platformsResult)) {
			for (const p of platformsResult.value.platforms) {
				if (p.runtime) map.set(p.serviceName, p.runtime)
			}
		}
		return map
	}, [platformsResult])

	// Bulk fetch workloads keyed off the same set of services that appear in edges.
	// Gated on infraEnabled so we don't issue this query on plans without the
	// infrastructure feature. Empty services array short-circuits to no rows.
	const services = useMemo(() => {
		if (!Result.isSuccess(mapResult)) return [] as string[]
		const set = new Set<string>()
		for (const edge of mapResult.value.edges) {
			set.add(edge.sourceService)
			set.add(edge.targetService)
		}
		for (const o of overviews) set.add(o.serviceName)
		return Array.from(set).sort()
	}, [mapResult, overviews])

	const workloadsInput = useMemo(
		() => ({ data: { startTime, endTime, services } }),
		[startTime, endTime, services],
	)
	const workloadsResult = useRefreshableAtomValue(getServiceWorkloadsResultAtom(workloadsInput))
	// Don't block first paint on workloads — fall back to empty until it lands.
	const workloads = infraEnabled && Result.isSuccess(workloadsResult) ? workloadsResult.value.workloads : []

	return Result.builder(mapResult)
		.onInitial(() => (
			<div className="flex items-center justify-center h-full">
				<div className="text-sm text-muted-foreground animate-pulse">Loading service map…</div>
			</div>
		))
		.onError((error) => {
			const formatted = formatBackendError(error)
			return (
				<div className="flex items-center justify-center h-full">
					<div className="text-center space-y-2">
						<p className="text-sm font-medium text-destructive">{formatted.title}</p>
						<p className="text-xs text-muted-foreground">{formatted.description}</p>
					</div>
				</div>
			)
		})
		.onSuccess((mapResponse) => (
			<ServiceMapCanvas
				edges={mapResponse.edges}
				dbEdges={dbEdges}
				platforms={platforms}
				runtimes={runtimes}
				overviews={overviews}
				workloads={workloads}
				showInfraTab={infraEnabled}
				durationSeconds={durationSeconds}
			/>
		))
		.render()
}
