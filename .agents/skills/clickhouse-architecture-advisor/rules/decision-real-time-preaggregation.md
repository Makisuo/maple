---
title: Choose raw-only vs incremental materialized views vs refreshable materialized views
impact: HIGH
tags:
  - materialized_views
  - preaggregation
  - rollups
  - real-time
---

# Choose raw-only vs incremental materialized views vs refreshable materialized views

## Principle

Real-time workloads should not be forced into either “everything raw” or “precompute everything.” The correct choice depends on freshness, query repetition, and transformation complexity.

## Decision framework

| Condition | Recommendation | Category |
|---|---|---|
| Queries are ad hoc and freshness matters most | Query raw tables | derived |
| Repeated aggregation pattern over append-only data | Incremental MV | official |
| Complex joins or scheduled batch recomputation | Refreshable MV | official |
| Very hot dashboard or alerting path | Incremental rollup table plus raw table fallback | derived |

## Guidance

### Recommendation: incremental MVs for repeated real-time aggregation
**Why**
Incremental MVs are the documented best fit for continuously maintained rollups over insert streams.

**Official sources**
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view
- `query-mv-incremental`

### Recommendation: refreshable MVs for heavier joins or scheduled transforms
**Why**
Refreshable MVs better fit complex transformations that do not need per-row trigger semantics.

**Official sources**
- https://clickhouse.com/docs/materialized-view/refreshable-materialized-view
- `query-mv-refreshable`

### Recommendation: dual-path design for hot dashboards
**Why**
A raw table preserves flexibility while a rollup path protects latency-sensitive workloads.

**Category**
derived

**Official context**
- https://clickhouse.com/docs/use-cases/time-series/basic-operations

## Validation

- Identify repeated dashboard queries
- Compare raw scan cost against incremental aggregation maintenance
- Confirm whether the source is append-only enough for incremental MV semantics
