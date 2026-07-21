import { useMemo } from "react"
import { cn } from "@maple/ui/utils"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceDependenciesBundleResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { toSingleDeploymentEnv } from "@/lib/services/environments"
import { formatLatency } from "@/lib/format"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { DependencyTable, type DependencyRow } from "./dependency-table"
import type { DependencyKind } from "./dependency-type-badge"

interface ServiceDependenciesTabProps {
	serviceName: string
	startTime?: string
	endTime?: string
	timePreset?: string
	effectiveStartTime: string
	effectiveEndTime: string
	/** Page-level env filter (single-element by convention, see the route). */
	environments?: string[]
}

interface RawEdge {
	sourceService?: string
	targetService?: string
	dbSystem?: string
	dbNamespace?: string
	targetType?: "http" | "messaging" | "rpc"
	targetSystem?: string
	targetName?: string
	callCount?: number
	estimatedCallCount?: number
	errorRate?: number
	avgDurationMs?: number
	p95DurationMs?: number
	hasSampling?: boolean
	samplingWeight?: number
}

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

function formatErrorRate(rate: number): string {
	if (rate >= 0.01) return `${(rate * 100).toFixed(1)}%`
	if (rate > 0) return "<1%"
	return "0%"
}

function escapeForWhereClause(value: string): string {
	return value.replace(/'/g, "\\'")
}

export function ServiceDependenciesTab({
	serviceName,
	startTime,
	endTime,
	timePreset,
	effectiveStartTime,
	effectiveEndTime,
	environments,
}: ServiceDependenciesTabProps) {
	// One fetch for the whole Dependencies tab — service, DB, and external edges in
	// a single round-trip (was three separate atoms). The atom key (incl. the
	// derived deploymentEnv) matches ServiceDependencyStrip's, so switching from
	// the Overview strip to this tab is a cache hit.
	const bundleResult = useRetainedRefreshableResultValue(
		getServiceDependenciesBundleResultAtom({
			data: {
				serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				deploymentEnv: toSingleDeploymentEnv(environments),
			},
		}),
	)

	const durationSeconds = useMemo(() => {
		const s = new Date(normalizeTimestampInput(effectiveStartTime)).getTime()
		const e = new Date(normalizeTimestampInput(effectiveEndTime)).getTime()
		return s > 0 && e > 0 ? Math.max((e - s) / 1000, 1) : 3600
	}, [effectiveStartTime, effectiveEndTime])

	const rows = useMemo<DependencyRow[]>(() => {
		const out: DependencyRow[] = []

		const serviceEdges = Result.builder(bundleResult)
			.onSuccess((r) => r.serviceEdges as RawEdge[])
			.orElse(() => [] as RawEdge[])
		const dbEdges = Result.builder(bundleResult)
			.onSuccess((r) => r.dbEdges as RawEdge[])
			.orElse(() => [] as RawEdge[])
		const externalEdges = Result.builder(bundleResult)
			.onSuccess((r) => r.externalEdges as RawEdge[])
			.orElse(() => [] as RawEdge[])

		for (const edge of serviceEdges) {
			// Server-side filter on `SourceService = ?` already scopes the result;
			// only need to guard against rows missing a target name.
			if (!edge.targetService) continue
			const callCount = Number(edge.callCount ?? 0)
			const estimated = Number(edge.estimatedCallCount ?? callCount)
			const target = String(edge.targetService)
			out.push({
				id: `service:${target}`,
				kind: "service",
				name: target,
				callsPerSec: estimated / durationSeconds,
				tracedCallsPerSec: callCount / durationSeconds,
				totalCalls: callCount,
				estimatedCalls: estimated,
				errorRate: Number(edge.errorRate ?? 0),
				avgDurationMs: Number(edge.avgDurationMs ?? 0),
				p95DurationMs: Number(edge.p95DurationMs ?? 0),
				hasSampling: Boolean(edge.hasSampling),
				samplingWeight: Number(edge.samplingWeight ?? 1),
				whereClause: `SpanKind = 'Client' AND server.address ILIKE '%${escapeForWhereClause(target)}%'`,
			})
		}

		for (const edge of dbEdges) {
			// Server-side filter on `ServiceName = ?` already scopes the result;
			// only need to guard against rows with no db system identified.
			if (!edge.dbSystem) continue
			const callCount = Number(edge.callCount ?? 0)
			const estimated = Number(edge.estimatedCallCount ?? callCount)
			const target = String(edge.dbSystem)
			// Edges are per database identity (db.namespace et al.) — surface it as
			// the row name so two databases of the same system stay distinguishable.
			// The drill-down stays scoped by system only: the identity can originate
			// from any of four span attributes, so an exact-attribute predicate here
			// could silently match nothing.
			const namespace = String(edge.dbNamespace ?? "")
			out.push({
				id: `database:${target}:${namespace}`,
				kind: "database",
				name: namespace ? `${target} · ${namespace}` : target,
				callsPerSec: estimated / durationSeconds,
				tracedCallsPerSec: callCount / durationSeconds,
				totalCalls: callCount,
				estimatedCalls: estimated,
				errorRate: Number(edge.errorRate ?? 0),
				avgDurationMs: Number(edge.avgDurationMs ?? 0),
				p95DurationMs: Number(edge.p95DurationMs ?? 0),
				hasSampling: Boolean(edge.hasSampling),
				samplingWeight: Number(edge.samplingWeight ?? 1),
				whereClause: `SpanKind = 'Client' AND db.system.name = '${escapeForWhereClause(target)}'`,
			})
		}

		for (const edge of externalEdges) {
			const target = String(edge.targetName ?? "")
			if (!target) continue
			const kind: DependencyKind =
				edge.targetType === "messaging" ? "messaging" : edge.targetType === "rpc" ? "rpc" : "http"
			const callCount = Number(edge.callCount ?? 0)
			const estimated = Number(edge.estimatedCallCount ?? callCount)
			const system = edge.targetSystem ? String(edge.targetSystem) : ""
			const whereClause =
				kind === "messaging"
					? `SpanKind = 'Producer' AND messaging.destination = '${escapeForWhereClause(target)}'`
					: kind === "rpc"
						? `SpanKind = 'Client' AND rpc.service = '${escapeForWhereClause(target)}'`
						: `SpanKind = 'Client' AND (server.address = '${escapeForWhereClause(target)}' OR http.host = '${escapeForWhereClause(target)}')`

			out.push({
				id: `${kind}:${target}`,
				kind,
				name: target,
				subtitle: system || undefined,
				callsPerSec: estimated / durationSeconds,
				tracedCallsPerSec: callCount / durationSeconds,
				totalCalls: callCount,
				estimatedCalls: estimated,
				errorRate: Number(edge.errorRate ?? 0),
				avgDurationMs: Number(edge.avgDurationMs ?? 0),
				p95DurationMs: Number(edge.p95DurationMs ?? 0),
				hasSampling: Boolean(edge.hasSampling),
				samplingWeight: Number(edge.samplingWeight ?? 1),
				whereClause,
			})
		}

		return out
	}, [bundleResult, durationSeconds])

	// Fold HTTP rows that look like a known internal service into that service's
	// row. The address-resolutions rollup eventually catches this server-side
	// via exact `ParentServerAddress` match — but only after the hourly tick,
	// and only when the Client span carries `server.address` (not `http.host`).
	// In the meantime we'd render two rows for the same logical target
	// (`SERVICE artifacts-api` AND `HTTP http://prd-artifacts-api`), which reads
	// as a duplicate.
	//
	// Heuristic: an HTTP target whose hostname *contains* a known internal
	// service name (>=5 chars, so generic names like `api` don't false-match)
	// is treated as a hostname-variant of that service. The HTTP row drops out
	// of the visible list; the SERVICE row gains a `via host1, host2` subtitle.
	const dedupedRows = useMemo<DependencyRow[]>(() => {
		const serviceNames = rows
			.filter((r) => r.kind === "service" && r.name.length >= 5)
			.map((r) => ({ canonical: r.name, lower: r.name.toLowerCase() }))

		if (serviceNames.length === 0) return rows

		// Map from canonical service name → list of HTTP hostnames that resolve here.
		const matchedHosts = new Map<string, string[]>()
		// IDs of HTTP rows to hide (those that matched at least one service).
		const hiddenIds = new Set<string>()

		for (const row of rows) {
			if (row.kind !== "http") continue
			const hostLower = row.name.toLowerCase()
			for (const svc of serviceNames) {
				if (hostLower.includes(svc.lower)) {
					const list = matchedHosts.get(svc.canonical) ?? []
					list.push(row.name)
					matchedHosts.set(svc.canonical, list)
					hiddenIds.add(row.id)
					break
				}
			}
		}

		if (hiddenIds.size === 0) return rows

		return rows.flatMap((row) => {
			if (hiddenIds.has(row.id)) return []
			if (row.kind !== "service") return [row]
			const hosts = matchedHosts.get(row.name)
			if (!hosts?.length) return [row]
			const subtitle =
				hosts.length === 1 ? `via ${hosts[0]}` : `via ${hosts[0]} +${hosts.length - 1} more`
			return [{ ...row, subtitle }]
		})
	}, [rows])

	const isWaiting = Result.isSuccess(bundleResult) && bundleResult.waiting

	// Aggregate facts for the summary strip. Each datum gets its own muted
	// label + sharp value so the eye lands on the numbers first, the labels
	// second — same hierarchy the chart cards on Overview already use.
	const summary = useMemo(() => {
		if (dedupedRows.length === 0) return null

		const byKind = dedupedRows.reduce<Record<DependencyKind, number>>(
			(acc, row) => {
				acc[row.kind] = (acc[row.kind] ?? 0) + 1
				return acc
			},
			{ service: 0, database: 0, http: 0, messaging: 0, rpc: 0 },
		)
		const breakdown = (["service", "database", "http", "messaging", "rpc"] as const)
			.filter((k) => byKind[k] > 0)
			.map((k) => `${byKind[k]} ${labelFor(k, byKind[k])}`)
			.join(" · ")

		const topByCalls = [...dedupedRows].sort((a, b) => b.callsPerSec - a.callsPerSec)[0]
		const topByErrors = [...dedupedRows]
			.filter((r) => r.errorRate > 0)
			.sort((a, b) => b.errorRate - a.errorRate)[0]
		const topByLatency = [...dedupedRows].sort((a, b) => b.p95DurationMs - a.p95DurationMs)[0]

		return { breakdown, topByCalls, topByErrors, topByLatency }
	}, [dedupedRows])

	return (
		<div className={cn("flex flex-col gap-3 transition-opacity", isWaiting && "opacity-60")}>
			{summary ? (
				<div className="flex flex-col gap-2 text-[11px] text-muted-foreground sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-5 sm:gap-y-1">
					<div className="flex items-baseline gap-x-3">
						<span className="text-foreground">
							<span className="tabular-nums font-mono font-medium">{dedupedRows.length}</span>{" "}
							<span className="text-muted-foreground">downstream</span>
						</span>
						<span className="text-muted-foreground/60">{summary.breakdown}</span>
					</div>
					<span className="hidden grow sm:block" />
					{/* On mobile the facts stack as their own rows; sm:contents dissolves
					    this wrapper so they rejoin the parent's single-line flow on desktop. */}
					<div className="flex flex-col gap-1 sm:contents">
						<HeadlineFact
							label="Busiest"
							name={summary.topByCalls.name}
							value={`${summary.topByCalls.hasSampling ? "~" : ""}${formatRate(summary.topByCalls.callsPerSec)}/s`}
						/>
						{summary.topByErrors ? (
							<HeadlineFact
								label="Most errors"
								name={summary.topByErrors.name}
								value={formatErrorRate(summary.topByErrors.errorRate)}
								tone="error"
							/>
						) : (
							<HeadlineFact label="Errors" name="none" value="0%" />
						)}
						<HeadlineFact
							label="Slowest p95"
							name={summary.topByLatency.name}
							value={formatLatency(summary.topByLatency.p95DurationMs)}
						/>
					</div>
				</div>
			) : null}

			<DependencyTable
				serviceName={serviceName}
				rows={dedupedRows}
				startTime={startTime}
				endTime={endTime}
				timePreset={timePreset}
			/>
		</div>
	)
}

interface HeadlineFactProps {
	label: string
	name: string
	value: string
	tone?: "error"
}

function HeadlineFact({ label, name, value, tone }: HeadlineFactProps) {
	return (
		<span className="flex w-full items-baseline justify-between gap-1.5 sm:inline-flex sm:w-auto sm:justify-start">
			<span className="flex min-w-0 items-baseline gap-1.5">
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
				<span className="max-w-[60vw] truncate text-foreground sm:max-w-[140px]">{name}</span>
			</span>
			<span
				className={cn(
					"shrink-0 tabular-nums font-mono",
					tone === "error" ? "text-severity-error" : "text-foreground",
				)}
			>
				{value}
			</span>
		</span>
	)
}

function labelFor(kind: DependencyKind, count: number): string {
	const map: Record<DependencyKind, [singular: string, plural: string]> = {
		service: ["service", "services"],
		database: ["database", "databases"],
		http: ["external HTTP", "external HTTP"],
		messaging: ["queue", "queues"],
		rpc: ["RPC target", "RPC targets"],
	}
	return count === 1 ? map[kind][0] : map[kind][1]
}
