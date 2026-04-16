---
title: Choose time-series partitioning for retention, pruning, and operational hygiene
impact: HIGH
tags:
  - partitioning
  - time-series
  - retention
  - ttl
---

# Choose time-series partitioning for retention, pruning, and operational hygiene

## Principle

Partitioning should primarily support lifecycle management and bounded pruning. It should not be used casually or at excessively fine granularity.

## Decision framework

| Workload condition | Recommendation | Category |
|---|---|---|
| Early-stage or modest data volume with unclear retention needs | Start without partitioning | official |
| Time-bounded workload with month-scale retention windows | Monthly partitioning | derived |
| Very short retention and strictly day-bounded queries | Daily partitioning only if partition count stays reasonable | derived |
| High-scale time-series with TTL and bulk expiration needs | Partition by time unit aligned to retention operations | official |

## Guidance

### Recommendation: start without partitioning when unsure
**Why**
The best-practices skill already notes that teams often over-partition too early.

**Official sources**
- `schema-partition-start-without`
- https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/custom-partitioning-key

### Recommendation: monthly partitions for many real-time systems
**Why**
For observability, SIEM, telemetry, and many financial workloads, monthly partitions often balance lifecycle management with manageable partition counts.

**Category**
derived

**Source**
- https://clickhouse.com/docs/partitions

### Recommendation: align partitioning with TTL boundaries
**Why**
If retention deletes are a primary operational concern, partitioning should make those drops efficient.

**Official sources**
- `schema-partition-lifecycle`
- https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/custom-partitioning-key

## Validation

- Count active partitions
- Verify common queries align to the partition key
- Confirm retention actions operate at partition granularity where possible
