import type { ConfiguredScaleLike } from "@tanstack/charts"

/**
 * A base-10 log scale, hand-rolled against `ConfiguredScaleLike<number>`.
 *
 * **`@tanstack/charts-scales@0.14.0` has no log scale.** It ships `band`,
 * `linear`, `ordinal` and `point` — that is the whole list — so every chart in
 * this lab that needs one has to bring it. `d3-scale@4.0.2` IS in the bun store
 * (transitively, via Recharts), but it is not a dependency of `apps/web` and
 * `require.resolve` fails from there, so importing it would mean adding one.
 *
 * It turns out none is needed. The contract the runtime actually exercises
 * (`dist/configured-scale.js`) is small: callable, `copy()`, `domain()`,
 * `range(pixels)`, and optionally `ticks()` / `tickFormat()` / `invert()`.
 *
 * Three constraints the runtime imposes and this honours:
 *
 * - It is an INSTANCE, not a factory. `isScaleFactory()` is literally
 *   `typeof source === "function" && !("copy" in source)`, so anything with a
 *   `copy` method keeps its configured domain instead of inferring one. That is
 *   wanted here — a log axis has no meaningful inferred zero floor — and it is
 *   the same factory-vs-instance distinction that silently renders an empty
 *   chart when `scaleLinear()` is passed by accident.
 * - **No `nice()`.** `applyScaleNice` throws `"This scale does not support
 *   nicening"` for a scale without one, so an axis using this must not set
 *   `nice`.
 * - `invert` is always provided, because the spatial transforms require it:
 *   `hexbin` bins in pixels and inverts each bin centre back into data space,
 *   and throws `"hexbin: x and y scales must support inversion"` otherwise.
 *
 * Absence of `bandwidth` is what marks it continuous; absence of a `base()`
 * method keeps it out of the log-domain inference validator, which only fires
 * for factories anyway.
 */
export interface LogScaleOptions {
	domain: readonly [number, number]
	/**
	 * `"decade"` puts a tick on each power of ten — right for counts, where the
	 * question is the order of magnitude. `"decade-mid"` adds the 3× point, which
	 * a duration axis needs because one tick per decade leaves most of the plot
	 * unlabelled.
	 */
	ticks?: "decade" | "decade-mid"
	format: (value: number) => string
}

export function createLogScale(options: LogScaleOptions): ConfiguredScaleLike<number> {
	const [lower, upper] = options.domain
	const logLower = Math.log10(lower)
	const logUpper = Math.log10(upper)
	const logSpan = logUpper - logLower
	const mantissas = options.ticks === "decade-mid" ? [1, 3] : [1]

	let low = 0
	let high = 1

	const map = (value: number): number | undefined => {
		if (!Number.isFinite(value) || value <= 0 || logSpan === 0) return undefined
		return low + ((Math.log10(value) - logLower) / logSpan) * (high - low)
	}

	const scale: ConfiguredScaleLike<number> = Object.assign(map, {
		copy: () => createLogScale(options),
		domain: (): readonly number[] => options.domain,
		range: (values: Iterable<number>): ConfiguredScaleLike<number> => {
			const bounds = [...values]
			low = bounds[0] ?? low
			high = bounds[1] ?? high
			return scale
		},
		invert: (position: number): number => {
			if (high === low) return lower
			return 10 ** (logLower + ((position - low) / (high - low)) * logSpan)
		},
		ticks: (): readonly number[] => {
			const values: number[] = []
			for (let exponent = Math.floor(logLower); exponent <= Math.ceil(logUpper); exponent++) {
				for (const mantissa of mantissas) {
					const value = mantissa * 10 ** exponent
					if (value >= lower && value <= upper) values.push(value)
				}
			}
			// A domain narrower than one tick step would otherwise draw a bare axis.
			if (values.length === 0) return [lower, upper]
			return values
		},
		tickFormat: () => options.format,
	})

	return scale
}
