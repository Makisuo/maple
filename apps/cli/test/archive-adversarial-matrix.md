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

The digest construction must bind (a) column index/name + position, (b) NULL
flag, (c) normalized value, and aggregate rows as an order-independent multiset
that preserves duplicates. A commutative sum of independent per-column hashes
fails all three transformations.

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

| Counterexample transformation                               | Named probe                            | Independent oracle                                    | Required                          |
| ----------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| NULL in any column (histogram `Min`/`Max`)                  | `archive-probe-null-digest.ts`         | per-column NULL-presence equality                     | digest stable, non-empty (green)  |
| Bare `DateTime` widened to `DateTime64(3,'UTC')` by Parquet | `archive-probe-datetime-normalize.ts`  | per-column hash equality after measured normalization | match (green)                     |
| Schema substitution `Array(UInt64)`↔`Array(String)`         | `archive-probe-schema-substitution.ts` | recursive type compare after measured normalization   | rejected (green)                  |
| Empty vs NULL vs single-element collections                 | `archive-probe-complex-fidelity.ts`    | canonical row comparison via DuckDB                   | rejected if changed (red → green) |

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
