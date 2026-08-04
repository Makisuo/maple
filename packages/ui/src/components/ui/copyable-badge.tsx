"use client"

import type { ReactNode } from "react"

import type { VariantProps } from "class-variance-authority"

import { useCopy } from "../../hooks/use-copy"
import { cn } from "../../lib/utils"
import { badgeVariants } from "./badge"
import { copyTooltipText } from "./copy-button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip"

export interface CopyableBadgeProps {
	/** The full value written to the clipboard (may differ from the displayed children). */
	value: string
	/** What the badge displays — defaults to the value. */
	children?: ReactNode
	/** Human label for the thing being copied, e.g. "trace ID" or "commit SHA". */
	label: string
	variant?: VariantProps<typeof badgeVariants>["variant"]
	size?: VariantProps<typeof badgeVariants>["size"]
	className?: string
}

export function CopyableBadge({
	value,
	children,
	label,
	variant = "outline",
	size = "default",
	className,
}: CopyableBadgeProps) {
	// The badge *is* the affordance — there's no room for a status glyph, so the
	// tooltip carries the feedback (hence `useCopy` rather than `CopyButton`).
	const { copy, status } = useCopy({ label })

	return (
		<Tooltip>
			<TooltipTrigger
				render={<button type="button" />}
				onClick={() => void copy(value)}
				aria-label={`Copy ${label}`}
				className={cn(badgeVariants({ variant, size }), "max-w-full", className)}
			>
				{children ?? value}
			</TooltipTrigger>
			<TooltipPopup>{copyTooltipText(status, label)}</TooltipPopup>
		</Tooltip>
	)
}
