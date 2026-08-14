import type { CSSProperties } from "react"

/**
 * Rank made visible: the row's background filled to its share of the listed
 * total. The scale is linear — a row at 40% is twice the block of one at 20% —
 * so scrolling the list traces the decay curve without spending a column on it.
 *
 * The edge is hard. An earlier version faded the fill out over its last fifth to
 * keep it from reading as a selected row, which cost the bar the one thing a bar
 * is for — a legible end — and left every row looking smudged. Selection is
 * distinguished by its own marker instead: rows carry an inset rule down their
 * leading edge when picked, which no amount of share can imitate.
 *
 * 14% of the primary hue is the ceiling here. These rows put 12px text over the
 * fill, so the tint has to stay under the text rather than compete with it, and
 * hover (a neutral lift behind the fill) has to stay visible through it.
 *
 * Below half a percent the fill would be a sliver of noise, so it doesn't render
 * at all.
 *
 * Shared by the analytics, Cloudflare and PlanetScale breakdown panels. What the
 * ratio *means* is the caller's business, and it differs: see `relativeRatio`.
 */
export const shareBar = (share: number): CSSProperties | undefined => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return undefined

	const fill = "color-mix(in oklab, var(--primary) 14%, transparent)"

	return {
		backgroundImage: `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, transparent ${pct}%)`,
	}
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
