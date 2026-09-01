// Shared cell + header primitives for the service detail tables (Operations,
// API, Dependencies). Extracted when the API tab became the third table with
// the same distribution-bar treatment — a copy per tab is how the three drift.

import { cn } from "@maple/ui/lib/utils"
import { TableCell, TableHead } from "@maple/ui/components/ui/table"
import { ChevronDownIcon, ChevronUpIcon, ChevronExpandYIcon } from "@/components/icons"

export type SortDir = "asc" | "desc"

export function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

export function formatErrorRate(rate: number): string {
	if (rate >= 0.01) return `${(rate * 100).toFixed(1)}%`
	if (rate > 0) return "<1%"
	return "0%"
}

export function errorTone(rate: number): "error" | "warn" | "default" {
	if (rate > 0.05) return "error"
	if (rate > 0.01) return "warn"
	return "default"
}

interface BarCellProps {
	value: number
	max: number
	tone: "calls" | "errors" | "latency"
	children: React.ReactNode
}

/** Numeric cell with a column-tinted distribution bar. */
export function BarCell({ value, max, tone, children }: BarCellProps) {
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

export function SortableHead({ label, align = "left", active, dir, onClick }: SortableHeadProps) {
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
