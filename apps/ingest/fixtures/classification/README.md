# Vendored classification fixture

Recorded OTLP spans that CI replays through the AI span classifier — the tests
live in `src/ai_classification_fixture_test.rs`. Two things are asserted:

1. every span classifies exactly as `expectations.json` records — vendor,
   session-key state and session key;
2. at most one vendor's rules match any span.

| file | what it is | owned by |
| ---- | ---------- | -------- |
| `classification-fixture.jsonl` | one span per line — the classifier's inputs, recorded from real framework runs (identifiers pseudonymized, content masked) | trace-capture, copied here unchanged |
| `expectations.json` | the expected result per span, aligned line-for-line with the JSONL | this repo — a reviewed snapshot of classifier output |
| `manifest.json` | sha256 + line count for the JSONL, and the trace-capture commit that generated it | trace-capture, copied here unchanged |

## Changing the rules

Edit `src/ai_vendors.rs`, then regenerate the expected results and review the
diff — the diff *is* the behavior change:

```sh
cd apps/ingest
UPDATE_CLASSIFICATION_EXPECTATIONS=1 cargo test --lib fixture_replay
git diff fixtures/classification/expectations.json
```

Every changed line is one span whose classification moved. If a span moved that
you didn't intend to move, that's a regression the diff just caught. Never
regenerate to make a red CI green without reading what changed.

## Adding or updating recorded spans

The JSONL comes from trace-capture (`bun run fixture` over there). Copy the new
`classification-fixture.jsonl` + `manifest.json` here, then regenerate
`expectations.json` as above and review what the new spans classify as. The
test checks the JSONL's sha256 against the manifest, so a partial copy or a
hand-edited line fails loudly; `manifest.source.commit` (with `dirty: false`)
records the trace-capture revision that reproduces the file byte-for-byte.
