# Local telemetry archives

Maple's embedded chDB store is a bounded **hot store**: it retains recent
telemetry (logs and traces for 30 days, metrics for 90 days) for fast local
querying. Local telemetry archives extend Maple with **long-term, portable
Parquet storage** exported from immutable checkpoints, queryable independently
with DuckDB — without reloading history into the live store or running a second
always-on database.

This document is the operator and architecture guide for local archives. It
covers the model, the happy path, every major off-happy-path outcome, and the
independent query path.

## What archives are (and are not)

**Are:**

- Immutable Parquet exports of the six raw telemetry tables from a validated
  checkpoint.
- Sealed by fixed UTC day and signal, one generation at a time.
- Independently queryable with DuckDB; portable across machines.
- Crash-safe: an interrupted archive leaves the live store untouched and the
  archive in a recoverable state.

**Are not:**

- A live export endpoint. v1 archives are created explicitly by an operator.
- Automatic hot-store pruning. Existing chDB TTLs govern the hot store; archives
  do not delete from it.
- Archive rehydration into the Maple UI. Historical data is queried in DuckDB,
  not reloaded into the dashboard.
- A second always-running database. Archives are files; DuckDB opens them on
  demand.

## Architecture

```text
Live Maple store (chDB)            Archive volume (operator-configured)
  data/                              <archiveDir>/
  backups/                             logs/
    state.json                           2026-06-01/
    snapshots/<checkpoint-id>/             active.json
      backup/                              generations/<generation-id>/
      manifest.json                          manifest.json
    pins/<checkpoint-id>/<pin-id>.json       shards/00.parquet ...
    operations/                            catalog.jsonl
    quarantine/                          traces/ ...
    retiring/                          building/<generation-id>/  (in-progress)
                                      quarantine/                (uncertain state)
```

### Why checkpoint-restored scratch, not a live copy

The only proven safe source for an archive is a native chDB checkpoint restored
into sacrificial scratch. A raw copy of the live data directory is unsafe: it
captures an inconsistent on-disk state, may include half-written merges, and
races concurrent ingest. A checkpoint, by contrast, is a validated, consistent
snapshot. Archive export restores one checkpoint into a private scratch chDB
(reusing the same scoped instance that checkpoint validation uses), exports from
it, then removes the scratch. The live store is never opened for export.

### Why generations supersede instead of deduplicating by TraceId

There is no universal deduplication key across the six raw tables. `TraceId` is
shared by many spans, may be absent from logs, and does not exist on metrics. An
archive therefore seals a fixed UTC-day range into an immutable **generation**.
Late-arriving telemetry for an already-sealed day creates a **new generation**
that structurally supersedes the old one. The `active.json` pointer atomically
selects the new generation; the old generation is retained on disk but never
returned to listings or queries. This avoids scanning all generations to dedup
and makes each generation independently reproducible.

### Separation of logical chunks, physical shards, and row groups

- A **logical chunk** is a provisioning target (the `targetChunkBytes` tuning
  value); it is not a hard limit.
- A **physical shard** is one Parquet file, bounded by `maxShardRows` and
  `maxShardBytes`. In v1, each shard covers one UTC hour within the sealed day.
- A **Parquet row group** is the unit of compression and parallel decode inside
  a shard, sized by `rowGroupRows`.

All three are configurable and calibratable.

## Pinning and the maintenance lock

Archive export holds Maple's **maintenance lock** so it cannot overlap checkpoint
creation, restore, or reset. Inside the lock, it acquires a **persistent pin**
on the source checkpoint so retention cannot delete the snapshot between
resolution and export. A stale pin (e.g. from a crashed archive that never
released it) safely over-retains data rather than risking deletion. The pin is
released after the generation is durable.

## Commands

### `maple archive create <range-date> <signal>`

Seal one UTC day of one signal into a validated Parquet generation.

```sh
maple archive create 2026-06-01 traces \
  --data-dir ~/.maple/data \
  --archive-dir /Volumes/External/maple-archive \
  --scratch-root /Volumes/External/maple-scratch
```

- `<range-date>`: the UTC day to seal, as `YYYY-MM-DD`.
- `<signal>`: one of `logs`, `traces`, `metrics_sum`, `metrics_gauge`,
  `metrics_histogram`, `metrics_exponential_histogram`.
- `--checkpoint-id`: archive from a specific checkpoint instead of the current.
- `--archive-dir` / `--scratch-root`: override the default locations.

The command resolves and pins the checkpoint, restores it to scratch, exports
bounded Parquet shards, validates row counts and checksums, publishes the
generation manifest, atomically selects it, appends the catalog, releases the
pin, and removes the owned scratch.

### `maple archive list`

Report active generations:

```sh
maple archive list --archive-dir /Volumes/External/maple-archive
maple archive list --output paths --signal traces   # machine-readable paths
maple archive list --output json                    # full JSON
```

`--output paths` emits the active generation's Parquet shard paths (excluding
superseded generations) ready for DuckDB's `read_parquet`.

### `maple archive rebuild <signal>`

Rebuild a signal's `catalog.jsonl` from the authoritative generation manifests,
recovering from a truncated or missing catalog without rescanning Parquet bytes.

## The happy path: fresh checkpoint through DuckDB investigation

1. Ingest telemetry into the running Maple store.
2. `maple checkpoint` to create a validated checkpoint.
3. `maple archive create 2026-06-01 traces` (and the other signals).
4. `maple archive list --output paths --signal traces` to get the Parquet paths.
5. Query in DuckDB:

```sh
duckdb -c "SELECT ServiceName, count(*) FROM read_parquet(['/path/to/00.parquet', ...], union_by_name=true) GROUP BY ServiceName"
```

## DuckDB queries

Archives are portable Parquet. Use `read_parquet` with the active paths from
`maple archive list --output paths`. `union_by_name=true` NULL-fills columns
added between generations; without it, a schema mismatch fails closed.

```sql
-- Logs by service containing a keyword
SELECT ServiceName, min(Timestamp), max(Timestamp), count(*)
FROM read_parquet(<active_log_paths>, union_by_name=true)
WHERE Body ILIKE '%timeout%'
GROUP BY ServiceName;

-- Traces with p99 duration by service
SELECT ServiceName, count(*), quantile_cont(Duration, 0.99)
FROM read_parquet(<active_trace_paths>, union_by_name=true)
WHERE StatusCode = 'Error'
GROUP BY ServiceName;

-- Sum metric maxima
SELECT ServiceName, MetricName, max(Value)
FROM read_parquet(<active_metrics_sum_paths>, union_by_name=true)
GROUP BY ServiceName, MetricName;
```

### Memory limits and spill storage

For large archive ranges, constrain DuckDB's memory and direct spills to the
archive volume:

```sql
PRAGMA memory_limit='2GB';
PRAGMA temp_directory='/Volumes/External/duckdb-spill';
```

## Configuration and calibration

The tuning knobs are centralized, documented, and overridable. Defaults are the
measured research baselines (max_threads=1, 10,000-row groups, ~500k rows /
~256 MiB per shard) — **not universal constants**. A deployment should
calibrate against its checkpoint, archive volume, chDB version, and memory
budget with `maple archive calibrate` (see the calibration section below).

Every generation manifest records the effective tuning values, so a generation
is reproducible and deployment drift is visible.

## Off-happy-path outcomes

| Outcome                                                 | What happens                                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unavailable checkpoint**                              | `archive create` fails closed; the live store is untouched. No generation is written.                                                                                              |
| **Incompatible checkpoint** (wrong chDB/schema version) | The checkpoint resolver rejects it; no export runs.                                                                                                                                |
| **Stale pin**                                           | A crashed archive's pin over-retains the checkpoint snapshot safely. Re-running archive create succeeds; the pin from the failed run can be inspected under `backups/pins/`.       |
| **Interrupted restore**                                 | The restored scratch is owned by the operation; on failure it is cleaned up. The live store is never modified.                                                                     |
| **Partial shard**                                       | A shard that exceeds `maxShardRows` or `maxShardBytes` fails closed; the operator recalibrates with a finer split or larger budget.                                                |
| **Validation mismatch** (source vs archived row count)  | The generation is not promoted. The building dir is removed (it is owned temp output); no active pointer changes.                                                                  |
| **Full or disconnected archive volume**                 | Free-space preflight fails before any export. No scratch is created.                                                                                                               |
| **Pointer or catalog corruption**                       | `archive list` skips a malformed pointer for one range without hiding others. `archive rebuild` regenerates the catalog from manifests. The corrupt files are preserved untouched. |
| **Late telemetry**                                      | A new generation supersedes; the old generation is retained but excluded from active paths.                                                                                        |
| **Interrupted GC**                                      | Not applicable in v1 (no archive GC yet). Checkpoint GC over-retains on uncertainty.                                                                                               |
| **Insufficient memory budget**                          | Calibration reports low confidence rather than presenting synthetic precision.                                                                                                     |
| **Failed calibration**                                  | No config is written; temporary calibration output is cleaned up.                                                                                                                  |

### What failures leave untouched vs. require action

- **Live store untouched by every archive failure.** Export reads only from
  restored scratch.
- **Recoverable debris:** interrupted building dirs (owned, removed on retry) and
  stale pins (over-retained).
- **Operator intervention:** a persistently corrupt active pointer or a shard
  that repeatedly exceeds bounds requires recalibration or manual inspection.

## Capacity and resource model

For a 4 GiB hot-store target, live store plus current and previous checkpoints is
roughly 3x the live footprint. Archive export temporarily adds scratch restore
capacity. Checkpoint validation and archive export share **one** sacrificial
chDB, so archive export does not add a second concurrent `f(4)` memory term —
rotation adds duration and disk I/O to that scratch working set, not another
full in-memory OLAP copy.

The archive volume grows with retained historical ranges. Use volume-specific
free-space measurements in deployment; the `minFreeSpaceReserve` preflight
enforces headroom at operation time.

> **Capacity caveat:** The research baselines were measured on one macOS ARM64
> machine with one synthetic data distribution. CPU count, RAM, storage speed,
> row width, cardinality, and compression ratio vary. Operators should
> calibrate their deployment.

## Non-goals (v1)

- No live export endpoint.
- No automatic hot-store pruning.
- No archive rehydration into the Maple UI.
- No always-running twin database.
- No automatic archive scheduling (start manual; add scheduling only after
  repeated successful runs and measured checkpoint pause).
