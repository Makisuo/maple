import { useLayoutEffect, useState } from "react"

/**
 * Virtualizer wiring for a list that rides the page's own scroller
 * (`PageLayout.ScrollArea`) rather than an inner one.
 *
 * The margin is measured from rects, not `offsetTop`: `offsetTop` resolves
 * against the nearest positioned ancestor, which on these pages is the layout
 * shell above the scroller, not the scroller itself — measured ~200px high on
 * /replays, previously masked by overscan. Clamped at zero so a hidden
 * ancestor (rects collapse to 0) can never produce a negative margin, and the
 * scroll element falls back to the list itself outside a page layout (a bare
 * render in tests) so the virtualizer still mounts rows there; both production
 * callers sit inside a `PageLayout.ScrollArea`.
 *
 * It is measured in a layout effect and re-measured on resize rather than read
 * during render, because the margin is a fact about a layout that does not
 * exist yet on the render that mounts the list. Reading it during render pins
 * whatever the page looked like at that instant — on the agent-session page,
 * the list's position while the view it replaced was still on screen — and the
 * virtualizer then draws only the rows it believes are inside the viewport from
 * there, leaving the bottom of the screen blank until a scroll or resize
 * happens to recompute the range. Publishing it as state means the settled
 * layout, and every later change above the list (a banner appearing, a toolbar
 * wrapping), re-renders the list with a margin that matches the DOM.
 */
export function usePageScrollMargin() {
	const [list, setList] = useState<HTMLElement | null>(null)
	const scroller = list?.closest<HTMLElement>('[data-slot="page-scroll-area"]') ?? null
	const [scrollMargin, setScrollMargin] = useState(0)

	useLayoutEffect(() => {
		if (list === null || scroller === null) return
		// Same number in, no re-render out: React bails out of an identical
		// state, so the observer firing on every scroll-driven reflow is free.
		const measure = () => setScrollMargin(marginBetween(list, scroller))
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(list)
		observer.observe(scroller)
		return () => observer.disconnect()
	}, [list, scroller])

	return {
		/** Put this on the element the virtual rows are positioned inside. */
		ref: setList,
		getScrollElement: () => scroller ?? list,
		scrollMargin,
	}
}

function marginBetween(list: HTMLElement, scroller: HTMLElement): number {
	return Math.max(
		0,
		Math.round(
			list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
		),
	)
}
