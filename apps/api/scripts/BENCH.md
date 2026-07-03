# bench-queries — ClickHouse query benchmarking

A small CLI for measuring the real cost of our dashboard queries.

It replays the exact SQL we already ran in production (captured on every
`WarehouseQueryService.executeSql` span as `db.query.text`), records wall-time

- server-side stats + EXPLAIN plans, and lets you diff two runs so you can
  prove whether a DSL change actually moved the number.

## Commands

```
bun bench:fetch    [--context name] [--profile name] [--since 24h]
                   [--top 20] [--out path] [--org id]
                   # mine recent db.query.text spans from prod traces → JSON

bun bench:suite    [--org id] [--since 24h] [--trace-id id] [--service name]
                   [--search phrase] [--attr-key k] [--attr-value v]
                   [--attr-scope span] [--table-map from=to,...] [--out path]
                   # compile the committed DSL benchmark suite → JSON (same
                   # shape as `fetch`, so `run`/`inspect`/`compare` replay it)

bun bench:run      <file> [--runs 5] [--warmup 1] [--out path]
                   # replay each query N times and report aggregated stats

bun bench:inspect  <file>
                   # run EXPLAIN and EXPLAIN PIPELINE for each query

bun bench:compare  <a.json> <b.json> [--max-regression-pct N]
                   # diff two run outputs (p95 wall, read bytes, memory);
                   # exits non-zero if any case's p95 regresses beyond N%
```

Output JSONs land in `apps/api/scripts/.bench/` by default (gitignored).

## Two ways to get a query set

- **`fetch`** mines whatever prod actually ran for a context label — great for
  chasing a specific slow query, but not repeatable (the fingerprints drift as
  traffic changes).
- **`suite`** compiles a **committed, repeatable** set of ~13 representative
  cases (needle-in-haystack body search, trace point lookup, attribute
  equality/contains filters, list scans, facets, autocomplete, plus canaries)
  straight from the `@maple/query-engine` DSL, so the benchmark runs the exact
  SQL production emits. Definitions live in
  [scripts/bench/suite.ts](bench/suite.ts). Pass `--trace-id` / `--service` /
  `--attr-key` / `--attr-value` that exist in the target window for
  representative timing — the two lookup cases fall back to zero-row
  placeholders (with a warning) otherwise.

## A/B: schema-change spike (e.g. sort-key experiment)

`suite --table-map` rewrites `FROM`/`JOIN` table names in the compiled SQL so
you can benchmark the same queries against shadow tables without recompiling.
Rules are whole-identifier and longest-first, so `traces=traces_t2` never
touches `trace_detail_spans` or `traces_aggregates_hourly`.

```
# control vs candidate tables, same window/org
bun bench:suite --org org_x --trace-id <id> --service <svc> \
  --out .bench/suiteA.json
bun bench:suite --org org_x --trace-id <id> --service <svc> \
  --table-map "traces=traces_t2,logs=logs_l2" --out .bench/suiteB.json

bun bench:run .bench/suiteA.json --out .bench/resA.json   # CLICKHOUSE_URL = dedicated CH
bun bench:run .bench/suiteB.json --out .bench/resB.json
bun bench:compare .bench/resA.json .bench/resB.json --max-regression-pct 25
```

Run A/B against a **dedicated ClickHouse** (docker/staging), not a Tinybird
branch — Tinybird branches share prod compute, so wall-time is noisy (lean on
`read rows`/`read bytes`, which are deterministic). The `inspect` command's
`EXPLAIN PIPELINE` tells you whether `optimize_read_in_order` actually engaged
for the candidate sort key.

## Implementation

Built on Effect v4 end-to-end:

- **CLI** — `effect/unstable/cli` (`Command` / `Flag` / `Argument`). The command
  tree gives `--help`, per-subcommand help, `--version`, shell `--completions`,
  and arg validation for free; no hand-rolled parser.
- **Runtime** — `@effect/platform-bun` `BunRuntime.runMain` with
  `BunServices.layer` providing the CLI `Environment` (FileSystem, Path,
  Terminal, Stdio). Exits non-zero on failure with structured error logging.
- **Config** — env resolved via `Config` (`CLICKHOUSE_*`, `TINYBIRD_*`).
- **Errors** — `Schema.TaggedErrorClass`: `MissingConfigError`,
  `HttpRequestError`, `UpstreamStatusError`, `BenchFileError`,
  `InvalidDurationError`.
- **Services** — ClickHouse + Tinybird HTTP clients as `Context.Service`s wired
  through a `Layer`; file IO via the core `FileSystem` service. Each subcommand
  handler is an `Effect.fn` so its span name shows up in traces.

## Env

The tool resolves env vars with Effect's `Config` (not `Env.layer`), so it
works in a checkout that doesn't have the full API config (Clerk keys, ingest
secrets, etc.) set up. You only need warehouse credentials.

| Var                     | Required by        | Purpose                                        |
| ----------------------- | ------------------ | ---------------------------------------------- |
| `TINYBIRD_HOST`         | `fetch`            | Source — where prod self-instrumentation lives |
| `TINYBIRD_TOKEN`        | `fetch`            | Bearer token for the Tinybird workspace        |
| `CLICKHOUSE_URL`        | `run`, `inspect`   | Target — where we replay queries               |
| `CLICKHOUSE_USER`       | `run`, `inspect`   | Default `default`                              |
| `CLICKHOUSE_PASSWORD`   | `run`, `inspect`   | Empty when CH allows anonymous local conns     |
| `CLICKHOUSE_DATABASE`   | `run`, `inspect`   | Default `default`                              |
| `MAPLE_INTERNAL_ORG_ID` | `fetch` (optional) | Default `internal` — matches the gateway       |

`run` and `inspect` deliberately do **not** support a Tinybird-SDK fallback.
They need `query_id` and `system.query_log` for memory + ProfileEvents, which
only the raw ClickHouse HTTP interface exposes.

## Worked example — optimizing `errorsByType`

1. **Capture baseline.** Pull the recent slow queries for one context label:

    ```
    bun bench:fetch --context errorsByType --since 24h --top 5 \
      --out .bench/errorsByType-baseline.json
    ```

    Skim the table to confirm the queries look real — they should start with
    `SELECT`, contain `OrgId =`, and the p95 column should match the staging
    trace dashboard.

2. **Measure baseline.** Replay them locally, 5 runs each:

    ```
    bun bench:run .bench/errorsByType-baseline.json --runs 5 \
      --out .bench/errorsByType-before.json
    ```

    Look at `read bytes` and `mem` — those are usually the more interesting
    columns than wall time for a managed-CH dashboard query.

3. **Inspect the plan.** Find out what ClickHouse is doing:

    ```
    bun bench:inspect .bench/errorsByType-baseline.json
    ```

    In particular, EXPLAIN PIPELINE shows whether the optimizer collapsed
    filters into a `PREWHERE` and how many threads it's using.

4. **Iterate on the DSL.** Edit
   [packages/query-engine/src/ch/queries/errors.ts](../../../packages/query-engine/src/ch/queries/errors.ts)
   — add a `PREWHERE`, narrow the projection, switch from `Traces` to an
   already-aggregated MV, whatever the EXPLAIN suggested.

5. **Re-run.** Either deploy the change to staging and run `bench:fetch`
   again (so the new fingerprint shows up in traces), or hand-edit the SQL in
   a copy of the baseline JSON for a faster local loop. Then:

    ```
    bun bench:run .bench/errorsByType-after-prewhere.json --runs 5 \
      --out .bench/errorsByType-after.json
    ```

6. **Diff.** Confirm the change actually helped:

    ```
    bun bench:compare .bench/errorsByType-before.json .bench/errorsByType-after.json
    ```

    The compare table prints absolute and percentage deltas for p95 wall,
    read bytes, and memory. Negative numbers mean improvement.

## Notes

- **Warmup matters.** ClickHouse caches mark ranges and column blocks
  aggressively. The default of 1 warmup run + 5 timed runs is enough to
  separate cold-vs-warm without dominating the bench duration.
- **`system.query_log` is buffered ~7s.** The script retries a few times to
  pick up `memory_usage` and `read_rows` after each run, then falls back to
  the `X-ClickHouse-Summary` header values it captured at execution time.
- **The mining query itself runs against Tinybird** because that's where the
  `internal`-org self-instrumentation lands. The replays go against
  `CLICKHOUSE_URL`. You can point those at different deployments.
- **Source SQL is byte-for-byte what production ran.** Resolved params,
  `OrgId` filter, profile `SETTINGS` clause — all already baked in by
  `WarehouseQueryService.executeSql` before the span was emitted.
