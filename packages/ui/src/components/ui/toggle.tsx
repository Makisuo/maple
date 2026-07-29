"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"

export const toggleVariants = cva(
	"relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base text-foreground outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-pressed:bg-input/64 data-pressed:text-accent-foreground sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
	{
		// Segments carry text, not a lone icon, so they need more horizontal room
		// than the base sizes give: those are tuned for square icon toggles, where
		// 5px of padding is correct. Inside a track that reads as cramped — the
		// label sits right against the pill's edge.
		compoundVariants: [
			{ class: "px-2.5", size: "sm", variant: "segment" },
			{ class: "px-3", size: "default", variant: "segment" },
			{ class: "px-3.5", size: "lg", variant: "segment" },
		],
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-9 min-w-9 px-[calc(--spacing(2)-1px)] sm:h-8 sm:min-w-8",
				lg: "h-10 min-w-10 px-[calc(--spacing(2.5)-1px)] sm:h-9 sm:min-w-9",
				sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7",
			},
			variant: {
				default: "border-transparent",
				outline:
					"border-input bg-background not-dark:bg-clip-padding shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:data-pressed:bg-input dark:hover:bg-input/64 dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] dark:not-disabled:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/2%)] [:disabled,:active,[data-pressed]]:shadow-none",
				/**
				 * A segment inside a `ToggleGroup`'s recessed track. It carries no
				 * border of its own — the track draws the single outer frame, and the
				 * selected segment reads as a raised pill lifted out of it. Selection
				 * is carried by surface + text color + weight together, so it survives
				 * both themes and reads at a glance in a row of four.
				 *
				 * Standalone toggles keep `outline` (they need their own frame); this
				 * variant is only meaningful with a track behind it.
				 */
				segment: cn(
					// One step tighter than the track's radius, so the pill nests inside
					// the frame instead of tracing the same curve as it.
					"rounded-md border-transparent bg-transparent font-normal text-muted-foreground shadow-none transition-colors",
					// Hover tints the label, not the surface: a background on hover
					// competes with the selected pill sitting right next to it.
					"hover:bg-transparent hover:text-foreground",
					"data-pressed:border-border/70 data-pressed:bg-background data-pressed:font-medium data-pressed:text-foreground data-pressed:shadow-sm",
					"dark:data-pressed:border-white/10 dark:data-pressed:bg-input dark:hover:bg-transparent",
				),
			},
		},
	},
)

export function Toggle({
	className,
	variant,
	size,
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>): React.ReactElement {
	return (
		<TogglePrimitive
			className={cn(toggleVariants({ className, size, variant }))}
			data-slot="toggle"
			{...props}
		/>
	)
}

export { TogglePrimitive }
