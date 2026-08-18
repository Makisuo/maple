import * as React from "react"

export interface ContainerSize {
	width: number
	height: number
}

/**
 * Tracks the size of a container element using ResizeObserver.
 * On React Native, replace with an onLayout-based implementation.
 *
 * Sizes are ROUNDED to whole pixels and a tick that measures the same box
 * returns the previous object, so nothing downstream re-renders. This matters
 * because the measurement feeds chart definitions: `containerWidth` decides the
 * dot indexes, which are an input to the `definition` memo of the line and area
 * charts, so an unrounded, always-fresh object rebuilt the entire chart scene on
 * every sub-pixel reflow — every sidebar animation, window drag or flex
 * re-layout. `PlotFrame`'s `useMeasuredHeight` rounds and bails for exactly the
 * same reason; this is the same rule applied at the other measurement site.
 *
 * A whole pixel is the smallest step any consumer can act on: the value is used
 * for layout decisions (how many dots fit, how many columns, which breakpoint)
 * and ends up as a device-pixel coordinate regardless. No consumer compares it
 * to a fractional constant.
 */
export function useContainerSize(ref: React.RefObject<HTMLElement | null>): ContainerSize {
	const [size, setSize] = React.useState<ContainerSize>({ width: 0, height: 0 })

	React.useEffect(() => {
		const el = ref.current
		if (!el) return

		const apply = (width: number, height: number) => {
			const nextWidth = Math.round(width)
			const nextHeight = Math.round(height)
			setSize((previous) =>
				previous.width === nextWidth && previous.height === nextHeight
					? previous
					: { width: nextWidth, height: nextHeight },
			)
		}

		// Measure synchronously up front. ResizeObserver is specced to deliver an initial
		// callback, but that fire can be throttled (e.g. background tabs), which would leave
		// consumers stuck at 0 until the next real resize. Reading the box now avoids that.
		const rect = el.getBoundingClientRect()
		apply(rect.width, rect.height)

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				apply(entry.contentRect.width, entry.contentRect.height)
			}
		})

		observer.observe(el)
		return () => observer.disconnect()
	}, [ref])

	return size
}
