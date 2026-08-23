import { useState, type ReactNode } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"
import { queryBadgeColor, type QueryBuilderDataSource } from "@maple/query-engine/query-builder"
import { QUERY_BUILDER_DATA_SOURCES } from "@maple/query-model"

// The chrome every query panel shares — the collapsible header with the
// query's badge, its source select and its actions — and the add-on toggle
// bar under a panel's body. `QueryPanel` (traces / logs / metrics) and the
// funnel widget's `FunnelQueryPanel` (product events) both render through
// these, which is what makes the funnel read as one more query rather than a
// sidebar of its own.

/**
 * What a panel's source select offers. The three query-builder data sources
 * lower to the query set; `product_events` is the funnel widget's own source,
 * answered by the funnel route. It is NOT a `QueryBuilderDataSource`: nothing
 * else in the builder (alerts, formulas, the list panel) can target it.
 */
export type QueryPanelSource = QueryBuilderDataSource | "product_events"

export const QUERY_PANEL_SOURCE_LABEL = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
	product_events: "Product events",
} satisfies Record<QueryPanelSource, string>

export const isQueryBuilderDataSource = (source: string): source is QueryBuilderDataSource =>
	QUERY_BUILDER_DATA_SOURCES.some((candidate) => candidate === source)

/** The query-builder sources, in the order the select shows them. */
export const QUERY_BUILDER_PANEL_SOURCES: ReadonlyArray<QueryPanelSource> = ["traces", "logs", "metrics"]

interface QueryPanelShellProps {
	/** The query's letter — "A", "B", … */
	name: string
	index: number
	source: QueryPanelSource
	sourceOptions: ReadonlyArray<QueryPanelSource>
	onSourceChange: (source: QueryPanelSource) => void
	/** The "include in the chart" checkbox; omitted for a panel that is always drawn. */
	visibility?: { checked: boolean; onChange: (checked: boolean) => void; id: string }
	/** Clone / Remove, right-aligned in the header. */
	headerActions?: ReactNode
	children: ReactNode
}

export function QueryPanelShell({
	name,
	index,
	source,
	sourceOptions,
	onSourceChange,
	visibility,
	headerActions,
	children,
}: QueryPanelShellProps) {
	const [collapsed, setCollapsed] = useState(false)
	const badgeColor = queryBadgeColor(index)
	const items = Object.fromEntries(sourceOptions.map((option) => [option, QUERY_PANEL_SOURCE_LABEL[option]]))

	return (
		<div className="border rounded-md">
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
					aria-label={collapsed ? "Expand query" : "Collapse query"}
				>
					{collapsed ? "▶" : "▼"}
				</button>

				{visibility && (
					<Checkbox
						id={visibility.id}
						checked={visibility.checked}
						onCheckedChange={(checked) => visibility.onChange(checked === true)}
						className="shrink-0"
					/>
				)}

				<Badge
					variant="outline"
					className={cn("font-mono text-[11px] text-white border-0 shrink-0", badgeColor)}
				>
					{name}
				</Badge>

				<Select
					items={items}
					value={source}
					onValueChange={(value) => {
						const next = sourceOptions.find((option) => option === value)
						if (next !== undefined) onSourceChange(next)
					}}
				>
					<SelectTrigger
						className="h-7 w-36 text-xs border-none bg-transparent shadow-none px-1"
						aria-label="Query source"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{sourceOptions.map((option) => (
							<SelectItem key={option} value={option}>
								{QUERY_PANEL_SOURCE_LABEL[option]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<div className="flex-1" />

				{headerActions}
			</div>

			{/* Body */}
			{!collapsed && <div className="p-3 space-y-3">{children}</div>}
		</div>
	)
}

/** The row of small toggles that reveal a panel's optional clauses. */
export function AddOnToggleBar<K extends string>({
	items,
	active,
	onToggle,
}: {
	items: ReadonlyArray<{ key: K; label: string }>
	active: Record<K, boolean>
	onToggle: (key: K) => void
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-dashed">
			{items.map(({ key, label }) => (
				<button
					key={key}
					type="button"
					onClick={() => onToggle(key)}
					aria-pressed={active[key]}
					className={cn(
						"px-2 py-0.5 text-[11px] rounded-sm border transition-colors",
						active[key]
							? "bg-primary/10 border-primary/30 text-primary"
							: "bg-muted/40 border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					{label}
				</button>
			))}
		</div>
	)
}
