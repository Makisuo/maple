# ClickHouse Architecture Advisor

**Version 0.1.0**  
ClickHouse Inc  
April 2026  
ClickHouse 24.1+

## Abstract

This skill complements `clickhouse-best-practices` by adding a workload-aware architecture layer for ClickHouse. It is optimized for advisory, workshop, and system design workflows where a user needs more than a rule check. It provides decision frameworks for ingestion strategy, time-series partitioning, enrichment paths, late-arriving data, and real-time pre-aggregation.

## Core principle

Official documentation is the source of truth. Every recommendation must be labeled as:

- `official`
- `derived`
- `field`

## Decision areas

### 1. Ingestion strategy
Use when deciding between:
- direct inserts
- async inserts
- Kafka engine + MV
- upstream buffering

### 2. Time-series partitioning
Use when deciding:
- whether to partition
- partition granularity
- how retention and TTL affect design
- how to avoid excessive partition counts

### 3. Enrichment path selection
Use when deciding between:
- runtime JOINs
- dictionaries
- denormalization
- materialized enrichment

### 4. Late-arriving data and mutable state
Use when reasoning about:
- immutable append-only events
- latest-state queries
- replacing or collapsing semantics
- whether frequent mutations should be avoided

### 5. Real-time pre-aggregation
Use when deciding:
- raw-only design
- incremental materialized views
- refreshable MVs
- rollup tables

## Output standard

A valid architecture response should include:
- workload summary
- key decisions
- recommendations with provenance labels
- suggested target architecture
- example DDL or SQL
- validation approach

## Required recommendation schema

See `schemas/recommendation_schema.yaml`.

## Rule index

1. `decision-ingestion-strategy`
2. `decision-partitioning-timeseries`
3. `decision-join-enrichment`
4. `decision-late-arriving-upserts`
5. `decision-real-time-preaggregation`

## Implementation notes

This skill is intentionally narrow:
- it does not replace low-level rule enforcement
- it does not make commercial recommendations
- it does not claim field heuristics are official policy

Its purpose is to translate documented ClickHouse capabilities into workload-specific architecture decisions.
