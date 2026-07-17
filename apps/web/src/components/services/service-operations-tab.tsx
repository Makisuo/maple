import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"
import { formatLatency } from "@/lib/format"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceOperationsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import type { ServiceOperation } from "@/api/warehouse/service-operations"
import {
	callsPerSecond,
	operationTraceSearch,
	serviceOperationsQueryInput,
	windowSeconds,
} from "./service-operations"

interface ServiceOperationsTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Raw search params, forwarded to the /traces drill-down so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

type SortKey = "calls" | "errorRate" | "p50" | "p95"
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

const sortValue = (op: ServiceOperation, key: SortKey): number => {
	switch (key) {
		case "calls":
			return op.estimatedSpanCount
		case "errorRate":
			return op.errorRate
		case "p50":
			return op.p50DurationMs
		case "p95":
			return op.p95DurationMs
	}
}

export function ServiceOperationsTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: ServiceOperationsTabProps) {
	const navigate = useNavigate()
	const [sortKey, setSortKey] = useState<SortKey>("calls")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

	const result = useRetainedRefreshableResultValue(
		getServiceOperationsResultAtom({
			data: serviceOperationsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)

	const operations = useMemo<ServiceOperation[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.operations])
				.orElse(() => []),
		[result],
	)

	const sorted = useMemo(() => {
		return operations.toSorted((a, b) => {
			const diff = sortValue(b, sortKey) - sortValue(a, sortKey)
			return sortDir === "desc" ? diff : -diff
		})
	}, [operations, sortKey, sortDir])

	// Column-relative maxima drive the inline throughput/latency bars, mirroring
	// the Dependencies tab so both tables read as one system.
	const maxima = useMemo(
		() =>
			operations.reduce(
				(acc, op) => ({
					calls: Math.max(acc.calls, op.estimatedSpanCount),
					p95: Math.max(acc.p95, op.p95DurationMs),
				}),
				{ calls: 0, p95: 0 },
			),
		[operations],
	)

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir(sortDir === "desc" ? "asc" : "desc")
		} else {
			setSortKey(key)
			setSortDir("desc")
		}
	}

	const handleRowClick = (op: ServiceOperation) => {
		navigate({
			to: "/traces",
			search: operationTraceSearch({
				serviceName,
				spanName: op.spanName,
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
			.orElse(() => <OperationsLoadingState />)
	}

	const isWaiting = Result.isSuccess(result) && result.waiting

	return (
		<div className={cn("flex flex-col gap-2 transition-opacity", isWaiting && "opacity-60")}>
			{/* Desktop: dense sortable table with inline distribution bars. */}
			<div className="hidden overflow-hidden rounded-lg border bg-card md:block">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent border-b">
							<TableHead className="h-8 pl-3 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
								Operation
							</TableHead>
							<SortableHead
								label="Calls /s"
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
							<TableHead className="h-8 w-[140px] pr-3 text-right text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
								Activity
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell colSpan={6} className="py-12 text-center text-xs text-muted-foreground">
									No operations recorded in this window.
								</TableCell>
							</TableRow>
						) : (
							sorted.map((op) => {
								const tone = errorTone(op.errorRate)
								return (
									<TableRow
										key={op.spanName}
										onClick={() => handleRowClick(op)}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40"
									>
										<TableCell className="max-w-0 py-2 pl-3 align-middle">
											<span
												className="block truncate font-mono text-[12.5px] text-foreground"
												title={op.spanName}
											>
												{op.spanName}
											</span>
										</TableCell>
										<BarCell value={op.estimatedSpanCount} max={maxima.calls} tone="calls">
											<span className="tabular-nums font-mono text-[12.5px] text-foreground">
												{op.estimatedSpanCount > op.spanCount ? "~" : ""}
												{formatRate(callsPerSecond(op.estimatedSpanCount, seconds))}
											</span>
										</BarCell>
										<BarCell
											value={op.errorRate > 0 ? op.errorRate : 0}
											// Fixed severity scale (5% = full bar), matching the
											// Dependencies tab — a 0.2% sliver stays a sliver.
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
												{formatErrorRate(op.errorRate)}
											</span>
										</BarCell>
										<TableCell className="py-2 text-right align-middle">
											<span className="tabular-nums font-mono text-[12.5px] text-muted-foreground/80">
												{formatLatency(op.p50DurationMs)}
											</span>
										</TableCell>
										<BarCell value={op.p95DurationMs} max={maxima.p95} tone="latency">
											<span className="tabular-nums font-mono text-[12.5px] text-foreground">
												{formatLatency(op.p95DurationMs)}
											</span>
										</BarCell>
										<TableCell className="py-1.5 pr-3 align-middle">
											<Sparkline
												data={op.sparkline.map((point) => ({ value: point.count }))}
												className="ml-auto h-6 w-[120px]"
											/>
										</TableCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</div>

			{/* Mobile: tap-to-trace list with a compact sort control. */}
			<div className="space-y-2 md:hidden">
				<div className="flex items-center gap-1.5 text-[11px]">
					<span className="uppercase tracking-wider text-muted-foreground/60">Sort</span>
					{(
						[
							["calls", "Calls"],
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
								<Icon size={11} className={active ? "text-foreground" : "text-muted-foreground/40"} />
							</button>
						)
					})}
				</div>
				<div className="overflow-hidden rounded-lg border bg-card">
					{sorted.length === 0 ? (
						<div className="py-12 text-center text-xs text-muted-foreground">
							No operations recorded in this window.
						</div>
					) : (
						sorted.map((op) => {
							const tone = errorTone(op.errorRate)
							return (
								<button
									key={op.spanName}
									type="button"
									onClick={() => handleRowClick(op)}
									className="flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
								>
									<span className="truncate font-mono text-[13px] text-foreground">{op.spanName}</span>
									<div className="flex items-center gap-3 font-mono text-xs tabular-nums">
										<span>
											<span className="text-muted-foreground/60">calls </span>
											<span className="text-foreground">
												{op.estimatedSpanCount > op.spanCount ? "~" : ""}
												{formatRate(callsPerSecond(op.estimatedSpanCount, seconds))}
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
												{formatErrorRate(op.errorRate)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">p95 </span>
											<span className="text-foreground">{formatLatency(op.p95DurationMs)}</span>
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

function OperationsLoadingState() {
	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			{Array.from({ length: 10 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
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
 *  Dependencies tab's BarCell so the two tables read identically. */
function BarCell({ value, max, tone, children }: BarCellProps) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
	const hasBar = pct > 0
	return (
		<TableCell className="relative py-2 text-right align-middle">
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
}

function SortableHead({ label, align = "left", active, dir, onClick }: SortableHeadProps) {
	const Icon = active ? (dir === "desc" ? ChevronDownIcon : ChevronUpIcon) : ChevronExpandYIcon
	return (
		<TableHead
			onClick={onClick}
			className={cn(
				"h-8 cursor-pointer select-none text-[10px] uppercase tracking-wider font-medium transition-colors",
				active ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
				align === "right" && "text-right",
			)}
		>
			<span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end w-full")}>
				{label}
				<Icon size={11} className={active ? "text-foreground" : "text-muted-foreground/30"} />
			</span>
		</TableHead>
	)
}
