import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"
import { formatLatency } from "@/lib/format"
import { DependencyTypeBadge, type DependencyKind } from "./dependency-type-badge"
import { ServiceDot } from "@maple/ui/components/service-dot"

export interface DependencyRow {
	id: string
	kind: DependencyKind
	name: string
	subtitle?: string
	callsPerSec: number
	tracedCallsPerSec: number
	totalCalls: number
	estimatedCalls: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
	whereClause: string
}

interface DependencyTableProps {
	serviceName: string
	rows: DependencyRow[]
	startTime?: string
	endTime?: string
	timePreset?: string
}

type SortKey = "calls" | "errorRate" | "p95"
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

export function DependencyTable({ serviceName, rows, startTime, endTime, timePreset }: DependencyTableProps) {
	const navigate = useNavigate()
	const [sortKey, setSortKey] = useState<SortKey>("calls")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

	// Column-relative maxima drive the inline bars. Calls + p95 read as "more is
	// more"; error rate as "any value is a problem", so its bar always tints red
	// with intensity scaled to severity (0..5%+).
	const maxima = useMemo(() => {
		return rows.reduce(
			(acc, row) => ({
				calls: Math.max(acc.calls, row.callsPerSec),
				p95: Math.max(acc.p95, row.p95DurationMs),
			}),
			{ calls: 0, p95: 0 },
		)
	}, [rows])

	const sorted = useMemo(() => {
		const out = [...rows]
		out.sort((a, b) => {
			const aV =
				sortKey === "calls" ? a.callsPerSec : sortKey === "errorRate" ? a.errorRate : a.p95DurationMs
			const bV =
				sortKey === "calls" ? b.callsPerSec : sortKey === "errorRate" ? b.errorRate : b.p95DurationMs
			return sortDir === "desc" ? bV - aV : aV - bV
		})
		return out
	}, [rows, sortKey, sortDir])

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir(sortDir === "desc" ? "asc" : "desc")
		} else {
			setSortKey(key)
			setSortDir("desc")
		}
	}

	const handleRowClick = (row: DependencyRow) => {
		navigate({
			to: "/traces",
			search: {
				services: [serviceName],
				whereClause: row.whereClause,
				startTime,
				endTime,
				timePreset,
			},
		})
	}

	return (
		<>
			{/* Desktop: dense sortable table with inline distribution bars. */}
			<div className="hidden overflow-hidden rounded-lg border bg-card md:block">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent border-b">
							<TableHead className="h-8 pl-3 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
								Target
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
							<TableHead className="h-8 text-right text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
								Avg
							</TableHead>
							<SortableHead
								label="p95"
								align="right"
								active={sortKey === "p95"}
								dir={sortDir}
								onClick={() => toggleSort("p95")}
							/>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={5}
									className="py-12 text-center text-xs text-muted-foreground"
								>
									No downstream dependencies in this window.
								</TableCell>
							</TableRow>
						) : (
							sorted.map((row) => {
								const tone = errorTone(row.errorRate)
								return (
									<TableRow
										key={row.id}
										onClick={() => handleRowClick(row)}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40"
									>
										<TableCell className="py-2 pl-3 align-middle">
											<div className="flex items-center gap-2.5 min-w-0">
												<DependencyTypeBadge kind={row.kind} />
												<div className="flex min-w-0 flex-col leading-tight">
													<span className="flex items-center gap-1.5 truncate text-[12.5px] text-foreground">
														{row.kind === "service" && (
															<ServiceDot serviceName={row.name} className="size-1.5" />
														)}
														<span className="truncate">{row.name}</span>
													</span>
													{row.subtitle ? (
														<span className="truncate text-[10px] text-muted-foreground/60">
															{row.subtitle}
														</span>
													) : null}
												</div>
											</div>
										</TableCell>
										<BarCell
											value={row.callsPerSec}
											max={maxima.calls}
											tone="calls"
											align="right"
										>
											{row.hasSampling ? (
												<Tooltip>
													<TooltipTrigger
														render={<span />}
														className="cursor-help tabular-nums font-mono text-[12.5px] text-foreground"
													>
														~{formatRate(row.callsPerSec)}
													</TooltipTrigger>
													<TooltipContent>
														Estimated ×{row.samplingWeight.toFixed(0)} from{" "}
														{formatRate(row.tracedCallsPerSec)} traced req/s
													</TooltipContent>
												</Tooltip>
											) : (
												<span className="tabular-nums font-mono text-[12.5px] text-foreground">
													{formatRate(row.callsPerSec)}
												</span>
											)}
										</BarCell>
										<BarCell
											value={row.errorRate > 0 ? row.errorRate : 0}
											// Errors get a fixed "severity scale" (5% = full bar) rather
											// than column-relative, so a 0.2% sliver looks small even
											// when it happens to be the worst in the table.
											max={0.05}
											tone="errors"
											align="right"
										>
											<span
												className={cn(
													"tabular-nums font-mono text-[12.5px]",
													tone === "error" && "text-severity-error",
													tone === "warn" && "text-severity-warn",
													tone === "default" && "text-muted-foreground/80",
												)}
											>
												{formatErrorRate(row.errorRate)}
											</span>
										</BarCell>
										<TableCell className="py-2 text-right align-middle">
											<span className="tabular-nums font-mono text-[12.5px] text-muted-foreground/80">
												{formatLatency(row.avgDurationMs)}
											</span>
										</TableCell>
										<BarCell
											value={row.p95DurationMs}
											max={maxima.p95}
											tone="latency"
											align="right"
										>
											<span className="tabular-nums font-mono text-[12.5px] text-foreground">
												{formatLatency(row.p95DurationMs)}
											</span>
										</BarCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</div>

			{/* Mobile: tap-to-trace list with a compact sort control. The 5-column
			    table clips below md, so each row collapses to name + a mono metric line. */}
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
							No downstream dependencies in this window.
						</div>
					) : (
						sorted.map((row) => {
							const tone = errorTone(row.errorRate)
							return (
								<button
									key={row.id}
									type="button"
									onClick={() => handleRowClick(row)}
									className="flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
								>
									<div className="flex min-w-0 items-center gap-2.5">
										<DependencyTypeBadge kind={row.kind} />
										<div className="flex min-w-0 flex-col leading-tight">
											<span className="truncate text-[13px] text-foreground">
												{row.name}
											</span>
											{row.subtitle ? (
												<span className="truncate text-[10px] text-muted-foreground/60">
													{row.subtitle}
												</span>
											) : null}
										</div>
									</div>
									<div className="flex items-center gap-3 font-mono text-xs tabular-nums">
										<span>
											<span className="text-muted-foreground/60">calls </span>
											<span className="text-foreground">
												{row.hasSampling ? "~" : ""}
												{formatRate(row.callsPerSec)}
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
												{formatErrorRate(row.errorRate)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">p95 </span>
											<span className="text-foreground">
												{formatLatency(row.p95DurationMs)}
											</span>
										</span>
									</div>
								</button>
							)
						})
					)}
				</div>
			</div>
		</>
	)
}

interface BarCellProps {
	value: number
	max: number
	tone: "calls" | "errors" | "latency"
	align: "left" | "right"
	children: React.ReactNode
}

/**
 * A numeric cell with a column-tinted bar overlay behind the value. The bar's
 * width is normalized against the column max (or, for errors, a fixed severity
 * ceiling) so distribution is legible at a glance — replaces the standalone
 * bar-list cards the previous design had stacked beside the table.
 *
 * Bars sit at very low opacity behind the text; group hover lifts them so they
 * become a clear hover affordance without screaming for attention at rest.
 */
function BarCell({ value, max, tone, align, children }: BarCellProps) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
	const hasBar = pct > 0
	return (
		<TableCell className="relative py-2 text-right align-middle">
			{hasBar ? (
				<div
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-y-1.5 rounded-sm opacity-50 transition-opacity group-hover/row:opacity-90",
						align === "right" ? "right-2" : "left-2",
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
