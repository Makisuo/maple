# Example: Observability — High-throughput event ingestion

## Scenario

- Workload: observability / logs
- Ingest rate: 300K events/sec
- Producer shape: many agents, uneven bursts
- Query pattern: time-range scans, grouped aggregations, service-level dashboards
- Freshness target: under 5 seconds

## Workload Summary

This is a high-ingest, append-friendly, time-series workload. The main architectural risks are:
- excessive small parts
- merge pressure
- slow tail queries if rollups are not used for dashboards

## Key Decisions

1. Use a decoupled ingestion path
2. Partition conservatively
3. Preserve raw data while introducing focused rollups

## Recommendations

### 1. Kafka engine + materialized view for ingestion

**What**  
Use Kafka as the decoupling layer and load ClickHouse through Kafka engine tables and downstream MVs.

**Why**  
The producer fleet is bursty and distributed. This pattern improves replayability and isolates producers from storage behavior.

**How**  
- Kafka topic per stream family
- Kafka engine source table
- MV into MergeTree raw table

**Category**  
derived

**Confidence**  
medium

**Source**
- https://clickhouse.com/docs/engines/table-engines/integrations/kafka
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view

### 2. Monthly partitions on event time

**What**  
Use `PARTITION BY toYYYYMM(event_time)` for the main raw table.

**Why**  
This workload is time-bounded and retention-based, but daily partitioning would likely create unnecessary operational overhead at scale.

**Category**  
derived

**Confidence**  
medium

**Source**
- https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/custom-partitioning-key

### 3. Incremental MVs for hot service dashboards

**What**  
Create rollup tables for repeated service-health queries.

**Why**  
Dashboards and alerts should not repeatedly scan the raw log corpus.

**Category**  
official

**Confidence**  
high

**Source**
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view

## Example raw table

```sql
CREATE TABLE logs_raw
(
    event_time DateTime64(3),
    service LowCardinality(String),
    level LowCardinality(String),
    host String,
    message String,
    attrs JSON
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (service, event_time, host);
```

## Example rollup table

```sql
CREATE TABLE logs_rollup_1m
(
    bucket DateTime,
    service LowCardinality(String),
    level LowCardinality(String),
    count_state AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (service, level, bucket);
```
