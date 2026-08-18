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

	const toggle = useCallback((key: string) => {
		setHidden((previous) => {
			const next = new Set(previous)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}, [])

	const visible = useMemo(() => {
		if (hidden.size === 0) return series
		const shown = series.filter((entry) => !hidden.has(entry.key))
		// Hiding the LAST visible series would leave an empty plot with a collapsed
		// axis, which reads as a broken chart rather than as a choice. Recharts had
		// the same floor.
		return shown.length === 0 ? series : shown
	}, [series, hidden])

	const visibleKeys = useMemo(() => visible.map((entry) => entry.key), [visible])

	return { hidden, toggle, visible, visibleKeys }
}
