# Frequent-query optimization review — 2026-09-05

**Prioritize metric-specific trace alert queries.** The tested count/error-rate variants read **51–74% fewer bytes** and used **10–24% less mean server time**. The returned values consumed by alert evaluation matched. End-to-end p95 did not improve consistently, so this is evidence of reduced warehouse work, not a demonstrated latency improvement for every alert.

This investigation made no production query, schema, configuration, or deployment changes. Experimental SQL and benchmark adapters are saved locally under `apps/api/scripts/.bench/frequent-2026-09-05/`.

## What runs frequently

Window: **2026-09-03 23:48:28 through 2026-09-04 23:48:28 UTC**. There were **226,562 captured `WarehouseQueryService.executeSql` spans**, covering 163 context labels. These are observed executions, not a sampling-adjusted traffic estimate.

| Query context                 |  Calls | Share of calls | Mean recorded duration | Assessment                                                                                               |
| ----------------------------- | -----: | -------------: | ---------------------: | -------------------------------------------------------------------------------------------------------- |
| `alertRawQuery`               | 97,436 |          43.0% |                 153 ms | Largest volume; sampled queries are already small. Investigate repeated executions before rewriting SQL. |
| `tracesAlertEval`             | 61,449 |          27.1% |                 114 ms | Best measured query optimization: avoid computing unused metrics.                                        |
| `errorIssuesScan`             | 28,979 |          12.8% |                 130 ms | Already reads the minute fingerprint rollup for steady-state scans.                                      |
| `anomalyTraceSignalsCurrent`  |  5,020 |           2.2% |                 133 ms | Already uses hourly aggregates.                                                                          |
| `anomalyLogVolumeCurrent`     |  5,020 |           2.2% |                 125 ms | Already uses hourly aggregates.                                                                          |
| `anomalyErrorSpikeCurrent`    |  5,020 |           2.2% |                 121 ms | Sample replay was small; lower priority.                                                                 |
| `serviceMapResolutionsRollup` |  1,732 |           0.8% |                 212 ms | Child-table substitution has limited benefit on the populated case.                                      |
| `serviceMapRollup`            |  1,732 |           0.8% |                 208 ms | Larger scans, but substantially less frequent than alerts.                                               |
| `tracesTimeseries`            |    693 |           0.3% |                 467 ms | Worth a later targeted review of long windows and series capping.                                        |

Recorded duration is the duration of the warehouse execution span, including external-call overhead; it is not CPU time or billable compute. Mean duration was calculated from summed durations and call counts, not by averaging percentiles.

The CLI's `fetch --top 10000` captured all 508 nonempty fingerprints in this window. Its miner groups by fingerprint and selects `any(query.context)`, which can attribute multiple callers to one label. I therefore independently grouped the same time window by **context and fingerprint** for the table above. That read also included 12 spans without fingerprints. The corrected ranking splits anomaly current/baseline queries that the fingerprint-only export combined.

## Measured experiments

The final run interleaved baseline and candidate cases with rotating order: **20 measured executions per variant, one warmup**, 240 measured requests in total. Both variants used identical tenant/window/filter inputs, two threads, a 15-second query timeout, and disabled result and condition caches. Existing memory limits were preserved. Filesystem/OS caches were not flushed.

Measurements came from the production Tinybird ClickHouse gateway, version `25.3.17.3`. Windows were fixed and historical, but the database was not an isolated snapshot. Results and read volume were stable within the final run. Memory and ProfileEvents were unavailable.

| Case                                    | Mean bytes read, before → after | Reduction | Mean server ms, before → after | p95 wall ms, before → after |
| --------------------------------------- | ------------------------------: | --------: | -----------------------------: | --------------------------: |
| Service-filtered count alert            |               838,559 → 222,325 |     73.5% |                  23.18 → 17.94 |             163.87 → 180.19 |
| Service-filtered error-rate alert       |               838,559 → 256,383 |     69.4% |                  20.94 → 18.75 |             160.79 → 159.63 |
| All-services count alert                |             1,268,988 → 579,000 |     54.4% |                  22.39 → 16.95 |             180.55 → 174.87 |
| All-services error-rate alert           |             1,268,988 → 621,276 |     51.0% |                  23.05 → 20.29 |             165.66 → 196.66 |
| Address resolution, empty result        |         19,225,332 → 16,215,944 |     15.7% |                  41.45 → 30.76 |             183.62 → 223.45 |
| Address resolution, four returned edges |       345,653,334 → 338,765,616 |      2.0% |                334.62 → 318.37 |             553.90 → 512.17 |

Read-byte and mean-server-time comparison gates passed. The p95 wall-time gate failed for the all-services error-rate case (+18.7%) and empty address-resolution case (+21.7%). Earlier sequential runs also showed variable latency; retain the lower-read conclusion without claiming a universal response-time improvement.

**Trace alerts:** [the service-overview branch](../packages/query-engine/src/ch/queries/traces.ts) computes duration sums, t-digests, and Apdex counts unconditionally. [Alert evaluation](../packages/query-engine/src/runtime/query-engine.ts) consumes one selected metric plus the actual sample count. The experiment wrapped the existing query with a projection of the needed columns, allowing ClickHouse to discard unused aggregate work. Read-row counts stayed identical, while read bytes fell.

Result hashes compare `bucket`, `groupName`, `count`, `spanCount`, and `estimatedSpanCount`, plus `errorRate` for error-rate cases. All four cases returned two rows and matched across all 20 executions of each variant. This verifies the tested alert inputs, **not full-row equivalence with the original all-metrics output**. The explicit projection is recorded in the artifacts.

The implementation candidate is to make this tier honor the existing `METRIC_NEEDS` convention, preserving `allMetrics` behavior, weighted throughput, actual `spanCount`, and raw/rollup boundary semantics. Before shipping, exercise count, error rate, latency, Apdex, partial-minute seams, sampling, and capability fallbacks through the existing parity tests. The current SQL fingerprint does not identify the selected alert metric, so the 61,449 calls cannot all be counted as beneficiaries without checking the rule mix.

**Address resolution:** replacing only the child-side raw `traces` scan with `service_map_children` preserved all returned columns in the tested windows. The populated case returned four matching rows, but saved only 2% of bytes; the expensive parent scan remains. This is a lower-priority candidate. General correctness still needs checks for missing/old materializations and malformed empty span IDs, since the child MV excludes empty `ParentSpanId` values. Keep join multiplicity intact; an ANY join can discard distinct resolved targets.

**Other frequent queries:** the three sampled raw-alert statements read approximately 19–29 KB and took 5–9 ms of server execution in the discovery run; two returned no rows. Their large call volume warrants inspection of identical SQL/windows and cache misses, but does not prove those requests are redundant. A 90-second evaluation cache already exists in [QueryEngineService](../apps/api/src/services/warehouse/QueryEngineService.ts). The sampled error-issue scan read 41 KB from `error_fingerprints_minutely` and returned no rows. Empty scans also drive issue auto-resolution, so skipping them requires lifecycle analysis. These are triage observations from three-run replays, not validated optimizations.

## Benchmark tooling findings

The existing CLI successfully mined the workload, and the reusable `runSuite` plus CLI `compare` produced the final evidence. Direct production replay required a local adapter because:

1. `run` unconditionally requests `log_queries` and related settings; Tinybird rejects them. Its gateway also omits `X-ClickHouse-Summary`. The adapter obtains elapsed time, rows, and bytes from `FORMAT JSON` statistics and explicitly records missing query-log metrics.
2. `benchmarkSql` appends control settings to existing settings. Captured SQL already has `max_execution_time`, and Tinybird rejects duplicate names. The adapter deduplicates the scalar settings used in this experiment, preserving the final override.
3. `inspect` uses `TabSeparatedRaw`, which the gateway rejects. Retrying with JSON reached a separate rejection: `EXPLAIN` is unsupported. No production index plan was available.
4. The available older BYO server runs ClickHouse `24.8.14.39`, which rejects `use_query_condition_cache`. Local ClickHouse was empty. Neither was used as performance evidence.

These limitations are recorded rather than silently treated as successful CLI runs. The adapter is experimental and gitignored; it is not a generalized backend-support change.

## Evidence and reproduction

All SQL containing tenant literals stays in the gitignored artifact directory. Principal files:

- [Frequency and total-duration ranking](../apps/api/scripts/.bench/frequent-2026-09-05/frequency-summary.json), backed by [context/fingerprint rows](../apps/api/scripts/.bench/frequent-2026-09-05/frequency-by-context.json).
- [Interleaved suite](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved-suite.json) and [full run](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved.json).
- [Read-byte comparison](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved-read-comparison.json), [server-time comparison](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved-server-comparison.json), and [wall-time comparison including regressions](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved-wall-comparison.json).
- [Gateway benchmark adapter](../apps/api/scripts/.bench/frequent-2026-09-05/gateway-bench.ts), [result projections](../apps/api/scripts/.bench/frequent-2026-09-05/interleaved-projections.json), and [15-case discovery replay](../apps/api/scripts/.bench/frequent-2026-09-05/discovery-run.json).

Run from the repository root, using a fresh output name to preserve this evidence:

```sh
infisical run --env=prod --silent -- bun \
  apps/api/scripts/.bench/frequent-2026-09-05/gateway-bench.ts \
  apps/api/scripts/.bench/frequent-2026-09-05/interleaved-suite.json \
  apps/api/scripts/.bench/frequent-2026-09-05/repeat.json 20 \
  apps/api/scripts/.bench/frequent-2026-09-05/interleaved-projections.json

bun run bench:queries compare \
  apps/api/scripts/.bench/frequent-2026-09-05/interleaved-baseline.json \
  apps/api/scripts/.bench/frequent-2026-09-05/interleaved-candidate.json \
  --metric meanReadBytes --threshold 10 --min-delta 0 --fail-on-regression \
  --out apps/api/scripts/.bench/frequent-2026-09-05/rechecked-reads.json
```

**Rules checked:** per `schema-pk-filter-on-orderby`, sampled queries retain tenant and time predicates; no index-pruning improvement is claimed without a plan. Per `query-join-filter-before`, both service-map inputs are filtered before joining. Per `query-join-use-any`, the resolution candidate preserves all matches. Per `query-join-choose-algorithm`, no algorithm recommendation is made without memory evidence. Per `query-index-skipping-indices`, no speculative index is proposed. The workflow follows [ClickHouse query optimization guidance](https://clickhouse.com/docs/guides/clickhouse/performance-and-monitoring/query-optimization): identify recurring work, compare controlled executions, and separate measured improvements from hypotheses.
