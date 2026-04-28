import { Metric } from "effect"

// --- Counters ---

export const cacheHitsTotal = Metric.counter("query_engine.cache.hits_total", {
	description: "Total number of query engine cache hits",
	incremental: true,
})

export const cacheMissesTotal = Metric.counter("query_engine.cache.misses_total", {
	description: "Total number of query engine cache misses (triggered a new lookup)",
	incremental: true,
})

export const bucketCacheBucketsHit = Metric.counter("query_engine.bucket_cache.buckets_hit_total", {
	description: "Buckets served from the bucket cache without re-querying Tinybird",
	incremental: true,
})

export const bucketCacheBucketsMissed = Metric.counter("query_engine.bucket_cache.buckets_missed_total", {
	description: "Buckets that were fetched from Tinybird and written to the bucket cache",
	incremental: true,
})

// --- Histograms ---

export const executeDurationMs = Metric.histogram("query_engine.execute_duration_ms", {
	description: "Duration of a cached execute call in milliseconds",
	boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

export const bucketCacheMissingRanges = Metric.histogram("query_engine.bucket_cache.missing_ranges", {
	description: "Number of missing time ranges per bucket cache lookup",
	boundaries: [0, 1, 2, 3, 5, 10],
})
