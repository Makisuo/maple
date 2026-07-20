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
	description: "Requested buckets already covered by the bucket cache",
	incremental: true,
})

export const bucketCacheBucketsMissed = Metric.counter("query_engine.bucket_cache.buckets_missed_total", {
	description: "Requested buckets not covered by the bucket cache at lookup time",
	incremental: true,
})

export const bucketCacheBucketsRequested = Metric.counter(
	"query_engine.bucket_cache.buckets_requested_total",
	{
		description: "Total buckets requested through the bucket cache",
		incremental: true,
	},
)

export const bucketCacheWarehouseQueries = Metric.counter(
	"query_engine.bucket_cache.warehouse_queries_total",
	{
		description: "Warehouse queries issued to fill bucket cache gaps",
		incremental: true,
	},
)

export const bucketCacheSegmentHits = Metric.counter("query_engine.bucket_cache.segment_hits_total", {
	description: "Bucket-cache segments read successfully",
	incremental: true,
})

export const bucketCacheSegmentMisses = Metric.counter("query_engine.bucket_cache.segment_misses_total", {
	description: "Bucket-cache segments absent or invalid",
	incremental: true,
})

export const bucketCacheSegmentTimeouts = Metric.counter("query_engine.bucket_cache.segment_timeouts_total", {
	description: "Bucket-cache segment reads that exceeded the read deadline",
	incremental: true,
})

export const bucketCacheSegmentErrors = Metric.counter("query_engine.bucket_cache.segment_errors_total", {
	description: "Bucket-cache segment reads that failed",
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
