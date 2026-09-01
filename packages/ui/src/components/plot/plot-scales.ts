import { scaleLinear as niceableScaleLinear } from "@tanstack/charts-scales/linear"
import { scaleLinear, scaleLog, scaleTime } from "d3-scale"

/**
 * Scales, and the three rules about them that are easy to get wrong.
 *
 * 1. **There is no zero anchor.** TanStack infers a linear domain from the data
 *    extent, so a latency chart whose p50 never drops below 40ms starts its axis
 *    at 40 and the p50 line hugs the floor. Recharts anchored numeric domains at
 *    zero, so every ported chart must state the domain explicitly. That is what
 *    `linearYDomain` is for, and why it is not optional.
 *
 * 2. **A scale FACTORY infers, a scale INSTANCE pins.** The library tests
 *    `typeof source === "function" && !("copy" in source)` — `copy` lives on the
 *    instance. So `scaleLog` (bare) has its domain inferred, and `scaleLog()`
 *    (called) keeps whatever domain you gave it. Every helper here returns an
 *    instance, deliberately.
 *
 * 3. **Use `scaleTime`, not `scaleUtc`.** Bucket labels are formatted in local
 *    time by `formatBucketLabel`; a UTC scale would place ticks against a
 *    different clock than the one printing them, so labels drift off their
 *    gridlines by the browser's offset.
 */

/** A threshold whose value has to stay inside the plot. */
export interface DomainThreshold {
	value: number
}

export interface LinearYDomainOptions {
	rows: ReadonlyArray<Record<string, unknown>>
	/** The series keys that are VISIBLE. Hidden series must not widen the axis. */
	keys: ReadonlyArray<string>
	/** Sums keys per row instead of taking each separately. */
	stacked?: boolean
	/** Start the axis at the data minimum (with padding) rather than at zero. */
	fitYAxisToData?: boolean
	/**
	 * A floor the axis takes *unless the data goes lower* — Grafana's soft-min,
	 * not a clamp.
	 *
	 * Soft, deliberately, and the persisted config settles the question: the
	 * widget schema carries `min`/`max` AND `softMin`/`softMax` as separate
	 * fields (`packages/widgets/src/dashboard/shared/display.ts`), which is only
	 * coherent if the soft pair yields to the data and the hard pair does not.
	 * The Recharts predecessor paired its bound with `allowDataOverflow`, which
	 * CLIPPED the overflowing part of the series; TanStack marks are not clipped
	 * (`clip` defaults to false at 0.16.0), so porting the clamp literally would
	 * paint the out-of-range part of the series over the axis labels instead of
	 * hiding it — the same defect as an unconditional zero floor.
	 *
	 * It still overrides both the zero anchor and `fitYAxisToData`, which is what
	 * makes it the stronger control that `ChartYAxisOptions` documents: a
	 * `softMin` of 40 over data that bottoms out at 40 moves the axis to 40.
	 */
	softMin?: number
	/** A ceiling the axis takes unless the data goes higher. See `softMin`. */
	softMax?: number
	/**
	 * Threshold values are unioned into the domain.
	 *
	 * Recharts had `ifOverflow="extendDomain"` on `<ReferenceLine>`; `ruleY` has
	 * no equivalent, so a threshold above the data would simply paint outside the
	 * plot (`clip` defaults to false, so it would not even be clipped — it would
	 * overlap the axis labels).
	 */
	thresholds?: ReadonlyArray<DomainThreshold>
}

/** How much headroom `fitYAxisToData` leaves around the data extent. */
const FIT_PADDING_RATIO = 0.1

/**
 * The explicit `[min, max]` a linear y axis must be given.
 *
 * Always returns a domain — there is no "let it infer" path, because inference
 * is the bug this exists to prevent.
 */
export function linearYDomain(options: LinearYDomainOptions): [number, number] {
	const { rows, keys, stacked, fitYAxisToData, softMin, softMax, thresholds } = options

	let dataMin = Number.POSITIVE_INFINITY
	let dataMax = Number.NEGATIVE_INFINITY

	for (const row of rows) {
		if (stacked) {
			let total = 0
			let sawValue = false
			for (const key of keys) {
				const value = row[key]
				if (typeof value === "number" && Number.isFinite(value)) {
					total += value
					sawValue = true
				}
			}
			if (!sawValue) continue
			if (total < dataMin) dataMin = total
			if (total > dataMax) dataMax = total
			continue
		}
		for (const key of keys) {
			const value = row[key]
			if (typeof value !== "number" || !Number.isFinite(value)) continue
			if (value < dataMin) dataMin = value
			if (value > dataMax) dataMax = value
		}
	}

	// No readings at all: a flat [0, 1] beats NaN, and matches what an empty
	// Recharts chart drew.
	if (dataMin === Number.POSITIVE_INFINITY) return [0, 1]

	// The zero anchor means ZERO IS IN THE DOMAIN, not "zero is the floor". Pinning
	// `min` to 0 outright dropped every negative reading below the axis — and
	// nothing clips it, so a period-comparison delta painted over the x tick
	// labels. `Math.min`/`Math.max` keep the anchor exactly where it earns its
	// keep (positive data starts at zero rather than floating) and let a series
	// that crosses or sits below zero describe its own floor, which is what
	// Recharts' `"auto"` did.
	let min = fitYAxisToData ? dataMin - (dataMax - dataMin) * FIT_PADDING_RATIO : Math.min(0, dataMin)
	let max = fitYAxisToData ? dataMax : Math.max(0, dataMax)

	// Applied against the DATA extent, before thresholds: a soft bound yields to
	// the data, so it replaces the base bound rather than only widening it (the
	// old `softMin < min` test could never fire against a zero floor and positive
	// data, which is how the setting came to do nothing at all).
	if (softMin != null && Number.isFinite(softMin)) min = Math.min(softMin, dataMin)
	if (softMax != null && Number.isFinite(softMax)) max = Math.max(softMax, dataMax)

	// Last, so a threshold outside every other bound still lands inside the plot.
	for (const threshold of thresholds ?? []) {
		if (!Number.isFinite(threshold.value)) continue
		if (threshold.value < min) min = threshold.value
		if (threshold.value > max) max = threshold.value
	}

	// A degenerate domain maps every value to the same pixel, so the series
	// collapses onto one line. Widen it rather than paint a flat chart.
	if (max <= min) max = min + 1

	return [min, max]
}

/**
 * The tick count a niced linear y axis rounds to.
 *
 * Pinned rather than left to the library because `resolveConfiguredScale` passes
 * its own `tickCount` as the nice count, and that count is derived from the
 * PIXEL HEIGHT of the plot (`resolveTickCount(definition.y, chart.height, 48, 7)`
 * in `scene.js`). A height-dependent nice count means the rounded domain this
 * module computes and the one the renderer computes agree only at some window
 * sizes. An axis that passes `nice: NICE_TICK_COUNT` gets the same number back.
 */
export const NICE_TICK_COUNT = 5

/**
 * The domain after `nice()` — the one the axis is actually drawn with.
 *
 * `resolveScaleInput` applies `nice()` to the resolved scale whether the domain
 * was inferred or PINNED, so a caller that hands over an explicit domain and
 * then reads that same domain back is describing an axis the renderer does not
 * draw. It matters because the returned domain is a data value, not decoration:
 * an area band fills from `domain[0]`, so a 41–97 series whose raw domain is
 * `[35.4, 97]` and whose drawn axis is `[30, 100]` leaves a blank strip beneath
 * the whole series, and `integerTickValues` computed off the raw domain can drop
 * the top gridline.
 *
 * Uses the renderer's own `scaleLinear` rather than d3's so the rounding is the
 * same implementation, not merely the same algorithm. Nicing is idempotent (both
 * iterate to a fixed point), so an axis may still declare `nice` on top of this.
 */
export function niceLinearDomain(
	[min, max]: readonly [number, number],
	count = NICE_TICK_COUNT,
): [number, number] {
	const niced = niceableScaleLinear().domain([min, max]).nice(count).domain()
	// `nice()` is a no-op on a degenerate domain, and a non-finite bound would
	// come back untouched too — keep the caller's domain rather than invent one.
	const [low, high] = niced
	return Number.isFinite(low) && Number.isFinite(high) && low !== high ? [low, high] : [min, max]
}

/**
 * The domain a log y axis gets, floor at 1.
 *
 * The floor matters twice over: log is undefined at zero, and the library
 * validates an *inferred* log domain and throws when it includes or crosses zero
 * (`validateInferredLogDomain` in `scale-input.js`). Supplying an explicit
 * domain skips inference entirely, so the floor is ours to set — and counts,
 * which are the usual log series, are meaningfully floored at 1.
 *
 * Separate from the scale below because a caller that fills from the axis floor
 * needs the number without building a scale to read it back off.
 *
 * The CEILING is only a degenerate-domain guard. It used to be `max(max, 10)`,
 * an undocumented full decade of dead headroom: a histogram whose tallest bucket
 * holds 3 rows drew that bucket at log(3)/log(10) ≈ 44% of the plot. The real
 * constraint is narrower — a log scale over `[1, 1]` divides by a zero span and
 * maps every value to NaN — so the guard only has to fire when `max` fails to
 * clear the floor. The Recharts predecessor's `[1, "auto"]` behaved this way.
 */
export function logYDomain(max: number): [number, number] {
	return [1, Number.isFinite(max) && max > 1 ? max : 10]
}

/** A log y scale with its domain PINNED — see `logYDomain`. */
export function logYScale(max: number) {
	return scaleLog().domain(logYDomain(max))
}

/** A linear y scale over an explicit domain. */
export function linearYScale(domain: [number, number]) {
	return scaleLinear().domain(domain)
}

/** The time scale for bucketed series — local, not UTC. See rule 3 above. */
export function bucketTimeScale(domain: [Date, Date]) {
	return scaleTime().domain(domain)
}

/**
 * Tick values for an axis that must not show fractions.
 *
 * There is no `allowDecimals` option. Counts rendered as `1.5 requests` are the
 * failure this prevents, and the only lever is to supply the tick values
 * outright (`axis.ticks.values`).
 */
export function integerTickValues([min, max]: readonly [number, number], desired = 5): number[] {
	const lo = Math.floor(min)
	const hi = Math.ceil(max)
	const span = hi - lo
	if (span <= 0) return [lo]

	// Round the step up to a whole number so every tick lands on an integer, then
	// walk the range. A step of 0 would loop forever.
	const step = Math.max(1, Math.ceil(span / Math.max(1, desired)))
	const values: number[] = []
	for (let value = lo; value <= hi; value += step) values.push(value)
	return values
}

/**
 * The share of the y domain a non-zero bar is guaranteed to paint.
 *
 * ~1.5% of a 200px plot is 3px — enough to see and to aim a pointer at, small
 * enough that it cannot be mistaken for a readable quantity.
 */
const MIN_BAR_FRACTION = 0.015

/**
 * A y accessor that floors a bar's painted length so a tiny value stays visible.
 *
 * There is no library lever for this at any version: `BarYOptions` carries
 * `inset`, `maxThickness` and `radius` — a maximum thickness, never a minimum
 * length — and a bucket holding 1 against a domain topping out at 40,000 maps to
 * a sub-pixel rect that paints as nothing. "No errors this hour" and "one error
 * this hour" then look identical, which is the reading that matters most.
 *
 * Three rules make the lift honest:
 *
 * 1. **`null` stays `null`.** `barY` skips a null y, and the stacked histograms
 *    rely on that to mask one lane while keeping both lanes' x channels
 *    identical (see `query-builder-bar-chart`). Lifting a null would paint a bar
 *    where the source reported nothing at all.
 * 2. **A true `0` stays `0`.** Zero is a real reading, and a floor under it
 *    would claim traffic that did not happen. Only a non-zero value that would
 *    round away is lifted.
 * 3. **The tooltip is unaffected.** This maps the CHANNEL, not the row: readers
 *    still get the raw number. The floor is a painting concession, and it must
 *    not survive into anything quoted back as data.
 *
 * Taken as a share of the domain rather than a pixel count so it composes with
 * `linearYDomain`/`niceLinearDomain` and holds at any plot height, and signed so
 * a negative series (a period-comparison delta) is floored away from zero rather
 * than flipped across it.
 */
export function minBarLength(
	[min, max]: readonly [number, number],
	fraction = MIN_BAR_FRACTION,
): (value: number | null) => number | null {
	const span = max - min
	const floor = Number.isFinite(span) && span > 0 ? span * fraction : 0
	return (value) => {
		if (value === null || !Number.isFinite(value) || value === 0 || floor === 0) return value
		if (value > 0) return Math.max(value, floor)
		return Math.min(value, -floor)
	}
}
