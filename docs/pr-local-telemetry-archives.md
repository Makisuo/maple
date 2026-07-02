# Local telemetry archives — draft PR description

> **Status:** draft. This document is the long-form PR narrative for the
> `local-telemetry-archives` feature branch. It is written fresh against the
> implementation at the branch head; it supersedes and does not reuse any prior
> draft PR materials. It is intended to become the body of the dependent pull
> request once a push is authorized.

## Summary

This PR adds **local telemetry archives**: long-term, portable Parquet storage
exported from immutable Maple checkpoints, queryable independently with DuckDB.
It lets an operator retain telemetry history far beyond the hot store's 30/90-day
TTL **without** reloading history into the live chDB store and **without**
running a second always-on database. An archived day is a set of immutable
Parquet files, sealed once, that any DuckDB can read.

## What this is

- Export of the **six raw telemetry tables** (`logs`, `traces`, `metrics_sum`,
  `metrics_gauge`, `metrics_histogram`, `metrics_exponential_histogram`) from a
  validated checkpoint into Parquet, sealed by fixed UTC day and signal.
- A generation model where each sealed day is an immutable **generation**; late
  telemetry creates a newer generation that supersedes, selected atomically by an
  `active.json` pointer.
- A **calibration** workflow that measures export behavior on the deployment's
  hardware and emits a versioned, SHA-256-bound tuning config.
- Crash-safe create and GC: their mutations are journaled, calibration uses
  separate recovery records, and a single pure decision function owns
  create/GC recovery branch logic.
- A conservative **garbage collector** that reclaims superseded generations by
  tombstone-rename with terminal-invariant proofs.
- Full operator/architecture documentation (`docs/local-telemetry-archives.md`).

## Why each major choice was made

**Checkpoint-restored scratch, not a live copy.** A raw copy of the live data
directory is unsafe: it captures an inconsistent on-disk state, may include
half-written merges, and races concurrent ingest. The only proven safe source is
a native chDB checkpoint restored into sacrificial scratch. Export restores one
checkpoint into a private scratch chDB (the same scoped instance checkpoint
validation uses), exports from it, then removes the scratch. The live store is
never opened for export. This is also why export holds the maintenance lock: it
shares the one sacrificial chDB with checkpoint operations and must serialize.

**Generations supersede; we do not deduplicate by `TraceId`.** There is no
universal deduplication key across the six raw tables — `TraceId` is shared by
many spans, may be absent from logs, and does not exist on metrics. Sealing a
fixed UTC-day range into an immutable generation makes each generation
independently reproducible and avoids scanning all generations to dedup. Late
telemetry creates a new generation; the active pointer selects it; the old
generation stays on disk but is excluded from listings and queries until GC.

**Three distinct units (logical chunk / physical shard / row group).** A logical
chunk is a provisioning target (`targetChunkBytes`, not a hard limit); a physical
shard is one Parquet file bounded by `maxShardRows`/`maxShardBytes` covering one
UTC hour, recursively bisected at the `_part_offset` boundary if it exceeds the
byte bound; a Parquet row group is the compression/decode unit (`rowGroupRows`).
Keeping these separate lets operators tune for their row width, cardinality, and
storage without conflating provisioning with physical layout.

**A single reconciliation decision function.** `decideReconciliation` is the sole
pure transition table for create and GC recovery. There is no second `if phase`
implementation anywhere — this invariant is enforced by review and is what makes
crash recovery auditable. A phase label is never proof: the decision and the
terminal checks re-read reality from disk.

**Defense-in-depth config loading.** A calibration config is loaded with `lstat`
→ size cap → `open(O_NOFOLLOW)` → `fstat` → **fd-identity check** → bounded
read, and the SHA-256 is computed over the exact bytes from the one fd. The
config's structured identity (`{ formatVersion, configName, sha256 }`) is bound
into the generation manifest so a generation records exactly which config
produced it and deployment drift is visible.

## Dependency on PR #129

This branch is **dependent on PR #129** (`codex/chdb-checkpoints`, native chDB
checkpoint create/restore). Archives restore a checkpoint into scratch and
export from it; without PR #129's validated, restorable checkpoints there is no
safe source. The checkpoint manifest fingerprint (`checkpointId:createdAt:backupBytes`)
is recorded in every generation manifest, binding each archive to its exact
source. **PR #129 must land first** (or be co-dependent); this PR does not
duplicate checkpoint logic.

## Resource and adoption implications

- **Disk:** the archive volume grows with retained historical ranges. The volume
  must be separate from the live data directory. Create requires
  `minFreeSpaceReserve + targetChunkBytes`; calibration children require
  `freeSpaceReserve + 4 * maxShardBytes`. `archive gc` bounds growth by
  reclaiming superseded generations.
- **Memory/CPU during export:** export restores a checkpoint into scratch, adding
  temporary scratch-restore capacity. Because checkpoint validation and archive
  export share **one** sacrificial chDB, export does not add a second concurrent
  full-memory OLAP copy; rotation adds duration and disk I/O to that working set,
  not another `f(4)` memory term. Calibration measures the real peak RSS per
  candidate via `/usr/bin/time` and selects within a declared budget.
- **Concurrency:** export, checkpoint create/restore/reset, and GC all take the
  maintenance lock, so they serialize. This is intentional and safe.
- **Operators** adopt by: taking a checkpoint, (optionally) calibrating, running
  `archive create` per signal/day, then querying the active paths in DuckDB. No
  second database runs at rest.

## Happy path

1. Ingest telemetry into the running Maple store.
2. `maple checkpoint` creates a validated checkpoint.
3. (Optional) `maple archive calibrate <day> --write-config cfg.json` tunes for
   the deployment; then pass `--config cfg.json` to `create`.
4. `maple archive create 2026-06-01 traces` (and the other five signals) seals
   each day/signal into a validated generation.
5. `maple archive list --output paths --signal traces` returns the active
   Parquet shard paths (superseded generations excluded).
6. DuckDB answers historical queries with exact source counts:
   `read_parquet(<paths>, union_by_name=true)`.

Every archived day's row count is validated against the source
(`sourceRowCount == archivedRowCount == Σ shard.rowCount`), and `archive list`
re-verifies each shard's SHA-256 and byte size against the manifest before
returning it.

## Major failure outcomes

Every archive failure leaves the **live store untouched** — export reads only
from restored scratch. The categories:

- **No generation written:** unavailable or incompatible checkpoint, free-space
  preflight failure, a single matching row exceeding `maxShardBytes`, or a
  validation mismatch. No active pointer changes.
- **Recoverable or retained debris:** the next `create` or
  `archive reconcile` releases exact create scratch/pin ownership and moves
  pre-publication building output into retained quarantine. Unrelated stale
  pins remain safely over-retained.
- **Requires reconciliation:** an interrupted create _after_ publication (pointer
  re-selected, catalog rebuilt) and an interrupted GC (frozen target set resumed;
  a half-removed tombstone is finished, an already-absent target confirmed).
- **Operator intervention:** a `FailClosed` reconciliation (impossible topology
  or suspected corruption), a persistently corrupt active pointer, or a shard
  that repeatedly exceeds bounds. `archive reconcile --dry-run` reports the
  verdict without mutating.
- **Calibration:** no candidate meeting the budget, or insufficient/
  unrepresentative data, yields `low` confidence with `selected: null` (or no
  recommendation) — never a silently hand-tuned config. An interrupted
  calibration releases its derived pin and owned sample on reconcile.

GC is the only operation that deletes published generations; it verifies all
manifests/shards up front, excludes any uncertain signal/range, deletes by
tombstone-rename, persists progress after every target, and proves terminal
invariants before retiring the journal.

## Validation evidence

The branch passed a full validation matrix at the head commit:

- **Unit tests:** complete CLI suite passing (306/306), including manifest-v3
  strictness, semantic config validation (hostile-rewrite and forged-scope
  rejection), strict parent-session pin identity, and the larger disjoint
  held-out scope.
- **Typecheck, lint (zero warnings), formatting, `git diff --check`:** clean.
- **Native archive adversarial probes:** 17/17.
- **Six-signal native archive smoke:** exact DuckDB counts against the source,
  live store unchanged, catalog rebuilt.
- **Merge safety:** multi-part merge probe.
- **Create SIGKILL matrix:** 18/18 boundaries (prepublication quarantine,
  first-shard/validation interruption, manifest/rename/pointer/catalog
  boundaries, the pin-removal gap, scratch cleanup, operation archival,
  live-store invariance, idempotence, and automatic reconciliation by a
  subsequent create).
- **GC SIGKILL matrix:** 6/6 boundaries (prefix/current/suffix crash topology,
  tombstone evidence, zero-mutation parity).
- **Calibration loop:** like-for-like six-metric comparison on a larger, disjoint
  held-out window through the shared writer, with every result's persisted
  sample scope and the document's `samplePolicy` verified. Training observes
  exactly `N` rows and held-out exactly `2N` rows from `[N,3N)`; short windows
  cannot recommend. The persisted hybrid comparison scales wall/physical-byte
  predictions by the recorded logical-byte ratio, compares throughput and
  compression directly, and leaves RSS/temp-disk as absolute peaks. Tolerances
  are a fixed canonical policy (each `< 1.0`) and cannot be redefined by the
  document.
- **Calibration crash probe:** deterministic recovery of a SIGKILLed sampling
  child and an inert intent whose unpinned source was normally retired, plus a post-session-release/
  pre-config-write SIGKILL oracle proving no recommendation, pin, recovery
  record, sample, or scratch debris survives.
- **`archive create --config`:** manifest records the exact immutable config SHA
  and effective tuning, with no calibration debris.

The complete adversarial matrix (invariants, counterexamples, and the
authoritative SIGKILL oracles) is checked in at
`apps/cli/test/archive-adversarial-matrix.md`.

## Known limits

- **v1 is operator-initiated.** There is no live export endpoint and no automatic
  scheduling; scheduling should follow only after repeated successful runs and a
  measured checkpoint pause.
- **No hot-store pruning.** Existing chDB TTLs govern the hot store; archives do
  not delete from it.
- **No UI rehydration.** Historical data is queried in DuckDB, not reloaded into
  the dashboard.
- **No second always-on database.** Archives are files; DuckDB opens them on
  demand.
- **Calibration is machine-specific.** Configs record the environment (Maple/chDB
  version, schema fingerprint, CPU, memory, archive-volume identity) and six
  recalibration triggers; the documented capacity numbers come from one machine
  and operators should calibrate their own deployment.
- **Manifest format v3** rejects v2/v1 fail-closed; older archives must be
  re-exported rather than migrated in place.

## Follow-up work

- Automatic scheduling of `archive create` after measured checkpoint-pause
  characterization.
- Live export endpoint (out of scope for v1).
- Archive rehydration into the Maple UI (out of scope for v1).

## Documentation

`docs/local-telemetry-archives.md` is the operator and architecture guide: the
model, the six signals, the directory/manifest/pointer/catalog layouts, the full
tuning field reference with defaults and constraints, the calibration workflow
(candidate matrix, worst-case aggregation, margin-inside-ceiling, held-out
validation, and the no-recommendation cases), recovery and reconciliation, the
complete off-happy-path catalog, the capacity model, and non-goals.
