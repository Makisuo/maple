# Query optimization: second scan — 2026-09-05

**The strongest new SQL candidate is the timeseries series cap:** a window-ranking experiment read approximately **50% fewer bytes** and used **30–54% less mean server time**, with matching results in four populated cases. The broader scan also found substantial repeated trace-alert work and raw-alert authentication failures. Switching service facets to the existing minute tier increased reads and is not recommended from this evidence.

This extends the [first review](query-optimization-review-2026-09-05.md). All changes in this review are documentation and gitignored experiments; no production query, cache, schema, or configuration was changed.

## 1. Avoid evaluating the timeseries base query twice

[finalizeTimeseries](../packages/query-engine/src/ch/queries/series-cap.ts) references `__series_base` twice: once to rank groups and once to return their buckets. **Official behavior:** ordinary ClickHouse CTE references expand to their defining subqueries and can repeat the underlying computation. See [ClickHouse WITH documentation](https://clickhouse.com/docs/reference/statements/select/with).

**Derived candidate:** calculate each group's maximum with `max(count) OVER (PARTITION BY groupName)`, rank groups with `dense_rank() OVER (ORDER BY peak DESC, groupName ASC)`, then filter to the requested cap and project the original columns. The experiment retains tenant, time, environment, aggregation, and final ordering predicates. It removes the redundant inner ordering as well as the second base reference.

The two captured count-query fingerprints represented **162 of 693 `tracesTimeseries` executions** in the original 24-hour window. Each was replayed with caps of 12 and 3. These are selected historical windows, not a representative latency estimate for all 162 executions.

| Case                                     | Mean bytes read, before → after | Mean server ms, before → after | p95 wall ms, before → after | Returned rows |
| ---------------------------------------- | ------------------------------: | -----------------------------: | --------------------------: | ------------: |
| Environment-filtered count, cap 12       |         75,361,105 → 37,680,401 |                 122.49 → 72.72 |             313.30 → 270.14 |            11 |
| Environment-filtered count, cap 3        |         75,361,105 → 37,680,401 |                 137.25 → 62.50 |             288.11 → 211.10 |             6 |
| Count without environment filter, cap 12 |          10,357,211 → 5,155,738 |                  50.96 → 35.49 |             234.12 → 207.41 |             5 |
| Count without environment filter, cap 3  |          10,357,204 → 5,155,738 |                  53.51 → 31.50 |             234.78 → 240.37 |             5 |

Each variant had **20 measured executions and one warmup**, interleaved with rotating case order: 160 measurements total. Full-row hashes matched between variants and across every execution; no column projection was used for verification. Read rows halved in all four cases. The CLI comparison gates passed for bytes, mean server time, and p95 wall time at a 10% regression threshold. The last case's p95 increased 2.4%, so passing that gate does not mean every latency measurement improved.

Before implementation, extend parity coverage to tied ranks, other metrics, nullable/non-finite values, multiple grouping dimensions, rollup paths, and large group counts. The candidate gives ties a deterministic group-name order; the current query leaves tied selection unspecified. The production motivation for this cap is high cardinality, but these returned groups are small, and memory metrics were unavailable. Preserve the existing typed output columns and uncapped behavior when implementing the builder change.

## 2. Reuse repeated trace-alert work where evaluation semantics allow it

Using the same **2026-09-03 23:48:28–2026-09-04 23:48:28 UTC** window as the first review, group warehouse spans by context, tenant `orgId`, `db.client`, **complete SQL text**, and execution minute. Count executions beyond the first in each group:

| Context           | Executions | Repeated identical SQL within a minute | Share | Maximum executions of one SQL/minute |
| ----------------- | ---------: | -------------------------------------: | ----: | -----------------------------------: |
| `tracesAlertEval` |     61,449 |                                 13,956 | 22.7% |                                    8 |
| `alertRawQuery`   |     97,436 |                                  2,747 |  2.8% |                                    4 |
| `errorIssuesScan` |     28,979 |                                      0 |    0% |                                    1 |

These are observed repeated executions, **not guaranteed removable requests**. They include failures and can reflect retries, late-arriving data, different execution settings, or separate rule evaluations. Tenant identity is grouped explicitly, including for raw SQL scoped by JWT rather than a SQL predicate. SQL equality alone does not prove a shared result is appropriate.

The existing [evaluation cache](../apps/api/src/services/warehouse/QueryEngineService.ts) already lasts 90 seconds. Successful `cachedEvaluate` spans recorded 8,593 hits and 156,540 misses: **5.2% hit rate**. Another 5,802 failed spans lacked a completed hit outcome and are excluded from that denominator. Hits averaged 4.46 ms versus 121.27 ms for successful misses; this is observational, not a controlled speedup comparison.

Separate `EdgeCacheService.getOrCompute` spans for `qe-evaluate` recorded:

- 147,713 ordinary misses.
- 12,739 reads skipped by the circuit breaker.
- 1,890 reads that timed out at 40 ms.
- 8,593 hits.

Most reads therefore missed normally; circuit-breaker skips and timeouts are additional contributors. These counts are not joined to the repeated-SQL groups, so they do not establish why those particular executions repeated.

**Derived candidate:** investigate sharing the fetched alert buckets within one scheduler invocation, before rule-specific reduction, when tenant, backend/settings, SQL, and freshness requirements match. [The evaluation key](../packages/query-engine/src/runtime/query-engine.ts) currently includes the reducer, sample-count strategy, and complete query specification. Different rules can require distinct evaluation results even when their warehouse SQL matches. Keep those semantics separate; do not simply remove fields from the result-cache key or increase its TTL.

[The cache service](../lib/cache/src/edge-cache.ts) explicitly prohibits sharing in-flight I/O across Worker requests. Any coalescing experiment must respect that existing ownership constraint. Start by correlating repeated executions with rule inputs and cache outcomes before claiming the 13,956 calls as savings.

## 3. Investigate raw-alert authentication failures

Of 97,436 raw-alert warehouse executions, **5,716 failed (5.9%)**. Error-message classification found **5,616 invalid-authentication-token failures**, 69 HTTP 503 failures, and 31 timeouts. Authentication failures alone account for 5.8% of raw-alert traffic and deserve investigation before further tuning of the small raw-alert SQL samples.

The [raw execution route](../apps/api/src/services/warehouse/WarehouseQueryService.ts) substitutes an organization-scoped JWT on managed Tinybird. [TinybirdOrgTokenService](../apps/api/src/services/integrations/TinybirdOrgTokenService.ts) already refreshes tokens before expiry, and the executor's client identity includes credentials. The historical failure counts do **not** establish an expiry or client-cache bug. Correlate failures with deployment, token minting, routing, and upstream diagnostics to identify the cause. Preserve organization scoping throughout that investigation. Error-class artifacts contain counts without credential-bearing messages.

## 4. Reject a blanket minute-tier switch for service facets

An isolated copy of the real [services query builder](../packages/query-engine/src/ch/queries/services.ts) changed only the default grain from `hour` to `minute`, using the existing minute/hour/raw boundary implementation. The custom suite was exported with `bench:queries catalog` and `caseFromCompiled`.

| Window          | Mean bytes read, current → minute default | Change |
| --------------- | ----------------------------------------: | -----: |
| Captured window |                     4,313,840 → 5,304,910 | +23.0% |
| Partial hour    |                     4,340,264 → 5,136,119 | +18.3% |
| Aligned hours   |                     3,682,204 → 4,122,204 | +11.9% |

All returned rows matched, but three-run triage showed more reads in every case. Latency was mixed. This does not justify promoting the change or adding a new materialization. Any future adaptive tier choice must follow the existing [rollup boundary and retention contract](warehouse-rollups.md) and be measured on populated workloads. The existing four-way facet UNION also documents a prior single-scan rewrite that was slower; fewer SQL branches alone are not evidence of improvement.

## 5. Lower-priority service-map request fan-out

The committed [service-map view](../apps/web/src/components/service-map/service-map-view.tsx) requests Cloudflare and PlanetScale statistics alongside integration inventory. Those [API handlers](../apps/api/src/routes/internal/query-engine.http.ts) execute two Cloudflare and three PlanetScale warehouse queries. This reconfirms an opportunity already described in [service-map architecture](service-map-architecture.md): skip integration-specific statistics when their absence has been established, while preserving loading, refresh, and newly connected integration behavior.

Each of these five query contexts appeared 18 times in the measured day: **90 calls total**. Inventory was not correlated with those calls, so the avoidable fraction is unknown. This is lower priority than trace-alert reuse and the measured series-cap rewrite.

## Evidence, limits, and next implementation order

Prioritize raw-alert authentication diagnosis for correctness, the first review's metric-specific trace-alert projection for frequent-query cost, then the measured series-cap rewrite. Investigate alert-bucket reuse with rule/cache correlation before implementation. Retain the current service-facet default.

Benchmark settings and gateway limitations match the first review: ClickHouse `25.3.17.3`, two threads, 15-second timeout, existing memory limits, result and condition caches disabled, server statistics from `FORMAT JSON`, no query logs/EXPLAIN/memory/ProfileEvents. Historical production data was populated but not an isolated snapshot. No ingestion or warehouse configuration was changed. Frequency counts are captured spans rather than sampling-adjusted totals.

Artifacts are local and gitignored under `apps/api/scripts/.bench/second-scan-2026-09-05/`; tenant-bearing SQL is not committed:

- [Series suite](../apps/api/scripts/.bench/second-scan-2026-09-05/series-suite.json), [160-measurement run](../apps/api/scripts/.bench/second-scan-2026-09-05/series-run.json), and [read](../apps/api/scripts/.bench/second-scan-2026-09-05/series-read-comparison.json), [server](../apps/api/scripts/.bench/second-scan-2026-09-05/series-server-comparison.json), and [wall](../apps/api/scripts/.bench/second-scan-2026-09-05/series-wall-comparison.json) comparisons.
- [Repeated SQL counts](../apps/api/scripts/.bench/second-scan-2026-09-05/duplicates.json), [cache outcomes](../apps/api/scripts/.bench/second-scan-2026-09-05/cache-outcomes.json), [cache read reasons](../apps/api/scripts/.bench/second-scan-2026-09-05/cache-read-reasons.json), and [alert error classes](../apps/api/scripts/.bench/second-scan-2026-09-05/alert-error-classes.json), with corresponding SQL files.
- [Facet catalog module](../apps/api/scripts/.bench/second-scan-2026-09-05/facets-suite.ts), [isolated builder copy](../apps/api/scripts/.bench/second-scan-2026-09-05/services-minute-experiment.ts), and [three-run discovery results](../apps/api/scripts/.bench/second-scan-2026-09-05/discovery-run.json).

Reproduce the series run with a fresh output path:

```sh
infisical run --env=prod --silent -- bun \
  apps/api/scripts/.bench/frequent-2026-09-05/gateway-bench.ts \
  apps/api/scripts/.bench/second-scan-2026-09-05/series-suite.json \
  apps/api/scripts/.bench/second-scan-2026-09-05/series-repeat.json 20

bun run bench:queries compare \
  apps/api/scripts/.bench/second-scan-2026-09-05/series-baseline.json \
  apps/api/scripts/.bench/second-scan-2026-09-05/series-candidate.json \
  --metric meanReadBytes --threshold 10 --min-delta 0 --fail-on-regression \
  --out apps/api/scripts/.bench/second-scan-2026-09-05/rechecked-reads.json
```

**Rules applied:** `schema-pk-filter-on-orderby` preserves tenant/time filtering; no improved index pruning is claimed without a plan. `query-index-skipping-indices` rules out speculative index advice. `query-mv-incremental` and architecture rule `decision-real-time-preaggregation` support evaluating existing aggregate tiers, but the measured facet regression overrides a generic preference for preaggregation. The window-ranking and cache-reuse proposals are workload-derived candidates, not universal ClickHouse recommendations.
