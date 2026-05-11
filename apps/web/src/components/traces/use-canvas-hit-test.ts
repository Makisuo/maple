import * as React from "react"
import type { BarRect } from "./trace-timeline-types"

export interface HitTestApi {
	barRectsRef: React.MutableRefObject<BarRect[]>
	findBarAt: (cssX: number, cssY: number) => BarRect | null
}

/**
 * Maintains the rect array exposed by drawMain and provides O(visible-rows) hit-testing.
 * Bars are non-overlapping in y so a single linear scan suffices for typical visible counts.
 */
export function useCanvasHitTest(): HitTestApi {
	const barRectsRef = React.useRef<BarRect[]>([])

	const findBarAt = React.useCallback((cssX: number, cssY: number) => {
		const arr = barRectsRef.current
		for (let i = arr.length - 1; i >= 0; i--) {
			const r = arr[i]
			if (cssX >= r.x && cssX <= r.x + r.w && cssY >= r.y && cssY <= r.y + r.h) return r
		}
		return null
	}, [])

	return { barRectsRef, findBarAt }
}
