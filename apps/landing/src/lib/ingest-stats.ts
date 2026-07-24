// Platform-wide ingest volume shown in the hero. Hardcoded on purpose — bump
// these by hand when you want to refresh the figure.
const MANAGED_DATA_POINTS = 3_100_000_000 // managed warehouse (Tinybird)
const SELF_HOSTED_DATA_POINTS = 38_400_000_000 // self-hosted (BYO ClickHouse)

export const DATA_POINTS_INGESTED = MANAGED_DATA_POINTS + SELF_HOSTED_DATA_POINTS

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** Formats the count compactly, e.g. 41_500_000_000 → "41.5B". */
export function formatDataPoints(n: number): string {
	return compact.format(n)
}
