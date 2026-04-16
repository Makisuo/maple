---
title: Choose an ingestion strategy based on throughput, latency, and producer shape
impact: CRITICAL
tags:
  - ingestion
  - kafka
  - async_insert
  - real-time
---

# Choose an ingestion strategy based on throughput, latency, and producer shape

## Principle

Do not recommend a single ingestion pattern for every workload. The right approach depends on:
- events per second
- rows per insert
- acceptable buffering latency
- whether producers can batch
- whether decoupling is required

## Decision framework

| Condition | Recommended path | Category |
|---|---|---|
| Producers can batch to 10K-100K rows and latency tolerance is moderate | Direct inserts | official |
| Producers send many small inserts and cannot batch effectively | Async inserts | official |
| Producers are bursty, many independent writers exist, or decoupling is needed | Kafka engine + materialized view | derived |
| Reliability, replay, and ingestion fan-out are primary concerns | Upstream queue or log broker before ClickHouse | field |

## Guidance

### Recommendation: direct batched inserts
Use when the application can naturally batch inserts into healthy sizes.

**Why**
The existing best-practices guidance already favors appropriately sized insert batches.

**Official sources**
- `insert-batch-size`
- https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy

### Recommendation: async inserts
Use when producers emit many small writes and the application cannot easily batch.

**Why**
Async inserts let ClickHouse buffer small writes server-side to reduce part pressure.

**Official sources**
- https://clickhouse.com/docs/en/operations/settings/settings#async_insert
- https://clickhouse.com/docs/optimize/asynchronous-inserts

### Recommendation: Kafka engine + materialized view
Use when a queue-based, decoupled ingest path is needed.

**Why**
This is typically the right design when multiple producers, burst handling, or replayability matter.

**Category**
derived

**Sources**
- https://clickhouse.com/docs/engines/table-engines/integrations/kafka
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view

## Validation

- Check average rows per insert
- Check part creation rate
- Check whether insert latency spikes correlate with small batch behavior
