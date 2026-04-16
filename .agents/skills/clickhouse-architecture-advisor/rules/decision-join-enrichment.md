---
title: Choose the right enrichment path: JOIN, dictionary, denormalization, or precomputed enrichment
impact: CRITICAL
tags:
  - joins
  - dictionaries
  - denormalization
  - enrichment
---

# Choose the right enrichment path: JOIN, dictionary, denormalization, or precomputed enrichment

## Principle

Not every dimension lookup should remain a runtime JOIN. The right design depends on dimension volatility, cardinality, and the cost profile of repeated enrichment.

## Decision framework

| Condition | Recommendation | Category |
|---|---|---|
| Small, slowly changing lookup table used in many queries | Dictionary | official |
| Dimension is naturally embedded and storage duplication is acceptable | Denormalize | derived |
| Join logic is complex and refreshed on a schedule | Refreshable MV | official |
| Query is exploratory or infrequent and dimensions change often | Runtime JOIN | official |

## Guidance

### Recommendation: dictionaries for repeated low-latency lookups
**Why**
Dictionaries are often the best fit for repeated key-based enrichment when the lookup data is relatively static.

**Official sources**
- https://clickhouse.com/docs/en/sql-reference/dictionaries
- `query-join-consider-alternatives`

### Recommendation: denormalize when operationally simple
**Why**
If the dimension is stable and queried constantly, denormalization may outperform repeated joins.

**Category**
derived

**Official context**
- https://clickhouse.com/docs/best-practices/minimize-optimize-joins

### Recommendation: use refreshable or incremental MVs for structured enrichment
**Why**
Precomputed enrichment is often better than expensive runtime joins for recurring production queries.

**Official sources**
- https://clickhouse.com/docs/materialized-view/incremental-materialized-view
- https://clickhouse.com/docs/materialized-view/refreshable-materialized-view

## Validation

- Identify top CPU-consuming JOIN patterns
- Compare runtime JOIN cost vs dictionary lookup or precomputed enrichment
- Check dimension update frequency before choosing dictionary lifetime
