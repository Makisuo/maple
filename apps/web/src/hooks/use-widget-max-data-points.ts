import * as React from "react"
import type { PanelType } from "@maple/domain/http"

/**
 * Widths are read in 100px steps so a drag-resize does not issue a fetch per
 * pixel and the params (= cache key) stay stable while a tile settles.
 */
export const WIDTH_STEP_PX = 100

/**
 * What a tile is assumed to be before it has been measured — a typical
 * full-width tile — so first paint does not fetch at one width and refetch at
 * another a frame later. Also the width the editor's "Auto (…)" placeholder
 * reads before the preview mounts.
 */
export const DEFAULT_WIDGET_WIDTH_PX = 800

/**
 * A bar needs a few pixels to read as a bar. Bars divide the width by this so a
 * 1400px chart asks for ~230 buckets, not 1400 hairlines. Grafana leaves this
 * to the user ("Max data points"); we derive it from the panel type instead.
 */
export const MIN_BAR_WIDTH_PX = 6

/** Round a measured width down to the step; `undefined` until measured. */
export function quantizeWidthPx(widthPx: number | undefined): number | undefined {
	if (widthPx === undefined || !Number.isFinite(widthPx) || widthPx <= 0) return undefined
	return Math.max(WIDTH_STEP_PX, Math.floor(widthPx / WIDTH_STEP_PX) * WIDTH_STEP_PX)
}

/**
 * The `maxDataPoints` a tile of `widthPx` should ask for. Grafana's rule is
 * one point per pixel; bars are the exception (see `MIN_BAR_WIDTH_PX`).
 */
export function maxDataPointsForWidth(widthPx: number, panelType: PanelType): number {
	const points = panelType === "bar" ? widthPx / MIN_BAR_WIDTH_PX : widthPx
	return Math.max(1, Math.floor(points))
}

/**
 * The element's quantized width, `undefined` until it has been measured.
 *
 * Measured synchronously up front — the ResizeObserver's initial delivery can
 * be throttled in background tabs, which would leave the tile on the default
 * width until the next real resize — then kept in step, one 100px step at a
 * time. Only a step change reaches state: an unchanged step is a no-op
 * re-render at most, never a new params blob.
 */
function useMeasuredWidthPx(ref: React.RefObject<HTMLElement | null>): number | undefined {
	const [widthPx, setWidthPx] = React.useState<number | undefined>(undefined)

	React.useEffect(() => {
		const element = ref.current
		if (!element) return

		setWidthPx(quantizeWidthPx(element.getBoundingClientRect().width))

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const next = quantizeWidthPx(entry.contentRect.width)
				setWidthPx((current) => (next === undefined ? current : next))
			}
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [ref])

	return widthPx
}

/**
 * Measure `ref` and turn its width into a quantized `maxDataPoints` for
 * `useWidgetData`. Returns the `DEFAULT_WIDGET_WIDTH_PX`-derived value until the
 * element has been measured.
 */
export function useWidgetMaxDataPoints(
	ref: React.RefObject<HTMLElement | null>,
	panelType: PanelType,
): number {
	const widthPx = useMeasuredWidthPx(ref)
	return maxDataPointsForWidth(widthPx ?? DEFAULT_WIDGET_WIDTH_PX, panelType)
}

/**
 * `useWidgetMaxDataPoints` without the default: `undefined` until the element
 * has actually been measured. For callers whose fetch is keyed on the value
 * and would otherwise pay one request at the default width and a second at
 * the real one — the share page's tiles, whose data is requested page-level as
 * soon as a tile reports.
 */
export function useMeasuredWidgetMaxDataPoints(
	ref: React.RefObject<HTMLElement | null>,
	panelType: PanelType,
): number | undefined {
	const widthPx = useMeasuredWidthPx(ref)
	return widthPx === undefined ? undefined : maxDataPointsForWidth(widthPx, panelType)
}
