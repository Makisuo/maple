import * as React from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { cn } from "@maple/ui/utils"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

const MACRO_HINTS: Array<{ token: string; description: string }> = [
	{ token: "$__orgFilter", description: "Required — expands to OrgId = '<your org>'" },
	{ token: "$__timeFilter(Column)", description: "Column >= <start> AND Column <= <end>" },
	{ token: "$__startTime", description: "Range start as toDateTime('…')" },
	{ token: "$__endTime", description: "Range end as toDateTime('…')" },
	{ token: "$__interval_s", description: "Auto-computed bucket size in seconds" },
]

export interface RawSqlDraft {
	sql: string
	granularitySeconds: number | null
}

interface RawSqlEditorPanelProps {
	widget: DashboardWidget
	draft: RawSqlDraft
	onDraftChange: (next: RawSqlDraft) => void
	onRunPreview: () => void
}

export function RawSqlEditorPanel({
	widget,
	draft,
	onDraftChange,
	onRunPreview,
}: RawSqlEditorPanelProps) {
	const [collapsed, setCollapsed] = React.useState(false)
	const missingOrgFilter = !draft.sql.includes("$__orgFilter")

	return (
		<div className="space-y-3">
			<div className="border rounded-md">
				{/* Header — same shape as QueryPanel's header */}
				<div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
					<button
						type="button"
						onClick={() => setCollapsed((c) => !c)}
						className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
						aria-label={collapsed ? "Expand SQL" : "Collapse SQL"}
					>
						{collapsed ? "▶" : "▼"}
					</button>

					<Badge
						variant="outline"
						className={cn(
							"font-mono text-[11px] text-white border-0 shrink-0 bg-primary/80",
						)}
					>
						sql
					</Badge>

					<span className="text-[11px] text-muted-foreground">ClickHouse</span>

					<div className="flex-1" />

					{missingOrgFilter && !collapsed && (
						<span className="text-[11px] text-destructive">
							Missing $__orgFilter
						</span>
					)}
				</div>

				{/* Body — matches QueryPanel's p-3 space-y-3 rhythm */}
				{!collapsed && (
					<div className="p-3 space-y-3">
						<textarea
							value={draft.sql}
							onChange={(e) => onDraftChange({ ...draft, sql: e.target.value })}
							spellCheck={false}
							className="w-full text-xs font-mono bg-background border border-border rounded-sm px-2 py-1.5 min-h-[200px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
						/>

						{/* Macros + bucket seconds — sit on the same row, like QueryPanel's
						    add-on toggle bar above the body */}
						<div className="flex items-start gap-3 pt-1 border-t border-dashed">
							<div className="flex flex-wrap gap-1.5 flex-1 pt-2">
								{MACRO_HINTS.map((hint) => (
									<span
										key={hint.token}
										title={hint.description}
										className="px-2 py-0.5 text-[11px] rounded-sm bg-muted/40 text-muted-foreground font-mono cursor-help"
									>
										{hint.token}
									</span>
								))}
							</div>

							<div className="flex items-center gap-2 pt-1.5 shrink-0">
								<label className="text-[11px] text-muted-foreground whitespace-nowrap">
									Bucket
								</label>
								<Input
									type="number"
									min={1}
									placeholder="auto"
									value={draft.granularitySeconds ?? ""}
									onChange={(e) =>
										onDraftChange({
											...draft,
											granularitySeconds:
												e.target.value === ""
													? null
													: Math.max(1, Number(e.target.value)),
										})
									}
									className="h-7 w-20 text-xs"
								/>
								<span className="text-[11px] text-muted-foreground">s</span>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Toolbar — mirrors the query-builder toolbar (Run Preview + status) */}
			<div className="flex items-center gap-3">
				<Button size="sm" onClick={onRunPreview} disabled={missingOrgFilter}>
					Run Preview
				</Button>
				<span className="text-[11px] text-muted-foreground ml-auto">
					Targets <code className="font-mono text-foreground">{widget.visualization}</code>
				</span>
			</div>
		</div>
	)
}
