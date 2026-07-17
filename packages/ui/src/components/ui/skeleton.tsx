import type React from "react"
import { cn } from "../../lib/utils"

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(
				// The sweep lives on a transform-animated pseudo-element so it stays on the
				// compositor — animating background-position on a `fixed`-attachment gradient
				// repaints every skeleton per frame and visibly lags busy loading screens.
				"relative isolate overflow-hidden rounded-sm bg-muted before:absolute before:inset-0 before:animate-skeleton before:[background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] [--skeleton-highlight:--alpha(var(--color-white)/64%)] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)] motion-reduce:before:animate-none",
				className,
			)}
			data-slot="skeleton"
			{...props}
		/>
	)
}
