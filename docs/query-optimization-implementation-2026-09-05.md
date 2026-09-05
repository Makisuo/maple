# Query optimization implementation — 2026-09-05

Implemented the measured trace-alert and series-cap optimizations from the [first review](query-optimization-review-2026-09-05.md) and [second scan](query-optimization-second-scan-2026-09-05.md), plus scheduler-scoped bucket reuse. Replaying the actual modified builders against populated historical windows reduced alert reads by **51–74%** and capped-timeseries reads by **about 50%**.

## Changes

- **Selected trace metrics:** sub-hour service-overview queries compute only the aggregates the selected metric needs. Count and error-rate alerts no longer read or merge duration digests. Weighted counts, actual sample counts, tenant/time predicates, tier boundaries, and the complete output schema remain intact. Unused metric fields are zero; `allMetrics: true` still computes every metric. Hour-multiple single-metric requests retain their existing separate weighted-aggregate route.
- **Series caps:** nested window queries calculate each group's peak, rank by peak descending and group name ascending, and retain every bucket of the selected groups. The base query occurs once. This removes repeated work from the previous two-reference CTE; ordinary CTE references can re-execute their defining query. Ties now have a deterministic group-name order. Typed output columns and uncapped behavior are preserved. See [ClickHouse WITH documentation](https://clickhouse.com/docs/reference/statements/select/with).
- **Alert bucket reuse:** one scheduler invocation can share structured-query bucket reads across reducers. Keys include the complete tenant, source specification, exact window, resolved bucket width, and warehouse instance identity. The cache holds at most 32 entries, successful entries expire after 90 seconds, and failures expire immediately. Each rule still validates and reduces independently. Raw SQL bypasses this cache because it can contain volatile functions. The existing result-cache policy is unchanged. The cache is created at the scheduler boundary so in-flight I/O remains owned by one invocation, following [Cloudflare's request ownership constraint](https://developers.cloudflare.com/workers/observability/errors/).
- **Authentication diagnostics:** warehouse errors redact echoed tokens from both messages and retained causes while preserving their classification and diagnostic text.

The observed 13,956 repeated trace-alert executions are an opportunity count, not a measured reduction from the new cache. Only matching structured sources within the same invocation qualify; different source specifications can still compile to identical SQL.

## Measurements of the implementation

The baseline was exported before changing the builders. Eight baseline/candidate pairs then ran with 20 measured executions and one warmup per variant, interleaved with rotating order: **320 measurements**. Inputs and historical windows were identical within each pair.

| Case                                    | Mean bytes read, before → after | Mean server ms, before → after | p95 wall ms, before → after |
| --------------------------------------- | ------------------------------: | -----------------------------: | --------------------------: |
| Service-filtered count alert            |               838,559 → 222,325 |                  23.27 → 12.94 |             212.55 → 161.33 |
| Service-filtered error-rate alert       |               838,559 → 256,383 |                  23.41 → 12.64 |             160.34 → 151.57 |
| All-services count alert                |             1,268,988 → 579,000 |                  21.48 → 12.14 |             160.67 → 163.03 |
| All-services error-rate alert           |             1,268,988 → 621,276 |                  23.34 → 17.98 |             167.91 → 233.16 |
| Environment-filtered timeseries, cap 12 |         75,361,105 → 37,680,401 |                  99.30 → 50.99 |             290.81 → 192.30 |
| Environment-filtered timeseries, cap 3  |         75,361,105 → 37,680,401 |                  94.66 → 52.77 |             266.31 → 206.44 |
| Other count timeseries, cap 12          |          10,357,204 → 5,155,738 |                  39.53 → 22.50 |             185.91 → 195.56 |
| Other count timeseries, cap 3           |          10,357,177 → 5,155,738 |                  59.30 → 21.97 |             188.91 → 158.34 |

All measured hashes were stable and matched between variants. Alert comparisons project the selected metric plus bucket, group, weighted count, actual sample count, and estimated count; intentionally unused metric fields are not compared. Series-cap comparisons use complete rows.

The CLI's bytes and mean-server-time gates passed for every case. The first p95 wall-time gate failed for the all-services error-rate alert. A focused, interleaved recheck with **40 measurements per variant** passed: p95 **201.93 → 173.97 ms**, mean server time **39.23 → 20.93 ms**, with the same read reduction and matching results. This shows variable tail latency; the repeatable result is less warehouse work, not a guarantee that every request is faster.

Settings: ClickHouse `25.3.17.3`, two threads, 15-second timeout, existing memory limits, query-result and condition caches disabled. The Tinybird gateway adapter collects server statistics from `FORMAT JSON`; query logs, EXPLAIN, memory, and ProfileEvents are unavailable. Historical production data was populated but not an isolated snapshot. A separate local correctness test exercises 5,000 groups and 50,000 rows under a 128 MiB query memory limit; this does not measure production memory savings.

## Authentication finding

All 5,616 historical invalid-token failures reported **signature verification failure**, between **2026-09-04 18:36:52.406 and 20:41:27.573 UTC** in the captured window. The investigation redacted credentials before returning diagnostic text. A fresh organization-scoped JWT minted through the existing implementation successfully queried the real scoped traces table through the Tinybird SDK.

The historical failure does not currently reproduce. No token expiry bug was established, and no credential or routing configuration was changed. The implemented fix prevents future upstream token echoes from appearing in exposed warehouse errors; it does not claim to repair the historical signing mismatch.

## Validation and artifacts

- Query-engine suite: **1,398 tests passed** across 63 files.
- API alert and query-engine runtime suites: **101 tests passed**, including concurrent reuse across reducers, tenant/warehouse/window isolation, retry after failure or cancellation, expiration, capacity eviction, raw-SQL bypass, and actual sample counts.
- Populated ClickHouse parity: **42 service-overview tests** covering selected metrics at five- and fifteen-minute buckets and existing all-metric minute/hour/raw boundaries, plus **10 series-cap tests** covering peak selection, ties, negative/null/non-finite values, tenant isolation, complete bucket retention, and high cardinality.
- Live SQL catalog: **343 checks passed** against compiled queries, including decoding and tenant scope.
- API and query-engine typechecks, benchmark typecheck, targeted lint, and formatting passed.

The service-facet minute-default experiment remains rejected because it increased reads. No warehouse schema or materialization was added. Applied rules: `schema-pk-filter-on-orderby` preserves tenant/time filtering, and `query-index-skipping-indices` requires plan evidence before recommending indices; no new index or pruning improvement is claimed here.

Local, gitignored evidence is under `apps/api/scripts/.bench/implementation-2026-09-05/`:

- `suite.ts`, `baseline-suite.json`, and `candidate-suite.json` contain the actual builder catalogs.
- `interleaved-run.json`, `final-baseline.json`, `final-candidate.json`, and the three `*-comparison.json` files contain the main results and CLI gates.
- `tail-recheck-run.json` and `tail-recheck-comparison.json` contain the independent tail-latency recheck.
- `auth-reasons.json` contains sanitized historical diagnostics; `auth-probe.ts` implements the current credential probe.
- `query-engine-tests-final.log`, `alert-tests-final.log`, `parity-final.log`, `catalog-analyzer.log`, `api-typecheck-final.log`, and `lint-final.log` contain validation output.

Tenant-bearing SQL and credential material are not committed.
