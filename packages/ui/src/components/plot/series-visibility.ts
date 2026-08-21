import { useCallback, useMemo, useState } from "react"

/**
 * Which series a legend click has removed, and the filtered view of the data
 * that follows from it.
 *
 * **This is the restack contract.** `@tanstack/charts` ships
 * `interactiveColorLegend`, whose `filterMark` hook runs on the RESOLVED SCENE —
 * `filterMarkSceneByPoint` is applied at `scene.js:137`, after `stackValues` has
 * already assigned every segment its y1/y2 and after the y domain has been
 * inferred. Hiding the bottom band of a stack therefore deletes its rects and
 * leaves the survivors floating at their old offsets, with a hole on the
 * baseline and an axis that does not rescale. Its sibling `seriesVisible` is
 * explicit about the same thing: it "keeps hidden series in scale inference
 * while removing their scene output", which is right for a colour scale and
 * wrong for a y axis.
 *
 * Recharts got the restack for free because `<Bar hide>` removed the series
 * before layout. The equivalent here is to filter the DATA, above
 * `defineChart` — so stacks and the domain are computed from the visible series
 * only. Every chart with a hiding legend must run this order:
 *
 *   1. normalise rows + series definitions
 *   2. unit conversion
 *   3. compute stats over ALL keys        ← before the filter, so a hidden
 *                                            series keeps its legend row and can
 *                                            be brought back
 *   4. `visibleSeries` from this hook
 *   5. long-form rows from the visible series only (stacked charts)
 *   6. `stack()` / `barY`'s `z` sees only those      → stacks recompute
 *   7. `linearYDomain({ keys: visible })`            → domain recomputes
 *   8. marks map over the visible series             → a hidden series emits no
 *                                                      mark at all
 */
export function useSeriesVisibility<T extends { key: string }>(series: ReadonlyArray<T>) {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())

	/**
	 * The floor lives HERE, in the state transition, not in the derived view.
	 *
	 * An empty plot with a collapsed axis reads as a broken chart rather than as a
	 * choice, so the last visible series cannot be hidden. Enforcing that on
	 * `visible` instead — by painting every series again once `hidden` covered them
	 * all — made the chart and its legend assert opposite things: the plot showed
	 * three lines while all three legend rows were dimmed and struck through. The
	 * legend renders `hidden` directly, so `hidden` is what has to stay honest, and
	 * the only way to keep it honest is to never let it reach a state the plot
	 * refuses to draw. A refused click is a no-op the legend can't misreport.
	 */
	const toggle = useCallback(
		(key: string) => {
			setHidden((previous) => {
				if (previous.has(key)) {
					const next = new Set(previous)
					next.delete(key)
					return next
				}
				// Counted over `series` rather than over set sizes: `hidden` can outlive
				// a series (a query change swaps the keys) and a stale key must not be
				// mistaken for one of the survivors.
				const remaining = series.filter(
					(entry) => entry.key !== key && !previous.has(entry.key),
				).length
				if (remaining === 0) return previous
				const next = new Set(previous)
				next.add(key)
				return next
			})
		},
		[series],
	)

	const visible = useMemo(() => {
		if (hidden.size === 0) return series
		return series.filter((entry) => !hidden.has(entry.key))
	}, [series, hidden])

	const visibleKeys = useMemo(() => visible.map((entry) => entry.key), [visible])

	return { hidden, toggle, visible, visibleKeys }
}
