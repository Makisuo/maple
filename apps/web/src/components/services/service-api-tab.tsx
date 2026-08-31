import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServiceEndpointsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import type { ServiceEndpoint } from "@/api/warehouse/service-endpoints"
import { errorTone, formatErrorRate, formatRate } from "./service-table-cells"
import { serviceEndpointsQueryInput } from "./service-endpoints"
import { callsPerSecond, operationTraceSearch, windowSeconds } from "./service-operations"
import { groupEndpoints, leafLabel, type EndpointGroup, type EndpointSort } from "./endpoint-grouping"

interface ServiceApiTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Raw search params, forwarded to the /traces drill-down so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

/**
 * Muted by default; only the mutating verbs earn a tint. The Paper direction
 * tinted GET green, but the palette has no success token — severity is
 * trace/debug/info/warn/error/fatal — and adding one for a method label is a
 * palette decision, not a table decision. Read-only verbs stay muted.
 */
const methodTone = (method: string): string => {
	switch (method) {
		case "POST":
		case "PUT":
		case "PATCH":
			return "text-severity-warn"
		case "DELETE":
			return "text-severity-error"
		default:
			return "text-muted-foreground"
	}
}

export function ServiceApiTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: ServiceApiTabProps) {
	const navigate = useNavigate()
	const [sort, setSort] = useState<EndpointSort>("traffic")
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

	const result = useRefreshableAtomValue(
		getServiceEndpointsResultAtom({
			data: serviceEndpointsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)
	const traceDetailLimited = seconds > 30 * 24 * 60 * 60
	const traceDetailStartTime = traceDetailLimited
		? new Date(Date.parse(effectiveEndTime) - 30 * 24 * 60 * 60 * 1000).toISOString()
		: startTime

	const endpoints = useMemo<ServiceEndpoint[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.endpoints])
				.orElse(() => []),
		[result],
	)

	const groups = useMemo(() => groupEndpoints(endpoints, sort), [endpoints, sort])

	const handleRowClick = (endpoint: ServiceEndpoint) => {
		navigate({
			to: "/traces",
			search: operationTraceSearch({
				serviceName,
				spanName: endpoint.spanName,
				environments,
				startTime: traceDetailStartTime,
				endTime: traceDetailLimited ? effectiveEndTime : endTime,
				timePreset: traceDetailLimited ? undefined : timePreset,
			}),
		})
	}

	if (!Result.isSuccess(result)) {
		return Result.builder(result)
			.onError((error) => <QueryErrorState error={error} />)
			.orElse(() => <ApiLoadingState />)
	}

	if (endpoints.length === 0) {
		return <ApiEmptyState serviceName={serviceName} />
	}

	const isWaiting = result.waiting

	return (
		<div className={cn("flex flex-col gap-3 transition-opacity", isWaiting && "opacity-60")}>
			<div className="flex items-center justify-between">
				{traceDetailLimited ? (
					<p className="text-xs text-muted-foreground">
						Endpoint summaries cover the selected range; trace drill-downs show the latest 30
						days.
					</p>
				) : (
					<span />
				)}
				<div className="flex items-center gap-1.5 text-[11px]">
					<span className="uppercase tracking-wider text-muted-foreground/60">Sort</span>
					{(
						[
							["traffic", "Traffic"],
							["path", "Path"],
						] as const
					).map(([key, label]) => (
						<button
							key={key}
							type="button"
							onClick={() => setSort(key)}
							className={cn(
								"rounded-md border px-2 py-1 font-mono transition-colors",
								sort === key
									? "border-border bg-muted text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			<div className="overflow-hidden rounded-lg border bg-card">
				<ColumnHead />
				{groups.map((group) => (
					<GroupSection
						key={`${group.kind}:${group.stem}`}
						group={group}
						seconds={seconds}
						expanded={expanded.has(group.kind)}
						onToggle={() =>
							setExpanded((open) => {
								const next = new Set(open)
								if (!next.delete(group.kind)) next.add(group.kind)
								return next
							})
						}
						onSelect={handleRowClick}
					/>
				))}
			</div>
		</div>
	)
}

/** Shared lane widths — the leaf rows, the column head and the group totals all
 *  read from these, so the rail cannot drift between them. */
const LANE = {
	method: "w-[58px]",
	rate: "w-[78px]",
	err: "w-[70px]",
	p50: "w-[70px]",
	p95: "w-[70px]",
	p99: "w-[78px]",
} as const

function ColumnHead() {
	return (
		<div className="flex items-center gap-4 border-b py-2 pl-[52px] pr-[18px]">
			<span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
				Endpoint
			</span>
			{(
				[
					["Req/s", LANE.rate],
					["Err", LANE.err],
					["p50", LANE.p50],
					["p95", LANE.p95],
				] as const
			).map(([label, lane]) => (
				<span
					key={label}
					className={cn(
						lane,
						"shrink-0 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60",
					)}
				>
					{label}
				</span>
			))}
			<span
				className={cn(
					LANE.p99,
					"shrink-0 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80",
				)}
			>
				p99
			</span>
		</div>
	)
}

interface GroupSectionProps {
	group: EndpointGroup
	seconds: number
	expanded: boolean
	onToggle: () => void
	onSelect: (endpoint: ServiceEndpoint) => void
}

/**
 * Copy for the two groups that are collapsed by default. Both exist because the
 * rollup cannot tell us whether a span carried `http.route`, so both are read
 * from the route text, and both are one click from being shown in full — a wrong
 * guess costs a click, never a hidden endpoint.
 */
const COLLAPSED_COPY = {
	unrouted: {
		label: "unrouted",
		explainer: "These are URL paths, not route templates — each distinct id counts as its own endpoint.",
	},
	probes: {
		label: "scanner probes",
		explainer:
			"Paths no route matched, in the shape bots scan for. Counted here to keep them out of your endpoint list, not deleted.",
	},
} as const

function GroupSection({ group, seconds, expanded, onToggle, onSelect }: GroupSectionProps) {
	if (group.kind === "unrouted" || group.kind === "probes") {
		return (
			<CollapsedSection
				group={group}
				copy={COLLAPSED_COPY[group.kind]}
				seconds={seconds}
				open={expanded}
				onToggle={onToggle}
				onSelect={onSelect}
			/>
		)
	}
	return (
		<>
			{group.kind === "stem" && <StemHeader group={group} seconds={seconds} />}
			{group.endpoints.map((endpoint) => (
				<LeafRow
					key={endpoint.spanName}
					endpoint={endpoint}
					stem={group.stem}
					seconds={seconds}
					onSelect={onSelect}
				/>
			))}
		</>
	)
}

function StemHeader({ group, seconds }: { group: EndpointGroup; seconds: number }) {
	return (
		<div className="flex items-baseline gap-3.5 border-b bg-muted/30 px-[18px] py-2.5">
			<span className="truncate font-mono text-[13px] font-semibold text-foreground" title={group.stem}>
				{group.stem}
			</span>
			<span className="shrink-0 font-mono text-xs text-muted-foreground/70">
				{group.endpoints.length} endpoint{group.endpoints.length === 1 ? "" : "s"}
			</span>
			<span className="flex-1" />
			<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
				{formatRate(callsPerSecond(group.totals.estimatedSpanCount, seconds))} req/s ·{" "}
				{formatErrorRate(group.totals.errorRate)} err · p99 {Math.round(group.totals.p99DurationMs)}
				ms
			</span>
		</div>
	)
}

function LeafRow({
	endpoint,
	stem,
	seconds,
	onSelect,
}: {
	endpoint: ServiceEndpoint
	stem: string
	seconds: number
	onSelect: (endpoint: ServiceEndpoint) => void
}) {
	const { head, tail } = leafLabel(endpoint.route, stem)
	const tone = errorTone(endpoint.errorRate)
	return (
		<button
			type="button"
			onClick={() => onSelect(endpoint)}
			className="flex w-full items-center gap-4 border-b py-2.5 pl-[34px] pr-[18px] text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
		>
			<span
				className={cn(
					LANE.method,
					"shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide",
					methodTone(endpoint.method),
				)}
			>
				{endpoint.method}
			</span>
			<span className="flex min-w-0 flex-1 items-baseline" title={endpoint.spanName}>
				{head ? (
					<span className="shrink-0 font-mono text-[13px] text-muted-foreground/40">{head}</span>
				) : null}
				<span className="truncate font-mono text-[13px] font-medium text-foreground">{tail}</span>
			</span>
			<span
				className={cn(
					LANE.rate,
					"shrink-0 text-right font-mono text-xs tabular-nums text-foreground",
				)}
			>
				{endpoint.estimatedSpanCount > endpoint.spanCount ? "~" : ""}
				{formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds))}
			</span>
			<span
				className={cn(
					LANE.err,
					"shrink-0 text-right font-mono text-xs tabular-nums",
					tone === "error" && "text-severity-error",
					tone === "warn" && "text-severity-warn",
					tone === "default" && "text-muted-foreground/80",
				)}
			>
				{formatErrorRate(endpoint.errorRate)}
			</span>
			<span className={cn(LANE.p50, "shrink-0 text-right")}>
				<LatencyValue ms={endpoint.p50DurationMs} scale="p50" className="text-xs" />
			</span>
			<span className={cn(LANE.p95, "shrink-0 text-right")}>
				<LatencyValue ms={endpoint.p95DurationMs} scale="p95" className="text-xs" />
			</span>
			<span className={cn(LANE.p99, "shrink-0 text-right")}>
				<LatencyValue ms={endpoint.p99DurationMs} scale="p95" className="text-xs" />
			</span>
		</button>
	)
}

/**
 * A bucket that is always collapsed on arrival. A service missing `http.route`
 * can produce thousands of these rows, and letting them into the list by default
 * is what makes the tab useless on exactly the services that most need fixing.
 * Expanding is always available, and the aggregate stays visible either way — so
 * a service being actively scanned still reads as such at a glance.
 */
function CollapsedSection({
	group,
	copy,
	seconds,
	open,
	onToggle,
	onSelect,
}: {
	group: EndpointGroup
	copy: { label: string; explainer: string }
	seconds: number
	open: boolean
	onToggle: () => void
	onSelect: (endpoint: ServiceEndpoint) => void
}) {
	const sample = group.endpoints.slice(0, 2).map((endpoint) => endpoint.route)
	const remaining = group.endpoints.length - sample.length
	return (
		<>
			<div className="flex items-baseline gap-3.5 border-b bg-muted/30 px-[18px] py-2.5">
				<span className="font-mono text-[13px] font-semibold italic text-muted-foreground">
					{copy.label}
				</span>
				<span className="shrink-0 font-mono text-xs text-muted-foreground/70">
					{group.endpoints.length.toLocaleString()} path
					{group.endpoints.length === 1 ? "" : "s"}
				</span>
				<span className="flex-1" />
				<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
					{formatRate(callsPerSecond(group.totals.estimatedSpanCount, seconds))} req/s ·{" "}
					{formatErrorRate(group.totals.errorRate)} err · p99{" "}
					{Math.round(group.totals.p99DurationMs)}ms
				</span>
			</div>
			<div className="flex items-center gap-4 border-b py-3.5 pl-[34px] pr-[18px] last:border-b-0">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="text-[13px] text-foreground/90">{copy.explainer}</span>
					<span className="truncate font-mono text-xs text-muted-foreground/50">
						{sample.join("  ·  ")}
						{remaining > 0 ? `  ·  ${remaining.toLocaleString()} more` : ""}
					</span>
				</div>
				<Button variant="outline" size="sm" onClick={onToggle} className="shrink-0">
					{open ? "Hide" : "Show anyway"}
				</Button>
			</div>
			{open
				? group.endpoints.map((endpoint) => (
						<LeafRow
							key={endpoint.spanName}
							endpoint={endpoint}
							stem=""
							seconds={seconds}
							onSelect={onSelect}
						/>
					))
				: null}
		</>
	)
}

/** Names which of the two conditions failed — a server span, and a route on it —
 *  rather than "no data", because the tab is empty for a reason the user can fix. */
function ApiEmptyState({ serviceName }: { serviceName: string }) {
	return (
		<div className="flex flex-col items-center gap-3.5 rounded-lg border bg-card px-[18px] py-11 text-center">
			<span className="font-mono text-[15px] font-medium text-foreground/90">
				No HTTP endpoints in this window
			</span>
			<span className="max-w-[620px] text-[13px] leading-[21px] text-muted-foreground">
				<span className="font-mono text-foreground/80">{serviceName}</span> reported spans in this
				range, but none are HTTP server spans with a route. An endpoint needs a server span carrying{" "}
				<span className="font-mono text-foreground/80">http.route</span> or{" "}
				<span className="font-mono text-foreground/80">url.path</span>.
			</span>
		</div>
	)
}

/** Keeps the group/leaf rhythm so the list does not reflow when it resolves. */
function ApiLoadingState() {
	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			<div className="flex items-center gap-4 border-b bg-muted/30 px-[18px] py-3">
				<Skeleton className="h-2.5 w-[230px]" />
				<Skeleton className="h-2.5 w-[70px]" />
				<span className="flex-1" />
				<Skeleton className="h-2.5 w-[190px]" />
			</div>
			{Array.from({ length: 8 }).map((_, i) => (
				<div
					key={i}
					className="flex items-center gap-4 border-b py-3 pl-[52px] pr-[18px] last:border-b-0"
				>
					<Skeleton className="h-2.5 w-[38px] shrink-0" />
					<Skeleton
						className={cn(
							"h-2.5",
							i % 3 === 0 ? "w-[210px]" : i % 3 === 1 ? "w-[150px]" : "w-[108px]",
						)}
					/>
					<span className="flex-1" />
					{[LANE.rate, LANE.err, LANE.p50, LANE.p95, LANE.p99].map((lane, j) => (
						<div key={j} className={cn(lane, "flex shrink-0 justify-end")}>
							<Skeleton className="h-2.5 w-[42px]" />
						</div>
					))}
				</div>
			))}
		</div>
	)
}
