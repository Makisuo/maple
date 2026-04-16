---
title: Handle late-arriving data and mutable state without defaulting to heavy mutations
impact: CRITICAL
tags:
  - upserts
  - late-arriving
  - replacingmergetree
  - collapsingmergetree
  - mutable-state
---

# Handle late-arriving data and mutable state without defaulting to heavy mutations

## Principle

Frequent `ALTER TABLE UPDATE` and `ALTER TABLE DELETE` operations are usually the wrong first answer. Prefer append-friendly patterns and engines designed for state evolution.

## Decision framework

| Condition | Recommendation | Category |
|---|---|---|
| Immutable event log with latest-state queries | Raw append table + latest-state query or MV | derived |
| Natural replacement semantics with version ordering | ReplacingMergeTree | official |
| Explicit row-state transitions are modeled | CollapsingMergeTree or VersionedCollapsingMergeTree | official |
| Small correction workload, infrequent and operationally bounded | Targeted mutation may be acceptable | field |

## Guidance

### Recommendation: prefer append + latest-state logic for event streams
**Why**
Many real-time systems do not need in-place updates if the application can compute current state from ordered events.

**Category**
derived

**Official context**
- https://clickhouse.com/docs/en/guides/replacing-merge-tree

### Recommendation: use ReplacingMergeTree for replacement semantics
**Why**
ReplacingMergeTree is the standard documented pattern for row replacement based on version ordering.

**Official sources**
- https://clickhouse.com/docs/en/guides/replacing-merge-tree
- `insert-mutation-avoid-update`

### Recommendation: avoid defaulting to mutations
**Why**
Heavy mutation usage often becomes the bottleneck in otherwise append-friendly systems.

**Official sources**
- `insert-mutation-avoid-update`
- `insert-mutation-avoid-delete`

## Validation

- Measure mutation volume per day
- Check whether the workload is actually latest-state, not true OLTP
- Confirm whether late-arriving records can be handled by version semantics
