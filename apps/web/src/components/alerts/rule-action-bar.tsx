import type { ReactNode } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import {
	CheckIcon,
	CircleWarningIcon,
	FloppyDiskIcon,
	LoaderIcon,
	SquareTerminalIcon,
} from "@/components/icons"
import { RULE_FORM_MAX_WIDTH } from "@/components/alerts/rule-form-layout"

interface RuleActionBarProps {
	editing: boolean
	saving: boolean
	validationIssues: string[]
	onCancel: () => void
	onSave: () => void
	onShowTemplates?: () => void
	cancelSlot?: ReactNode
}

const MAX_VISIBLE_ISSUES = 3

/**
 * Sticky bottom bar with live validation summary on the left and Cancel /
 * Save on the right. Replaces the old top-right header actions so the user
 * never has to scroll back up to know what's still missing.
 *
 * `cancelSlot` lets the caller render Cancel as a `<Link>`-rendered button
 * (TanStack Router) instead of relying on `onCancel`.
 */
export function RuleActionBar({
	editing,
	saving,
	validationIssues,
	onCancel,
	onSave,
	onShowTemplates,
	cancelSlot,
}: RuleActionBarProps) {
	const ready = validationIssues.length === 0
	const visibleIssues = validationIssues.slice(0, MAX_VISIBLE_ISSUES)
	const hiddenCount = validationIssues.length - visibleIssues.length

	return (
		<div
			// Sticky inside PageLayout.ScrollArea — works because SidebarInset
			// now has `min-h-0`, so the height chain
			// SidebarProvider → SidebarInset → PageLayout.Root → PageLayout.Body
			// → PageLayout.Content → PageLayout.ScrollArea constrains the
			// scroll-area to the viewport. The action bar is rendered as the
			// last child inside the scroll area and pins to its bottom edge.
			className={cn(
				"sticky bottom-0 z-20 -mx-4 -mb-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80",
			)}
		>
			<div className={cn("mx-auto flex items-center justify-between gap-4", RULE_FORM_MAX_WIDTH)}>
				<div className="flex min-w-0 items-center gap-3">
					{onShowTemplates && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={onShowTemplates}
							className="hidden sm:inline-flex"
						>
							<SquareTerminalIcon size={14} />
							Templates
						</Button>
					)}
					<ValidationSummary
						ready={ready}
						visibleIssues={visibleIssues}
						hiddenCount={hiddenCount}
						fullList={validationIssues}
					/>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{cancelSlot ?? (
						<Button type="button" variant="outline" onClick={onCancel}>
							Cancel
						</Button>
					)}
					<Button type="button" onClick={onSave} disabled={!ready || saving}>
						{saving ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : (
							<FloppyDiskIcon size={14} />
						)}
						{editing ? "Save changes" : "Create rule"}
					</Button>
				</div>
			</div>
		</div>
	)
}

function ValidationSummary({
	ready,
	visibleIssues,
	hiddenCount,
	fullList,
}: {
	ready: boolean
	visibleIssues: string[]
	hiddenCount: number
	fullList: string[]
}) {
	if (ready) {
		return (
			<span className="flex items-center gap-1.5 text-xs text-success-foreground">
				<CheckIcon size={14} />
				Ready to save
			</span>
		)
	}
	const summary = visibleIssues.join(", ") + (hiddenCount > 0 ? ` +${hiddenCount} more` : "")
	return (
		<span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground")}>
			<CircleWarningIcon size={14} className="shrink-0 text-warning" />
			<span className="truncate">
				Missing: <span className="text-foreground">{summary}</span>
			</span>
			{hiddenCount > 0 && (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								className="rounded-sm px-1 text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
							/>
						}
					>
						details
					</TooltipTrigger>
					<TooltipPopup>
						<ul className="space-y-0.5 text-xs">
							{fullList.map((issue) => (
								<li key={issue}>• {issue}</li>
							))}
						</ul>
					</TooltipPopup>
				</Tooltip>
			)}
		</span>
	)
}
