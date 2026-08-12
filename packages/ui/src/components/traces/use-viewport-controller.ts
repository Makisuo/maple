import * as React from "react"

import { clampViewport, viewportBounds } from "./clamp-viewport"
import type { ViewportState } from "./trace-timeline-types"

/**
 * The visible time window, held in a ref rather than React state.
 *
 * Every pan and zoom frame used to be a `dispatch`, which re-rendered the whole timeline
 * subtree — rows, minimap (one node per span, unvirtualized), ruler and all. Here the window
 * lives in a ref and reaches the DOM two ways:
 *
 *  1. **Time surfaces** — elements carrying `--vp0`/`--vpk`, from which every span bar derives
 *     its own position in pure CSS. A gesture writes two custom properties per surface and the
 *     style engine repositions every bar. No React, no per-bar arithmetic.
 *  2. **Subscribers** — the minimap overlay, the ruler and the row decorations, notified on a
 *     single coalesced rAF so they can paint imperatively.
 *
 * Nothing here calls `setState`, so a wheel-zoom or a drag-pan produces **zero React commits**.
 */
export interface ViewportController {
	/** The current window. Reads the ref — always fresh, never a stale closure. */
	get(): ViewportState
	/** Commit a window: clamp, write the CSS vars, notify subscribers. */
	set(vp: ViewportState): void
	/** Zoom about a fixed time; `factor > 1` zooms in. */
	zoomAt(centerMs: number, factor: number): void
	panBy(deltaMs: number): void
	/** Zoom to exactly this range (either argument order). */
	zoomToRange(startMs: number, endMs: number): void
	/** Eased zoom to a span's extent plus 10% breathing room. */
	zoomToSpan(startMs: number, endMs: number): void
	/** Fit the whole trace. */
	fit(): void
	/** Eased commit over `durationMs`; cancels any tween already in flight. */
	animateTo(vp: ViewportState, durationMs?: number): void
	/** Cancel an in-flight tween — direct gestures must win over an animation. */
	cancelAnimation(): void
	subscribe(cb: (vp: ViewportState) => void): () => void
	/**
	 * Register an element to carry `--vp0`/`--vpk`. Returns an unbind function; pass `null`
	 * to unbind. Safe to call from a ref callback.
	 */
	bindTimeSurface(el: HTMLElement | null): () => void
	/** Trace bounds, so consumers can convert between time and trace fractions. */
	readonly traceStartMs: number
	readonly traceEndMs: number
}

/**
 * Write the window onto a time surface.
 *
 * `--vp0` is the window start in **trace-relative** ms and `--vpk` is `100 / visibleMs`, so a
 * bar at `--b0` resolves to `calc((var(--b0) - var(--vp0)) * var(--vpk) * 1%)`.
 *
 * Two deliberate choices, both load-bearing:
 *
 *  - **Trace-relative, not epoch.** Epoch ms are ~1.7e12 and would swamp the interesting digits
 *    in DevTools; trace-relative values read as "1234.5" and are debuggable by eye.
 *  - **Never register these with `@property`.** An unregistered custom property substitutes as
 *    raw tokens, so the enclosing `calc()` is re-parsed and evaluated in `double`. Registering
 *    them as `<number>` stores a float32 instead, and at a 0.1ms window float32 rounding on
 *    `var(--b0) - var(--vp0)` lands the bar tens of percent away from where it belongs.
 */
function writeTimeSurface(el: HTMLElement, vp: ViewportState, traceStartMs: number): void {
	const visible = vp.endMs - vp.startMs
	el.style.setProperty("--vp0", String(vp.startMs - traceStartMs))
	el.style.setProperty("--vpk", String(visible > 0 ? 100 / visible : 0))
}

export interface UseViewportControllerOptions {
	traceStartMs: number
	traceEndMs: number
	/** Window to (re)start at. Re-applied whenever its identity changes, i.e. on a new trace. */
	initialViewport: ViewportState
}

export function useViewportController({
	traceStartMs,
	traceEndMs,
	initialViewport,
}: UseViewportControllerOptions): ViewportController {
	const viewportRef = React.useRef<ViewportState>(initialViewport)
	const surfacesRef = React.useRef<Set<HTMLElement>>(new Set())
	const subscribersRef = React.useRef<Set<(vp: ViewportState) => void>>(new Set())
	const notifyRafRef = React.useRef(0)
	const animRafRef = React.useRef(0)

	// Bounds are read inside stable callbacks, so they go through refs rather than closures.
	const boundsRef = React.useRef({ traceStartMs, traceEndMs })
	boundsRef.current = { traceStartMs, traceEndMs }

	const controller = React.useMemo<ViewportController>(() => {
		const notify = () => {
			if (notifyRafRef.current !== 0) return
			notifyRafRef.current = requestAnimationFrame(() => {
				notifyRafRef.current = 0
				const vp = viewportRef.current
				for (const cb of subscribersRef.current) cb(vp)
			})
		}

		const set = (vp: ViewportState) => {
			const { traceStartMs: lo, traceEndMs: hi } = boundsRef.current
			const clamped = clampViewport(vp, lo, hi)
			viewportRef.current = clamped
			for (const el of surfacesRef.current) writeTimeSurface(el, clamped, lo)
			notify()
		}

		const cancelAnimation = () => {
			cancelAnimationFrame(animRafRef.current)
			animRafRef.current = 0
		}

		const self: ViewportController = {
			get: () => viewportRef.current,
			set,
			zoomAt: (centerMs, factor) => {
				const vp = viewportRef.current
				const current = vp.endMs - vp.startMs
				const next = current / factor
				const ratio = (centerMs - vp.startMs) / current
				const startMs = centerMs - ratio * next
				set({ startMs, endMs: startMs + next })
			},
			panBy: (deltaMs) => {
				const vp = viewportRef.current
				set({ startMs: vp.startMs + deltaMs, endMs: vp.endMs + deltaMs })
			},
			zoomToRange: (a, b) => set({ startMs: Math.min(a, b), endMs: Math.max(a, b) }),
			zoomToSpan: (startMs, endMs) => {
				const padding = Math.max((endMs - startMs) * 0.1, 0.001)
				// Eased: a jump straight to a µs-wide span loses all sense of where it sat.
				self.animateTo({ startMs: startMs - padding, endMs: endMs + padding }, 220)
			},
			fit: () => {
				// Exactly the navigable bounds — the same span the minimap strip draws — so a
				// fitted timeline and the strip share one coordinate space and line up. Eased,
				// because every caller (the Fit button, `F`, minimap double-click) wants that.
				const { traceStartMs: lo, traceEndMs: hi } = boundsRef.current
				const { loMs, hiMs } = viewportBounds(lo, hi)
				self.animateTo({ startMs: loMs, endMs: hiMs }, 220)
			},
			animateTo: (target, durationMs = 160) => {
				cancelAnimation()
				const { traceStartMs: lo, traceEndMs: hi } = boundsRef.current
				const to = clampViewport(target, lo, hi)
				const from = viewportRef.current
				const t0 = performance.now()
				const step = (now: number) => {
					const t = Math.min(1, (now - t0) / durationMs)
					const k = Math.sin((t * Math.PI) / 2) // easeOutSine
					set({
						startMs: from.startMs + (to.startMs - from.startMs) * k,
						endMs: from.endMs + (to.endMs - from.endMs) * k,
					})
					animRafRef.current = t < 1 ? requestAnimationFrame(step) : 0
				}
				animRafRef.current = requestAnimationFrame(step)
			},
			cancelAnimation,
			subscribe: (cb) => {
				subscribersRef.current.add(cb)
				// Prime the subscriber so it paints from the current window rather than waiting
				// for the next gesture — matters for a freshly mounted minimap or ruler.
				cb(viewportRef.current)
				return () => {
					subscribersRef.current.delete(cb)
				}
			},
			bindTimeSurface: (el) => {
				if (!el) return () => {}
				surfacesRef.current.add(el)
				writeTimeSurface(el, viewportRef.current, boundsRef.current.traceStartMs)
				return () => {
					surfacesRef.current.delete(el)
				}
			},
			get traceStartMs() {
				return boundsRef.current.traceStartMs
			},
			get traceEndMs() {
				return boundsRef.current.traceEndMs
			},
		}
		return self
		// Identity must never change: native listeners and subscribers bind to it once.
	}, [])

	// A new trace (or a recomputed default window) resets the viewport. Runs as a layout effect
	// so the first paint of the new trace already carries the right CSS vars.
	React.useLayoutEffect(() => {
		controller.cancelAnimation()
		controller.set(initialViewport)
	}, [controller, initialViewport])

	// Cancelling is not enough: `notify()` treats a non-zero id as "a frame is already
	// scheduled" and skips, so leaving a cancelled id behind wedges every later
	// notification. Under StrictMode's mount/unmount/remount that happens on the first
	// paint, and the ruler and minimap simply stop updating for the rest of the session.
	React.useEffect(
		() => () => {
			cancelAnimationFrame(notifyRafRef.current)
			notifyRafRef.current = 0
			cancelAnimationFrame(animRafRef.current)
			animRafRef.current = 0
		},
		[],
	)

	return controller
}
