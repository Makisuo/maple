"use client"

import type { ComponentProps } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@/lib/utils"
import { useCallback } from "react"

export type SuggestionsProps = ComponentProps<"div">

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
	<div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
		{children}
	</div>
)

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
	suggestion: string
	onClick?: (suggestion: string) => void
}

/**
 * A one-line pill. Deliberately not a wrapping one: this previously set
 * `h-auto … whitespace-normal`, and `twMerge` does resolve `h-auto` against the
 * `h-8` in `buttonVariants({size:"sm"})` — but that variant also carries
 * `sm:h-7`, which is a *different* modifier group and survives the merge. Above
 * 640px the pill stayed locked at 1.75rem while its text wrapped freely, so long
 * suggestions spilled over the border and collided with the row below.
 *
 * So the height belongs to the size variant and the text truncates instead. The
 * cap is a backstop — a suggestion long enough to reach it is a generator bug
 * (see `investigationSuggestions`), not something to design around.
 */
export const Suggestion = ({
	suggestion,
	onClick,
	className,
	variant = "outline",
	size = "sm",
	children,
	...props
}: SuggestionProps) => {
	const handleClick = useCallback(() => {
		onClick?.(suggestion)
	}, [onClick, suggestion])

	return (
		<Button
			className={cn("max-w-[min(100%,24rem)] cursor-pointer rounded-full px-3.5", className)}
			onClick={handleClick}
			size={size}
			title={children ? undefined : suggestion}
			type="button"
			variant={variant}
			{...props}
		>
			<span className="min-w-0 truncate">{children || suggestion}</span>
		</Button>
	)
}
