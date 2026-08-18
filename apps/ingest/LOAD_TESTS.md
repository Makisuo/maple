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

## Profiling with hotpath

The crate carries opt-in [hotpath](https://hotpath.rs) instrumentation: the
request stages in `main.rs` (`resolve_ingest_key`, `decode_and_enrich_payload`,
`process_decoded_payload`, `forward_to_collector`, …), the pipeline in
`telemetry.rs` (`accept_*_to`, `commit_frames`, WAL `append_inner` /
`mark_exported`, `export_and_mark`, `post_tinybird` / `post_clickhouse`, the
`encode_*` row encoders, `gzip`), the shared outbound reqwest client
(per-endpoint latency/error counts) and tokio runtime metrics. All of it is a
no-op unless the `hotpath` cargo feature is on — never enable it in a deploy.

```sh
cargo build --release --features hotpath            # timings + HTTP + runtime
cargo build --release --features hotpath,hotpath-alloc   # + allocations (wraps jemalloc)
```

Run the binary as usual; the report prints on exit (SIGINT). The load harness
SIGKILLs ingest and discards its stdout, so there the easiest route is the live
TUI: `cargo install hotpath --features tui`, then `hotpath console` while the
run is going (ingest serves profiler metrics on port 6770). To get a file
instead, make ingest write the report and exit on a timer that fires *before*
the harness finishes — the harness will report the tail as failures, which is
expected:

```sh
HOTPATH_OUTPUT_PATH=/tmp/ingest-hotpath.txt HOTPATH_SHUTDOWN_MS=60000 \
LOAD_TEST_INGEST_BIN=target/release/maple-ingest LOAD_TEST_REQUESTS=500000 \
target/release/load_test
```

`HOTPATH_OUTPUT_FORMAT=json` gives machine-readable output and
`HOTPATH_REPORT=functions-timing,http` restricts sections. Profile release
builds; unoptimized futures are large enough that debug-profile timings are
not representative.

The request entry points (`handle_*`, `handle_*_inner`, `accept_grpc_decoded`)
are deliberately not measured: wrapping their futures overflowed the tokio
worker stack. Measure a stage beneath them instead of re-adding those.

On pull requests, the `Ingest Rust Tests` workflow runs the load harness
**three times** on the PR and (when the same `LOAD_TEST_INGEST_MODE` is
supported on the base branch) three times on the base branch, then posts
median throughput, row throughput, latency, export catch-up, RSS, and failure
deltas back to the PR as a single sticky comment that updates on each push.
If the base branch does not support the head's ingest mode (e.g. this PR
introduces a new mode), the cross-mode comparison is skipped and only
absolute PR numbers are shown.
