import { Metric } from "effect"

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

/**
 * Incremented once per isolate that boots without a Workers cache binding and
 * silently falls back to per-isolate memory. Without this the fallback is
 * visible only as a single log line and a span attribute, so a deploy running
 * with no shared cache at all looks identical in metrics to a healthy one —
 * every cross-request hit just quietly disappears.
 */
export const cacheBackendMemoryFallback = Metric.counter("query_engine.cache.memory_fallback_total", {
	description: "Isolates that fell back to the per-isolate in-memory cache backend",
	incremental: true,
})

export const executeDurationMs = Metric.histogram("query_engine.execute_duration_ms", {
	description: "Duration of a cached execute call in milliseconds",
	boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

export const bucketCacheMissingRanges = Metric.histogram("query_engine.bucket_cache.missing_ranges", {
	description: "Number of missing time ranges per bucket cache lookup",
	boundaries: [0, 1, 2, 3, 5, 10],
})

/**
 * Fraction of requested buckets already in cache — the honest hit-rate signal
 * for the timeseries path.
 *
 * `cache.hits_total` cannot serve this purpose there: the trailing flux window
 * is never cacheable, so a live dashboard always issues at least one warehouse
 * query and a `warehouseQueryCount === 0` test reports a miss on every single
 * request, even at 99% coverage. Chart this instead.
 */
export const bucketCacheCoverageRatio = Metric.histogram("query_engine.bucket_cache.coverage_ratio", {
	description: "Fraction of requested buckets served from the bucket cache",
	boundaries: [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1],
})
