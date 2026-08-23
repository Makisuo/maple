import { useState } from "react"

/**
 * Virtualizer wiring for a list that rides the page's own scroller
 * (`PageLayout.ScrollArea`) rather than an inner one.
 *
 * The margin is measured from rects, not `offsetTop`: `offsetTop` resolves
 * against the nearest positioned ancestor, which on these pages is the layout
 * shell above the scroller, not the scroller itself. Outside a page layout (a
 * bare render in tests) the list stands in for the scroller and the margin is 0.
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
				: Math.round(
						list.getBoundingClientRect().top -
							scroller.getBoundingClientRect().top +
							scroller.scrollTop,
					),
	}
}
