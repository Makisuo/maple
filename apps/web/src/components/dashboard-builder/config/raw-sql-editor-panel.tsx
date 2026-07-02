import { useId, useRef, useState } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { cn } from "@maple/ui/utils"
import { useDashboardVariablesOptional } from "@/components/dashboard-builder/dashboard-variables-context"
import type { DashboardWidget } from "@/components/dashboard-builder/types"
import { tokenizeSql } from "@/lib/sql-highlight"

const MACRO_HINTS: Array<{ token: string; description: string }> = [
	{ token: "$__orgFilter", description: "Required: expands to OrgId = '<your org>'" },
	{ token: "$__timeFilter(Column)", description: "Column >= <start> AND Column <= <end>" },
	{ token: "$__startTime", description: "Range start as toDateTime('...')" },
	{ token: "$__endTime", description: "Range end as toDateTime('...')" },
	{ token: "$__interval_s", description: "Auto-computed bucket size in seconds" },
]

export interface RawSqlDraft {
	sql: string
	granularitySeconds: number | null
}

interface RawSqlEditorPanelProps {
	widget?: Pick<DashboardWidget, "visualization">
	draft: RawSqlDraft
	onDraftChange: (next: RawSqlDraft) => void
	onRunPreview?: () => void
	showBucketControl?: boolean
	targetLabel?: string
}

export function RawSqlEditorPanel({
	widget,
	draft,
	onDraftChange,
	onRunPreview,
	showBucketControl = true,
	targetLabel,
}: RawSqlEditorPanelProps) {
	const [collapsed, setCollapsed] = useState(false)
	const preRef = useRef<HTMLPreElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const editorId = useId()
	const bucketInputId = `${editorId}-bucket`
	const missingOrgFilter = !draft.sql.includes("$__orgFilter")

	const variablesContext = useDashboardVariablesOptional()
	const variableNames = variablesContext?.variables.map((variable) => variable.name) ?? []

	// Insert a token at the caret (replacing any selection) and keep editing —
	// macro and variable chips are one-click inserts, not just documentation.
	const insertToken = (token: string) => {
		const textarea = textareaRef.current
		if (!textarea) {
			onDraftChange({ ...draft, sql: draft.sql + token })
			return
		}
		const start = textarea.selectionStart ?? draft.sql.length
		const end = textarea.selectionEnd ?? start
		const sql = draft.sql.slice(0, start) + token + draft.sql.slice(end)
		onDraftChange({ ...draft, sql })
		requestAnimationFrame(() => {
			textarea.focus()
			const caret = start + token.length
			textarea.setSelectionRange(caret, caret)
		})
	}

	return (
		<div className="space-y-3">
			<div className="border rounded-md">
				{/* Header follows QueryPanel's compact query row. */}
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
						className={cn("font-mono text-[11px] text-white border-0 shrink-0 bg-primary/80")}
					>
						sql
					</Badge>

					<span className="text-[11px] text-muted-foreground">ClickHouse</span>

					<div className="flex-1" />

					{missingOrgFilter && !collapsed && (
						<span className="text-[11px] text-destructive">Missing $__orgFilter</span>
					)}
				</div>

				{!collapsed && (
					<div className="p-3 space-y-3">
						<div className="relative w-full text-xs font-mono leading-5">
							<pre
								ref={preRef}
								aria-hidden
								className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-sm border border-transparent px-2 py-1.5 leading-5"
							>
								<code className="font-mono">
									{tokenizeSql(draft.sql).map((token) => (
										<span key={token.start} className={token.className}>
											{token.text}
										</span>
									))}
									{"\n"}
								</code>
							</pre>
							<textarea
								ref={textareaRef}
								aria-label="SQL query"
								value={draft.sql}
								onChange={(e) => onDraftChange({ ...draft, sql: e.target.value })}
								onScroll={(e) => {
									const pre = preRef.current
									if (!pre) return
									pre.scrollTop = e.currentTarget.scrollTop
									pre.scrollLeft = e.currentTarget.scrollLeft
								}}
								spellCheck={false}
								className="relative w-full bg-transparent text-transparent caret-foreground border border-border rounded-sm px-2 py-1.5 min-h-[200px] resize-y outline-none focus:ring-1 focus:ring-foreground/20 leading-5"
							/>
						</div>

						<div className="flex items-start gap-3 pt-1 border-t border-dashed">
							<div className="flex flex-wrap gap-1.5 flex-1 pt-2">
								{MACRO_HINTS.map((hint) => (
									<button
										key={hint.token}
										type="button"
										title={hint.description}
										onClick={() => insertToken(hint.token)}
										className="px-2 py-0.5 text-[11px] rounded-sm bg-muted/40 text-muted-foreground font-mono transition-colors hover:bg-muted hover:text-foreground"
									>
										{hint.token}
									</button>
								))}
								{variableNames.map((name) => (
									<button
										key={`var-${name}`}
										type="button"
										title={`Dashboard variable — expands to the selected value, e.g. ServiceName IN ($${name}). "All" expands to every value.`}
										onClick={() => insertToken(`$${name}`)}
										className="px-2 py-0.5 text-[11px] rounded-sm bg-primary/10 text-primary font-mono transition-colors hover:bg-primary/20"
									>
										${name}
									</button>
								))}
							</div>

							{showBucketControl && (
								<div className="flex items-center gap-2 pt-1.5 shrink-0">
									<label
										htmlFor={bucketInputId}
										className="text-[11px] text-muted-foreground whitespace-nowrap"
									>
										Bucket
									</label>
									<Input
										id={bucketInputId}
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
							)}
						</div>
					</div>
				)}
			</div>

			{(onRunPreview || targetLabel || widget) && (
				<div className="flex items-center gap-3">
					{onRunPreview && (
						<Button size="sm" onClick={onRunPreview} disabled={missingOrgFilter}>
							Run Preview
						</Button>
					)}
					<span className="text-[11px] text-muted-foreground ml-auto">
						Targets{" "}
						<code className="font-mono text-foreground">
							{targetLabel ?? widget?.visualization}
						</code>
					</span>
				</div>
			)}
		</div>
	)
}
