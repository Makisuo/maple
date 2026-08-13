import type { ViewportState } from "./trace-timeline-types"
import { MIN_VISIBLE_ABS_MS } from "./trace-timeline-types"

/**
 * Slack past the *end* of the trace that the viewport can reach, as a fraction of its duration.
 *
 * Trailing only. The trace starts at zero and zero belongs hard against the left edge of the
 * column — a symmetric pad puts an empty strip in front of the first span, which just reads as
 * the waterfall being misaligned with its own ruler. The trailing slack earns its keep: the
 * duration labels on narrow bars render *outside* the bar to its right, and a span finishing at
 * the trace end would otherwise have its label clipped.
 */
const TRAILING_PADDING = 0.05

/**
 * The furthest the viewport can travel: the trace, plus a little slack after the last span.
 *
 * This — not `[traceStartMs, traceEndMs]` — is the timeline's coordinate space, and **anything
 * that has to line up with the timeline column must use it**. The minimap originally drew over
 * the bare trace while the ruler drew the (padded) viewport, so trace-zero sat at 0% of the strip
 * but several percent into the column; at full zoom-out the two disagreed by ~80px.
 */
export function viewportBounds(
	traceStartMs: number,
	traceEndMs: number,
): { loMs: number; hiMs: number; durationMs: number } {
	const loMs = traceStartMs
	const hiMs = traceEndMs + Math.max(0, traceEndMs - traceStartMs) * TRAILING_PADDING
	return { loMs, hiMs, durationMs: hiMs - loMs }
}

/**
 * Bound a candidate window to the trace.
 *
 * Its own module (rather than living in `use-trace-timeline`) so the viewport controller can
 * reach it without pulling in the layout hook and its React dependencies.
 */
export function clampViewport(vp: ViewportState, traceStartMs: number, traceEndMs: number): ViewportState {
	const { loMs: loBound, hiMs: hiBound, durationMs: boundWidth } = viewportBounds(traceStartMs, traceEndMs)

	// Absolute floor only — a proportional floor (traceDuration * k) makes long traces
	// un-zoomable: a 7-min trace would cap the window at tens of ms while the spans you're
	// trying to inspect are µs-scale, so zoom appears not to work. Span bars clamp their
	// rendered rect in CSS, so extreme zoom can't emit gigapixel nodes.
	const minDuration = MIN_VISIBLE_ABS_MS
	const maxDuration = Math.max(boundWidth, minDuration)

	const rawDuration = vp.endMs - vp.startMs
	const duration = Number.isFinite(rawDuration)
		? Math.max(minDuration, Math.min(rawDuration, maxDuration))
		: maxDuration

	// Window as wide as (or wider than) the padded trace → center it, so neither edge
	// clamp can push the other back out of bounds (degenerate/near-zero traces included).
	if (duration >= boundWidth) {
		const center = (loBound + hiBound) / 2
		return { startMs: center - duration / 2, endMs: center + duration / 2 }
	}

	// Right-clamp before left-clamp: min() first means the subsequent max() can only pull
	// the window right, never past hiBound (duration < boundWidth guarantees room).
	const startMs = Number.isFinite(vp.startMs)
		? Math.max(loBound, Math.min(vp.startMs, hiBound - duration))
		: loBound
	return { startMs, endMs: startMs + duration }
}
