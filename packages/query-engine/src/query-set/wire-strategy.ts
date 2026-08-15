import {
	type EmptyRangeFallbackStrategy,
	LAB_EMPTY_RANGE_STRATEGY,
	resolveFallbackStrategy,
} from "./bucketing"

/**
 * The empty-range strategy as it travels in widget params —
 * `{ enableEmptyRangeFallback, fallbackWindowSeconds, maxFallbackRangeSeconds }`.
 *
 * The wire names stay as they are: `planWidgetRequest` pins
 * `strategy: { enableEmptyRangeFallback: false }` on every widget fetch, and
 * renaming them would be a behaviour change dressed as a refactor.
 */
export interface WireFallbackStrategy {
	readonly enableEmptyRangeFallback?: boolean
	readonly fallbackWindowSeconds?: ReadonlyArray<number>
	readonly maxFallbackRangeSeconds?: number
}

/**
 * Wire shape → the runner's `EmptyRangeFallbackStrategy`, on top of the lab
 * ladder. Used by the browser's `getQueryBuilderTimeseries` and by the share
 * API's widget resolver, so a query-set widget widens (or, for every dashboard
 * tile, does not) identically on both hosts.
 */
export function fallbackStrategyFromWire(
	strategy: WireFallbackStrategy | undefined,
	base: EmptyRangeFallbackStrategy = LAB_EMPTY_RANGE_STRATEGY,
): EmptyRangeFallbackStrategy {
	return resolveFallbackStrategy(
		{
			...(strategy?.enableEmptyRangeFallback === undefined
				? undefined
				: { enabled: strategy.enableEmptyRangeFallback }),
			...(strategy?.fallbackWindowSeconds === undefined
				? undefined
				: { windowSeconds: strategy.fallbackWindowSeconds }),
			...(strategy?.maxFallbackRangeSeconds === undefined
				? undefined
				: { maxRangeSeconds: strategy.maxFallbackRangeSeconds }),
		},
		base,
	)
}
