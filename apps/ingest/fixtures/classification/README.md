# Vendored classification fixture

Recorded OTLP spans that CI replays through the AI span classifier — the tests
live in `src/ai_classification_fixture_test.rs`. The files are generated in the
trace-capture repo by `bun run fixture` and copied here unchanged.

| file | what it is |
| ---- | ---------- |
| `classification-fixture.jsonl` | one span per line — the classifier's inputs. Spans no vendor matches are deduplicated: one representative line with a weight instead of many near-identical lines. |
| `expectations.json` | the expected classification results per capture, taken from hand-reviewed goldens |
| `manifest.json` | line counts, sha256 hashes, and a record of exactly which trace-capture revision produced the files |

## Updating the fixture

Whenever trace-capture's captures or vendor seeds change, regenerate and
re-vendor in the same change that edits `src/ai_vendors.rs`:

```sh
cd ../../../trace-capture   # or wherever the checkout lives
bun run fixture
cp fixture/classification-fixture.jsonl fixture/expectations.json fixture/manifest.json \
   <maple>/apps/ingest/fixtures/classification/
```

The test recomputes the sha256s against `manifest.json`, so a hand-edited
fixture, a partial copy, or mangled line endings fail CI loudly.

The hashes only cover the two data files — `manifest.json` itself is not
hashed. What keeps the manifest honest is its `source` block: it names the
trace-capture commit that produced the files, and `dirty: false` means checking
out that commit and running `bun run fixture` reproduces these exact bytes. If
a re-vendor ever comes out `dirty: true`, don't ship it (the test rejects it):
commit the trace-capture side first, then regenerate — otherwise the recorded
commit can't reproduce the files and the provenance is worthless.

One more manifest field is checked mechanically: `dedup.value_sensitive_keys`
lists the attribute keys whose *values* affect classification, so
deduplication never collapses spans that differ on one of them. A test
re-derives the list from `ai_vendors.rs` and fails if it has fallen behind.
That check matters: a missing key would merge spans that classify differently,
making the false-positive numbers and histograms wrong rather than merely loose.

## Limits of the format

Two rule shapes can't be expressed in the fixture lines, and a test asserts
nothing depends on them yet:

- **Scope attributes** — the lines carry the scope name/version/schema-url but
  not scope attributes. No rule reads one today; the first that does needs a
  line-schema extension and `format_version` bump in trace-capture.
- **Link contents** — only the *number* of links is recorded. The classifier
  has no link accessor at all today, so the field is currently unread.

Maple CI never reaches into trace-capture, deliberately. The flip side: a PR
that touches vendor rules without a fixture update (or the reverse) is a
review smell nothing automated will catch.

## Where the expected results come from

`expectations.json` was **not** produced by this classifier. The numbers come
from running each vendor seed's own rules over its captures in trace-capture,
followed by human review. A green replay therefore proves maple's Rust rules
compute the same answers as the reviewed rules — an independent check, though
not ground truth.

There are marked exceptions: six golden fields across four captures carry a
`v2_resolved` note, meaning the shipped rule can't be expressed in the seed
rule language, so those numbers were predicted by hand instead. The replay
test pins that exact set so it can't grow silently. Two fields have even
weaker coverage:

| field | gate |
| --- | --- |
| `pydantic_ai_agents.unsessioned_traces` | trace-level, and this fixture strips trace ids — only `ai_classifier_corpus_test.rs` checks it, which needs a local trace-capture checkout (`TRACE_CAPTURE_DIR`). No CI coverage. |
| `pydantic_ai_agents.key_state_by_candidate` | none — not emitted into `expectations.json` at all. |

If a golden looks wrong, re-review the seed in trace-capture (see its
`frameworks/REVIEW_IMPLEMENTATION.md`). Never regenerate goldens from this
classifier's output — the gate would then only check that the classifier
agrees with itself, and nothing in either repo would record that it happened.
