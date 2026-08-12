import * as React from "react"

import type { ViewportController } from "./use-viewport-controller"

/**
 * The two bits of span-bar chrome CSS can't derive on its own.
 *
 * Everything else about a bar — position, width, which labels fit — is expressed in custom
 * properties and container queries, so the style engine handles it during a gesture. These two
 * need to know whether the `clamp()` in the bar's `left`/`right` actually bit, which is a
 * comparison CSS has no way to make:
 *
 *   - the `‹`/`›` chevrons marking a bar that continues past the visible window;
 *   - which side an outside label goes on, when the bar is too narrow to hold one.
 *
 * So one pass over the ~40 mounted rows per viewport frame, reading each bar's `--b0`/`--b1`
 * back out and toggling attributes. No React, no per-bar layout reads (nothing here calls
 * `getBoundingClientRect`), so it can't force a reflow.
 */
export function useRowDecorations(
	controller: ViewportController,
	rowsRef: React.RefObject<HTMLElement | null>,
): () => void {
	const paintRef = React.useRef<() => void>(() => {})

	React.useEffect(() => {
		const paint = (vp: { startMs: number; endMs: number }) => {
			const root = rowsRef.current
			if (!root) return
			const vp0 = vp.startMs - controller.traceStartMs
			const visible = vp.endMs - vp.startMs
			if (!(visible > 0)) return
			const k = 100 / visible

			for (const bar of root.querySelectorAll<HTMLElement>("[data-span-bar]")) {
				const b0 = Number(bar.style.getPropertyValue("--b0"))
				const b1 = Number(bar.style.getPropertyValue("--b1"))
				if (!Number.isFinite(b0) || !Number.isFinite(b1)) continue

				const leftPct = (b0 - vp0) * k
				const rightPct = (b1 - vp0) * k

				const cell = bar.parentElement
				if (cell) {
					const clipL = cell.querySelector<HTMLElement>("[data-clip-left]")
					const clipR = cell.querySelector<HTMLElement>("[data-clip-right]")
					if (clipL) clipL.style.display = leftPct < 0 ? "block" : "none"
					if (clipR) clipR.style.display = rightPct > 100 ? "block" : "none"
				}

				const label = bar.querySelector<HTMLElement>("[data-outside-label]")
				if (label) {
					// A bar entirely outside the window still has a clamped rect, so its label
					// could otherwise drift into view with nothing attached to it.
					const offscreen = leftPct > 100 || rightPct < 0
					label.style.visibility = offscreen ? "hidden" : ""
					// Right by default; flip left only when the tail is close enough to the right
					// edge that the label would be clipped, and there is room on the left.
					if (rightPct >= 70 && leftPct > 30) label.dataset.side = "left"
					else delete label.dataset.side
				}
			}
		}
		paintRef.current = () => paint(controller.get())
		return controller.subscribe(paint)
	}, [controller, rowsRef])

	// Scrolling mounts fresh rows whose chevrons and label side were never computed — the
	// viewport hasn't moved, so no subscriber fires. Callers re-run the pass after a row render.
	return React.useCallback(() => paintRef.current(), [])
}
