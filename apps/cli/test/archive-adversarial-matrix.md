# Archive export — adversarial validation matrix

This is a **permanent gate**, not a one-time review. It exists because four
consecutive Gate 2 rounds failed for the same root cause: the implementation
and its tests shared one mental model, so the tests confirmed the author's
intent while the independent review attacked the author's assumptions. Each
repair taught a lesson that then disappeared into conversation. This matrix
captures the lessons so the next change to archive export must answer them
explicitly, in code, before it can be considered done.

**Working rule:** before any change to archive export can be called complete,
answer this question in writing for the diff:

> How could an _incorrect_ archive preserve every metric I currently check?

Every cell below is a concrete instance of that question, the transformation
that realizes it, the named probe that must catch it, the independent oracle
that confirms the verdict, and the required result. A probe must be hermetic
(owned `mkdtemp`, cleans only its own state, no fixed `/tmp` paths, runs from a
fresh clone with otherwise-empty `/tmp`) and use consistent exit semantics:
**nonzero when corruption is accepted, zero when corruption is correctly
rejected.**

The red/green columns record the state at the round this matrix was introduced
(Gate 2 round 5). Red = the current code fails to detect the corruption; the
repair must turn it green.

## Invariants and counterexamples

### 1. Exact row identity

**Invariant:** a shard contains exactly the source rows for its sealed slice,
each row's values bound to its columns and its row identity — not merely the
same aggregate of values.

| Counterexample transformation                                                                                               | Named probe                           | Independent oracle                                     | Required                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Swap two same-typed Map columns within rows (e.g. `SpanAttributes`↔`ResourceAttributes`), preserving count and time extrema | `archive-probe-digest-column-swap.ts` | canonical full source rows vs DuckDB-read Parquet rows | rejected (red at round 4 → green at round 5) |
| Reassociate values between two rows (move row A's map to row B and vice versa), preserving count and time extrema           | `archive-probe-digest-row-swap.ts`    | per-row canonical comparison                           | rejected (red → green)                       |
| Duplicate one row and drop another of equal count, preserving count and time extrema                                        | `archive-probe-digest-dup-drop.ts`    | per-row multiset equality                              | rejected (red → green)                       |

The digest construction must bind (a) column index/name + position, (b) an
EXPLICIT NULL flag (a sentinel alone is insufficient — a real Nullable(String)
value can equal the sentinel), (c) normalized value, and aggregate rows as an
order-independent multiset that preserves duplicates. A commutative sum of
independent per-column hashes fails all three transformations.

### 2. Stable physical sharding

**Invariant:** every archived row is archived exactly once across all shards,
and no row outside the sealed slice is archived, for any physical layout.

| Counterexample transformation                                | Named probe                        | Independent oracle                      | Required      |
| ------------------------------------------------------------ | ---------------------------------- | --------------------------------------- | ------------- |
| Offset holes within a part (matching offsets non-contiguous) | `archive-probe-mixed-hour.ts`      | source ID set vs union of shard ID sets | exact (green) |
| Multiple parts for one hour, out-of-order insertion          | `archive-probe-multipart.ts`       | same                                    | exact (green) |
| A background merge injected between shard pages              | `archive-probe-merge-injection.ts` | same; merges must be blocked            | exact (green) |

Paging must derive counts and cut points from the **actual** matching rows, not
from an assumed contiguous offset range. `_part_offset` repeats across parts, so
any predicate must bind `_part` together with the offset range.

### 3. Complex-value fidelity

**Invariant:** Map, Array, nested-Map/Array, NULL, and high-precision
timestamp values round-trip exactly through Parquet.

| Counterexample transformation                                   | Named probe                                                               | Independent oracle                                  | Required                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| NULL in any column collapses the digest to empty                | `archive-probe-null-digest.ts`                                            | digest string non-empty                             | digest non-empty (green)     |
| NULL-bearing rows lose value sensitivity in NON-NULL columns    | `archive-probe-null-value-sensitivity.ts`                                 | two NULL-Min datasets, different non-null values    | digests differ (red → green) |
| NULL collides with a real Nullable(String) sentinel value       | `archive-probe-null-flag-binding.ts`                                      | NULL vs '\x00NULL' string                           | digests differ (red → green) |
| Bare `DateTime` / `DateTime64(N)` render diverge source↔Parquet | covered by `archive-probe-duckdb-oracle.ts` (epoch_us on raw TIMESTAMPTZ) | numeric epoch normalization in the digest           | match (green)                |
| Schema substitution `Array(UInt64)`↔`Array(String)`             | `archive-probe-schema-substitution.ts`                                    | recursive type compare after measured normalization | rejected (green)             |
| A non-null map/value changed with identical count/time          | `archive-probe-complex-alter.ts`                                          | export twice, compare digests                       | digests differ (green)       |
| Read-back fidelity via an INDEPENDENT reader (not the digest)   | `archive-probe-duckdb-oracle.ts`                                          | DuckDB epoch_us / NULL count / array contents       | match source (green)         |

No chDB Parquet type/value behavior may be assumed; it is measured (see
`reports/gate2-round4-probes.md` and the round-5 probe report) before any
comparison logic is written.

### 4. Byte bounds

**Invariant:** every shard satisfies both `maxShardRows` and `maxShardBytes`
(uncompressed). The planner refines by measurement, not by sampling.

| Counterexample transformation                                               | Named probe                           | Independent oracle                                  | Required                          |
| --------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | --------------------------------- |
| Narrow prefix + wide incompressible tail (sample-based plan underestimates) | `archive-probe-byte-heterogeneous.ts` | actual `total_uncompressed_size` per shard ≤ bound  | every shard ≤ bound (red → green) |
| Uniform wide rows                                                           | `archive-probe-byte-uniform.ts`       | same                                                | ≤ bound (green)                   |
| One genuinely oversized row that cannot fit alone                           | `archive-probe-byte-single-row.ts`    | distinct `single row exceeds maxShardBytes` failure | distinct failure (red → green)    |

Sampling may choose an initial range size but cannot determine correctness.
The only impassable case is a single matching row whose uncompressed size
exceeds `maxShardBytes`.

### 5. UTC time bounds

**Invariant:** shard time evidence and range binding are independent of the host
timezone.

| Counterexample transformation                                  | Named probe                                  | Independent oracle                       | Required                       |
| -------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- | ------------------------------ |
| Valid 23:30 UTC shard bound parsed under `TZ=America/New_York` | `archive-probe-timezone-bound.ts`            | `BigInt` epoch-nanosecond comparison     | accepted (red → green)         |
| Out-of-range bound (2027 shard for a 2026 range)               | unit test in `archive-export-round5.test.ts` | integer range comparison                 | rejected (green)               |
| Timezone-less string `"2026-06-29 23:30:00..."` serialized     | covered by the timezone-bound probe          | canonical UTC epoch-nano decimal strings | never serialized (red → green) |

Shard bounds are persisted as decimal-string epoch nanoseconds and parsed with
`BigInt`, never as timezone-dependent ISO via `Date.parse`.

### 6. Cleanup at every boundary

**Invariant:** a failure at any point in the export lifecycle leaves merges
restarted and only proven-owned temporary output removed.

| Counterexample transformation                                         | Named probe                             | Independent oracle                              | Required                   |
| --------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | -------------------------- |
| Setup failure immediately after `STOP MERGES` (before the main `try`) | `archive-probe-merge-freeze-leak.ts`    | `OPTIMIZE` succeeds after failure (no code 236) | merges restarted (green)   |
| Mid-export shard failure                                              | covered by the heterogeneous-byte probe | merges restarted; only owned candidate removed  | restarted, no leak (green) |

`try/finally` begins immediately after a successful `STOP MERGES`.

### 7. Malformed-state fail-closed

**Invariant:** an unknown manifest format version or a malformed field fails
closed while preserving the offending files.

| Counterexample transformation                          | Named probe | Independent oracle            | Required                    |
| ------------------------------------------------------ | ----------- | ----------------------------- | --------------------------- |
| Manifest `formatVersion` from a future/unknown version | unit test   | parse throws, files untouched | rejected, preserved (green) |
| Missing/empty `complexDigest`, non-numeric digest      | unit test   | parse throws                  | rejected (green)            |
| Shard time outside sealed range                        | unit test   | `BigInt` range comparison     | rejected (green)            |

A manifest format-version bump must reject older formats explicitly (the
on-disk files are preserved for inspection).

### 8. Recovery reproducibility

**Invariant:** the recovery bundle clones to the exact reviewed commit with
complete ancestry, verifiable with the original repository and `/tmp`
unavailable.

| Counterexample transformation                               | Named probe                                                              | Independent oracle                              | Required                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------- |
| Clone bundle from isolated dir, original repo + `/tmp` gone | `git clone -b codex/local-telemetry-archives-impl <bundle>` + `git fsck` | cloned HEAD == final round-5 commit; clean fsck | exact HEAD, clean (red → green) |
| Run the committed probe runner from that clone              | the native runner                                                        | all probes green                                | green (red → green)             |

The bundle must contain the exact branch and complete ancestry, never rewritten
alternate history.

### 9. Crash recovery (Gate 3a) — authoritative SIGKILL oracle

**Invariant:** a process kill at ANY point in the archive generation lifecycle
leaves state that the next operation reconciles to its exact intended outcome —
no orphaned pin, no orphaned scratch, no half-published generation, no duplicate
catalog entry, no clobbered pointer, and the live store unchanged. The operation
has no cleanup `finally`: hook-throw and SIGKILL therefore leave the same
journal-described durable state, and reconciliation is the only cleanup
authority.

**Authoritative oracle:** the native harness
`native-archive-crash-recovery-probe.sh` injects a real SIGKILL at each boundary
via a committed child worker paused at a fault seam, then reconciles WITHOUT a
fresh export and verifies exact convergence + idempotence. Hook-throw results are
secondary deterministic coverage; they cannot substitute for the real process
kills below.

| Kill-point (SIGKILL at…)                                   | Published? | Required oracle                                              |
| ---------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| before initial intent durability                           | no         | no final/pointer/catalog/quarantine; no debris               |
| intent durable, before pin acquisition                     | no         | exact journal-owned pin absent or released; clean abort      |
| scratch allocated, immediately before synchronous restore  | no         | scratch removed; no final generation                         |
| restore complete                                           | no         | scratch removed; no final generation                         |
| building created                                           | no         | exact building quarantine retained                           |
| after first individually fsynced shard of a 3-shard export | no         | exactly owned incomplete building quarantined; no final      |
| all shard validation complete                              | no         | exact complete shard set quarantined; no final               |
| before in-building manifest write                          | no         | quarantine retained; no final                                |
| in-building manifest + journal hash durable, before rename | no         | manifest-bearing building quarantined; no final              |
| complete manifest-bearing generation renamed               | yes        | strict manifest/hash/shard verification, then CAS pointer    |
| before pointer update                                      | yes        | same as above                                                |
| pointer durable, before catalog update                     | yes        | catalog exactly one authoritative entry                      |
| catalog durable, before pin release                        | yes        | exact-purpose pin released                                   |
| pin removed, before journal phase advance                  | yes        | absence accepted because catalog-complete authorizes release |
| pin-released phase durable                                 | yes        | scratch cleanup completes                                    |
| before scratch removal                                     | yes        | exact scratch removed                                        |
| complete phase, before operation-journal archival          | yes        | active journal archived exactly once                         |
| fresh `archive create` after crash                         | yes        | dead-owner lock reconciled first, then new generation sealed |

The journal is written BEFORE pin acquisition and records the deterministic
resolved archive/data/scratch roots, pinId/purpose, scratchSubdir, signal/range,
and generationId up front — closing the orphan-pin window
where a SIGKILL between pin creation and journal write would be unreconcilable.
The complete manifest is written and synced inside `building/`, its exact
SHA-256 is recorded in the journal, and only then is the whole directory renamed
to its final location. Reconciliation strictly binds that manifest and every
shard before pointer or catalog mutation.
The pointer flip is CAS-guarded (must equal the recorded base or already select
the intended generation) so post-crash concurrent activity is never clobbered.
Pin absence is success ONLY at a phase where release was already authorized.

### 9a. Reconciliation labels are claims, not evidence

| Hostile topology                                                              | Required oracle                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| free-space preflight fails                                                    | no new active intent exists                                                      |
| configured scratch root has a symlinked ancestor                              | fail closed; outside sentinel unchanged; active journal retained                 |
| partial restored store contains an internal table symlink                     | unlink owned tree without following link; outside target survives; evidence kept |
| pointer-complete/catalog-complete label but pointer or catalog is missing     | repair from recorded CAS topology and authoritative manifests                    |
| pointer selects neither recorded base nor intended generation                 | fail closed without clobbering pointer; active journal retained                  |
| catalog-complete label but catalog is tampered, duplicated, or truncated      | rebuild exact canonical catalog from all authoritative manifests                 |
| complete label with manifest/shard/pointer/catalog/pin/scratch/building drift | fail closed without repair or journal retirement                                 |

The `complete` phase is uniquely non-repairing: before its journal can move out
of `operations/active/`, reconciliation must prove the final manifest hash and
identity, every shard hash/size, intended pointer, exact canonical catalog,
owned-pin absence, owned-scratch absence, and building absence. Any mismatch
retains the active journal as the only authority over uncertain state.

**Restore limitation, stated precisely:** chDB exposes RESTORE as one synchronous
FFI call and provides no callback from inside that call. The authoritative
matrix therefore covers the durable boundary immediately before RESTORE and the
boundary after RESTORE returns; it does not mislabel the pre-call pause as
"during restore." A real OS-level arbitrary-time kill inside the FFI call
remains outside this deterministic seam, while its possible durable topology
(journal at scratch-allocated with partial scratch) is the same topology the
pre-restore recovery case exercises.

**Working rule for this section:** _how could a crash at this kill-point preserve
every metric I currently check, or appear recovered while leaving corrupt state?_
The answer the harness enforces: reconcile-without-export → verify exact
convergence → reconcile AGAIN (idempotence). The recovery code returning success
is NOT the oracle; the on-disk state after a kill is.

### 10. Garbage collection (Gate 3b) — conservative journaled deletion

**Invariant:** GC deletes only superseded generations it can PROVE are not the
active pointer target — never the active generation, never quarantined/malformed/
symlinked/ambiguous state, never a range with NO active pointer (uncertain →
over-retained). It is the only archive operation that deletes published
generations, so it journals a frozen deletion set (computed under the maintenance
lock) and collects via a **tombstone rename**, never an in-place recursive delete,
so a SIGKILL mid-collection leaves only whole, owned state that reconcile can
prove ownership of. A crashed GC shares the single `operations/active/` slot with
create and is reconciled by the same entry point (dispatched on `kind: "gc"`); a
stranded GC must reconcile or it blocks all future archive work.

**State machine (the core repair):** GC uses a nonterminal `gc-collecting` phase
(`0 ≤ completedTargets ≤ targets.length` — the full cursor is the legitimate
post-final-deletion state before catalog repair). Progress is persisted as
`gc-collecting` per target, NEVER `complete`. `complete` is written only after
every target is absent + every affected catalog passes `assertCatalogExact`, and
a `complete` journal is verified before archival. The parser rejects
kind-incompatible phases, `aborted` for GC, and inconsistent phase/cursor
combinations (a phase label is never proof of durable reality — the exact defect
repaired in 3a, applied to GC).

**Policy:** `--keep N` default **1** (retain the newest superseded generation per
signal/range; `--keep 0` reclaims all). A signal whose catalog cannot be
authoritatively reconstructed, OR a range with no active pointer, is excluded
ENTIRELY before any mutation. Both `reconcile` and `gc` acquire the maintenance
lock; dry-run consumes a shared nonmutating planner (never reconciles).

| Kill-point (SIGKILL at…)                                                       | Probe                            | Oracle + required recovery                                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| after GC intent durability, before any collection                              | `native-archive-gc-probe.sh`     | reconcile completes the frozen set; only the active generation remains; idempotent                            |
| after first source→tombstone rename, before removal                            | "                                | reconcile resumes: source absent + tombstone present → remove the tombstone; both superseded deleted          |
| **nonfinal target removed + gc-collecting progress durable** (index < total-1) | "                                | reconcile resumes from the cursor + collects the remaining target; NEVER archives prematurely                 |
| after all removals, before catalog rebuild                                     | "                                | reconcile rebuilds affected catalogs from manifests; `assertCatalogExact` passes                              |
| after catalog rebuild, before journal completion                               | "                                | reconcile verifies terminal invariants + archives the journal; create-after succeeds                          |
| `gc --dry-run` (with an active op present)                                     | " + `archive-gc.test.ts`         | reports the blocker; NO mutation (snapshot before == after; no reconcile, no journal, no deletion)            |
| `reconcile --dry-run`                                                          | `archive.ts` + journal           | shared `planArchiveReconciliation`; reports kind/phase/actions without mutating (no migration)                |
| keep-N retention ordering                                                      | `archive-gc.test.ts`             | newest N superseded retained per range; older ones targeted; active never selected                            |
| pointer re-selection (CAS)                                                     | `archive-gc.test.ts` + reconcile | if the pointer returns to a target, collection stops and preserves it; never deletes a re-selected generation |
| source replaced/both-present topology                                          | `archive-gc.test.ts`             | source+tombstone both present, or identity differs → fail closed (preserve everything)                        |
| malformed manifest / tampered shard / symlinked gen                            | `archive-gc.test.ts`             | range/signal excluded before any mutation; over-retained; reported                                            |
| absent leaf below symlinked generation/tombstone ancestor                      | `archive-reconcile.test.ts`      | root-to-leaf classifier rejects before mutation; outside sentinel and complete structural snapshot unchanged  |
| absent completed/quarantine destination below symlinked ancestor               | `archive-reconcile.test.ts`      | dry-run and apply both fail closed before collection/quarantine; journal and building state unchanged         |
| missing active pointer (uncertain range)                                       | `archive-gc.test.ts`             | range excluded entirely; nothing targeted; no journal written; no invalid sentinel                            |
| terminal invariant (complete journal)                                          | `archive-gc.test.ts`             | completedTargets===length, every source/tombstone absent, pointer unchanged, catalog exact — else fail closed |
| legacy v2 create intent (pre-kind)                                             | `archive-journal.test.ts`        | `migrateV2CreateIntent` lifts to v3 under the lock; a stranded 3a intent reconciles; corrupt v2 fails closed  |

For every boundary the harness verifies the EXACT invariants (not just counts):
only the FROZEN target IDs are removed; the EXACT active generation remains with
its pointer identity unchanged; the completed GC journal has `phase: complete` +
`completedTargets === targets.length` + the unchanged frozen set; the catalog
exactly matches authoritative manifests; no tombstone retains a generation; a
second reconcile is a no-op; and a subsequent `archive create` succeeds (a crashed
GC never blocks future work). Reconciliation NEVER expands the frozen set — a
resumed GC deletes exactly what the original decided.

Zero-mutation parity uses a fail-loud structural snapshot, not shell `find |
shasum`: it records every relative path, entry type, symlink target, file size
and hash, and empty directory. A dangling symlink is evidence and snapshot
failure is a test failure, never a comparable sentinel value.

**Working rule for this section:** _GC is the only path that deletes published
evidence, so it must prove it owns and may delete each generation twice — once at
plan time (under the lock) and once at collection time (the CAS re-check)._
"Recovery succeeded" is never the oracle; the on-disk state after a kill is.

## How to use this matrix

1. For any archive-export change, identify which invariants the diff touches.
2. Write/extend the corresponding probe so it fails against the current code.
3. Implement the change; require the probe to pass and the six-signal smoke to
   pass.
4. Re-answer, in the change description: _how could an incorrect archive
   preserve every metric this change checks?_
5. Update this matrix's red/green columns if a new transformation is
   discovered.

The matrix is the gate; the ledgers (`STATUS.md`/`TESTS.md`/`DECISIONS.md`)
record only the verdict.
