import { Marker, MarkerContent, MarkerIcon } from "@maple/ui/components/ui/marker"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/utils"

interface StatusMarkerProps {
	children?: string
	className?: string
}

/**
 * The live "the agent is working" row. It is a `Marker`, not a `Message`: it has no
 * turn of its own, so rendering it as an assistant message made screen readers
 * announce a reply that hadn't arrived and left an empty bubble behind once it did.
 *
 * `shimmer` is the CSS utility from `@maple/ui/styles/shadcn-utilities.css` — it
 * sweeps `currentColor`, so it inherits the marker's muted tone and respects
 * `prefers-reduced-motion` without a motion component in the streaming path.
 */
export function StatusMarker({ children = "Thinking…", className }: StatusMarkerProps) {
	return (
		<Marker className={cn("text-sm", className)} role="status">
			<MarkerIcon>
				<Spinner className="size-3.5" />
			</MarkerIcon>
			<MarkerContent className="shimmer">{children}</MarkerContent>
		</Marker>
	)
}
