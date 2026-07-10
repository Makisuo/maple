# Local telemetry archives

Maple's embedded chDB store is a bounded **hot store**: it retains recent
telemetry (logs and traces for 30 days, metrics for 90 days) for fast local
querying. Local telemetry archives extend Maple with **long-term, portable
Parquet storage** exported from immutable checkpoints, queryable independently
with DuckDB — without reloading history into the live store or running a second
always-on database.

This document is the operator and architecture guide for local archives. It
covers the model, the happy path, every major off-happy-path outcome, the
independent query path, the full tuning configuration reference, calibration,
and the directory and manifest layouts.

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

## The six signals

Archives export exactly the six **raw** telemetry tables. Aggregation and
materialized-view tables are deliberately excluded: they are rebuildable from
raw telemetry and would balloon archive volume without preserving any fact the
raw tables do not already carry.

| Signal (table / directory name) | Event-time column used for the UTC-day range |
| ------------------------------- | -------------------------------------------- |
| `logs`                          | `TimestampTime`                              |
| `traces`                        | `Timestamp`                                  |
| `metrics_sum`                   | `TimeUnix`                                   |
| `metrics_gauge`                 | `TimeUnix`                                   |
| `metrics_histogram`             | `TimeUnix`                                   |
| `metrics_exponential_histogram` | `TimeUnix`                                   |

Each signal drives fixed half-open UTC-day range semantics. Production queries
implement that range with UTC `toDate(...) = <range-date>` and per-hour
`toHour(...)` predicates, equivalent to `eventTime >= start AND eventTime < end`
for valid timestamps.

## Architecture

```text
Live Maple store (chDB)            Archive volume (operator-configured, SEPARATE from data/)
  data/                              <archiveDir>/
  backups/                             logs/
    state.json                           2026-06-01/
    snapshots/<checkpoint-id>/             active.json            ← atomic active pointer (formatVersion 1)
      backup/                              generations/<generation-id>/
      manifest.json                          manifest.json        ← generation manifest (formatVersion 3)
    pins/<checkpoint-id>/<pin-id>.json       shards/HH-NNNN.parquet  ← one or more shards per hour
    operations/active/                     catalog.jsonl          ← canonical rebuildable JSONL index
    quarantine/                          traces/ ...
    retiring/                          building/<generation-id>/  (in-progress; owned temp output)
                                      quarantine/
                                        building-<operation-id>/ (retained pre-publication debris)
                                      calibration/               (calibration ownership + samples)
                                        recovery.json
                                        samples/<operation-id>/
                                      operations/
                                        active/archive-<operation-id>/
                                          intent.json
                                          tombstones/<generation-id>/  (GC only)
                                        completed/archive-<operation-id>/
                                          intent.json
```

The archive volume is an operator-configured directory that **must be separate**
from the live data directory. The `assertArchiveRootSeparate` check refuses to
archive into (or beneath) the live store.

### Why checkpoint-restored scratch, not a live copy

The only proven safe source for an archive is a native chDB checkpoint restored
into sacrificial scratch. A raw copy of the live data directory is unsafe: it
captures an inconsistent on-disk state, may include half-written merges, and
races concurrent ingest. A checkpoint, by contrast, is a validated, consistent
snapshot. Archive export restores one checkpoint into a private scratch chDB
(reusing the same scoped instance that checkpoint validation uses), exports from
it, then removes the scratch. The live store is never opened for export.

A consequence: archive export holds the **maintenance lock** so it cannot overlap
checkpoint creation, restore, or reset. This is by design — the two operations
share one sacrificial chDB and must serialize.

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

Three distinct units, all configurable and calibratable:

- A **logical chunk** is a provisioning target (the `targetChunkBytes` tuning
  value); it is not a hard limit.
- A **physical shard** is one Parquet file, bounded by `maxShardRows` and
  `maxShardBytes`. In v1, each shard covers one UTC hour within the sealed day;
  if a single hour exceeds `maxShardBytes` uncompressed, it is recursively
  bisected at the physical `_part_offset` boundary. A single row that exceeds the
  byte bound is a distinct failure (raise `maxShardBytes` or recalibrate).
- A **Parquet row group** is the unit of compression and parallel decode inside a
  shard, sized by `rowGroupRows`.

## Pinning and the maintenance lock

Archive export holds Maple's **maintenance lock** so it cannot overlap checkpoint
creation, restore, or reset. Inside the lock, it acquires a **persistent pin**
on the source checkpoint so retention cannot delete the snapshot between
resolution and export. A stale pin (e.g. from a crashed archive that never
released it) safely over-retains data rather than risking deletion. The pin is
released after the generation is durable. Calibration pins use the purpose
`archive-calibrate:<operation-id>` so they are unambiguous and operation-scoped.

## Commands

`maple archive` has six operator-facing subcommands (`create`, `list`,
`rebuild`, `reconcile`, `gc`, `calibrate`) plus the internal
`calibrate-session` and `calibrate-run` commands used by calibration and its
fault probes. There are no short flags anywhere in this command tree. Root
flags fall back to `~/.maple` defaults when omitted.

| Flag             | Default            |
| ---------------- | ------------------ |
| `--data-dir`     | `~/.maple/data`    |
| `--archive-dir`  | `~/.maple/archive` |
| `--scratch-root` | `~/.maple/scratch` |

### `maple archive create <range-date> <signal>`

Seal one UTC day of one signal into a validated Parquet generation.

```sh
maple archive create 2026-06-01 traces \
  --data-dir ~/.maple/data \
  --archive-dir /Volumes/External/maple-archive \
  --scratch-root /Volumes/External/maple-scratch \
  --config ./maple-archive-config.json
```

- `<range-date>`: the UTC day to seal, as `YYYY-MM-DD` (validated; impossible
  calendar dates like `2026-02-31` are rejected).
- `<signal>`: one of the six signal names (positional, not a flag).
- `--checkpoint-id`: archive from a specific checkpoint instead of `current`.
- `--archive-dir` / `--scratch-root` / `--data-dir`: override the defaults.
- `--config`: load tuning overrides from a versioned calibration config document
  (see [Tuning configuration](#tuning-configuration)). The config's SHA-256
  identity is recorded in the generation manifest. The strict config schema has
  no root override fields; roots always come from the CLI/defaults.

The command resolves and pins the checkpoint, restores it to scratch, exports
bounded Parquet shards, validates row counts and checksums, publishes the
generation manifest, atomically selects it, canonically rebuilds the catalog,
releases the pin, and removes the owned scratch.

**Tuning precedence:** `--config` effective values override compiled tuning
defaults. `archive create` exposes no per-knob CLI tuning flags in v1; its root
flags are separate and remain authoritative.

### `maple archive list`

Report active generations:

```sh
maple archive list --archive-dir /Volumes/External/maple-archive
maple archive list --output paths --signal traces   # machine-readable paths
maple archive list --output json                    # full JSON
```

`--output` modes (`summary` is default, only `list` has this flag):

- `summary`: one line per active generation: signal, range, rows, shards,
  short generation id.
- `paths`: a single comma-separated, double-quoted list of the active
  generation's Parquet shard paths (excluding superseded generations), ready for
  DuckDB's `read_parquet`. Requires `--signal`.
- `json`: the full `listActiveGenerations` object, pretty-printed.

`list` verifies every shard's actual SHA-256 and byte size against the manifest
before returning it; a tampered shard fails closed (the affected range surfaces
in `errors`, other ranges still list). Only the active generation is exposed.

### `maple archive rebuild <signal>`

Rebuild a signal's `catalog.jsonl` from the authoritative generation manifests,
recovering from a truncated or missing catalog without rescanning Parquet bytes.
`<signal>` is positional.

### `maple archive reconcile`

Reconcile an interrupted `create` or `gc` operation to its intended state
**without a fresh export**. Flags: the three root flags plus `--dry-run`.

- `--dry-run`: report the decision and the archive root without mutating
  anything.
- Apply: execute the decision function's verdict.

The decision is one of: `NoOp` (nothing active), `FailClosed` (unsafe state —
zero mutation, exits non-zero), `CreateVerifyComplete`, `CreateAbortPrepublication`,
`CreateFinishPublication`, `GcVerifyComplete`, or `GcResume`. A subsequent
`create` also runs this reconciliation automatically as its first step.

### `maple archive gc`

Reclaim superseded archive generations, retaining the newest N per signal/range.
This is the **only** archive operation that deletes published generations.

```sh
maple archive gc --archive-dir /Volumes/External/maple-archive --keep 1
maple archive gc --keep 0 --dry-run   # preview reclaiming all superseded
```

- `--keep` (default `1`, `>= 0`): generations to retain per signal/range beyond
  the active one. `--keep 0` reclaims all superseded generations.
- `--dry-run`: plan only, no mutation. If an operation is active in
  `operations/active/`, the dry run reports the blocker and reclaims nothing.

GC is conservative to a fault: it verifies every generation's manifest and shard
checksums up front, excludes any signal/range whose catalog is not provably
reconstructable or whose active pointer is missing, deletes by tombstone-rename
(never in-place recursive delete), persists progress after every target, and
proves terminal invariants before retiring the journal.

### `maple archive calibrate <range-date>`

Calibrate archive tuning by running a candidate matrix against a pinned
checkpoint across **all six signals**.

```sh
maple archive calibrate 2026-06-01 \
  --archive-dir /Volumes/External/maple-archive \
  --memory-budget 536870912 --time-budget 60000 \
  --write-config ./maple-archive-config.json
```

Flags (defaults shown):

| Flag                      | Default               | Meaning                                            |
| ------------------------- | --------------------- | -------------------------------------------------- |
| `--checkpoint-id`         | `current`             | Source checkpoint                                  |
| `--memory-budget`         | `536870912` (512 MiB) | Per-candidate RSS ceiling                          |
| `--time-budget`           | `60000` (ms)          | Total matrix deadline                              |
| `--sample-rows`           | `10000`               | Rows sampled per signal (training window `[0, N)`) |
| `--max-candidate-wall-ms` | `30000` (ms)          | Per-candidate wall ceiling                         |
| `--min-throughput`        | `0` (B/s)             | Throughput floor (0 disables)                      |
| `--max-temp-disk`         | `2147483648` (2 GiB)  | Temporary disk ceiling                             |
| `--free-space-reserve`    | `536870912` (512 MiB) | Required free space on the archive volume          |
| `--safety-margin-milli`   | `1100` (→ 1.1×)       | Margin applied inside each ceiling (thousandths)   |
| `--write-config`          | none                  | Write the recommended config document to this path |

The calibrator spawns each candidate as a child process under `/usr/bin/time`
(for independent peak-RSS measurement) inside its own process group with a
wall-clock and temporary-disk watchdog. It selects the candidate with the lowest
worst-case peak RSS (tie-broken by wall) that passes every signal's ceiling,
then validates the selection on a **disjoint held-out window**
`[sampleRows, 3*sampleRows)` through the same real writer: `N` training rows
followed by `2N` held-out rows. Confidence is `high` only when a candidate is
selected and every signal actually produced the complete requested training
and held-out cardinality; otherwise it is `low` with `selected: null` and no
config is written. See [Calibration](#calibration).

`maple archive calibrate-session --action open|close` is an internal recovery
and probe command. `open` reconciles an older session, resolves one checkpoint,
acquires its operation-scoped pin, and prints the operation/checkpoint identity
required by `calibrate-run`. `close` invokes the authoritative reconciler,
removing only the derived sample/scratch paths and exact session pin. Ordinary
operators should use `calibrate`, which owns this lifecycle automatically.
After all measurements finish, `calibrate` reconciles the session and releases
the source pin before publishing the config. A deterministic
`post-session-release` crash probe proves that interruption in this gap writes
no config and leaves no pin, recovery record, sample, or scratch debris; the
operator must rerun calibration.

## The happy path: fresh checkpoint through DuckDB investigation

1. Ingest telemetry into the running Maple store.
2. `maple checkpoint` to create a validated checkpoint.
3. (Optional) `maple archive calibrate <day> --write-config cfg.json` to tune for
   your hardware, then use `--config cfg.json` on `create`.
4. `maple archive create 2026-06-01 traces` (and the other five signals).
5. `maple archive list --output paths --signal traces` to get the Parquet paths.
6. Query in DuckDB:

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

## Tuning configuration

The tuning knobs are centralized, documented, and overridable. Defaults are the
measured research baselines — **not universal constants**. A deployment should
calibrate against its checkpoint, archive volume, chDB version, and memory budget
with `maple archive calibrate`.

### Fields, defaults, and validation

| Field                 | Type   | Default               | Constraint                                 |
| --------------------- | ------ | --------------------- | ------------------------------------------ |
| `writerThreads`       | number | `1`                   | positive integer, `<= 32`                  |
| `rowGroupRows`        | number | `10000`               | positive integer, `<= maxShardRows`        |
| `maxShardRows`        | number | `500000`              | positive integer                           |
| `maxShardBytes`       | number | `268435456` (256 MiB) | positive integer, `>= rowGroupRows * 1024` |
| `targetChunkBytes`    | number | `1073741824` (1 GiB)  | positive integer, `> minFreeSpaceReserve`  |
| `minFreeSpaceReserve` | number | `536870912` (512 MiB) | positive integer, `< targetChunkBytes`     |

There is no clamping: any out-of-bounds value or unsafe combination fails closed
with an explicit error. `archiveDir` and `scratchRoot` have no defaults in the
tuning block; they are always resolved from the CLI/defaults.

- `writerThreads` → chDB `max_threads` (Parquet writer thread count).
- `rowGroupRows` → `output_format_parquet_row_group_size`.
- `maxShardRows` / `maxShardBytes` → physical shard split bounds.
- `targetChunkBytes` → provisioning hint (not a hard limit).
- `minFreeSpaceReserve` → enforced free-space headroom at operation time.

Every generation manifest records the effective tuning values (the six knobs
above), so a generation is reproducible and deployment drift is visible.

### The calibration config document

`maple archive calibrate --write-config <path>` writes a **versioned calibration
config document** (`formatVersion: 3`, mode `0o600`) with strict, exact-key
schema. It is a complete evidence record, not just the numbers, and the loader
re-derives every aggregate from the recorded evidence rather than trusting it.
Top-level keys (all required; unknown keys rejected):

| Key                     | Contents                                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| `formatVersion`         | `3`                                                                    |
| `checkpoint`            | `{ checkpointId, manifestFingerprint }` — the single source snapshot   |
| `candidateMatrix`       | The exact four-candidate matrix evaluated                              |
| `requiredSignals`       | The exact six-signal set                                               |
| `budget`                | The full `CalibrationBudget` the run used (see below)                  |
| `selected`              | `{ candidate, worstCase }` for the chosen candidate (always present)   |
| `confidence`            | `"high"` (a loadable recommendation is always high-confidence)         |
| `heldOut`               | Selected held-out evidence, scaling inputs, and six comparisons        |
| `heldOutAttempts`       | Every attempt, including rejected results and recomputed comparisons   |
| `samplePolicy`          | The disjoint training/held-out window contract (sizes + windows)       |
| `environment`           | Maple/chDB version, schema fingerprint, CPU, memory, archive-volume id |
| `results`               | Per-signal, per-candidate evidence, each with a `sample` scope         |
| `effective`             | The six effective tuning knobs (what `--config` applies)               |
| `derivation`            | How `minFreeSpaceReserve`/`targetChunkBytes` are derived               |
| `safetyMargin`          | The margin applied inside each ceiling                                 |
| `recalibrationTriggers` | The six events that should prompt recalibration                        |
| `measuredAt`            | Canonical UTC ISO-8601 timestamp                                       |
| `note`                  | Human-readable summary                                                 |

Each `results` entry carries a `sample` scope — `{ checkpointId,
checkpointManifestFingerprint, rangeDate, role, startRow, requestedRows,
rowCount }` — binding that measurement to one immutable checkpoint/range and an
exact ordered-row window. Every training sample is `role: "training"`,
`startRow: 0`; every held-out sample is `role: "held-out"`, `startRow:
sampleRows`. The loader proves all scopes share one checkpoint/range, that the
two windows are disjoint, and that actual `rowCount` equals `requestedRows`
(`N` for training and `2N` for held-out). A short source window is
unrepresentative and cannot produce a loadable recommendation.

`heldOut` and every complete `heldOutAttempts` entry persist a descriptive
aggregate `worstCase` plus a `signalComparisons` array — one entry per signal in
canonical order. Each entry carries its own `scaleRatio`, six metric comparison
records (adjusted prediction, observation, tolerance, relative delta, pass/fail),
and a per-signal `passed` flag; raw metrics are not duplicated (the loader
re-derives them from the training/held-out results by candidate + signal). The
loader recomputes these values; the document cannot choose its own ratio,
prediction, tolerance, or signal pairing.

Format 3 treats resource costs directionally: a lower observed RSS, wall time,
compression ratio, physical-byte count, or temporary-disk peak is safe; only a
regression beyond tolerance fails. Write operations emit only format 3. For
upgrade compatibility, the loader also accepts a format-2 document only when
its *entire* held-out evidence matches one coherent historical policy: either
the original symmetric comparison or the brief directional format-2 form. It
rejects a document that mixes those representations across the selected
evidence and attempts.

`environment.archiveVolume` records `{ fsid, type, archiveDir }` so a config is
bound to the volume it was measured on, and `archive create --config` enforces
that identity (plus the host environment) before exporting. `recalibrationTriggers`
is exactly:

1. Maple version change
2. chDB version change
3. Schema fingerprint change
4. Hardware change (CPU count, memory, storage speed)
5. Archive-volume replacement or filesystem change
6. Material telemetry-shape change (row width, cardinality, signal mix)

A document containing only `formatVersion` + `effective` is **rejected** — all
evidence fields are required, so a config cannot be hand-edited into existence.
The loader recomputes the worst cases, the held-out comparisons, the tuning
derivation, and the sample scopes, and rejects any field that does not match
(for example a forged tolerance, a redefined derivation, or a scope bound to the
wrong checkpoint).

### How `--config` loads

`loadTuningConfig` opens the file with defense-in-depth against tampering and
TOCTOU:

1. `lstat` first — refuse if not a regular file (rejects symlinks/devices).
2. Size cap: `16 MiB` (`MAX_CONFIG_BYTES`).
3. `open` with `O_NOFOLLOW` — the kernel refuses a symlink at the final path.
4. `fstat` the fd — refuse if not a regular file.
5. **fd-identity check** — the opened fd's `dev`/`ino` must equal the pre-`lstat`
   `dev`/`ino` (detects a swap between lstat and open).
6. Bounded read to exactly the fd's size; SHA-256 is computed over those exact
   bytes.

The result is a `TuningConfigIdentity` bound into the manifest:

```jsonc
{ "formatVersion": 3, "configName": "maple-archive-config.json", "sha256": "<64 hex>" }
```

`configName` is the file basename (validated `^[A-Za-z0-9._-]+$`); `sha256` is
the content hash. A generation thus records exactly which config produced it.
(The manifest stores this as an opaque, hash-bound identity, so it can describe
both legacy v1 and verified v2 config documents; only the loader refuses v1 for
new writes. It also records and accepts format-3 directional config documents.)

## Calibration

Calibration measures how archive export behaves on your hardware and recommends
the candidate that meets your resource budget with the most headroom. It is the
recommended way to set tuning; the defaults are a research baseline only.

### The candidate matrix

Four fixed candidates are evaluated, each across **all six signals**:

| Candidate | `writerThreads` | `rowGroupRows` | `maxShardRows` | `maxShardBytes` |
| --------- | --------------- | -------------- | -------------- | --------------- |
| 1         | 1               | 10 000         | 500 000        | 256 MiB         |
| 2         | 1               | 5 000          | 250 000        | 128 MiB         |
| 3         | 2               | 10 000         | 500 000        | 256 MiB         |
| 4         | 1               | 20 000         | 1 000 000      | 512 MiB         |

### Worst-case aggregation and selection

For each candidate, per-signal metrics are aggregated into a single worst case:
**MAX** of every cost metric (`logicalBytes`, `physicalBytes`,
`compressionRatio`, `peakTempDiskBytes`, `peakRssBytes`, `wallMs`, `rowCount`)
and **MIN** of `writeThroughputBytesPerSec` (the slowest signal is the worst
case). A candidate is eligible only if **every** signal individually meets the
ceilings. Selection is best-first by lowest worst-case peak RSS, tie-broken by
lowest wall.

### Margin inside each ceiling

The safety margin is applied **inside** each ceiling, not to the result:

- **RSS:** `peakRssBytes * margin > memoryBudget` → fail
- **Wall:** `wallMs > maxCandidateWallMs` → fail (hard ceiling, no margin)
- **Throughput** (only if `minThroughputBytesPerSec > 0`):
  `writeThroughputBytesPerSec / margin < minThroughputBytesPerSec` → fail
- **Temp disk:** `peakTempDiskBytes * margin > maxTempDiskBytes` → fail

So `safetyMargin` 1.1 reserves 10% headroom under the declared budget for RSS,
throughput, and temp disk.

### Held-out validation

The selected candidate is re-measured on a **larger, disjoint** row window
through the same shared writer. Training covered ordered rows `[0, sampleRows)`;
held-out covers `[sampleRows, sampleRows + 2*sampleRows)`, equivalently
`[N, 3N)` — strictly larger than training and non-overlapping. Both requested
windows and observed cardinalities are recorded in every result's `sample`
scope and in `samplePolicy`; the loader requires actual `N`/`2N` rows.

The comparison is **per-signal and like-for-like**: each signal's held-out
result is paired with the same candidate's TRAINING result for that signal, and
the comparison uses that signal's own
`scaleRatio = heldOut.logicalBytes / training.logicalBytes`. Cross-signal
aggregate extrema never decide acceptance (they are recorded only as a
descriptive `worstCase` summary). Each signal's entry in `signalComparisons`
records its own `scaleRatio`, its six metric comparisons, and a per-signal
`passed` flag. The attempt passes only when **all six signals** pass. The fixed
canonical tolerances (`< 1.0` for every metric) apply per metric, per signal:

| Metric                       | Comparison                                    |
| ---------------------------- | --------------------------------------------- |
| `peakRssBytes`               | absolute peak, two-sided                      |
| `wallMs`                     | training prediction × `scaleRatio`, two-sided |
| `writeThroughputBytesPerSec` | direct; higher observed is better             |
| `compressionRatio`           | direct, two-sided                             |
| `physicalBytes`              | training prediction × `scaleRatio`, two-sided |
| `peakTempDiskBytes`          | absolute peak, two-sided                      |

The loader rejects document-selected tolerances and independently recomputes
each signal's ratio, adjusted predictions, relative deltas, and per-signal pass
result by re-pairing the recorded training and held-out results by exact
candidate + signal identity. Training and held-out `logicalBytes` must both be
strictly positive for every paired signal (an undefined ratio makes the attempt
incomplete, never silently ratio 1).

A candidate that fails held-out (any signal fails) is **rejected** and the next
eligible candidate is tried; every attempt is recorded in `heldOutAttempts`. A
complete attempt records six `signalComparisons` entries (even when it fails);
an incomplete or over-budget attempt records `signalComparisons: []`,
`worstCase: null`, `passed: false`.

### When calibration does not recommend

- **No candidate meets the ceilings across all six signals** → no
  recommendation; the command exits non-zero with a clear note and **no config
  is written**.
- **No eligible candidate passes held-out**, or the data is
  small/unrepresentative (a signal's training row count below `sampleRows`) →
  the command exits non-zero with `selected: null` and **no config is written**.
  The CLI throws before writing a config when there is no recommendation.
- **An impossible resource budget** is not a special case: it composes from the
  above — every candidate is rejected and no config is written, with no change
  to existing configuration and no temporary data left behind.

The calibrator never redefines the operator's goals to make a candidate pass,
and a config cannot redefine its tolerances, derivation, or sample scope.

## Manifest, pointer, and catalog formats

### Generation manifest (`manifest.json`, formatVersion 3)

One per generation at
`<archiveDir>/<signal>/<range>/generations/<generationId>/manifest.json`. Fields:

| Field                                                | Type            | Notes                                                   |
| ---------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `formatVersion`                                      | `3`             | Readers reject v2/v1 fail-closed (re-export to migrate) |
| `generationId`                                       | string (UUIDv4) |                                                         |
| `signal`                                             | string          |                                                         |
| `rangeStart`                                         | string          | `YYYY-MM-DD`                                            |
| `rangeEndExclusive`                                  | string          | ISO, the next UTC midnight                              |
| `checkpointId`                                       | string          | Source checkpoint                                       |
| `checkpointManifestFingerprint`                      | string          | `id:createdAt:backupBytes` of the source checkpoint     |
| `createdAt`                                          | string          | ISO                                                     |
| `mapleVersion` / `chdbVersion` / `schemaFingerprint` | string          |                                                         |
| `sourceRowCount` / `archivedRowCount`                | number          | Must be equal; `Σ shard.rowCount == archivedRowCount`   |
| `tuning`                                             | object          | The six effective knobs                                 |
| `tuningConfig`                                       | object \| null  | `{ formatVersion, configName, sha256 }` or null         |
| `shards`                                             | array           | One `ArchiveShardRecord` per shard                      |

Each `shard` entry: `name` (e.g. `00-0000.parquet`), `rowCount`,
`minEventTimeUnixNano` / `maxEventTimeUnixNano` (epoch-nanosecond decimal
strings), `sha256`, `bytes`, `columns`, `complexDigest`, and
`complexDigestAlgorithm`. Cross-field invariants (unique names, row-count sums,
source == archived) are enforced.

**Format-version history.** v1 used timezone-dependent time evidence and a
per-column-sum digest; v2 moved to UTC epoch-nanosecond strings and a multiset
digest but carried a bare `tuningConfigName`; **v3** replaces that with the
SHA-256-bound structured `tuningConfig` identity. v3 readers reject v2/v1
fail-closed and preserve the files — older archives must be re-exported, not
migrated in place.

### Active pointer (`active.json`, formatVersion 1)

One per `<archiveDir>/<signal>/<range>/active.json`: `{ formatVersion: 1,
generationId, signal, rangeStart, selectedAt }`. The signal and range are bound
to the enclosing directory (mismatch fails closed). It is replaced atomically to
select a new generation.

### Catalog (`catalog.jsonl`)

One per signal at `<archiveDir>/<signal>/catalog.jsonl`. Each line is a JSON
object: `{ generationId, signal, rangeStart, checkpointId, archivedRowCount,
shardCount, createdAt, formatVersion: 1 }`. The catalog is a canonical,
rebuildable index: create, GC, and `archive rebuild` durably rewrite it from the
authoritative manifests. `assertCatalogExact` proves the result byte-for-byte
without rescanning Parquet.

## Recovery and reconciliation

Create and GC persist durable ownership/intent records **before** mutation and
retire them **only after** proving terminal state. Calibration has its own
recovery records. Catalog rebuild uses a durable atomic rewrite rather than an
operation journal. A single pure decision function (`decideReconciliation`) is
the sole branch logic for create/GC recovery.

### The decision function

Given an inspection of the on-disk state, it returns one of:

- `NoOp` — nothing active.
- `FailClosed` — an unsafe/impossible topology (e.g. both building and final
  state present, a published generation with no manifest, a final generation
  before the manifest-written phase, an aborted operation still active). Zero
  mutation; exits non-zero.
- `CreateVerifyComplete` — a create reached `complete`; verify terminal
  invariants only.
- `CreateAbortPrepublication` — an interrupted create that had not published;
  move its owned building dir into retained quarantine, remove exact owned
  scratch, and release its exact pin.
- `CreateFinishPublication` — an interrupted create that **had** published;
  re-select the pointer and rebuild the catalog.
- `GcResume` — resume collecting a frozen GC target set.
- `GcVerifyComplete` — a GC reached `complete`; prove terminal invariants and
  retire the journal.

A phase label is never proof: the decision and the terminal checks re-read
reality from disk. Reconciliation runs inside the maintenance lock, and a
subsequent `create` runs it automatically as its first step, so most
interruptions heal without an explicit operator action.

### Calibration recovery

Calibration has its own durable record at
`<archiveDir>/calibration/recovery.json` (`formatVersion: 1`), naming owned
paths **derived from the operation id** (`calibrate-<operationId>` scratch,
`calibration/samples/<operationId>` archive, and the pin at
`pinFilePath(dataDir, checkpointId, pinId)` with purpose
`archive-calibrate:<operationId>`). Because the paths are derived, a crash
between pin creation and the phase advance (when the record still shows
`pinPath: null`) still releases the exact pin. A checkpoint-fingerprint
mismatch fails closed and preserves the record. Reconciliation removes the owned
dirs only after classifying them as real directories, and clears the record only
after the pin is confirmed released and both dirs confirmed absent — otherwise
it preserves the record for retry.

### GC recovery

GC persists the **non-terminal** `gc-collecting` phase after every target
(including the last); `complete` is written only after catalog rebuild and
`assertCatalogExact`. Collection is by tombstone-rename (`generations/<id>` →
`operations/active/archive-<op>/tombstones/<id>`) then removal, never in-place
recursive delete. A read-only preflight classifies every frozen target into
**prefix** (already collected), **current** (the documented crash topologies),
and **suffix** (must still be untouched); an out-of-order suffix mutation is
`impossible` and fails closed. Resume finishes a half-removed tombstone or
idempotently confirms an already-absent target.

## Off-happy-path outcomes

| Outcome                                                 | What happens                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unavailable checkpoint**                              | `archive create` fails closed; the live store is untouched. No generation is written.                                                                                           |
| **Incompatible checkpoint** (wrong chDB/schema version) | The checkpoint resolver rejects it; no export runs.                                                                                                                             |
| **Stale pin**                                           | A crashed archive's pin over-retains the checkpoint snapshot safely. Re-running archive create succeeds; the pin from the failed run can be inspected under `backups/pins/`.    |
| **Interrupted restore**                                 | The restored scratch remains journal-owned until the next `create` or `archive reconcile` removes the exact owned path. The live store is never modified.                       |
| **Partial shard**                                       | Row limits are planned into separate shards and byte-overflow candidates are recursively bisected. Only one matching row that still exceeds `maxShardBytes` fails distinctly.   |
| **Validation mismatch** (source vs archived row count)  | The generation is not promoted. Reconciliation moves owned building output into retained quarantine, clears exact scratch/pin state, and leaves the active pointer unchanged.   |
| **Full or disconnected archive volume**                 | Free-space preflight fails before any export. No scratch is created.                                                                                                            |
| **Pointer or catalog corruption**                       | Summary mode omits malformed ranges; JSON exposes their errors, while paths mode fails closed for the requested signal. `archive rebuild` atomically replaces only the catalog. |
| **Late telemetry**                                      | A new generation supersedes; the old generation is retained but excluded from active paths.                                                                                     |
| **Supersession**                                        | Same as late telemetry: the newest generation becomes active; superseded ones remain on disk until `archive gc` reclaims them.                                                  |
| **Interrupted create**                                  | Reconciles automatically on the next `create`, or via `archive reconcile`. Pre-publication output moves to retained quarantine; post-publication repairs pointer and catalog.   |
| **Interrupted GC**                                      | Resumes the frozen target set; a half-removed tombstone is finished, an already-absent target is confirmed. Out-of-order mutation fails closed.                                 |
| **Interrupted calibration**                             | The derived-pin and owned-dir reconciliation releases the pin and removes the sample; the record is preserved until cleanup is proven.                                          |
| **Insufficient memory budget**                          | Calibration reports `low` confidence (or no recommendation) rather than presenting synthetic precision.                                                                         |
| **Failed calibration**                                  | No config is written; temporary calibration output is cleaned up. Existing configuration is unchanged.                                                                          |

### What failures leave untouched vs. require action

- **Live store untouched by every archive failure.** Export reads only from
  restored scratch. GC never touches the live store either.
- **Recoverable or retained debris:** create reconciliation releases exact
  scratch/pin ownership but retains pre-publication building evidence under
  `quarantine/building-<operation-id>`. Unrelated stale pins are safely
  over-retained.
- **Requires reconciliation:** an interrupted `create` after publication
  (pointer/catalog may be inconsistent until reconcile re-selects/rebuilds) and
  an interrupted GC (frozen target set resumed).
- **Operator intervention:** a `FailClosed` reconciliation (impossible topology
  or suspected corruption), a persistently corrupt active pointer, or a shard
  that repeatedly exceeds bounds requires manual inspection. `archive reconcile
--dry-run` reports the verdict without mutating.

## Capacity and resource model

For a 4 GiB hot-store target, live store plus current and previous checkpoints is
roughly 3x the live footprint. Checkpoint creation, scratch restore, and archive
building can temporarily raise aggregate working storage toward 4–5x. That is
an aggregate across volumes, not a free-space requirement for one disk.
Checkpoint validation and archive export share **one** sacrificial chDB, so
archive export does not add a second concurrent `f(4)` memory term.

The archive volume grows with retained historical ranges. Use volume-specific
free-space measurements in deployment. Create requires
`minFreeSpaceReserve + targetChunkBytes` on the archive filesystem; calibration
children require `freeSpaceReserve + 4 * maxShardBytes`. GC lets you bound growth
by reclaiming superseded generations.

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
