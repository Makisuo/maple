import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceEndpointsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import type { ServiceEndpoint } from "@/api/warehouse/service-endpoints"
import {
	endpointDetailSearch,
	methodTone,
	serviceEndpointsQueryInput,
	splitRouteForDisplay,
} from "./service-endpoints"
import { callsPerSecond, windowSeconds } from "./service-operations"

interface ServiceEndpointsTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Raw search params, forwarded to the detail route so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

type SortKey = "calls" | "errorRate" | "p50" | "p95" | "p99"
type SortDir = "asc" | "desc"

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

function errorTone(rate: number): "error" | "warn" | "default" {
	if (rate > 0.05) return "error"
	if (rate > 0.01) return "warn"
	return "default"
}

const sortValue = (endpoint: ServiceEndpoint, key: SortKey): number => {
	switch (key) {
		case "calls":
			return endpoint.estimatedSpanCount
		case "errorRate":
			return endpoint.errorRate
		case "p50":
			return endpoint.p50DurationMs
		case "p95":
			return endpoint.p95DurationMs
		case "p99":
			return endpoint.p99DurationMs
	}
}

export function ServiceEndpointsTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: ServiceEndpointsTabProps) {
	const navigate = useNavigate()
	const [sortKey, setSortKey] = useState<SortKey>("calls")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

	const result = useRetainedRefreshableResultValue(
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

	const endpoints = useMemo<ServiceEndpoint[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.endpoints])
				.orElse(() => []),
		[result],
	)

	const sorted = useMemo(() => {
		return endpoints.toSorted((a, b) => {
			const diff = sortValue(b, sortKey) - sortValue(a, sortKey)
			return sortDir === "desc" ? diff : -diff
		})
	}, [endpoints, sortKey, sortDir])

	// Column-relative maxima drive the inline throughput/latency bars, mirroring
	// the Operations and Dependencies tables so all three read as one system.
	const maxima = useMemo(
		() =>
			endpoints.reduce(
				(acc, endpoint) => ({
					calls: Math.max(acc.calls, endpoint.estimatedSpanCount),
					p95: Math.max(acc.p95, endpoint.p95DurationMs),
				}),
				{ calls: 0, p95: 0 },
			),
		[endpoints],
	)

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir(sortDir === "desc" ? "asc" : "desc")
		} else {
			setSortKey(key)
			setSortDir("desc")
		}
	}

	const handleRowClick = (endpoint: ServiceEndpoint) => {
		navigate({
			to: "/services/$serviceName/endpoints",
			params: { serviceName },
			search: endpointDetailSearch({
				method: endpoint.method,
				route: endpoint.route,
				environments,
				startTime,
				endTime,
				timePreset,
			}),
		})
	}

	if (!Result.isSuccess(result)) {
		return Result.builder(result)
			.onError((error) => <QueryErrorState error={error} />)
			.orElse(() => <EndpointsLoadingState />)
	}

	const isWaiting = Result.isSuccess(result) && result.waiting

	return (
		<div className={cn("flex flex-col gap-2 transition-opacity", isWaiting && "opacity-60")}>
			{/* Desktop: dense sortable table with inline distribution bars. */}
			<div className="hidden overflow-hidden rounded-lg border bg-card md:block">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent border-b">
							<TableHead className="h-8 w-full pl-3 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
								Endpoint
							</TableHead>
							<SortableHead
								label="Req /s"
								align="right"
								active={sortKey === "calls"}
								dir={sortDir}
								onClick={() => toggleSort("calls")}
							/>
							<SortableHead
								label="Errors"
								align="right"
								active={sortKey === "errorRate"}
								dir={sortDir}
								onClick={() => toggleSort("errorRate")}
							/>
							<SortableHead
								label="p50"
								align="right"
								active={sortKey === "p50"}
								dir={sortDir}
								onClick={() => toggleSort("p50")}
							/>
							<SortableHead
								label="p95"
								align="right"
								active={sortKey === "p95"}
								dir={sortDir}
								onClick={() => toggleSort("p95")}
							/>
							<SortableHead
								label="p99"
								align="right"
								active={sortKey === "p99"}
								dir={sortDir}
								onClick={() => toggleSort("p99")}
								className="hidden xl:table-cell"
							/>
							<TableHead className="hidden h-8 w-[104px] pr-3 text-right text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium lg:table-cell">
								Activity
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={7}
									className="py-12 text-center text-xs text-muted-foreground"
								>
									No endpoints recorded in this window.
								</TableCell>
							</TableRow>
						) : (
							sorted.map((endpoint) => {
								const tone = errorTone(endpoint.errorRate)
								return (
									<TableRow
										key={endpoint.spanName}
										onClick={() => handleRowClick(endpoint)}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40"
									>
										{/* w-full + max-w-0: this cell absorbs every pixel the
										    content-sized numeric columns don't need. */}
										<TableCell className="w-full max-w-0 py-2 pl-3 align-middle">
											<div className="flex items-center gap-2">
												<MethodBadge method={endpoint.method} />
												<RouteLabel
													route={endpoint.route}
													className="text-[12.5px]"
												/>
											</div>
										</TableCell>
										<BarCell
											value={endpoint.estimatedSpanCount}
											max={maxima.calls}
											tone="calls"
										>
											<span className="tabular-nums font-mono text-[12.5px] text-foreground">
												{endpoint.estimatedSpanCount > endpoint.spanCount ? "~" : ""}
												{formatRate(
													callsPerSecond(endpoint.estimatedSpanCount, seconds),
												)}
											</span>
										</BarCell>
										<BarCell
											value={endpoint.errorRate > 0 ? endpoint.errorRate : 0}
											// Fixed severity scale (5% = full bar), matching the
											// Operations tab — a 0.2% sliver stays a sliver.
											max={0.05}
											tone="errors"
										>
											<span
												className={cn(
													"tabular-nums font-mono text-[12.5px]",
													tone === "error" && "text-severity-error",
													tone === "warn" && "text-severity-warn",
													tone === "default" && "text-muted-foreground/80",
												)}
											>
												{formatErrorRate(endpoint.errorRate)}
											</span>
										</BarCell>
										<TableCell className="w-px whitespace-nowrap py-2 text-right align-middle">
											<LatencyValue
												ms={endpoint.p50DurationMs}
												scale="p50"
												className="text-[12.5px]"
											/>
										</TableCell>
										<BarCell
											value={endpoint.p95DurationMs}
											max={maxima.p95}
											tone="latency"
										>
											<LatencyValue
												ms={endpoint.p95DurationMs}
												scale="p95"
												className="text-[12.5px]"
											/>
										</BarCell>
										{/* p99 is the first thing to go on a narrow viewport —
										    p95 already carries the tail signal. */}
										<TableCell className="hidden w-px whitespace-nowrap py-2 text-right align-middle xl:table-cell">
											<LatencyValue
												ms={endpoint.p99DurationMs}
												scale="p95"
												className="text-[12.5px]"
											/>
										</TableCell>
										<TableCell className="hidden py-1.5 pr-3 align-middle lg:table-cell">
											<Sparkline
												data={endpoint.sparkline.map((point) => ({
													value: point.count,
												}))}
												className="ml-auto h-6 w-[88px]"
											/>
										</TableCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</div>

			{/* Mobile: tap-to-detail list with a compact sort control. */}
			<div className="space-y-2 md:hidden">
				<div className="flex items-center gap-1.5 text-[11px]">
					<span className="uppercase tracking-wider text-muted-foreground/60">Sort</span>
					{(
						[
							["calls", "Req"],
							["errorRate", "Errors"],
							["p95", "p95"],
						] as const
					).map(([key, label]) => {
						const active = sortKey === key
						const Icon = active
							? sortDir === "desc"
								? ChevronDownIcon
								: ChevronUpIcon
							: ChevronExpandYIcon
						return (
							<button
								key={key}
								type="button"
								onClick={() => toggleSort(key)}
								className={cn(
									"inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono transition-colors",
									active
										? "border-border bg-muted text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground",
								)}
							>
								{label}
								<Icon
									size={11}
									className={active ? "text-foreground" : "text-muted-foreground/40"}
								/>
							</button>
						)
					})}
				</div>
				<div className="overflow-hidden rounded-lg border bg-card">
					{sorted.length === 0 ? (
						<div className="py-12 text-center text-xs text-muted-foreground">
							No endpoints recorded in this window.
						</div>
					) : (
						sorted.map((endpoint) => {
							const tone = errorTone(endpoint.errorRate)
							return (
								<button
									key={endpoint.spanName}
									type="button"
									onClick={() => handleRowClick(endpoint)}
									className="flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
								>
									<div className="flex items-center gap-2">
										<MethodBadge method={endpoint.method} />
										<RouteLabel route={endpoint.route} className="text-[13px]" />
									</div>
									<div className="flex items-center gap-3 font-mono text-xs tabular-nums">
										<span>
											<span className="text-muted-foreground/60">req </span>
											<span className="text-foreground">
												{endpoint.estimatedSpanCount > endpoint.spanCount ? "~" : ""}
												{formatRate(
													callsPerSecond(endpoint.estimatedSpanCount, seconds),
												)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">err </span>
											<span
												className={cn(
													tone === "error" && "text-severity-error",
													tone === "warn" && "text-severity-warn",
													tone === "default" && "text-muted-foreground/80",
												)}
											>
												{formatErrorRate(endpoint.errorRate)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">p95 </span>
											<LatencyValue ms={endpoint.p95DurationMs} scale="p95" />
										</span>
									</div>
								</button>
							)
						})
					)}
				</div>
			</div>
		</div>
	)
}

/**
 * A route that gives up its middle, not its end. `head` shrinks and truncates;
 * `tail` (the last path segment) is fixed, so `/subscriptions/v2/{id}/cancel`
 * degrades to `/subscriptions/v2…/cancel` rather than `/subscriptions…`.
 */
export function RouteLabel({ route, className }: { route: string; className?: string }) {
	const { head, tail } = splitRouteForDisplay(route)
	return (
		<span className={cn("flex min-w-0 flex-1 font-mono text-foreground", className)} title={route}>
			{head ? <span className="truncate">{head}</span> : null}
			{/* Capped so a single enormous segment can't push the head to zero. */}
			<span className="max-w-[60%] shrink-0 truncate">{tail}</span>
		</span>
	)
}

export function MethodBadge({ method, className }: { method: string; className?: string }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
				methodTone(method),
				className,
			)}
		>
			{method || "—"}
		</span>
	)
}

function EndpointsLoadingState() {
	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			{Array.from({ length: 10 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
					<Skeleton className="h-3 w-10" />
					<Skeleton className="h-3 flex-1" />
					<Skeleton className="h-3 w-12" />
					<Skeleton className="h-3 w-10" />
					<Skeleton className="h-3 w-12" />
					<Skeleton className="hidden h-5 w-[120px] md:block" />
				</div>
			))}
		</div>
	)
}

interface BarCellProps {
	value: number
	max: number
	tone: "calls" | "errors" | "latency"
	children: React.ReactNode
}

/** Numeric cell with a column-tinted distribution bar — same treatment as the
 *  Operations and Dependencies tabs so the tables read identically. */
function BarCell({ value, max, tone, children }: BarCellProps) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
	const hasBar = pct > 0
	return (
		<TableCell className="relative w-px whitespace-nowrap py-2 text-right align-middle">
			{hasBar ? (
				<div
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-y-1.5 right-2 rounded-sm opacity-50 transition-opacity group-hover/row:opacity-90",
						tone === "calls" && "bg-severity-info/20",
						tone === "errors" && "bg-severity-error/25",
						tone === "latency" && "bg-severity-warn/20",
					)}
					style={{ width: `calc(${pct}% - 0.5rem)` }}
				/>
			) : null}
			<span className="relative pr-1.5">{children}</span>
		</TableCell>
	)
}

interface SortableHeadProps {
	label: string
	align?: "left" | "right"
	active: boolean
	dir: SortDir
	onClick: () => void
	/** Extra classes, e.g. the responsive hide that pairs with its cell. */
	className?: string
}

function SortableHead({ label, align = "left", active, dir, onClick, className }: SortableHeadProps) {
	const Icon = active ? (dir === "desc" ? ChevronDownIcon : ChevronUpIcon) : ChevronExpandYIcon
	return (
		<TableHead
			onClick={onClick}
			className={cn(
				// w-px + nowrap: sizes to its label so the Endpoint column keeps the rest.
				"h-8 w-px cursor-pointer select-none whitespace-nowrap text-[10px] uppercase tracking-wider font-medium transition-colors",
				active ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
				align === "right" && "text-right",
				className,
			)}
		>
			<span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end w-full")}>
				{label}
				<Icon size={11} className={active ? "text-foreground" : "text-muted-foreground/30"} />
			</span>
		</TableHead>
	)
}
