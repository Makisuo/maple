# Example: Financial Services — Real-time market surveillance

## Scenario

- Workload: order and execution event stream
- Ingest rate: 80M events/day
- Query pattern:
  - latest order state
  - time-bounded compliance scans
  - intraday anomaly and pattern detection
- Freshness target: sub-second to low-single-digit seconds
- Additional requirement: late-arriving corrections and cancels

## Workload Summary

This is not classic OLTP. It is a high-throughput analytical event pipeline with mutable business state derived from ordered events. The architecture should preserve append-only facts and compute latest-state views rather than forcing row-by-row transactional mutations.

## Key Decisions

1. Keep a raw append-only event table
2. Model current state separately
3. Avoid using ClickHouse like a row store
4. Use pre-aggregation only for repeated surveillance views

## Recommendations

### 1. Raw event table plus latest-state projection

**What**  
Store all order lifecycle events immutably, then derive current order state.

**Why**  
This preserves auditability and handles late-arriving business events without relying on heavy mutations.

**Category**  
derived

**Confidence**  
medium

**Source**
- https://clickhouse.com/docs/en/guides/replacing-merge-tree

### 2. Use ReplacingMergeTree for current-state table if version semantics are clean

**What**  
Maintain a latest-state table keyed by order identifier and version timestamp.

**Why**  
If corrections naturally replace prior state, ReplacingMergeTree is often the cleanest documented pattern.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/en/guides/replacing-merge-tree

### 3. Use dictionaries for small reference data used in surveillance rules

**What**  
Use dictionaries for symbol metadata, venue mappings, or account-tier lookups if they are read constantly and update slowly.

**Why**  
Repeated runtime joins in hot surveillance logic are often more expensive than key-based dictionary lookup.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/en/sql-reference/dictionaries

## Example raw events table

```sql
CREATE TABLE order_events
(
    event_time DateTime64(3),
    trade_date Date,
    order_id String,
    account_id String,
    symbol LowCardinality(String),
    venue LowCardinality(String),
    event_type LowCardinality(String),
    qty UInt64,
    px Decimal(18, 6),
    version_ts DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(trade_date)
ORDER BY (trade_date, symbol, order_id, event_time);
```

## Example current-state table

```sql
CREATE TABLE order_state_latest
(
    order_id String,
    symbol LowCardinality(String),
    venue LowCardinality(String),
    status LowCardinality(String),
    qty UInt64,
    px Decimal(18, 6),
    version_ts DateTime64(3)
)
ENGINE = ReplacingMergeTree(version_ts)
ORDER BY (order_id);
```

## Caveat

This pattern is architectural, not transactional. If the requirement is strict OLTP locking semantics with many point updates per key, ClickHouse should not be the system of record for that path.
