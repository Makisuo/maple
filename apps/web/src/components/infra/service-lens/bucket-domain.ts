import { toIsoBucket } from "@/api/warehouse/timeseries-utils"

/**
 * One x axis for series that came from different endpoints.
 *
 * Maple's warehouse APIs do not agree on how a bucket is spelled: the service
 * overview returns `2026-08-31T10:00:00.000Z` while the infra timeseries
 * returns the raw warehouse `2026-08-31 10:00:00`. They are the same instant.
 * Unioned naively and sorted, they don't interleave — `' '` (0x20) sorts before
 * `'T'` (0x54), so EVERY space-format bucket lands before every ISO one and a
 * shared axis runs the window twice, once per source.
 *
 * Normalizing through `toIsoBucket` (idempotent, already the codebase's
 * normalizer) collapses the duplicates and makes the sort chronological.
 */
export function unifiedBucketDomain(sources: ReadonlyArray<ReadonlyArray<string>>): string[] {
	const seen = new Set<string>()
	for (const buckets of sources) {
		for (const bucket of buckets) seen.add(toIsoBucket(bucket))
	}
	return [...seen].sort((a, b) => a.localeCompare(b))
}
