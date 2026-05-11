import { formatDuration } from "@/lib/format"

/**
 * Truncate text with ellipsis to fit within a maxWidth (in CSS pixels).
 * Returns the truncated string. Uses binary search over the text length
 * for O(log n) measurements per call.
 */
export function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ""
	if (ctx.measureText(text).width <= maxWidth) return text

	const ellipsis = "…"
	const ellipsisW = ctx.measureText(ellipsis).width
	if (ellipsisW >= maxWidth) return ""

	let lo = 0
	let hi = text.length
	let best = ""
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const candidate = text.slice(0, mid) + ellipsis
		const w = ctx.measureText(candidate).width
		if (w <= maxWidth) {
			best = candidate
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return best
}

/** Format a duration as a short pill label (e.g. "120ms", "1.20s"). */
export function formatTimePill(offsetMs: number): string {
	return formatDuration(offsetMs)
}

/** CSS pixel rounding for crisp 1px strokes. */
export function crisp(v: number): number {
	return Math.round(v) + 0.5
}

/** Theme-friendly oklch colors used by the canvas painter. */
export const CANVAS_COLORS = {
	gridLine: "oklch(0.5 0 0 / 0.05)",
	gridLineStrong: "oklch(0.5 0 0 / 0.08)",
	crosshair: "oklch(0.7 0 0 / 0.45)",
	crosshairPillBg: "oklch(0.22 0 0)",
	crosshairPillBorder: "oklch(0.4 0 0)",
	crosshairPillText: "oklch(0.96 0 0)",
	barLabel: "oklch(0.92 0 0 / 0.9)",
	barLabelMuted: "oklch(0.7 0 0 / 0.7)",
	focusRing: "oklch(0.78 0.16 250)",
	selectedRing: "oklch(0.7 0.18 250)",
	matchRing: "oklch(0.7 0.18 250 / 0.6)",
} as const

/**
 * Cheap binary lookup over a sorted ms array to find the smallest index with bar.startMs >= viewport.startMs.
 * Currently unused — bars are iterated row-by-row — but kept for potential future use when
 * bars become large and we want to seed the horizontal cull search.
 */
export function lowerBoundByStart<T extends { startMs: number }>(arr: T[], target: number): number {
	let lo = 0
	let hi = arr.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (arr[mid].startMs < target) lo = mid + 1
		else hi = mid
	}
	return lo
}
