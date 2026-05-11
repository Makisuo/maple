import * as React from "react"

export interface CrosshairApi {
	cursorXRef: React.MutableRefObject<number | null>
	setCursorX: (x: number | null) => void
}

/**
 * Holds the cursor's CSS-pixel X position in a ref so the overlay canvas can
 * redraw without forcing a React render. Consumers wire `setCursorX` to mouse
 * events and use the ref inside drawOverlay.
 */
export function useCanvasCrosshair(onChange: () => void): CrosshairApi {
	const cursorXRef = React.useRef<number | null>(null)

	const setCursorX = React.useCallback(
		(x: number | null) => {
			if (cursorXRef.current === x) return
			cursorXRef.current = x
			onChange()
		},
		[onChange],
	)

	return { cursorXRef, setCursorX }
}
