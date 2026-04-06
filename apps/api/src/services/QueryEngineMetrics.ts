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

// --- Histograms ---

export const executeDurationMs = Metric.histogram("query_engine.execute_duration_ms", {
  description: "Duration of a cached execute call in milliseconds",
  boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})
