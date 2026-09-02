import type { ReactNode } from "react"

import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/lib/utils"

import { MagnifierIcon, XmarkIcon } from "@/components/icons"

/**
 * The row between a fleet band and its table: a search box, any pivot the
 * list carries beside it, and the count on the right.
 *
 * Every infra list drew this row by hand and no two agreed on the gap, the
 * input width or whether the count was tabular. One row, one shape.
 */
export function ListToolbar({
	value,
	onChange,
	placeholder,
	children,
	trailing,
	className,
}: {
	value: string
	onChange: (value: string) => void
	placeholder: string
	/** Controls beside the search — a kind pivot, a sort menu. */
	children?: ReactNode
	/** The count line, right-aligned. */
	trailing?: ReactNode
	className?: string
}) {
	return (
		<div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
			<div className="flex flex-wrap items-center gap-2">
				<InputGroup className="w-64">
					<InputGroupAddon>
						<MagnifierIcon />
					</InputGroupAddon>
					<InputGroupInput
						size="sm"
						placeholder={placeholder}
						value={value}
						onChange={(event) => onChange(event.target.value)}
					/>
					{value && (
						<InputGroupAddon align="inline-end">
							<InputGroupButton aria-label="Clear search" onClick={() => onChange("")}>
								<XmarkIcon />
							</InputGroupButton>
						</InputGroupAddon>
					)}
				</InputGroup>
				{children}
			</div>
			{trailing ? <span className="text-xs text-muted-foreground tabular-nums">{trailing}</span> : null}
		</div>
	)
}

/**
 * "Top 50 of 541 pods" when the page is a slice, "541 pods" when it is the
 * whole list. The count is the truth, not the page size.
 */
export function countLabel(shown: number, total: number, noun: string): string {
	const word = total === 1 ? noun : `${noun}s`
	return total > shown
		? `Top ${shown} of ${total.toLocaleString()} ${word}`
		: `${total.toLocaleString()} ${word}`
}
