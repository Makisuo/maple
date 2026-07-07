import { useDeferredValue, useEffect, useMemo, useRef, useState, useCallback } from "react"
import {
	ReactFlow,
	Controls,
	MiniMap,
	Background,
	BackgroundVariant,
	applyNodeChanges,
	type Edge,
	type Node,
	type NodeChange,
	type NodePositionChange,
	type ReactFlowInstance,
	type Viewport,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { Result, useAtom } from "@/lib/effect-atom"
import { serviceMapLayoutAtomFamily } from "@/atoms/service-map-layout-atoms"
import { Link } from "@tanstack/react-router"
import { formatBackendError } from "@/lib/error-messages"
import { Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from "recharts"

import { cn } from "@maple/ui/utils"
import { getServiceLegendColor, getValueHue } from "@maple/ui/colors"
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Popover, PopoverTrigger, PopoverContent } from "@maple/ui/components/ui/popover"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@maple/ui/components/ui/resizable"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { formatBucketLabel } from "@/lib/format"
import {
	ArrowRightIcon,
	ArrowRotateAnticlockwiseIcon,
	CloudflareIcon,
	CubeIcon,
	ExternalLinkIcon,
	NetworkNodesIcon,
	XmarkIcon,
} from "@/components/icons"
import {
	getServiceDbQuerySummaryResultAtom,
	getServiceMapCloudflareResultAtom,
	getServiceMapDbEdgesResultAtom,
	getServiceMapResultAtom,
	getServiceOverviewResultAtom,
	getServicePlatformsResultAtom,
	getServiceWorkloadsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type {
	CloudflareService,
	GetServiceMapInput,
	ServiceDbEdge,
	ServiceDbQuerySummaryResponse,
	ServiceEdge,
	ServicePlatform,
} from "@/api/warehouse/service-map"
import type { GetServiceOverviewInput, ServiceOverview } from "@/api/warehouse/services"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { ServiceMapNode } from "./service-map-node"
import { ServiceMapLoading } from "./service-map-loading"
import { ServiceMapEdge } from "./service-map-edge"
import { NamespaceGroupNode, type NamespaceGroupData } from "./service-map-namespace-group"
import { layoutServiceMapWithElk, type ElkLayoutResult } from "./service-map-elk"
import {
	createParticleRegistry,
	ParticleRegistryProvider,
	ServiceMapParticleCanvas,
	type ParticleRegistry,
} from "./service-map-particles"
import { getDbDescriptor } from "./service-map-db"
import {
	buildFlowElements,
	CLOUDFLARE_COLOR,
	computeNodePositions,
	DB_NODE_PREFIX,
	parseDbNodeId,
	getPlatformColor,
	getServiceMapNodeColor,
	topologyKey,
	DEFAULT_LAYOUT_CONFIG,
	NS_LABEL_HEIGHT,
	NS_PADDING_X,
	NS_PADDING_Y,
	type CloudflareNodeMetrics,
	type LayoutConfig,
	type ServiceEdgeData,
	type ServiceMapColorMode,
	type ServiceNodeData,
} from "./service-map-utils"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"

const nodeTypes = {
	serviceNode: ServiceMapNode,
	namespaceGroup: NamespaceGroupNode,
}

const NAMESPACE_GROUP_PREFIX = "nsgroup:"
const nsGroupId = (namespace: string) => `${NAMESPACE_GROUP_PREFIX}${encodeURIComponent(namespace)}`

// Fallback node dimensions used before ReactFlow has measured a node, so the
// dotted boxes appear on first paint and refine once real sizes arrive.
const FALLBACK_NODE_WIDTH = 220
const FALLBACK_NODE_HEIGHT = 70

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
	/** Cloudflare direct-integration analytics overlaid onto this instrumented Worker, if matched. */
	cloudflare?: CloudflareNodeMetrics
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
	cloudflare,
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
					<div className="flex flex-col min-w-0">
						<span className="text-sm font-semibold text-foreground truncate">{serviceId}</span>
						{overview?.serviceNamespace ? (
							<span className="text-[10px] text-muted-foreground truncate">
								{overview.serviceNamespace}
							</span>
						) : null}
					</div>
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
				<TabsList variant="underline" className="shrink-0 px-4 pt-2">
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

							{/* Cloudflare edge (direct integration overlay) */}
							{cloudflare && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<div className="flex items-center gap-1.5">
										<CloudflareIcon size={12} style={{ color: CLOUDFLARE_COLOR }} />
										<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
											Cloudflare edge
										</h4>
									</div>
									<div className="grid grid-cols-2 gap-x-6 gap-y-4">
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">Requests</span>
											<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
												{formatCompactCount(cloudflare.requests)}
											</p>
											<span className="text-[10px] text-muted-foreground">
												edge-reported (unsampled)
											</span>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">Error Rate</span>
											<p
												className={cn(
													"text-xl font-semibold tabular-nums font-mono",
													cloudflare.errorRate > 0.05
														? "text-severity-error"
														: cloudflare.errorRate > 0.01
															? "text-severity-warn"
															: "text-foreground",
												)}
											>
												{(cloudflare.errorRate * 100).toFixed(1)}%
											</p>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">CPU p99</span>
											<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
												{formatLatency(cloudflare.cpuP99Ms ?? 0)}
											</p>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">Duration p99</span>
											<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
												{formatLatency(cloudflare.latencyP99Ms)}
											</p>
										</div>
									</div>
								</div>
							)}

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

// A single faint service-node glyph for the empty-state ghost graph — a rounded
// card with a status dot and two label lines, echoing the real ServiceMapNode.
function GhostNode({ x, y, color }: { x: number; y: number; color: string }) {
	return (
		<g>
			<rect
				x={x}
				y={y}
				width={72}
				height={30}
				rx={7}
				fill={color}
				fillOpacity={0.16}
				stroke={color}
				strokeOpacity={0.5}
				strokeWidth={1.25}
			/>
			<circle cx={x + 13} cy={y + 15} r={3} fill={color} fillOpacity={0.9} />
			<rect x={x + 22} y={y + 10} width={36} height={3} rx={1.5} fill={color} fillOpacity={0.34} />
			<rect x={x + 22} y={y + 17} width={22} height={3} rx={1.5} fill={color} fillOpacity={0.2} />
		</g>
	)
}

// Empty-state for the canvas, shown when there's no service activity at all in
// the window (no edges, db edges, or overviews → zero nodes). Echoes the live
// map's own language — the dotted Background grid plus a faint geometric service
// graph — so it reads as "the map, empty," not a blank void.
function ServiceMapEmptyState() {
	return (
		<div className="relative flex h-full items-center justify-center overflow-hidden">
			{/* Dotted grid: the live map's <Background variant={Dots} gap={16} size={1}>,
			    faded out toward the centre so it never competes with the message. */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 opacity-70"
				style={{
					backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
					backgroundSize: "16px 16px",
					maskImage: "radial-gradient(ellipse 75% 72% at 50% 50%, transparent 26%, black 82%)",
					WebkitMaskImage:
						"radial-gradient(ellipse 75% 72% at 50% 50%, transparent 26%, black 82%)",
				}}
			/>

			<div className="relative z-10 flex flex-col items-center motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300">
				{/* Ghost graph drawn in the node/edge vocabulary of the real map. */}
				<svg
					aria-hidden
					viewBox="0 0 460 178"
					className="pointer-events-none mb-1 w-[min(440px,76vw)] text-muted-foreground"
					fill="none"
					style={{
						maskImage: "radial-gradient(ellipse 62% 78% at 50% 50%, black 52%, transparent 100%)",
						WebkitMaskImage:
							"radial-gradient(ellipse 62% 78% at 50% 50%, black 52%, transparent 100%)",
					}}
				>
					<style>{`
						@keyframes sm-empty-flow { to { stroke-dashoffset: -16; } }
						.sm-empty-flow { animation: sm-empty-flow 1.8s linear infinite; }
						@media (prefers-reduced-motion: reduce) { .sm-empty-flow { animation: none; } }
					`}</style>
					<g stroke="currentColor" strokeWidth={1.25} strokeOpacity={0.3} strokeDasharray="4 4">
						<path d="M108 49 C 150 40, 162 30, 194 27" />
						<path className="sm-empty-flow" d="M108 49 C 150 66, 162 122, 194 131" />
						<path d="M266 27 C 312 34, 322 72, 352 79" />
						<path d="M266 131 C 312 122, 322 86, 352 79" />
					</g>
					<GhostNode x={36} y={34} color="var(--service-1)" />
					<GhostNode x={194} y={12} color="var(--service-2)" />
					<GhostNode x={194} y={116} color="var(--service-3)" />
					<GhostNode x={352} y={64} color="var(--service-5)" />
				</svg>

				<Empty className="flex-none bg-transparent py-0">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<NetworkNodesIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>No service map yet</EmptyTitle>
						<EmptyDescription>
							Maple builds this map from cross-service spans in your traces. Once your services
							report calls to each other, they&rsquo;ll appear here as a connected graph.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<a
							href="https://maple.dev/docs/getting-started/introduction"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1.5 text-foreground underline underline-offset-2 transition-colors hover:no-underline"
						>
							Set up instrumentation
							<ExternalLinkIcon size={12} />
						</a>
						<p className="text-xs text-muted-foreground/70">
							Seeing this with active services? Try widening the time range.
						</p>
					</EmptyContent>
				</Empty>
			</div>
		</div>
	)
}

interface DatabaseDetailPanelProps {
	dbSystem: string
	/** "" = the generic/legacy node (edges with no identified database). */
	dbNamespace: string
	dbEdges: ServiceDbEdge[]
	services: string[]
	durationSeconds: number
	startTime: string
	endTime: string
	onClose: () => void
}

const DB_QUERY_CHART_CONFIG = {
	queryCount: {
		label: "Queries",
		color: "var(--chart-2)",
	},
	p50DurationMs: {
		label: "P50",
		color: "var(--chart-p50)",
	},
	p95DurationMs: {
		label: "P95",
		color: "var(--chart-p95)",
	},
} satisfies ChartConfig

function pickDbSummaryBucketSeconds(durationSeconds: number): number {
	if (durationSeconds <= 6 * 60 * 60) return 5 * 60
	if (durationSeconds <= 24 * 60 * 60) return 15 * 60
	if (durationSeconds <= 7 * 24 * 60 * 60) return 60 * 60
	return 6 * 60 * 60
}

function formatCompactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	return value.toLocaleString()
}

function formatQueryLabel(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	if (collapsed.length <= 96) return collapsed || "unknown query"
	return `${collapsed.slice(0, 78)}…${collapsed.slice(-16)}`
}

function DbQueryActivityChart({
	response,
	waiting,
}: {
	response: ServiceDbQuerySummaryResponse | null
	waiting: boolean
}) {
	const data = useMemo(
		() =>
			(response?.timeseries ?? []).map((point) => ({
				...point,
				queryCount: Math.round(point.estimatedQueryCount || point.queryCount),
			})),
		[response],
	)
	const axisContext = useMemo(() => {
		if (data.length < 2) return { rangeMs: 0, bucketSeconds: undefined }
		const first = new Date(data[0]!.bucket).getTime()
		const second = new Date(data[1]!.bucket).getTime()
		const last = new Date(data[data.length - 1]!.bucket).getTime()
		const bucketMs = second - first
		return {
			rangeMs: Number.isFinite(last - first) ? last - first : 0,
			bucketSeconds: bucketMs > 0 && Number.isFinite(bucketMs) ? bucketMs / 1000 : undefined,
		}
	}, [data])

	if (!response && waiting) {
		return (
			<div className="flex h-44 items-center justify-center rounded-md border border-border/70 bg-muted/20 text-xs text-muted-foreground">
				Loading query activity…
			</div>
		)
	}

	if (data.length === 0) {
		return (
			<div className="flex h-44 items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 text-xs text-muted-foreground">
				No database query spans in this window
			</div>
		)
	}

	return (
		<ChartContainer config={DB_QUERY_CHART_CONFIG} className="h-44 w-full">
			<BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
				<CartesianGrid
					// recharts v3 only draws grid lines for a matching axis id; this chart's
					// y axes are "count"/"latency" (no default id=0), so pin to the primary "count" axis
					yAxisId="count"
					vertical={false}
					strokeDasharray="3 3"
				/>
				<XAxis
					dataKey="bucket"
					axisLine={false}
					tickLine={false}
					tickMargin={8}
					minTickGap={20}
					fontSize={10}
					tickFormatter={(value) => formatBucketLabel(value, axisContext, "tick")}
				/>
				<YAxis
					yAxisId="count"
					axisLine={false}
					tickLine={false}
					tickMargin={8}
					width={34}
					fontSize={10}
					tickFormatter={(value) => formatCompactCount(Number(value))}
				/>
				<YAxis
					yAxisId="latency"
					orientation="right"
					axisLine={false}
					tickLine={false}
					tickMargin={8}
					width={42}
					fontSize={10}
					tickFormatter={(value) => formatLatency(Number(value))}
				/>
				<ChartTooltip
					cursor={{ fill: "var(--muted)", opacity: 0.3 }}
					content={
						<ChartTooltipContent
							labelFormatter={(value) => formatBucketLabel(value, axisContext, "tooltip")}
							formatter={(value, name) => {
								const label = name === "queryCount" ? "Queries" : String(name)
								const formatted =
									name === "queryCount"
										? formatCompactCount(Number(value))
										: formatLatency(Number(value))
								return (
									<span className="flex items-center gap-2">
										<span className="text-muted-foreground">{label}</span>
										<span className="font-mono font-medium tabular-nums">
											{formatted}
										</span>
									</span>
								)
							}}
						/>
					}
				/>
				<Bar
					yAxisId="count"
					dataKey="queryCount"
					fill="var(--color-queryCount)"
					radius={[2, 2, 0, 0]}
					isAnimationActive={false}
				/>
				<Line
					yAxisId="latency"
					type="monotone"
					dataKey="p50DurationMs"
					stroke="var(--color-p50DurationMs)"
					strokeWidth={1.5}
					dot={false}
					isAnimationActive={false}
				/>
				<Line
					yAxisId="latency"
					type="monotone"
					dataKey="p95DurationMs"
					stroke="var(--color-p95DurationMs)"
					strokeWidth={1.5}
					dot={false}
					isAnimationActive={false}
				/>
			</BarChart>
		</ChartContainer>
	)
}

function DatabaseDetailPanel({
	dbSystem,
	dbNamespace,
	dbEdges,
	services,
	durationSeconds,
	startTime,
	endTime,
	onClose,
}: DatabaseDetailPanelProps) {
	const callers = dbEdges.filter((e) => e.dbSystem === dbSystem && e.dbNamespace === dbNamespace)
	const totalCalls = callers.reduce((sum, e) => sum + e.callCount, 0)
	const totalErrors = callers.reduce((sum, e) => sum + e.errorCount, 0)
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs =
		totalCalls > 0 ? callers.reduce((sum, e) => sum + e.avgDurationMs * e.callCount, 0) / totalCalls : 0
	const p95LatencyMs = callers.reduce((max, e) => Math.max(max, e.p95DurationMs), 0)
	const bucketSeconds = pickDbSummaryBucketSeconds(durationSeconds)
	const summaryResult = useRefreshableAtomValue(
		getServiceDbQuerySummaryResultAtom({
			data: {
				dbSystem,
				dbNamespace,
				startTime,
				endTime,
				bucketSeconds,
				topN: 8,
			},
		}),
	)
	const summaryResponse = Result.isSuccess(summaryResult) ? summaryResult.value : null
	const summary = summaryResponse?.summary ?? null
	const metricQueryCount = summary?.estimatedQueryCount ?? totalCalls
	const metricCallsPerSecond = metricQueryCount / Math.max(durationSeconds, 1)
	const metricErrorRate = summary?.errorRate ?? errorRate
	const metricAvgLatencyMs = summary?.avgDurationMs ?? avgLatencyMs
	const metricP50LatencyMs = summary?.p50DurationMs ?? avgLatencyMs
	const metricP95LatencyMs = summary?.p95DurationMs ?? p95LatencyMs
	const metricHasSampling = summary
		? summary.estimatedQueryCount > summary.queryCount + 1
		: callers.some((caller) => caller.hasSampling)
	const summaryWaiting = Boolean(summaryResult.waiting)

	const { category, Icon: DbIcon, color: dbColor, branded: dbBranded } = getDbDescriptor(dbSystem)

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-[3px] h-[18px] rounded-sm shrink-0"
						style={{ backgroundColor: dbColor }}
					/>
					<DbIcon
						size={14}
						className="shrink-0"
						style={dbBranded ? undefined : { color: dbColor }}
					/>
					<span className="text-sm font-semibold text-foreground truncate">
						{dbNamespace || dbSystem}
					</span>
					<span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase shrink-0">
						{dbNamespace ? dbSystem : category}
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
								<span className="text-[10px] text-muted-foreground">Queries</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{metricHasSampling ? "~" : ""}
									{formatCompactCount(metricQueryCount)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Throughput</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{metricHasSampling ? "~" : ""}
									{formatRate(metricCallsPerSecond)}
								</p>
								<span className="text-[10px] text-muted-foreground">calls/s</span>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Error Rate</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										metricErrorRate > 0.05
											? "text-severity-error"
											: metricErrorRate > 0.01
												? "text-severity-warn"
												: "text-foreground",
									)}
								>
									{(metricErrorRate * 100).toFixed(1)}%
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">P50 Latency</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{formatLatency(metricP50LatencyMs)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">P95 Latency</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										metricP95LatencyMs > metricP50LatencyMs * 3
											? "text-severity-warn"
											: "text-foreground",
									)}
								>
									{formatLatency(metricP95LatencyMs)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Avg Latency</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{formatLatency(metricAvgLatencyMs)}
								</p>
							</div>
						</div>
					</div>

					<div className="space-y-3">
						<div className="h-px bg-border" />
						<div className="flex items-center justify-between gap-2">
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Query Activity
							</h4>
							{summaryWaiting && summaryResponse && (
								<span className="text-[10px] text-muted-foreground">Refreshing</span>
							)}
						</div>
						{Result.builder(summaryResult)
							.onError((error) => {
								const formatted = formatBackendError(error)
								return (
									<div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
										<p className="font-medium text-destructive">{formatted.title}</p>
										<p className="mt-1 text-muted-foreground">{formatted.description}</p>
									</div>
								)
							})
							.orElse(() => null)}
						<DbQueryActivityChart response={summaryResponse} waiting={summaryWaiting} />
					</div>

					{summaryResponse?.topQueries.length ? (
						<div className="space-y-3">
							<div className="h-px bg-border" />
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Top Query Shapes
							</h4>
							<div className="space-y-1.5">
								{summaryResponse.topQueries.map((query) => (
									<div
										key={query.queryKey}
										className="rounded-md border border-border bg-card px-2.5 py-2"
									>
										<div className="flex items-start justify-between gap-2">
											<p className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
												{formatQueryLabel(query.queryLabel)}
											</p>
											<span
												className={cn(
													"shrink-0 font-mono text-[10px] tabular-nums",
													query.errorRate > 0.05
														? "text-severity-error"
														: query.errorRate > 0.01
															? "text-severity-warn"
															: "text-muted-foreground",
												)}
											>
												{(query.errorRate * 100).toFixed(1)}%
											</span>
										</div>
										<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
											<span className="font-mono tabular-nums">
												{query.estimatedQueryCount > query.queryCount + 1 ? "~" : ""}
												{formatCompactCount(query.estimatedQueryCount)} calls
											</span>
											<span className="font-mono tabular-nums">
												p50 {formatLatency(query.p50DurationMs)}
											</span>
											<span className="font-mono tabular-nums">
												p95 {formatLatency(query.p95DurationMs)}
											</span>
											<span className="truncate">
												{query.serviceCount > 1
													? `${query.serviceCount} services`
													: query.sampleService}
											</span>
										</div>
									</div>
								))}
							</div>
						</div>
					) : null}

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

/**
 * Run ELK's async layout whenever the topology/namespace/config key changes,
 * returning the result once it resolves for the CURRENT key (null while pending
 * or when disabled, so callers fall back to the synchronous layout). One effect:
 * this is genuine synchronization with an external, imperative async layout
 * engine — not derivable render state. Reads live nodes/edges through refs so the
 * effect only re-fires on the stable string key, not on array identity churn.
 */
function useElkLayout(
	rawNodes: Node<ServiceNodeData>[],
	flowEdges: Edge<ServiceEdgeData>[],
	enabled: boolean,
	config: LayoutConfig,
	key: string,
): ElkLayoutResult | null {
	const [state, setState] = useState<{ key: string; layout: ElkLayoutResult } | null>(null)
	const nodesRef = useRef(rawNodes)
	nodesRef.current = rawNodes
	const edgesRef = useRef(flowEdges)
	edgesRef.current = flowEdges
	const configRef = useRef(config)
	configRef.current = config

	useEffect(() => {
		if (!enabled) {
			setState(null)
			return
		}
		let cancelled = false
		layoutServiceMapWithElk(nodesRef.current, edgesRef.current, configRef.current)
			.then((layout) => {
				if (!cancelled) setState({ key, layout })
			})
			.catch((error) => {
				if (!cancelled) console.error("Service map ELK layout failed", error)
			})
		return () => {
			cancelled = true
		}
	}, [enabled, key])

	return state?.key === key ? state.layout : null
}

export function ServiceMapCanvas({
	edges: serviceEdges,
	dbEdges,
	cloudflareServices,
	faasNames,
	platforms,
	runtimes,
	overviews,
	workloads,
	showInfraTab,
	durationSeconds,
	startTime,
	endTime,
	layoutKey,
}: {
	edges: ServiceEdge[]
	dbEdges: ServiceDbEdge[]
	cloudflareServices: CloudflareService[]
	faasNames: Map<string, string>
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	showInfraTab: boolean
	durationSeconds: number
	startTime: string
	endTime: string
	// Namespaces persisted drag positions / viewport. Lifted to a prop so the
	// component renders without a Clerk session (e.g. the /service-map-bench
	// perf harness, which runs in self-hosted mode with no ClerkProvider).
	layoutKey: string
}) {
	const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null)
	const [layoutConfig, setLayoutConfig] = useState<LayoutConfig>({ ...DEFAULT_LAYOUT_CONFIG })
	const [colorMode, setColorMode] = useState<ServiceMapColorMode>("service")

	const [layout, setLayout] = useAtom(serviceMapLayoutAtomFamily(layoutKey))

	// Stable registry that edges publish their geometry into and the single
	// particle canvas reads each frame. Created once per canvas instance.
	const registryRef = useRef<ParticleRegistry | null>(null)
	if (registryRef.current === null) registryRef.current = createParticleRegistry()
	const registry = registryRef.current

	// Build nodes/edges (carrying live metrics) every render — cheap object work.
	const { rawNodes, flowEdges, services } = useMemo(() => {
		const { nodes, edges } = buildFlowElements({
			edges: serviceEdges,
			dbEdges,
			serviceOverviews: overviews,
			durationSeconds,
			serviceWorkloads: workloads,
			platforms,
			runtimes,
			cloudflareServices,
			faasNames,
		})
		// Service legend should only include real services, not synthetic db: nodes
		const allServices = Array.from(
			new Set(nodes.filter((n) => !n.id.startsWith(DB_NODE_PREFIX)).map((n) => n.id)),
		).toSorted()
		return { rawNodes: nodes, flowEdges: edges, services: allServices }
	}, [serviceEdges, dbEdges, cloudflareServices, faasNames, platforms, runtimes, overviews, workloads, durationSeconds])

	// Cloudflare analytics overlaid onto instrumented Workers.
	const cloudflareOverlayByService = useMemo(() => {
		const m = new Map<string, CloudflareNodeMetrics>()
		for (const n of rawNodes) {
			if (n.data.cloudflare) m.set(n.id, n.data.cloudflare)
		}
		return m
	}, [rawNodes])

	// Positions depend ONLY on topology + layout config. Memoize the expensive
	// hierarchical layout on a topology key so metric refreshes (new array
	// identities, same shape) don't re-run barycenter sweeps. The memo body runs
	// each render but short-circuits on an unchanged key.
	const topoKey = useMemo(() => topologyKey(rawNodes, flowEdges), [rawNodes, flowEdges])
	// Namespace assignment is part of node DATA, not topology, so it isn't covered
	// by topoKey. Fold a namespace signature into the cache key so re-bucketing
	// happens when a service's namespace changes even if the shape is unchanged.
	const nsKey = useMemo(
		() =>
			rawNodes
				.map((n) => (n.data.namespace ? `${n.id}=${n.data.namespace}` : ""))
				.filter(Boolean)
				.sort()
				.join(","),
		[rawNodes],
	)
	const layoutSignature = `${topoKey}|${nsKey}|${JSON.stringify(layoutConfig)}`

	// Persisted drag positions / viewport are absolute coordinates tied to a
	// specific layout. Honour them ONLY while their captured signature still
	// matches the live layout — otherwise (topology / namespace / config change,
	// or pre-signature localStorage data) the stale coords scatter nodes out of
	// their namespace clusters and overlap the dotted boxes, so fall back to the
	// clean ELK layout. Stable across metric refreshes (topoKey is the topology
	// memo key), so ordinary refreshes keep manual arrangements.
	const persisted = useMemo(
		() =>
			layout.signature === layoutSignature
				? layout
				: { positions: {}, viewport: null, signature: layoutSignature },
		[layout, layoutSignature],
	)
	// Mirror the live signature into a ref so drag/viewport persistence callbacks
	// can stamp it without being re-created on every signature change.
	const sigRef = useRef(layoutSignature)
	sigRef.current = layoutSignature

	// When namespaces are defined, ELK's layered/compound layout (async) produces
	// the final node positions. Until it resolves we fall back to the synchronous
	// swimlane layout below so first paint is instant; without namespaces ELK is
	// skipped entirely (identical to today, perf bench unaffected). Edges always
	// render as smooth-step curves (ELK is used for positions only).
	const hasNamespaces = useMemo(() => rawNodes.some((n) => Boolean(n.data.namespace)), [rawNodes])
	const elk = useElkLayout(rawNodes, flowEdges, hasNamespaces, layoutConfig, layoutSignature)

	const layoutCacheRef = useRef<{ key: string; positions: Map<string, { x: number; y: number }> } | null>(
		null,
	)
	const layoutedNodes = useMemo(() => {
		if (layoutCacheRef.current?.key !== layoutSignature) {
			layoutCacheRef.current = {
				key: layoutSignature,
				positions: computeNodePositions(rawNodes, flowEdges, layoutConfig),
			}
		}
		const positions = elk?.positions ?? layoutCacheRef.current.positions
		return rawNodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }))
	}, [rawNodes, flowEdges, layoutConfig, layoutSignature, elk])

	// Merge layout positions with selection + color-mode state. Persisted drag
	// positions (keyed by node id) override the deterministic auto-layout.
	const nodesWithSelection = useMemo(() => {
		return layoutedNodes.map((node) => ({
			...node,
			position: persisted.positions[node.id] ?? node.position,
			data: {
				...node.data,
				selected: node.id === selectedServiceId,
				colorMode,
			},
		}))
	}, [layoutedNodes, selectedServiceId, colorMode, persisted.positions])

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

	// Programmatic fitView after ALL nodes are measured (the fitView prop fires too early).
	// Skip auto-fit entirely when a saved viewport exists so the restored camera survives.
	const rfInstance = useRef<ReactFlowInstance | null>(null)
	const hasFitView = useRef(persisted.viewport != null)

	// ELK repositions every node when it resolves (positions, not dimensions, so
	// onNodesChange's measure-based fit won't fire). Refit once per ELK result —
	// unless the user has a saved camera — after the new positions paint.
	const elkFitKeyRef = useRef<string | null>(null)
	useEffect(() => {
		if (!elk || persisted.viewport != null) return
		if (elkFitKeyRef.current === layoutSignature) return
		elkFitKeyRef.current = layoutSignature
		const raf = requestAnimationFrame(() =>
			requestAnimationFrame(() => rfInstance.current?.fitView({ duration: 300 })),
		)
		return () => cancelAnimationFrame(raf)
	}, [elk, layoutSignature, persisted.viewport])

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			setNodes((prev) => {
				const next = applyNodeChanges(changes, prev) as typeof prev

				if (
					!hasFitView.current &&
					rfInstance.current &&
					changes.some((c) => c.type === "dimensions")
				) {
					const allMeasured =
						next.length > 0 && next.every((n) => n.measured?.width && n.measured?.height)
					if (allMeasured) {
						hasFitView.current = true
						setTimeout(() => rfInstance.current?.fitView(), 0)
					}
				}

				return next
			})

			// Persist finished drags only (dragging === false), keyed by node id.
			const dragEnds = changes.filter(
				(c): c is NodePositionChange =>
					c.type === "position" && c.dragging === false && c.position != null,
			)
			if (dragEnds.length > 0) {
				setLayout((prev) => {
					// Drop a stale base so we don't merge new drags onto positions from
					// a different layout; stamp the current signature.
					const base = prev.signature === sigRef.current ? prev.positions : {}
					const positions = { ...base }
					for (const c of dragEnds) {
						positions[c.id] = { x: c.position!.x, y: c.position!.y }
					}
					return { ...prev, positions, signature: sigRef.current }
				})
			}
		},
		[setLayout],
	)

	const onMoveEnd = useCallback(
		(_: unknown, viewport: Viewport) => {
			setLayout((prev) => {
				// If the stored layout predates the current signature, drop its stale
				// positions rather than reviving them alongside the new viewport.
				const positions = prev.signature === sigRef.current ? prev.positions : {}
				return { ...prev, positions, viewport, signature: sigRef.current }
			})
		},
		[setLayout],
	)

	const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
		// Namespace boxes are non-selectable, but guard anyway so a stray click
		// never selects a synthetic group node.
		if (node.type === "namespaceGroup") return
		setSelectedServiceId((prev) => (prev === node.id ? null : node.id))
	}, [])

	const handlePaneClick = useCallback(() => {
		setSelectedServiceId(null)
	}, [])

	// "Re-sort": discard any manual drag positions + saved camera and snap every
	// node back to the computed auto-layout, then fit the fresh layout into view.
	// Clearing positions re-derives node positions AND the namespace boxes over a
	// couple of render passes, so the fit is deferred to an effect that runs once
	// the nodes have actually settled (a fixed timeout races that cascade).
	const resortFitPending = useRef(false)
	const handleResort = useCallback(() => {
		resortFitPending.current = true
		setLayout({ positions: {}, viewport: null, signature: sigRef.current })
	}, [setLayout])

	useEffect(() => {
		if (!resortFitPending.current) return
		// Wait until every node carries measured dimensions, else fitView frames a
		// partial extent (unmeasured nodes are excluded from the bounds).
		if (nodes.length === 0 || !nodes.every((n) => n.measured?.width)) return
		resortFitPending.current = false
		const raf = requestAnimationFrame(() => rfInstance.current?.fitView({ duration: 300 }))
		return () => cancelAnimationFrame(raf)
	}, [nodes])

	// Derive a dotted box per namespace from the node positions/sizes, so the boxes
	// follow drags and hug the service cards. Only service nodes carrying a namespace
	// participate; databases and namespace-less services stay unboxed.
	//
	// Boxes are derived from `nodes` at DEFERRED priority. During the mount
	// measurement cascade (and drags), ReactFlow updates `nodes` many times in quick
	// succession; recomputing the boxes synchronously resized their DOM on every
	// single measurement, which ReactFlow's own node ResizeObserver then re-observed
	// mid-frame — producing a burst of benign "ResizeObserver loop completed with
	// undelivered notifications" warnings (173 in one session). useDeferredValue lets
	// the boxes lag the urgent measurement render by a frame so each resize lands in
	// its own commit, collapsing the burst. The ~1-frame lag is imperceptible and the
	// boxes still settle tight around the nodes.
	const deferredNodes = useDeferredValue(nodes)
	const namespaceGroupNodes = useMemo<Node<NamespaceGroupData>[]>(() => {
		const extents = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
		for (const node of deferredNodes) {
			if (node.id.startsWith(DB_NODE_PREFIX)) continue
			const ns = (node.data as ServiceNodeData).namespace
			if (!ns) continue
			const w = node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH
			const h = node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT
			const { x, y } = node.position
			const ext = extents.get(ns)
			if (ext) {
				ext.minX = Math.min(ext.minX, x)
				ext.minY = Math.min(ext.minY, y)
				ext.maxX = Math.max(ext.maxX, x + w)
				ext.maxY = Math.max(ext.maxY, y + h)
			} else {
				extents.set(ns, { minX: x, minY: y, maxX: x + w, maxY: y + h })
			}
		}
		const boxes: Node<NamespaceGroupData>[] = []
		for (const [ns, ext] of extents) {
			const width = ext.maxX - ext.minX + NS_PADDING_X * 2
			const height = ext.maxY - ext.minY + NS_LABEL_HEIGHT + NS_PADDING_Y * 2
			boxes.push({
				id: nsGroupId(ns),
				type: "namespaceGroup",
				position: { x: ext.minX - NS_PADDING_X, y: ext.minY - (NS_LABEL_HEIGHT + NS_PADDING_Y) },
				data: { label: ns, hue: getValueHue(ns) ?? 0 },
				draggable: false,
				selectable: false,
				focusable: false,
				// z 0 (same layer as service nodes) keeps the box above the pane/edges
				// so the dashed border + label paint; ordering it first in the nodes
				// array (below) keeps it behind the service cards.
				zIndex: 0,
				// These boxes are derived each render and never live in the controlled
				// `nodes` state, so ReactFlow's measured dims never round-trip back —
				// supply width/height/measured explicitly or it keeps them
				// `visibility: hidden` (unmeasured) forever.
				width,
				height,
				measured: { width, height },
				// pointerEvents:none on the WRAPPER (ReactFlow applies node.style to it)
				// so drags/clicks over empty box interior pass through to the pane
				// (panning) and to the service cards beneath.
				style: { width, height, pointerEvents: "none" },
			})
		}
		return boxes
	}, [deferredNodes])

	// Boxes first so they paint behind the service nodes. The service nodes use the
	// LIVE `nodes` (must stay current); only the derived boxes run a frame behind.
	const renderedNodes = useMemo(() => [...namespaceGroupNodes, ...nodes], [namespaceGroupNodes, nodes])

	if (nodes.length === 0) {
		return <ServiceMapEmptyState />
	}

	return (
		<div className="flex flex-col h-full">
			<ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
				<ResizablePanel defaultSize={selectedServiceId ? 65 : 100} minSize={40}>
					<div className="flex flex-col h-full">
						<div className="flex-1 min-h-0 relative">
							<LayoutDebugPanel config={layoutConfig} onChange={setLayoutConfig} />
							<div className="absolute top-2 left-2 z-50 flex items-center gap-2">
								<div className="flex items-center gap-2 bg-card/90 backdrop-blur-sm border border-border rounded-md px-2 py-1">
									<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
										Color by
									</span>
									<Select
										value={colorMode}
										onValueChange={(v) => setColorMode(v as ServiceMapColorMode)}
									>
										<SelectTrigger
											size="sm"
											className="h-6 min-w-0 text-[11px] capitalize border-0 bg-transparent px-1.5"
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
								<button
									type="button"
									onClick={handleResort}
									title="Re-sort — discard manual positions and auto-arrange"
									className="flex h-[34px] items-center gap-1.5 bg-card/90 backdrop-blur-sm border border-border rounded-md px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
								>
									<ArrowRotateAnticlockwiseIcon size={12} />
									Re-sort
								</button>
							</div>
							<ParticleRegistryProvider value={registry}>
								<ReactFlow
									nodes={renderedNodes}
									edges={flowEdges}
									onNodesChange={onNodesChange}
									onNodeClick={handleNodeClick}
									onPaneClick={handlePaneClick}
									onMoveEnd={onMoveEnd}
									defaultViewport={persisted.viewport ?? undefined}
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
									<ServiceMapParticleCanvas />
									<Controls showInteractive={false} />
									<MiniMap
										nodeColor={(node: Node) => {
											if (node.type === "namespaceGroup") return "transparent"
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
							</ParticleRegistryProvider>
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
									{(["kubernetes", "cloudflare", "lambda", "web", "unknown"] as const).map(
										(p) => (
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
										),
									)}
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
					(() => {
						const panel = selectedServiceId.startsWith(DB_NODE_PREFIX) ? (
							<DatabaseDetailPanel
								{...parseDbNodeId(selectedServiceId)}
								dbEdges={dbEdges}
								services={services}
								durationSeconds={durationSeconds}
								startTime={startTime}
								endTime={endTime}
								onClose={() => setSelectedServiceId(null)}
							/>
						) : (
							<ServiceDetailPanel
								serviceId={selectedServiceId}
								services={services}
								edges={serviceEdges}
								overviews={overviews}
								workloads={workloads}
								showInfraTab={showInfraTab}
								platforms={platforms}
								colorMode={colorMode}
								cloudflare={cloudflareOverlayByService.get(selectedServiceId)}
								durationSeconds={durationSeconds}
								onClose={() => setSelectedServiceId(null)}
							/>
						)
						return (
							<>
								<ResizableHandle withHandle />
								<ResizablePanel defaultSize={35} minSize={25}>
									{panel}
								</ResizablePanel>
							</>
						)
					})()}
			</ResizablePanelGroup>
		</div>
	)
}

export function ServiceMapView({ startTime, endTime }: ServiceMapViewProps) {
	const orgId = useMapleOrganizationId();
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
	const cloudflareResult = useRefreshableAtomValue(getServiceMapCloudflareResultAtom(mapInput))
	const platformsResult = useRefreshableAtomValue(getServicePlatformsResultAtom(mapInput))

	// Render map as soon as edges arrive — don't wait for overview metrics
	const overviews = Result.isSuccess(overviewResult) ? overviewResult.value.data : []
	const dbEdges = Result.isSuccess(dbEdgesResult) ? dbEdgesResult.value.edges : []
	const cloudflareServices = Result.isSuccess(cloudflareResult) ? cloudflareResult.value.services : []
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
	// service.name → faas.name, so a `cloudflare-worker/{script}` from the direct
	// integration can be matched to (and overlaid onto) its instrumented node.
	const faasNames = useMemo(() => {
		const map = new Map<string, string>()
		if (Result.isSuccess(platformsResult)) {
			for (const p of platformsResult.value.platforms) {
				if (p.faasName) map.set(p.serviceName, p.faasName)
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
		.onInitial(() => <ServiceMapLoading />)
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
				cloudflareServices={cloudflareServices}
				faasNames={faasNames}
				platforms={platforms}
				runtimes={runtimes}
				overviews={overviews}
				workloads={workloads}
				showInfraTab={infraEnabled}
				durationSeconds={durationSeconds}
				startTime={startTime}
				endTime={endTime}
				layoutKey={orgId ?? "default"}
			/>
		))
		.render()
}
