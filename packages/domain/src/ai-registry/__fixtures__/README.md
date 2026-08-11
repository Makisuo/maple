# `equivalence-spans.jsonl`

Adversarial spans, driven through **the real ingest row writer**, for the Rust↔SQL
equivalence suites in this directory.

## The claim

For any span, the SQL compiled from `registry.json` (`../compile-sql.ts`) evaluated over
the row ingest _actually wrote_ must produce the same `AiVendor` and `AiSessionKeyState` as
the Rust classifier that wrote it, and `AiSessionKeyHash` must be exactly
`cityHash64(value)` as ClickHouse computes it.

Each line is one span:

```jsonc
{
	"id": "session/spring/state6", // unique, stable across regenerations
	"category": "session/spring_ai", // fuzz-surface bucket (see below)
	"note": "resolved",
	"rust": {
		"vendor": "spring_ai",
		"session_state": 6,
		"session_key_hash": "10836…", // a decimal STRING: UInt64 > 2^53
		"rules_version": 1,
		"session_key_hex": "636f6e762d3432", // raw winning key, or null below state 5
	},
	"row": "{\"start_time\":…}", // the exact NDJSON line the writer produced
}
```

`row` is the writer's bytes verbatim, kept as a string. The suites replay it unmodified
through the same generated INSERT statement ingest uses — re-serialising a parsed row would
corrupt `ai_session_key_hash` on the way through `JSON.parse`. Because `row` already carries
the Rust verdict in `ai_vendor` / `ai_session_key_state`, the differential needs no join
key: it is `WHERE computed != stored` over a real `traces` table.

## Regeneration

The generator is `apps/ingest/src/ai_equivalence_fixtures.rs`. It builds each span, runs it
through `encode_traces` — the same function the ingest request path calls — with the
classification flag on, and serialises the row the writer produced.

```sh
cd apps/ingest
EQUIVALENCE_FIXTURE_OUT=../../packages/domain/src/ai-registry/__fixtures__/equivalence-spans.jsonl \
  cargo test --lib write_equivalence_fixture -- --ignored --nocapture
```

Regenerate after any change to `registry.json`, to the classifier, or to the row writer's
canonicalization. `cargo test --lib fixture_is_reproducible` fails when the checked-in
artifact is stale; `fixture_covers_every_branch` fails when a category, a session-key state
or a vendor stops being represented.

**Determinism.** No clock, no RNG, no environment: receive time and span start times are the
constant `1700000000`, trace/span ids come from a fixed counter, and every value is a
literal. Regeneration is byte-stable, which is what makes the staleness check meaningful.
The artifact is ~630 KB and must stay under 1 MB (asserted).

## Corpus composition

316 spans. Categories:

| category                               | spans | what it exercises                                                                 |
| -------------------------------------- | ----- | --------------------------------------------------------------------------------- |
| `resolution/sufficient_scope`          | 50    | every sufficient scope matcher, plus a second span under the same hoisted scope   |
| `resolution/attr_only`                 | 33    | every attr-class matcher alone under an unclaimed scope                           |
| `resolution/insufficient_promoted`     | 8     | insufficient resource/scope candidates promoted by a same-vendor attr hit         |
| `resolution/insufficient_not_promoted` | 8     | the same evidence with nothing to promote it                                      |
| `resolution/cross_vendor`              | 6     | two vendors' evidence on one span; the global priority bands decide               |
| `resolution/unknown_tier`              | 8     | each fingerprint, bucket ordering, and the `input.value` co-occurrence gate       |
| `resolution/non_ai`                    | 6     | HTTP/DB spans, no attributes, no scope, no resource                               |
| `session/*` (18 vendors)               | 71    | the state ladder 1–6, decoy values, `max` over disjoint candidate populations     |
| `values/typed`                         | 17    | int/double/bool/bytes/array/kvlist/`None` canonicalization, incl. as session keys |
| `values/present_empty`                 | 9     | present-but-empty vs absent (states 4 vs 3), empty keys, empty authority values   |
| `keys/duplicate`                       | 12    | registry keys first-occurrence-wins, non-registry keys last-wins, both orders     |
| `keys/near_miss`                       | 48    | keys/scopes sharing a first byte and length with a registry key or prefix         |
| `unicode`                              | 22    | astral planes, combining marks, BOM, embedded NUL, RTL, CJK, non-ASCII key values |
| `oversized`                            | 7     | 64 KiB values, 4 KiB keys and span names, 60-attribute spans, inline-view spill   |
| `pseudo_keys`                          | 6     | span attributes impersonating `scope.name`/`span.name`, empty/populated versions  |
| `cross_class`                          | 10    | registry keys carried where their matcher's class does not look — all non-hits    |

All 21 registry vendors and all three `unknown:*` buckets classify at least one span; all
seven session-key states (0–6) are represented; 64 spans resolve a session key and become
hash-alignment vectors.

## What this proves — and what it does not

**Rust↔SQL only.** trace-capture's reference evaluator (`scripts/verify-seed.ts`) is a third
implementation of the same algebra and is deliberately _not_ in this loop: it renders kvlist
values in insertion order and `JSON.stringify`s byte values, where the row writer's
`any_value_string` sorts kvlist keys (the row Map is a `serde_json::Map`) and hex-encodes
bytes. That divergence cannot affect these suites — the SQL reads the string the row writer
already produced — but "the fixture agrees with the seed verifier" is not a claim made here.

**`value_prefix` has no registry rule.** The registry currently contains zero `value_prefix`
matchers, so no vendor branch exercises the operator. `equivalence.clickhouse.e2e.test.ts`
covers it directly instead: it compiles the predicate against all four pseudo-keys and
compares ClickHouse's `startsWith` against the byte compare Rust performs on the same column
value, over every fixture row.

## Suites

| file                                           | gate                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `../equivalence.clickhouse.e2e.test.ts`        | the synthetic differential, present-but-empty, dedup, `value_prefix`                            |
| `../hash-alignment.clickhouse.e2e.test.ts`     | `cityHash64(value)` vs the stored hash, incl. the multi-argument negative pin                    |
| `../corpus-equivalence.clickhouse.e2e.test.ts` | the same differential over the whole capture corpus                                             |

```sh
bun ch:up
CLICKHOUSE_E2E=1 bun run --cwd packages/domain test -- clickhouse.e2e
```

### Full-corpus gate (local, on demand)

The trace-capture corpus is a sibling repo, not a vendored fixture, and its replay artifact
is ~150 MB — never checked in. Two commands:

```sh
# 1. emit rows + verdicts from the real writer
cd apps/ingest
TRACE_CAPTURE_DIR=~/Documents/repos/trace-capture \
CORPUS_EQUIVALENCE_OUT=/tmp/corpus-equivalence.jsonl \
  cargo test --lib write_corpus_equivalence_fixture -- --ignored --nocapture

# 2. replay them into ClickHouse and compare
CLICKHOUSE_E2E=1 CORPUS_EQUIVALENCE_FIXTURES=/tmp/corpus-equivalence.jsonl \
  bun run --cwd packages/domain test -- corpus-equivalence.clickhouse.e2e
```

Last run (2026-08-11, registry version 1, after the class-directed fix below): **10,091 spans
across 57 captures, 0 mismatches** — 5,921 classified spans over 23 distinct vendors and all
seven session-key states, span for span the same verdicts as before the fix.

## Findings

`PINNED_DIVERGENCES` in `../equivalence.clickhouse.e2e.test.ts` is **empty**: all 316 spans
agree. It was not always — twelve were pinned until 2026-08-11 under two findings that were
one root cause, and both are now fixed in the Rust classifier rather than pinned:

- **F1 — cross-class lookup.** Rust resolved a predicate's key span → scope → resource for
  _every_ matcher class, and took `key_prefix` evidence from the union of all three
  attribute lists, where the compiled SQL targets one map per matcher class. Ten fixture
  spans, engineered to carry a registry key where its class does not look, disagreed — in
  both directions, because Rust also let a span attribute veto a hoisted resource `eq` hit
  that SQL still saw.
- **F2 — prefix-family self-promotion.** `langsmith.internal_provider` is langchain's
  _insufficient_ resource matcher key and also lies inside langchain's `attr`-class
  `key_prefix(langsmith.)` family. Via F1 the resource key satisfied that attr matcher,
  which promotes, so a process that set the attribute on its **resource** had every span —
  plain HTTP included, and even with the value `'false'` — classified `langchain` by Rust.
  That defeated the plan's sufficiency gate on realistic, wire-observed input.

`apps/ingest/src/ai_classifier.rs` is now class-directed, mirroring `targetForClass`; the
span → scope → resource fallback survives only in trace-capture's single-seed
`scripts/verify-seed.ts`. The corpus never distinguished the two rules (its 10,091 spans
classify identically either way), so no golden moved. The twelve spans stay in the fixture
as the regression surface.
