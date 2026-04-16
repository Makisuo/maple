# Example: SIEM / security analytics

## Scenario

- Workload: endpoint, identity, cloud, and network telemetry
- Query pattern:
  - repeated detection logic
  - time-bounded investigations
  - lookup-heavy enrichments
- Freshness target: near real-time

## Workload Summary

This workload is time-series heavy, multi-source, and often enrichment-bound. The two common failure modes are:
- expensive runtime JOINs on slow-changing dimension data
- micro-batched ingest that creates excessive parts

## Key Decisions

1. Use append-friendly event storage
2. Replace repeated small-dimension JOINs where possible
3. Protect hot detections with precomputation or lookup structures

## Recommendations

### 1. Enable async inserts for small-batch telemetry senders

**What**  
Use async inserts when many agents or producers write very small batches.

**Why**  
This reduces small-part pressure without rewriting every upstream sender.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/en/operations/settings/settings#async_insert
- https://clickhouse.com/docs/optimize/asynchronous-inserts

### 2. Use dictionaries for slow-changing asset and identity lookups

**What**  
Move repeated device-owner or asset-lookup enrichment out of runtime joins where appropriate.

**Why**  
Security detections often execute continuously; repeated joins on slow-changing dimensions waste CPU.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/en/sql-reference/dictionaries

### 3. Use incremental MVs for repeated aggregated detection views

**What**  
Precompute common counts, rates, and rollups that power dashboards or recurring detections.

**Why**  
Not every threat-hunting query should hit the same raw telemetry tables repeatedly.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view
