/**
 * Rank made visible: a tint filling the row to its share of the listed total.
 * The scale is linear — a row at 40% is twice the block of one at 20% — so
 * scrolling the list traces the decay curve without a separate bar column.
 *
 * It fades out over its last fifth rather than stopping on a hard edge: a crisp
 * rectangle in the primary hue reads as a selected row, which is a state these
 * tables also have. Below half a percent the bar would be a sliver of noise, so
 * it doesn't render at all.
 *
 * Shared by the Cloudflare and PlanetScale breakdown panels. What the ratio
 * *means* is the caller's business, and it differs: see `relativeRatio` below.
 */
export const shareTint = (share: number): string | undefined => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return undefined
	const solid = pct * 0.8
	const tint = "color-mix(in oklab, var(--primary) 8%, transparent)"
	return `linear-gradient(to right, ${tint} 0%, ${tint} ${solid}%, transparent ${pct}%)`
}

/**
 * Ratio to the largest value in the set, for measures where a "share of total"
 * would be a fabricated statistic.
 *
 * You cannot sum maxima: adding up per-branch peak CPU produces a number that
 * corresponds to nothing, and a tint derived from it would state a proportion
 * that does not exist. For those measures the honest comparison is against the
 * worst branch, and the footer must say so.
 */
export const relativeRatio = (value: number, max: number): number =>
	max > 0 && Number.isFinite(value) ? Math.max(0, value) / max : 0
