# Query benchmarking

Use `bun run bench:queries` from the repository root. The CLI compiles the real
query catalog, runs fixed workloads against ClickHouse, saves evidence, and compares
implementations by **case ID**, so changing SQL does not lose the baseline.

The reusable, driver-free API lives at `@maple/query-engine/benchmark`. The CLI is
`apps/api/scripts/bench-queries.ts`; it owns credentials, HTTP, files, and printing.
No benchmark code is added to the query engine's root barrel or production paths.

This replaces the previous `@maple/query-engine/sql-catalog` and
`@maple/query-engine-integrations/catalog` entry points. The core fixtures and
coverage checks now live in `packages/query-engine/src/benchmark/`; integration
fixtures live in `packages/query-engine-integrations/src/benchmark/`. The shared
`apps/api/scripts/query-bench/catalog.ts` composes them for both the CLI and the
ClickHouse analyzer sweep. Decoder, tenant-scope, routing, and SQL snapshot checks
remain in place. Every named case is analyzed, including cases sharing a SQL
fingerprint but carrying different decoder metadata.

## Measure a change

1. Choose a populated, stable dataset and a fixed tenant/window/filter set.
2. Export the suite and run a baseline **before editing the query**.
3. Change the builder, re-export the same suite, and run the candidate against the
   same data with identical controls.
4. Compare read volume and memory as well as latency. Inspect the saved SQL and
   plans to explain the difference. Run the query's correctness/parity tests.

```sh
# Local ClickHouse from docker-compose.development.yml
export CLICKHOUSE_URL=http://localhost:8123
export CLICKHOUSE_USER=maple
export CLICKHOUSE_PASSWORD=maple
export CLICKHOUSE_DATABASE=default

# Edit this example's inputs to match a populated snapshot first.
bun run bench:queries catalog \
  --suite apps/api/scripts/bench-suites/services.ts \
  --out apps/api/scripts/.bench/baseline-suite.json

bun run bench:queries run apps/api/scripts/.bench/baseline-suite.json \
  --dataset services-snapshot-2026-09-01 --runs 20 --warmup 2 --threads 2 \
  --verify-results --out apps/api/scripts/.bench/baseline.json

# After changing the query builder, compile again; replaying baseline-suite.json
# would execute the old SQL, even though the TypeScript implementation changed.
bun run bench:queries catalog \
  --suite apps/api/scripts/bench-suites/services.ts \
  --out apps/api/scripts/.bench/candidate-suite.json

bun run bench:queries run apps/api/scripts/.bench/candidate-suite.json \
  --dataset services-snapshot-2026-09-01 --runs 20 --warmup 2 --threads 2 \
  --verify-results --out apps/api/scripts/.bench/candidate.json

bun run bench:queries compare \
  apps/api/scripts/.bench/baseline.json apps/api/scripts/.bench/candidate.json \
  --metric meanReadBytes --threshold 10 --min-delta 1048576 \
  --fail-on-regression --out apps/api/scripts/.bench/comparison.json

# Inspect the executed SQL, including the benchmark's thread/settings controls.
bun run bench:queries inspect apps/api/scripts/.bench/candidate.json \
  --out apps/api/scripts/.bench/candidate-plans.json
```

Artifacts default to `apps/api/scripts/.bench/`, which is gitignored. They contain
SQL literals and may contain tenant identifiers. Target credentials are not saved.
`--dataset` is a revision label, not an automatic snapshot or a data-drift detector.
The CLI does not create tables, seed data, deploy schema changes, or flush global
caches/logs. A benchmark against empty tables is not performance evidence; zero-row
reads produce a warning (they can also be legitimate optimized metadata reads).

## Select the workload

```sh
# Export every current core and integration fixture (no credentials required).
bun run bench:queries catalog --out apps/api/scripts/.bench/catalog.json

# Filter by case ID or context substring; an empty selection fails.
bun run bench:queries catalog --match services_facets
bun run bench:queries run apps/api/scripts/.bench/catalog.json --match services_facets

# Existing production-trace workflow remains available.
bun run bench:queries fetch --since 24h --top 20 \
  --out apps/api/scripts/.bench/production-samples.json
```

The catalog uses `org_sql_catalog`, synthetic dates, and example filters. It covers
the query shapes used by analyzer tests; it is not a representative performance
dataset. It deliberately retains distinct cases even when their fingerprints match.
`fetch` uses `TINYBIRD_HOST`, `TINYBIRD_TOKEN`, and optionally
`MAPLE_INTERNAL_ORG_ID` to mine captured warehouse SQL. Query and run failures are
reported, never silently removed from the suite.

For real measurements, a TypeScript module exports a `Suite`. Use
`caseFromCompiled(id, compiled, inputs)` to preserve a stable experiment identity
and a canonical record of every input. Inputs must be JSON-compatible; convert Sets,
Maps, and Dates explicitly. Include builder options, capability choices,
and bucket sizes in `inputs`, as well as compile parameters. Compilation happens
before timing. `CH.compileUnion` handles union builders; `CH.compile` handles
ordinary builders. The checked example is
[`services.ts`](../apps/api/scripts/bench-suites/services.ts).

```ts
import { Effect } from "effect"
import * as CH from "@maple/query-engine/ch"
import { caseFromCompiled, type Suite } from "@maple/query-engine/benchmark"

const inputs = {
	orgId: "your-snapshot-org",
	startTime: "2026-09-01 10:30:00",
	endTime: "2026-09-01 14:15:00",
}
const compiled = await Effect.runPromise(CH.compileUnion(CH.servicesFacetsQuery(), inputs))
export default {
	source: "services-workload",
	samples: [caseFromCompiled("services/facets/partial-hours", compiled, inputs)],
} satisfies Suite
```

Use separate IDs for narrow/wide windows, small/large tenants, selective/unselective
filters, and raw/rollup/capability routes. A suite module executes local TypeScript;
load modules you would normally trust to run in this checkout. Raw cases can also
provide `id`, `inputs`, `context`, `profile`, `fingerprint`, and `sampleSql` directly.
Without explicit inputs, the runner records the original SQL as its input identity;
SQL changes then require an explicit fixed-input case to be comparable. Legacy
trace files remain valid input; old unversioned **run reports** must be regenerated.

## Interpret the evidence

- Runs are serial. Case order rotates each round to reduce order bias; warmups are
  excluded. This measures isolated-query behavior, not concurrency throughput.
- Every iteration retains its query ID, full-response wall time, server time,
  read rows/bytes, result rows, memory, and query-log `ProfileEvents`. The report
  includes p50/p95/p99, sample standard deviation, exact executed SQL, server
  version, target database, and controls. Percentiles use nearest rank; p95/p99
  from a handful of runs are especially noisy.
- Query-log collection starts after all timed queries. `--log-wait 12` bounds the
  flush-polling window; HTTP requests have their own timeout. `--log-wait 0` makes
  one immediate pass. `--cluster NAME` reads `clusterAllReplicas` for load-balanced
  clusters; otherwise logs are node-local. Only initial `QueryFinish` records are
  included. Missing/denied logs fall back to HTTP summaries, with warnings and
  explicit missing memory/counters, never zero-filled values.
- Query result and condition caches are disabled. Default `--cache warm` permits
  filesystem/uncompressed caches; `--cache bypass` also disables those per query.
  Neither mode clears the OS page cache. This is not a guarantee of cold disk reads.
- `--threads N` pins parallelism. `--timeout N` sets the query limit in seconds,
  plus a five-second HTTP grace period. These controls override matching inline
  settings; other existing SQL settings remain intact. Catalog builders are
  compiled before runtime profile selection: apply the production settings in a
  custom suite when profile fidelity matters. Captured SQL already contains them.
- `inspect` accepts either a suite or a run report. It saves `EXPLAIN indexes = 1,
projections = 1`, `EXPLAIN PIPELINE`, and database table definitions, ordering
  keys, partition keys, and row/byte metadata. Prefer run reports for plans using
  the settings actually measured. Failed plans are saved and exit nonzero.

`--verify-results` requests JSONEachRow and stores SHA-256 hashes, not result data.
Object keys are canonicalized. `--result-order unordered` sorts rows while retaining
duplicates; `--result-order ordered` also verifies ordering. This is exact equality,
not a tolerance test: approximate aggregates, nondeterministic tie-breaking, floating
point changes, or concurrent ingestion may change hashes. Use domain parity tests
for these queries; do not call an unstable result a verified optimization.

`compare` supports `p95WallMs`, `meanServerMs`, `meanReadRows`, `meanReadBytes`, and
`meanMemoryUsage`. `--threshold` is a percentage and `--min-delta` uses the metric's
units (ms, rows, or bytes); **both** must be exceeded to flag a regression. A positive
increase from zero is handled explicitly. With `--fail-on-regression`, missing/new
cases, failed/partial runs, changed results, missing metrics, and incompatible
target/version/dataset/controls/inputs also fail. Normal reports and comparison
JSON are written before failure, so an agent or CI can inspect the evidence.

## Why these measurements

This is an observability workload with repeated aggregations and raw/rollup routes.
The tooling choices are **derived** from the documented optimization workflow:
measure comparable executions and identify whether reads, memory, or CPU explain
the change. It does not automatically recommend an index or materialized view.

- Per `schema-pk-filter-on-orderby` and `query-index-skipping-indices`, inspect
  pruning and granule selection before changing indexes. The plan flags and the
  required condition-cache/skip-index settings for recent versions are documented
  in [ClickHouse EXPLAIN](https://clickhouse.com/docs/sql-reference/statements/explain).
- Per `query-join-choose-algorithm`, `query-join-filter-before`, and
  `query-join-use-any`, evaluate read volume and memory alongside correctness when
  changing joins. Keep the returned row multiplicity contract intact.
- Per `decision-real-time-preaggregation`, keep raw and rollup routes as separate
  workload cases. A new preaggregation requires its own freshness/correctness
  decision; see [incremental materialized views](https://clickhouse.com/docs/materialized-view/incremental-materialized-view).
- **Official** metric semantics and initial-query filtering:
  [system.query_log](https://clickhouse.com/docs/operations/system-tables/query_log).
  Investigation workflow:
  [query optimization](https://clickhouse.com/docs/optimize/query-optimization).

## Validate tooling changes

```sh
bun run --cwd packages/query-engine test -- src/benchmark/benchmark.test.ts
bun run --cwd packages/query-engine test -- src/benchmark/catalog.test.ts
bun run --cwd packages/query-engine-integrations test -- src/benchmark/catalog.test.ts
bun run --cwd packages/query-engine typecheck
bun run --cwd apps/api bench:typecheck

# Real migrations, all catalog cases through the analyzer, and a populated CLI
# run/compare/inspect test. Uses its own temporary database, removed afterward.
CLICKHOUSE_E2E=1 CLICKHOUSE_E2E_URL=http://127.0.0.1:8123 \
  bun run --cwd apps/api test -- src/services/warehouse/query-benchmark.clickhouse.e2e.test.ts
```

The live test inserts 50,000 spans across two tenants, verifies 40,000 belong to
the target tenant, and checks both raw and rollup implementations of the same
all-metrics trace chart plus the service-facets query. It verifies identical
results, non-empty query-log measurements, fewer reads from the rollup, failure
of the reverse regression gate, and saved index/pipeline plans. A minute-aligned
window isolates the rollup benefit; it does not imply a speedup for every window.
Uniform durations make exact quantile equality meaningful for this smoke test.
Command logs and reports remain under `apps/api/scripts/.bench/maple_query_benchmark_e2e_*/`.
The existing service-overview parity tests separately exercise partial-window seams.
