import { useState } from "react"

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
 */
export function usePageScrollMargin() {
	const [list, setList] = useState<HTMLElement | null>(null)
	const scroller = list?.closest<HTMLElement>('[data-slot="page-scroll-area"]') ?? null

	return {
		/** Put this on the element the virtual rows are positioned inside. */
		ref: setList,
		getScrollElement: () => scroller ?? list,
		scrollMargin:
			list === null || scroller === null
				? 0
				: Math.max(
						0,
						Math.round(
							list.getBoundingClientRect().top -
								scroller.getBoundingClientRect().top +
								scroller.scrollTop,
						),
					),
	}
}
