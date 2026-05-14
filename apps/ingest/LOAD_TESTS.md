# Ingest Load Tests

The ingest load harness starts:

- a fake Tinybird HTTP import endpoint,
- a real `maple-ingest` process configured with the static key store,
- an OTLP protobuf log traffic generator,
- a process sampler for ingest RSS and CPU via `ps`.

Build and run a local smoke test:

```sh
cargo build --release --bin maple-ingest --bin load_test
LOAD_TEST_REQUESTS=10000 \
LOAD_TEST_CONCURRENCY=128 \
LOAD_TEST_BATCH_LOGS=10 \
target/release/load_test
```

Useful knobs:

- `LOAD_TEST_REQUESTS`: total OTLP requests to send.
- `LOAD_TEST_CONCURRENCY`: concurrent request workers.
- `LOAD_TEST_BATCH_LOGS`: log records per OTLP request.
- `LOAD_TEST_TARGET_RPS`: optional request/sec pacing target.
- `LOAD_TEST_MIN_RPS`: optional failure threshold for accepted request/sec.
- `LOAD_TEST_MAX_RSS_MB`: optional failure threshold for max ingest RSS.
- `LOAD_TEST_INGEST_BIN`: path to the ingest binary when not using the default sibling binary.
- `LOAD_TEST_INGEST_MODE`: `tinybird` (default) or `forward`.
- `LOAD_TEST_QUEUE_DIR`: WAL directory override.
- `LOAD_TEST_REPORT_PATH`: when set, the `LoadSummary` JSON is also written here
  (in addition to stdout). CI uses this to avoid parsing JSON out of mixed stdout.

The harness prints JSON with request throughput, row throughput, p50/p95/p99
latency, export catch-up time, max RSS, and exported rows. CPU samples come
from `ps` and are unreliable for short runs on Linux — they are kept in the
JSON for reference but the CI comment intentionally omits them.

The GitHub Actions workflow `Ingest Load Tests` is manual (`workflow_dispatch`)
so large runs do not make normal PR CI noisy or flaky.

For local microbenchmarks, the ingest crate also has Criterion benches:

```sh
cargo bench --bench ingest_bench -- --sample-size 10 --warm-up-time 1 --measurement-time 1
```

Those benchmarks measure WAL-acked native accepts for representative log and
trace OTLP batches. CI runs them on every PR via `--output-format=bencher`
and embeds the result in the PR comment.

On pull requests, the `Ingest Rust Tests` workflow runs the load harness
**three times** on the PR and (when the same `LOAD_TEST_INGEST_MODE` is
supported on the base branch) three times on the base branch, then posts
median throughput, row throughput, latency, export catch-up, RSS, and failure
deltas back to the PR as a single sticky comment that updates on each push.
If the base branch does not support the head's ingest mode (e.g. this PR
introduces a new mode), the cross-mode comparison is skipped and only
absolute PR numbers are shown.
