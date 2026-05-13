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
- `LOAD_TEST_QUEUE_DIR`: WAL directory override.

The harness prints JSON with request throughput, row throughput, p50/p95/p99
latency, export catch-up time, max RSS, max CPU, average CPU, and exported rows.

The GitHub Actions workflow `Ingest Load Tests` is manual (`workflow_dispatch`)
so large runs do not make normal PR CI noisy or flaky.
