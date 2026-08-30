# Warehouse rollups and materialized views

We have 41 materialized views across 39 datasources. They accreted one product feature at a
time, and for a long time nobody could answer "should this be an MV?" without re-deriving it
from scratch. This is that answer.

Definitions live in `packages/domain/src/tinybird/materializations.ts` (MVs) and
`datasources.ts` (targets). Everything else — the ClickHouse DDL snapshot, `local-schema.sql`
for the embedded chDB engine, the Rust insert mappings — is generated from those two files.

---

## The tier ladder

| Tier | Grain | TTL | Answers |
|---|---|---|---|
| **raw** | one row per span/log/point | 30d | "show me this exact trace / these log lines" — anything needing attributes, span names, or a specific id |
| **minutely** | pre-aggregated per minute | 90d | sub-hour timeseries and alert evaluation, where a per-span scan is the only alternative |
| **hourly** | pre-aggregated per hour | 365d | dashboards and trends over days-to-a-year |

**A query must read the coarsest tier that can answer it.** The routing guards
(`canUseAnnualServiceOverview`, `canUseTracesAggregatesMv`, `canUseServiceOverviewMv`,
`canUseLogsAggregatesHourly`) exist to enforce that, and each one names the tier it unlocks.

Rollup routes union a **raw edge** with a **rollup interior**: the rollup answers whole
buckets, and the raw table covers the partial buckets at each end of the window. Getting the
edge grain wrong double-counts every span in the first and last partial bucket, and the SQL
looks perfectly reasonable while it does — see the comment on `edgeGrain` in
`queries/traces.ts`.

---

## When a materialized view is justified

Three shapes, all already in the codebase. If a proposed MV is not one of these, it is a copy
of a table we already have.

1. **Re-sort for point lookup.** `trace_detail_spans` is a 1:1 copy of `traces` ordered by
   `(OrgId, TraceId, SpanId)` instead of `(OrgId, ServiceName, Timestamp)`. That turns
   "fetch this trace" from a bloom-filter scan into a primary-key lookup. It costs 82 GB —
   the single most expensive object we have — and it earns it.
2. **Pre-aggregation for scans.** `*_aggregates_hourly`, `service_overview_*`,
   `service_operations_*`. Trades write amplification for orders-of-magnitude less read.
3. **Filtered projection.** `error_events` keeps only `StatusCode = 'Error'` and unwraps the
   exception event, so error queries never touch the Map columns of the full traces table.

Storage is not free and the ratio is worse than it looks: `traces` is 110 GB, and its MV
descendants total roughly 116 GB. **We store traces more than twice over.** Every new MV on
`traces` adds to that.

---

## Rules

These are not style preferences. Each one is here because its absence cost something
measurable, found during the 2026-08 sweep.

### Every MV names its consuming query

No consumer, no MV. `error_spans` was materialized from every error span for the lifetime of
the product and **never read once** — no query in the DSL ever called `from(ErrorSpans)`.
Worse, it was still described to LLM agents in `warehouse-catalog.ts` as "use this instead of
`traces WHERE StatusCode = 'Error'`", so `run_sql` agents were actively steered onto it.

### Any MV that fans out over unbounded values must carry a cardinality bound

`ARRAY JOIN` over an attribute map turns every distinct value into its own row. With
`AttributeValue != ''` as its only filter, `attribute_values_hourly` reached **1.59 billion
rows / 12.3 GB** to serve an autocomplete dropdown read a couple hundred times a week.

Bound it by measuring what is actually in the table, not by guessing. The intuitive rules —
a length cap and a denylist of id-ish key names — would have missed the top two keys, which
were `idle_ns` and `busy_ns`: short *numeric measurements* that together were ~70% of the
rows. See `attributeValueCardinalityBound` for the rules that resulted and why.

### Keep the write filter and the read guard in sync, and test that they agree

`span_metrics_calls_hourly` sat at **0 rows for its entire existence**. The MV filtered
`MetricName IN ('span.metrics.calls', 'calls')`; the collector emits the counter namespaced
by its pipeline, as `traces.span.metrics.calls`. Both the write filter and the read fast-path
missed it, so they agreed with each other and disagreed with reality — and every read fell
back to a raw scan measured at ~7s p95.

A rollup whose target is empty is indistinguishable from a rollup nobody queries. Neither the
schema lint nor the SQL catalog can catch this; only looking at row counts can.

### A two-tier read takes its boundary from `rollup-splice`, never by hand

The raw edge and the rollup interior have to tile the window exactly once. Written by hand
that is two inequalities which must stay each other's exact complement, and when they drift
nothing errors — the counts simply come out wrong, on a chart that looks fine.

`packages/query-engine/src/ch/queries/rollup-splice.ts` owns that boundary:
`interiorConditions(bucketColumn, grain)` for the rollup branch, `edgeCondition(tsColumn,
grain)` for the raw branch, defined as its complement. Traces, logs, services and
service-operations use them.

The service-map family did not, and drifted in both directions at once. `serviceDependencies`
hand-rolled the boundary correctly. `serviceDbEdges`, `serviceExternalEdges` and the
db-query-shape drill-down hand-rolled the same boundary with the interior floored to
`toStartOfHour(startTime)` while their raw branch covered only the trailing hour — so every
window whose start was not hour-aligned counted the whole leading hour, including spans
outside the window. The web app snaps a 12h range to a 5-minute grid, so the start was
essentially never aligned. The DB nodes on the service map read high against the service
edges drawn beside them, permanently, and the boundary-exact e2e reproduces it as a *phantom
database node* built entirely from rows before the window began.

Two things made it survive: nothing forced the shared helper, and those queries had no
fixture in the SQL catalog at all, so neither the DESCRIBE sweep nor any structural gate ever
looked at them.

Both are closed now. `unsplicedTwoTierQueries` in `sql-catalog.ts` fails any query naming both
a rollup table and a raw table whose boundary is not a computed `firstFullBucket`, and
`service-map-parity.clickhouse.e2e.test.ts` compares the spliced result against a flat scan
with spans seeded exactly on each seam. **There is no allowlist on that gate.** A single-tier
query never trips it, and a deliberately-approximate one (`serviceHealthSnapshot` floors to
the hour on purpose) reads only its rollup and never trips it either. A new query that needs
an exemption is the gate finding something, not the gate needing a hole.

### A routing guard must be tested on the tier it selects, not on a table name

`canUseAnnualServiceOverview` required `allMetrics === true`. Alert evaluation
(`computeAlertBuckets`) never sets it, so every alert fell through to a flat scan of the
325M-row per-span `service_overview_spans` — **165k scans per 3 days** — while the 2.2M-row
minutely rollup built for exactly that shape sat unreachable.

`sql-catalog.test.ts` already asserts every routing predicate is exercised both ways, and it
passed throughout. The gap was that the test guarding this route asserted
`sql.toContain("FROM service_overview_spans")` — and the tiered union reads that table too,
as its raw edge. The assertion could not tell the two routes apart. **Assert the tier that
distinguishes the branch** (`FROM service_overview_minutely`), and include a fixture shaped
like a real alert rule, not just a dashboard query.

---

## Before adding or changing an MV

1. Name the query that will read it, and the tier it belongs to.
2. If it fans out over values, decide the cardinality bound first.
3. Add a routing fixture that pins the **tier**, both ways.
4. `bun run clickhouse:schema` and `bun run tinybird:manifest` to regenerate.
5. Write the numbered migration in `packages/domain/src/clickhouse/migrations/` —
   **`DROP VIEW` before `DROP TABLE`, always**. The inverse leaves an MV pointing at a
   missing target and wedges ingest with `Code: 60 UNKNOWN_TABLE`.
6. Set `requiredForIngest: false` unless the Rust gateway writes the table directly.
   Bumping `clickHouseSchemaVersion` un-readies ingest routing for every BYO-ClickHouse org.
7. Bump `LOCAL_SCHEMA_VERSION`, retain the snapshot, and add the local-store migration edge —
   including explicit drops, because `assertPhysicalSchema` fails on leftover objects too.

Because step 5–7 are expensive, **batch removals into one migration** rather than shipping
them one at a time. Migration `0019_mv_sweep` is the worked example.

---

## Known-unresolved

Recorded so the next sweep does not re-derive them.

- **`alertRawQuery` — 173,000 s/week**, the single largest consumer of warehouse time. It is
  user-authored SQL against raw tables, so no MV can see it and no routing guard applies.
  Needs its own design: a rollup users can target, or per-rule result caching.
- **`trace_detail_spans` TTL.** 82 GB, and TTL is the only remaining lever — column narrowing
  recovered 1.19 GB (1.5%) and the rest is `SpanAttributes` (31 GB) and the incompressible
  `SpanId` (17 GB). A product decision about the trace-drilldown window.
- **`service_map_spans` + `service_map_children`** — 18.6 GB of intermediate producing a
  223 MB hourly rollup. Suspicious amplification, but the recent-window branch reads them
  directly.
- **`metrics_exponential_histogram` is empty.** Not dead: ingest writes it
  (`apps/ingest/src/telemetry.rs`), and it is empty only because no SDK currently exports
  exponential histograms. Leave it and its two MVs alone.
- **Naming drift** — `trace_list_mv_mv`, and `serviceMapDbQuerySignaturesHourlyMv` producing
  `service_map_db_query_shapes_hourly_mv`. Cosmetic; renaming costs a full migration plus a
  local schema version, which is not worth spending on aesthetics.
