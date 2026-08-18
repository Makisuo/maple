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
	softMin?: number
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

	let min = fitYAxisToData ? dataMin - (dataMax - dataMin) * FIT_PADDING_RATIO : 0
	let max = dataMax

	for (const threshold of thresholds ?? []) {
		if (!Number.isFinite(threshold.value)) continue
		if (threshold.value < min) min = threshold.value
		if (threshold.value > max) max = threshold.value
	}

	if (softMin != null && softMin < min) min = softMin
	if (softMax != null && softMax > max) max = softMax

	// A degenerate domain maps every value to the same pixel, so the series
	// collapses onto one line. Widen it rather than paint a flat chart.
	if (max <= min) max = min + 1

	return [min, max]
}

/**
 * A log y scale with its domain PINNED, floor at 1.
 *
 * The floor matters twice over: log is undefined at zero, and the library
 * validates an *inferred* log domain and throws when it includes or crosses zero
 * (`validateInferredLogDomain` in `scale-input.js`). Supplying an explicit
 * domain skips inference entirely, so the floor is ours to set — and counts,
 * which are the usual log series, are meaningfully floored at 1.
 */
export function logYScale(max: number) {
	return scaleLog().domain([1, Math.max(max, 10)])
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
