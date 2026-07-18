import { Profiler, useCallback, useMemo, useState, type ProfilerOnRenderCallback } from "react"
import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react"
import type { DeclutterFocus } from "./service-map-declutter"
import type { ServiceDbEdge, ServiceEdge, ServicePlatform } from "@/api/warehouse/service-map"
import type { ServiceOverview } from "@/api/warehouse/services"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import { ServiceMapCanvas } from "./service-map-view"
import { useMountEffect } from "@/hooks/use-mount-effect"

/**
 * Synthetic, API-free service-map bench harness.
 *
 * Renders {@link ServiceMapCanvas} with a deterministic generated graph (sized
 * via search params) and installs a `window.__smBench` driver that measures
 * frame timing + long tasks over a fixed window — used by the Playwright perf
 * spec (apps/web/perf/service-map.perf.spec.ts) and for manual before/after
 * comparisons. DEV-only; the route renders null in production builds.
 */

// Fixed window so callsPerSecond (and thus particle pressure) is driven purely
// by generated callCount, independent of wall-clock.
const DURATION_SECONDS = 3600
const END_TIME = "2026-06-05T00:00:00.000Z"
const START_TIME = "2026-06-04T23:00:00.000Z"

export type BenchRps = "low" | "med" | "high"

export interface BenchParams {
	services: number
	edges: number
	rps: BenchRps
	seed: number
	/** Number of `service.namespace` groups to spread services across (0 = none). */
	groups: number
	/** Low-traffic filter threshold (% of peak edge rate; 0 = off). */
	minTraffic: number
	/** Service to focus (dim non-neighbors); "" = no focus. */
	focus: string
}

export const DEFAULT_BENCH_PARAMS: BenchParams = {
	services: 120,
	edges: 400,
	rps: "high",
	seed: 1,
	groups: 0,
	minTraffic: 0,
	focus: "",
}

// Realistic-ish namespace names; falls back to `team-<n>` past the pool length.
const NAMESPACE_POOL = [
	"payments",
	"checkout",
	"platform",
	"identity",
	"search",
	"growth",
	"billing",
	"notifications",
	"inventory",
	"shipping",
]
const namespaceName = (group: number): string => NAMESPACE_POOL[group] ?? `team-${group}`

// --- deterministic PRNG (mulberry32) ---
function makeRng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const PLATFORMS: ServicePlatform[] = ["kubernetes", "cloudflare", "lambda", "web", "unknown"]
const RUNTIMES = ["nodejs", "bun", "deno", "edge-light", "workerd"]
const DB_SYSTEMS = ["postgresql", "mysql", "clickhouse", "redis", "mongodb"]

const rpsRange = (rps: BenchRps): [number, number] =>
	rps === "high" ? [50, 500] : rps === "med" ? [5, 50] : [0.5, 5]

interface BenchGraph {
	edges: ServiceEdge[]
	dbEdges: ServiceDbEdge[]
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
}

function refreshBenchMetrics(graph: BenchGraph, revision: number): BenchGraph {
	const callScale = 1 + ((revision % 7) - 3) * 0.01
	const latencyScale = 1 + ((revision % 5) - 2) * 0.015

	return {
		...graph,
		edges: graph.edges.map((edge) => ({
			...edge,
			callCount: Math.max(1, Math.round(edge.callCount * callScale)),
			estimatedCallCount: Math.max(1, Math.round(edge.estimatedCallCount * callScale)),
			avgDurationMs: edge.avgDurationMs * latencyScale,
			p95DurationMs: edge.p95DurationMs * latencyScale,
		})),
		dbEdges: graph.dbEdges.map((edge) => ({
			...edge,
			callCount: Math.max(1, Math.round(edge.callCount * callScale)),
			estimatedCallCount: Math.max(1, Math.round(edge.estimatedCallCount * callScale)),
			avgDurationMs: edge.avgDurationMs * latencyScale,
			p95DurationMs: edge.p95DurationMs * latencyScale,
		})),
		overviews: graph.overviews.map((overview) => ({
			...overview,
			throughput: overview.throughput * callScale,
			tracedThroughput: overview.tracedThroughput * callScale,
			p50LatencyMs: overview.p50LatencyMs * latencyScale,
			p95LatencyMs: overview.p95LatencyMs * latencyScale,
			p99LatencyMs: overview.p99LatencyMs * latencyScale,
		})),
	}
}

function generateBenchGraph(params: BenchParams): BenchGraph {
	const rng = makeRng(params.seed)
	const serviceCount = Math.max(2, params.services)
	const names = Array.from({ length: serviceCount }, (_, i) => `svc-${String(i).padStart(3, "0")}`)

	const platforms = new Map<string, ServicePlatform>()
	const runtimes = new Map<string, string>()
	for (const name of names) {
		const platform = PLATFORMS[Math.floor(rng() * PLATFORMS.length)]
		platforms.set(name, platform)
		if (rng() > 0.4) runtimes.set(name, RUNTIMES[Math.floor(rng() * RUNTIMES.length)])
	}

	const [rpsLo, rpsHi] = rpsRange(params.rps)
	const callsFor = () => Math.round((rpsLo + rng() * (rpsHi - rpsLo)) * DURATION_SECONDS)

	// Edge set: a spanning backbone (every node reachable) plus extra random
	// forward edges up to the requested count. Source index < target index keeps
	// the graph mostly-acyclic so the layered layout stays meaningful.
	const seen = new Set<string>()
	const edges: ServiceEdge[] = []
	const addEdge = (sIdx: number, tIdx: number) => {
		if (sIdx === tIdx) return
		const source = names[sIdx]
		const target = names[tIdx]
		const key = `${source}->${target}`
		if (seen.has(key)) return
		seen.add(key)
		const callCount = callsFor()
		const errorRate = rng() < 0.15 ? rng() * 0.12 : rng() * 0.005
		edges.push({
			sourceService: source,
			targetService: target,
			callCount,
			estimatedCallCount: Math.round(callCount * (rng() < 0.3 ? 1.5 + rng() : 1)),
			errorCount: Math.round(callCount * errorRate),
			errorRate,
			avgDurationMs: 2 + rng() * 80,
			p95DurationMs: 20 + rng() * 400,
			hasSampling: rng() < 0.3,
			samplingWeight: 1 + Math.floor(rng() * 9),
		})
	}
	for (let i = 1; i < serviceCount; i++) addEdge(Math.floor(rng() * i), i)
	let guard = 0
	while (edges.length < params.edges && guard++ < params.edges * 20) {
		const s = Math.floor(rng() * serviceCount)
		const t = Math.floor(rng() * serviceCount)
		addEdge(Math.min(s, t), Math.max(s, t))
	}

	// DB edges: connect ~15% of services to a random database system.
	const dbEdges: ServiceDbEdge[] = []
	for (const name of names) {
		if (rng() > 0.15) continue
		const callCount = callsFor()
		const errorRate = rng() * 0.02
		dbEdges.push({
			sourceService: name,
			dbSystem: DB_SYSTEMS[Math.floor(rng() * DB_SYSTEMS.length)],
			dbNamespace: `bench_db_${Math.floor(rng() * 3)}`,
			callCount,
			estimatedCallCount: callCount,
			errorCount: Math.round(callCount * errorRate),
			errorRate,
			avgDurationMs: 1 + rng() * 40,
			p95DurationMs: 10 + rng() * 200,
			hasSampling: false,
			samplingWeight: 1,
		})
	}

	// Assign a `service.namespace` per service. Deterministic and rng-free so the
	// generated topology is identical regardless of `groups` (only namespaces
	// change) — and `groups=0` reproduces the original namespace-less graph exactly.
	// ~1 in 7 services is left ungrouped to exercise the unboxed region.
	const groupCount = Math.max(0, Math.floor(params.groups))
	const namespaceFor = (i: number): string =>
		groupCount <= 0 || i % 7 === 6 ? "" : namespaceName(i % groupCount)

	const overviews: ServiceOverview[] = names.map((name, i) => {
		const errorRate = rng() < 0.15 ? rng() * 0.1 : rng() * 0.004
		const throughput = rpsLo + rng() * (rpsHi - rpsLo)
		const hasSampling = rng() < 0.3
		const samplingWeight = hasSampling ? 1 + Math.floor(rng() * 9) : 1
		return {
			serviceName: name,
			serviceNamespace: namespaceFor(i),
			environment: "prod",
			commits: [],
			p50LatencyMs: 2 + rng() * 50,
			p95LatencyMs: 20 + rng() * 300,
			p99LatencyMs: 40 + rng() * 600,
			errorRate,
			throughput: throughput * samplingWeight,
			tracedThroughput: throughput,
			hasSampling,
			samplingWeight,
			spanCount: Math.round(throughput * 3600),
		}
	})

	const workloads: ServiceWorkload[] = []
	for (const name of names) {
		if (platforms.get(name) !== "kubernetes") continue
		const count = 1 + Math.floor(rng() * 3)
		for (let w = 0; w < count; w++) {
			workloads.push({
				serviceName: name,
				workloadKind: "deployment",
				workloadName: `${name}-${w}`,
				namespace: "default",
				clusterName: "bench",
				podCount: 1 + Math.floor(rng() * 12),
				avgCpuLimitUtilization: rng(),
				avgMemoryLimitUtilization: rng(),
			})
		}
	}

	return { edges, dbEdges, overviews, workloads, platforms, runtimes }
}

// --- window perf harness ------------------------------------------------------

interface BenchMetrics {
	durationMs: number
	frames: number
	fps: number
	frameP50: number
	frameP95: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	params: BenchParams
	react: ReactRenderMetrics
}

interface ReactCommitSample {
	phase: "mount" | "update" | "nested-update"
	actualDurationMs: number
	baseDurationMs: number
	startTimeMs: number
	commitTimeMs: number
}

export interface ReactRenderMetrics {
	commits: number
	mountCommits: number
	updateCommits: number
	nestedUpdateCommits: number
	totalActualDurationMs: number
	actualDurationP50Ms: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
	lastBaseDurationMs: number
}

export interface ReactRenderReport {
	initial: ReactRenderMetrics
	metricRefresh: ReactRenderMetrics
	topologyChange: ReactRenderMetrics
	viewportPan: ReactRenderMetrics
	viewportPanFrames: number
	viewportPanDurationMs: number
	viewportPanCommitsPerFrame: number
	viewportPanActualDurationPerFrameMs: number
	metricRefreshes: number
	topologyChanges: number
}

interface ReactRecorder {
	onRender: ProfilerOnRenderCallback
	reset: () => void
	snapshot: () => ReactRenderMetrics
}

interface SmBench {
	ready: boolean
	/** Time from harness install to ready (nodes measured + edges in the DOM) — includes the async ELK layout. */
	readyMs: number | null
	last: BenchMetrics | null
	run: (opts?: { durationMs?: number; pan?: boolean }) => Promise<BenchMetrics>
	runReact: (opts?: { metricRefreshes?: number; topologyChanges?: number }) => Promise<ReactRenderReport>
}

declare global {
	interface Window {
		__smBench?: SmBench
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
	return sorted[idx]
}

function createReactRecorder(): ReactRecorder {
	let samples: ReactCommitSample[] = []
	return {
		onRender: (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
			samples.push({
				phase,
				actualDurationMs: actualDuration,
				baseDurationMs: baseDuration,
				startTimeMs: startTime,
				commitTimeMs: commitTime,
			})
		},
		reset: () => {
			samples = []
		},
		snapshot: () => {
			const captured = samples.map((sample) => ({ ...sample }))
			const durations = captured.map((sample) => sample.actualDurationMs).sort((a, b) => a - b)
			return {
				commits: captured.length,
				mountCommits: captured.filter((sample) => sample.phase === "mount").length,
				updateCommits: captured.filter((sample) => sample.phase === "update").length,
				nestedUpdateCommits: captured.filter((sample) => sample.phase === "nested-update").length,
				totalActualDurationMs: durations.reduce((sum, duration) => sum + duration, 0),
				actualDurationP50Ms: percentile(durations, 50),
				actualDurationP95Ms: percentile(durations, 95),
				maxActualDurationMs: durations.at(-1) ?? 0,
				lastBaseDurationMs: captured.at(-1)?.baseDurationMs ?? 0,
			}
		},
	}
}

const nextPaint = () =>
	new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
	})

/**
 * Sibling of ServiceMapCanvas inside the shared ReactFlowProvider. Drives
 * pan/zoom via the flow instance and installs the window.__smBench API.
 */
function BenchDriver({
	params,
	recorder,
	onMetricRefresh,
	onTopologyChange,
}: {
	params: BenchParams
	recorder: ReactRecorder
	onMetricRefresh: () => void
	onTopologyChange: () => void
}) {
	const flow = useReactFlow()
	const store = useStoreApi()

	useMountEffect(() => {
		const measureUpdates = async (count: number, update: () => void | Promise<void>) => {
			recorder.reset()
			for (let index = 0; index < count; index++) {
				// oxlint-disable-next-line react-doctor/async-await-in-loop -- Each measured React update must commit before the next sample starts.
				await update()
				await nextPaint()
			}
			return recorder.snapshot()
		}

		const harness: SmBench = {
			ready: false,
			readyMs: null,
			last: null,
			run: ({ durationMs = 5000, pan = true } = {}) =>
				new Promise<BenchMetrics>((resolve) => {
					const longTaskEntries: PerformanceEntry[] = []
					let observer: PerformanceObserver | undefined
					try {
						observer = new PerformanceObserver((list) => {
							for (const entry of list.getEntries()) longTaskEntries.push(entry)
						})
						observer.observe({ entryTypes: ["longtask"] })
					} catch {
						// longtask unsupported — metrics just report 0
					}

					const base = flow.getViewport()
					const deltas: number[] = []
					let prev = performance.now()
					const start = prev
					recorder.reset()

					const tick = (now: number) => {
						deltas.push(now - prev)
						prev = now
						const elapsed = now - start
						if (pan) {
							// Oscillate pan + zoom so the engine repaints the whole
							// graph every frame (this is where edge cost shows up).
							const phase = (elapsed / durationMs) * Math.PI * 2
							flow.setViewport({
								x: base.x + Math.sin(phase) * 400,
								y: base.y + Math.cos(phase) * 250,
								zoom: base.zoom * (0.85 + 0.15 * (1 + Math.sin(phase * 1.7)) * 0.5),
							})
						}
						if (elapsed < durationMs) {
							requestAnimationFrame(tick)
							return
						}
						observer?.disconnect()
						if (pan) flow.setViewport(base)

						// First delta is the gap before measurement began — drop it.
						const samples = deltas.slice(1)
						const sorted = [...samples].sort((a, b) => a - b)
						const totalBlockingMs = longTaskEntries.reduce(
							(sum, e) => sum + Math.max(0, e.duration - 50),
							0,
						)
						const metrics: BenchMetrics = {
							durationMs: Math.round(elapsed),
							frames: samples.length,
							fps: samples.length / (elapsed / 1000),
							frameP50: percentile(sorted, 50),
							frameP95: percentile(sorted, 95),
							droppedFrames: samples.filter((d) => d > (1000 / 60) * 1.5).length,
							longTasks: longTaskEntries.length,
							totalBlockingMs,
							params,
							react: recorder.snapshot(),
						}
						harness.last = metrics
						resolve(metrics)
					}
					requestAnimationFrame(tick)
				}),
			runReact: async ({ metricRefreshes = 12, topologyChanges = 2 } = {}) => {
				// Readiness means the graph is visible and measured; a few deferred
				// ReactFlow bookkeeping commits can still follow. Include those in the
				// initial scenario instead of leaking them into the first refresh.
				await new Promise((resolve) => setTimeout(resolve, 500))
				await nextPaint()
				const initial = recorder.snapshot()
				const metricRefresh = await measureUpdates(metricRefreshes, onMetricRefresh)
				// oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Scenarios share the graph and recorder, so they must not overlap.
				const topologyChange = await measureUpdates(topologyChanges, async () => {
					onTopologyChange()
					// The graph remains visible while the worker computes the next ELK
					// layout. Give that asynchronous layout enough time to commit before
					// taking the scenario snapshot.
					await new Promise((resolve) => setTimeout(resolve, 1500))
				})
				await new Promise((resolve) => setTimeout(resolve, 500))
				await nextPaint()
				const viewportRun = await harness.run({ durationMs: 2000, pan: true })
				const viewportPan = viewportRun.react
				return {
					initial,
					metricRefresh,
					topologyChange,
					viewportPan,
					viewportPanFrames: viewportRun.frames,
					viewportPanDurationMs: viewportRun.durationMs,
					viewportPanCommitsPerFrame:
						viewportRun.frames === 0 ? 0 : viewportPan.commits / viewportRun.frames,
					viewportPanActualDurationPerFrameMs:
						viewportRun.frames === 0 ? 0 : viewportPan.totalActualDurationMs / viewportRun.frames,
					metricRefreshes,
					topologyChanges,
				}
			},
		}
		window.__smBench = harness

		// Mark ready once edges have rendered (nodes measured → geometry exists).
		let raf = 0
		const settleStart = performance.now()
		const checkReady = () => {
			const nodes = store.getState().nodes
			const measured = nodes.length > 0 && nodes.every((n) => n.measured?.width)
			const domEdges = document.querySelectorAll(".react-flow__edge").length
			if ((measured && domEdges > 0) || performance.now() - settleStart > 8000) {
				harness.readyMs = Math.round(performance.now() - settleStart)
				harness.ready = true
				return
			}
			raf = requestAnimationFrame(checkReady)
		}
		raf = requestAnimationFrame(checkReady)

		return () => {
			cancelAnimationFrame(raf)
			if (window.__smBench === harness) delete window.__smBench
		}
	})

	return null
}

export function ServiceMapBench({ params }: { params: BenchParams }) {
	const [metricRevision, setMetricRevision] = useState(0)
	const [topologyRevision, setTopologyRevision] = useState(0)
	const topologyParams = useMemo(
		() => ({
			...params,
			services: params.services + topologyRevision,
			edges: params.edges + topologyRevision,
		}),
		[params, topologyRevision],
	)
	const baseGraph = useMemo(() => generateBenchGraph(topologyParams), [topologyParams])
	const graph = useMemo(() => refreshBenchMetrics(baseGraph, metricRevision), [baseGraph, metricRevision])
	const recorder = useMemo(() => createReactRecorder(), [])
	const refreshMetrics = useCallback(() => setMetricRevision((revision) => revision + 1), [])
	const changeTopology = useCallback(() => setTopologyRevision((revision) => (revision === 0 ? 1 : 0)), [])
	// URL-driven focus so the perf spec can exercise the declutter paths without
	// UI automation; interactive changes via the toolbar still work on top.
	const [focus, setFocus] = useState<DeclutterFocus | null>(
		params.focus ? { serviceId: params.focus, hops: 1, mode: "dim" } : null,
	)
	// Note: animation respects `prefers-reduced-motion`. The Playwright project
	// runs with `reducedMotion: "no-preference"` (browser default) so the harness
	// measures the animated path.

	return (
		<div className="h-screen w-screen bg-background" data-testid="service-map-bench">
			<ReactFlowProvider>
				<Profiler id="service-map" onRender={recorder.onRender}>
					<ServiceMapCanvas
						edges={graph.edges}
						dbEdges={graph.dbEdges}
						// Exercises the instrumented-Worker overlay: svc-000 gets CF edge
						// analytics attached; the unmatched script must NOT create a node.
						cloudflareServices={[
							{
								serviceName: "cloudflare-worker/svc-000",
								kind: "worker",
								displayName: "svc-000",
								requests: 120_000,
								throughput: 120_000 / DURATION_SECONDS,
								errorRate: 0.004,
								latencyP99Ms: 38,
								cpuP99Ms: 9,
							},
							{
								serviceName: "cloudflare-worker/unmatched-script",
								kind: "worker",
								displayName: "unmatched-script",
								requests: 5_000,
								throughput: 5_000 / DURATION_SECONDS,
								errorRate: 0.2,
								latencyP99Ms: 55,
								cpuP99Ms: 12,
							},
						]}
						faasNames={new Map()}
						planetscaleDatabases={new Map()}
						planetscaleStats={[]}
						platforms={graph.platforms}
						runtimes={graph.runtimes}
						overviews={graph.overviews}
						workloads={graph.workloads}
						showInfraTab
						durationSeconds={DURATION_SECONDS}
						startTime={START_TIME}
						endTime={END_TIME}
						layoutKey="bench"
						focus={focus}
						onFocusChange={setFocus}
						minTrafficPctOverride={params.minTraffic > 0 ? params.minTraffic : undefined}
					/>
				</Profiler>
				<BenchDriver
					params={params}
					recorder={recorder}
					onMetricRefresh={refreshMetrics}
					onTopologyChange={changeTopology}
				/>
			</ReactFlowProvider>
		</div>
	)
}
