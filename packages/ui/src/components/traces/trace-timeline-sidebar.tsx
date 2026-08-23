import * as React from "react"

interface SidebarResizeHandleProps {
	/** Absolute x (px) of the sidebar/timeline boundary to sit on. */
	left: number
	onResize: (delta: number) => void
}

/**
 * Draggable divider on the sidebar/timeline boundary. Absolutely positioned at `left` within the
 * timeline body so it tracks the current sidebar width.
 */
export function SidebarResizeHandle({ left, onResize }: SidebarResizeHandleProps) {
	const startX = React.useRef<number | null>(null)

	// Pointer events with capture rather than window mouse listeners: the drag then survives the
	// cursor leaving the window or crossing an iframe, and a pen behaves like a mouse.
	const handlePointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return
		startX.current = e.clientX
		e.preventDefault()
		e.currentTarget.setPointerCapture(e.pointerId)
	}, [])

	const handlePointerMove = React.useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (startX.current == null) return
			const delta = e.clientX - startX.current
			startX.current = e.clientX
			onResize(delta)
		},
		[onResize],
	)

	const handlePointerUp = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		startX.current = null
		e.currentTarget.releasePointerCapture(e.pointerId)
	}, [])

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			// A 4px divider is a fine-pointer affordance; on touch it is unhittable and only
			// steals the pan gesture, and the column auto-fits the pane there anyway.
			className="absolute top-0 bottom-0 z-30 w-1 -ml-0.5 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 pointer-coarse:hidden"
			style={{ left }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		/>
	)
}
