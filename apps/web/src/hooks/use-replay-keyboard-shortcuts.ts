import * as React from "react"
import { useReplayPlayer } from "@/components/replays/replay-player-context"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"

/** Arrow-key seek step, in display ms. */
const SEEK_STEP_MS = 5000

/**
 * Page-wide keyboard transport for the replay player:
 * - Space → play/pause (from anywhere on the page)
 * - Left / Right → seek ∓ {@link SEEK_STEP_MS}
 *
 * Mount once inside a {@link useReplayPlayer} provider. Guards against typing
 * in text fields and open dialogs (see `@maple/ui/lib/keyboard`).
 */
export function useReplayKeyboardShortcuts(): void {
	const { togglePlay, seekRelativeDisplay } = useReplayPlayer()

	const handleKeyDown = React.useEffectEvent((e: KeyboardEvent) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return
		if (isEditableTarget(e.target)) return
		if (isDialogOpen()) return

		switch (e.code) {
			case "Space": {
				e.preventDefault() // otherwise the page scrolls
				togglePlay()
				break
			}
			case "ArrowLeft": {
				e.preventDefault()
				seekRelativeDisplay(-SEEK_STEP_MS)
				break
			}
			case "ArrowRight": {
				e.preventDefault()
				seekRelativeDisplay(SEEK_STEP_MS)
				break
			}
		}
	})

	useMountEffect(() => {
		// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
		const listener = (event: KeyboardEvent) => handleKeyDown(event)
		window.addEventListener("keydown", listener)
		return () => window.removeEventListener("keydown", listener)
	})
}
