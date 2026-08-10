import { Marker, MarkerContent, MarkerIcon } from "@maple/ui/components/ui/marker"
import { cn } from "@maple/ui/lib/utils"
import { ThinkingOrbIcon } from "./thinking-orb-icon"

interface StatusMarkerProps {
	children?: string
	className?: string
}

/**
 * The live "the agent is working" row. It is a `Marker`, not a `Message`: it has no
 * turn of its own, so rendering it as an assistant message made screen readers
 * announce a reply that hadn't arrived and left an empty bubble behind once it did.
 *
 * It shows only when nothing else in the turn is live — before the first token, and in
 * the gap between a settled tool burst and the prose that follows. While a tool is
 * running, that tool's own row or group header carries the orb instead, so the state is
 * always `breathing`: the model is thinking, not doing something nameable. See
 * `showsThinkingRow` in `chat-transcript.tsx`.
 *
 * `MarkerIcon` otherwise forces `size-3.5` on its child, but the orb only ships 20px and
 * 64px presets, so the slot is widened rather than scaling a preset it wasn't tuned for.
 *
 * Both animations here stay off the React streaming path: `shimmer` is the CSS utility from
 * `@maple/ui/styles/shadcn-utilities.css` (it sweeps `currentColor`, so it inherits the
 * marker's muted tone), and the orb paints to its own canvas from a `requestAnimationFrame`
 * loop React never re-enters. Both respect `prefers-reduced-motion` — the orb by painting a
 * single static frame.
 */
export function StatusMarker({ children = "Thinking…", className }: StatusMarkerProps) {
	return (
		<Marker className={cn("text-sm", className)} role="status">
			<MarkerIcon className="size-5">
				<ThinkingOrbIcon state="breathing" />
			</MarkerIcon>
			<MarkerContent className="shimmer">{children}</MarkerContent>
		</Marker>
	)
}
