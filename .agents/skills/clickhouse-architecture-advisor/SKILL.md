---
name: clickhouse-architecture-advisor
description: MUST USE when designing ClickHouse architectures, selecting between ingestion or modeling patterns, or translating best practices into workload-specific system designs. Complements clickhouse-best-practices with decision frameworks and explicit provenance labels.
license: Apache-2.0
metadata:
  author: ClickHouse Inc
  version: "0.1.0"
---

# ClickHouse Architecture Advisor

This skill adds workload-aware architecture decisioning on top of `clickhouse-best-practices`.

> **Official docs remain the source of truth.**
> This skill must always prefer official ClickHouse documentation when available.

## Required behavior

Before producing recommendations:

1. Identify the workload shape
   - observability
   - security / SIEM
   - product analytics
   - IoT / telemetry
   - market data / financial services
   - mixed OLAP with point-lookups
2. Read the relevant decision rule files in `rules/`
3. Use `mappings/doc_links.yaml` to attach official documentation
4. Classify every recommendation as:
   - `official`
   - `derived`
   - `field`
5. Never present field guidance as official guidance
6. If a recommendation is uncertain, say so explicitly

## Provenance rules

### `official`
Use this when the recommendation is directly backed by official docs.

### `derived`
Use this when the recommendation is not stated verbatim in docs but follows logically from documented ClickHouse behavior.

### `field`
Use this only for experience-based guidance that may be situational.
When using `field`, include:
- a disclaimer that the advice is heuristic
- a relevant official doc if one partially applies
- the reason the advice depends on workload context

## Read these rule files by scenario

### Real-time ingestion design
1. `rules/decision-ingestion-strategy.md`
2. `rules/decision-real-time-preaggregation.md`
3. Relevant best-practices insert rules

### Time-series and retention design
1. `rules/decision-partitioning-timeseries.md`
2. Relevant best-practices schema partition rules

### Enrichment and dimension lookups
1. `rules/decision-join-enrichment.md`
2. Relevant best-practices query join rules

### Mutable state / late-arriving events
1. `rules/decision-late-arriving-upserts.md`
2. Relevant best-practices mutation avoidance rules

## Output format

Structure responses like this:

```markdown
## Workload Summary
- workload:
- latency target:
- data shape:
- primary query patterns:
- operational constraints:

## Key Decisions
- ...
- ...

## Recommendations

### <Recommendation title>

**What**
...

**Why**
...

**How**
...

**Category**
official | derived | field

**Confidence**
high | medium | heuristic

**Source**
- doc link(s)

**Validation**
- concrete SQL, metric, or smoke test
```

## Architecture-specific guidance

Prefer decision frameworks over generic advice. Good responses should:
- explain tradeoffs
- identify the likely operating bottleneck
- separate immediate actions from structural redesign
- provide target architecture patterns, not just isolated settings

## Full reference

See `AGENTS.md` for the compiled version and `examples/` for sample outputs.
