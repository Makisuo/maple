import type * as React from "react"

import { MinusIcon, PlusIcon, SquareMinusIcon, SquarePlusIcon } from "../icons"
import { Button } from "../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/**
 * One cell of the depth control. Icon-only: the four actions differ along a single axis, and a
 * tooltip naming the action plus its key teaches that faster than a label that only fits on
 * wide panes — the Waterfall's used to truncate to a bare "Expand", which reads as the
 * one-level action rather than the all-levels one it actually fires.
 */
function DepthButton({
	icon,
	label,
	shortcut,
	onClick,
}: {
	icon: React.ReactNode
	label: string
	shortcut?: string
	onClick: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						onClick={onClick}
						aria-label={label}
						className="h-5 w-6 rounded-[3px] p-0 text-muted-foreground hover:text-foreground pointer-coarse:h-7 pointer-coarse:w-8"
					>
						{icon}
					</Button>
				}
			/>
			{/* Below the trigger: these bars sit directly under the tab strip, and a top-side
			    tooltip would open behind it. */}
			<TooltipContent side="bottom" className="text-xs">
				{label}
				{shortcut && <span className="ml-1 text-muted-foreground">({shortcut})</span>}
			</TooltipContent>
		</Tooltip>
	)
}

interface TraceDepthControlsProps {
	onCollapseOneLevel: () => void
	onExpandOneLevel: () => void
	onCollapseAll: () => void
	onExpandAll: () => void
	/** Only the Timeline binds E / ⇧E, so only it advertises them. */
	showShortcuts?: boolean
}

/**
 * How deep the span tree is opened — four actions on one axis, so they read as one segmented
 * control rather than four loose buttons. The bare glyphs step a level, the boxed ones go all
 * the way; that rhyme is the whole distinction the "Expand all" / "Collapse all" labels used to
 * spell out, at a fraction of the width.
 *
 * Shared by the Timeline and the Waterfall so the same tree gets the same control in both, in
 * the same corner. Each view keeps its own state model and passes handlers in.
 */
export function TraceDepthControls({
	onCollapseOneLevel,
	onExpandOneLevel,
	onCollapseAll,
	onExpandAll,
	showShortcuts = false,
}: TraceDepthControlsProps) {
	return (
		<div className="flex items-center gap-px rounded-md bg-background/70 p-px">
			<DepthButton
				icon={<MinusIcon size={11} />}
				label="Collapse one level"
				shortcut={showShortcuts ? "⇧E" : undefined}
				onClick={onCollapseOneLevel}
			/>
			<DepthButton
				icon={<PlusIcon size={11} />}
				label="Expand one level"
				shortcut={showShortcuts ? "E" : undefined}
				onClick={onExpandOneLevel}
			/>
			<span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
			<DepthButton icon={<SquareMinusIcon size={11} />} label="Collapse all" onClick={onCollapseAll} />
			<DepthButton icon={<SquarePlusIcon size={11} />} label="Expand all" onClick={onExpandAll} />
		</div>
	)
}
