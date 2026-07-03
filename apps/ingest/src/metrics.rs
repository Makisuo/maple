//! Operational metrics for the ingest gateway, emitted via OpenTelemetry.
//!
//! Every metric the gateway records is defined here as a lazily-initialised
//! OTLP instrument bound to the global meter provider (configured by
//! `init_metrics` in `main.rs`). Call sites use the thin facade functions
//! below — e.g. `metrics::requests_total(signal, "ok", "none")` — so the
//! attribute keys live in one place and no `KeyValue` plumbing leaks into
//! request handlers or `Drop` impls.
//!
//! Instruments created before `init_metrics` runs (or when it is skipped in
//! local dev) bind to the default no-op meter, so every function here is a
//! cheap no-op until the OTLP pipeline is wired up.

use std::sync::LazyLock;

use opentelemetry::metrics::{Counter, Gauge, Histogram, Meter, UpDownCounter};
use opentelemetry::{global, KeyValue};

static METER: LazyLock<Meter> = LazyLock::new(|| global::meter("maple-ingest"));

// --- Counters -------------------------------------------------------------

static REQUESTS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_requests_total")
        .with_description("Ingest requests processed, by signal and outcome")
        .build()
});

static ITEMS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_items_total")
        .with_description("Telemetry items (spans, logs, metric points) accepted")
        .build()
});

static ORG_THROTTLED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_org_throttled_total")
        .with_description("Requests rejected by per-org limits")
        .build()
});

static BACKPRESSURE_SHED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_backpressure_shed_total")
        .with_description("Frames shed because a lane's bounded export channel was full")
        .build()
});

static CLOUDFLARE_BATCHES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_cloudflare_batches_total")
        .with_description("Cloudflare Logpush batches received")
        .build()
});

static CLOUDFLARE_VALIDATION_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_cloudflare_validation_total")
        .with_description("Cloudflare Logpush validation pings received")
        .build()
});

static CLOUDFLARE_AUTH_FAILURES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_cloudflare_auth_failures_total")
        .with_description("Cloudflare Logpush requests rejected for bad auth")
        .build()
});

static CLOUDFLARE_PARSE_FAILURES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_cloudflare_parse_failures_total")
        .with_description("Cloudflare Logpush requests rejected for unparseable payloads")
        .build()
});

static CLOUDFLARE_RECORDS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_cloudflare_records_total")
        .with_description("Cloudflare Logpush log records parsed")
        .build()
});

static SENTINEL_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_sentinel_total")
        .with_description("Requests authenticated with the sentinel test token")
        .build()
});

static WAL_SHARD_FULL_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_wal_shard_full_total")
        .with_description("WAL appends rejected because the shard file was full")
        .build()
});

static FORWARD_RESPONSES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_forward_responses_total")
        .with_description("Responses from the downstream collector, by status bucket")
        .build()
});

static NATIVE_ROWS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_native_rows_total")
        .with_description("Rows accepted by the native warehouse pipeline")
        .build()
});

static NATIVE_SAMPLED_DROPPED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_native_sampled_dropped_total")
        .with_description("Rows dropped by sampling in the native pipeline")
        .build()
});

static TINYBIRD_EXPORT_ROWS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_tinybird_export_rows_total")
        .with_description("Rows successfully exported to Tinybird")
        .build()
});

static TINYBIRD_EXPORT_DROPPED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_tinybird_export_dropped_total")
        .with_description("Rows dropped while exporting to Tinybird")
        .build()
});

static TINYBIRD_EXPORT_RETRIES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_tinybird_export_retries_total")
        .with_description("Retry attempts while exporting to Tinybird")
        .build()
});

static CLICKHOUSE_EXPORT_ROWS_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_clickhouse_export_rows_total")
        .with_description("Rows successfully exported to self-managed ClickHouse")
        .build()
});

static CLICKHOUSE_EXPORT_DROPPED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_clickhouse_export_dropped_total")
        .with_description("Rows dropped while exporting to self-managed ClickHouse")
        .build()
});

static CLICKHOUSE_EXPORT_RETRIES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_clickhouse_export_retries_total")
        .with_description("Retry attempts while exporting to self-managed ClickHouse")
        .build()
});

static METRICS_SUMMARY_DROPPED_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("ingest_metrics_summary_dropped_total")
        .with_description("OTLP Summary metric data points dropped (unsupported)")
        .build()
});

static AUTUMN_FLUSHES_TOTAL: LazyLock<Counter<u64>> = LazyLock::new(|| {
    METER
        .u64_counter("autumn_track_flushes_total")
        .with_description("Autumn usage-tracking flush cycles, by outcome")
        .build()
});

// --- Up/down counter ------------------------------------------------------

static REQUESTS_IN_FLIGHT: LazyLock<UpDownCounter<i64>> = LazyLock::new(|| {
    METER
        .i64_up_down_counter("ingest_requests_in_flight")
        .with_description("In-flight ingest requests")
        .build()
});

// --- Gauges ---------------------------------------------------------------

static ORG_REQUESTS_IN_FLIGHT: LazyLock<Gauge<u64>> = LazyLock::new(|| {
    METER
        .u64_gauge("ingest_org_requests_in_flight")
        .with_description("In-flight ingest requests per org")
        .build()
});

static ORG_QUEUE_BYTES: LazyLock<Gauge<u64>> = LazyLock::new(|| {
    METER
        .u64_gauge("ingest_org_queue_bytes")
        .with_unit("By")
        .with_description("Bytes queued for export per org")
        .build()
});

static WAL_SHARD_BYTES: LazyLock<Gauge<u64>> = LazyLock::new(|| {
    METER
        .u64_gauge("ingest_wal_shard_bytes")
        .with_unit("By")
        .with_description("Current WAL shard file size")
        .build()
});

static AUTUMN_PENDING_GB: LazyLock<Gauge<f64>> = LazyLock::new(|| {
    METER
        .f64_gauge("autumn_track_pending_gb")
        .with_description("Unflushed Autumn usage accumulated in memory, in GB")
        .build()
});

// --- Histograms -----------------------------------------------------------

static REQUEST_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_request_duration_seconds")
        .with_unit("s")
        .with_description("Ingest request handling latency")
        .build()
});

static KEY_RESOLUTION_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_key_resolution_duration_seconds")
        .with_unit("s")
        .with_description("Ingest key resolution latency")
        .build()
});

static REQUEST_BODY_BYTES: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    METER
        .u64_histogram("ingest_request_body_bytes")
        .with_unit("By")
        .with_description("Raw (possibly compressed) request body size")
        .build()
});

static DECODED_BODY_BYTES: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    METER
        .u64_histogram("ingest_decoded_body_bytes")
        .with_unit("By")
        .with_description("Decompressed request payload size")
        .build()
});

static WAL_COMMIT_BYTES: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    METER
        .u64_histogram("ingest_wal_commit_bytes")
        .with_unit("By")
        .with_description("Bytes committed per WAL append")
        .build()
});

static EXPORT_BATCH_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_export_batch_duration_seconds")
        .with_unit("s")
        .with_description("WAL export batch processing latency")
        .build()
});

static WAL_EXPORTED_BYTES: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    METER
        .u64_histogram("ingest_wal_exported_bytes")
        .with_unit("By")
        .with_description("Bytes drained from the WAL per export batch")
        .build()
});

static FORWARD_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_forward_duration_seconds")
        .with_unit("s")
        .with_description("Downstream collector forward latency")
        .build()
});

static NATIVE_ACCEPT_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_native_accept_duration_seconds")
        .with_unit("s")
        .with_description("Native warehouse pipeline accept latency")
        .build()
});

static TINYBIRD_EXPORT_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_tinybird_export_duration_seconds")
        .with_unit("s")
        .with_description("Tinybird export request latency")
        .build()
});

static CLICKHOUSE_EXPORT_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("ingest_clickhouse_export_duration_seconds")
        .with_unit("s")
        .with_description("Self-managed ClickHouse export request latency")
        .build()
});

static AUTUMN_FLUSH_DURATION_SECONDS: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    METER
        .f64_histogram("autumn_track_flush_duration_seconds")
        .with_unit("s")
        .with_description("Autumn usage-tracking flush cycle latency")
        .build()
});

// --- Facade ---------------------------------------------------------------

/// A request entered the gateway; pair with [`request_finished`].
pub fn request_started() {
    REQUESTS_IN_FLIGHT.add(1, &[]);
}

/// A request left the gateway; pair with [`request_started`].
pub fn request_finished() {
    REQUESTS_IN_FLIGHT.add(-1, &[]);
}

/// Records a completed request: its latency and a counter increment.
pub fn request_completed(signal: &str, status: &str, error_kind: &str, duration_secs: f64) {
    REQUEST_DURATION_SECONDS.record(
        duration_secs,
        &[
            KeyValue::new("signal", signal.to_string()),
            KeyValue::new("status", status.to_string()),
        ],
    );
    REQUESTS_TOTAL.add(
        1,
        &[
            KeyValue::new("signal", signal.to_string()),
            KeyValue::new("status", status.to_string()),
            KeyValue::new("error_kind", error_kind.to_string()),
        ],
    );
}

/// Telemetry items accepted from a request payload.
pub fn items_accepted(signal: &str, count: u64) {
    ITEMS_TOTAL.add(count, &[KeyValue::new("signal", signal.to_string())]);
}

/// A request was rejected by a per-org limit (`reason` is `in_flight` or `queue_bytes`).
pub fn org_throttled(org_id: &str, reason: &'static str) {
    ORG_THROTTLED_TOTAL.add(
        1,
        &[
            KeyValue::new("org_id", org_id.to_string()),
            KeyValue::new("reason", reason),
        ],
    );
}

/// A frame was shed because its export lane's bounded channel was full
/// (backpressure) — typically a stalled destination that cannot drain fast
/// enough. Counted per shed event, symmetric with `org_throttled`.
pub fn backpressure_shed(org_id: &str, destination: &str, signal: &str) {
    BACKPRESSURE_SHED_TOTAL.add(
        1,
        &[
            KeyValue::new("org_id", org_id.to_string()),
            KeyValue::new("destination", destination.to_string()),
            KeyValue::new("signal", signal.to_string()),
        ],
    );
}

/// Current in-flight request count for an org.
pub fn org_requests_in_flight(org_id: &str, value: u64) {
    ORG_REQUESTS_IN_FLIGHT.record(value, &[KeyValue::new("org_id", org_id.to_string())]);
}

/// A request used the sentinel test token.
pub fn sentinel(signal: &str) {
    SENTINEL_TOTAL.add(1, &[KeyValue::new("signal", signal.to_string())]);
}

/// Ingest key resolution latency.
pub fn key_resolution_duration(duration_secs: f64) {
    KEY_RESOLUTION_DURATION_SECONDS.record(duration_secs, &[]);
}

/// Raw request body size.
pub fn request_body_bytes(signal: &str, bytes: u64) {
    REQUEST_BODY_BYTES.record(bytes, &[KeyValue::new("signal", signal.to_string())]);
}

/// Decompressed request payload size.
pub fn decoded_body_bytes(signal: &str, bytes: u64) {
    DECODED_BODY_BYTES.record(bytes, &[KeyValue::new("signal", signal.to_string())]);
}

/// A Cloudflare Logpush batch was received.
pub fn cloudflare_batch(dataset: &str, is_validation: bool) {
    CLOUDFLARE_BATCHES_TOTAL.add(
        1,
        &[
            KeyValue::new("dataset", dataset.to_string()),
            KeyValue::new("validation", if is_validation { "true" } else { "false" }),
        ],
    );
    if is_validation {
        CLOUDFLARE_VALIDATION_TOTAL.add(1, &[KeyValue::new("dataset", dataset.to_string())]);
    }
}

/// A Cloudflare Logpush request failed authentication.
pub fn cloudflare_auth_failure(dataset: &str) {
    CLOUDFLARE_AUTH_FAILURES_TOTAL.add(1, &[KeyValue::new("dataset", dataset.to_string())]);
}

/// A Cloudflare Logpush request failed parsing.
pub fn cloudflare_parse_failure(dataset: &str) {
    CLOUDFLARE_PARSE_FAILURES_TOTAL.add(1, &[KeyValue::new("dataset", dataset.to_string())]);
}

/// Log records parsed from a Cloudflare Logpush batch.
pub fn cloudflare_records(dataset: &str, count: u64) {
    CLOUDFLARE_RECORDS_TOTAL.add(count, &[KeyValue::new("dataset", dataset.to_string())]);
}

/// A WAL append was rejected because the lane file is full. `shard` is the real
/// shard; `destination` distinguishes the per-destination lane within it.
pub fn wal_shard_full(shard: usize, destination: &str) {
    WAL_SHARD_FULL_TOTAL.add(
        1,
        &[
            KeyValue::new("shard", shard.to_string()),
            KeyValue::new("destination", destination.to_string()),
        ],
    );
}

/// Bytes committed in a single WAL append.
pub fn wal_commit_bytes(shard: usize, destination: &str, bytes: u64) {
    WAL_COMMIT_BYTES.record(
        bytes,
        &[
            KeyValue::new("shard", shard.to_string()),
            KeyValue::new("destination", destination.to_string()),
        ],
    );
}

/// Current WAL lane file size.
pub fn wal_shard_bytes(shard: usize, destination: &str, bytes: u64) {
    WAL_SHARD_BYTES.record(
        bytes,
        &[
            KeyValue::new("shard", shard.to_string()),
            KeyValue::new("destination", destination.to_string()),
        ],
    );
}

/// Current bytes queued for export for an org.
pub fn org_queue_bytes(org_id: &str, bytes: u64) {
    ORG_QUEUE_BYTES.record(bytes, &[KeyValue::new("org_id", org_id.to_string())]);
}

/// Latency and exported-byte size of a completed WAL export batch.
pub fn export_batch_completed(shard: usize, signal: &str, duration_secs: f64, exported_bytes: u64) {
    EXPORT_BATCH_DURATION_SECONDS
        .record(duration_secs, &[KeyValue::new("shard", shard.to_string())]);
    WAL_EXPORTED_BYTES.record(
        exported_bytes,
        &[
            KeyValue::new("signal", signal.to_string()),
            KeyValue::new("shard", shard.to_string()),
        ],
    );
}

/// A response was received from the downstream collector.
pub fn forward_response(signal: &str, upstream_status: &'static str, upstream_pool: &str) {
    FORWARD_RESPONSES_TOTAL.add(
        1,
        &[
            KeyValue::new("signal", signal.to_string()),
            KeyValue::new("upstream_status", upstream_status),
            KeyValue::new("upstream_pool", upstream_pool.to_string()),
        ],
    );
}

/// Downstream collector forward latency.
pub fn forward_duration(signal: &str, upstream_pool: &str, duration_secs: f64) {
    FORWARD_DURATION_SECONDS.record(
        duration_secs,
        &[
            KeyValue::new("signal", signal.to_string()),
            KeyValue::new("upstream_pool", upstream_pool.to_string()),
        ],
    );
}

/// Native warehouse pipeline accept latency.
pub fn native_accept_duration(signal: &str, duration_secs: f64) {
    NATIVE_ACCEPT_DURATION_SECONDS.record(
        duration_secs,
        &[KeyValue::new("signal", signal.to_string())],
    );
}

/// Rows accepted by the native warehouse pipeline.
pub fn native_rows(signal: &str, count: u64) {
    NATIVE_ROWS_TOTAL.add(count, &[KeyValue::new("signal", signal.to_string())]);
}

/// Rows dropped by sampling in the native pipeline.
pub fn native_sampled_dropped(signal: &str, count: u64) {
    NATIVE_SAMPLED_DROPPED_TOTAL.add(count, &[KeyValue::new("signal", signal.to_string())]);
}

/// A successful Tinybird export: latency and exported row count.
pub fn tinybird_export_succeeded(datasource: &str, duration_secs: f64, rows: u64) {
    TINYBIRD_EXPORT_DURATION_SECONDS.record(
        duration_secs,
        &[
            KeyValue::new("datasource", datasource.to_string()),
            KeyValue::new("status", "2xx"),
        ],
    );
    TINYBIRD_EXPORT_ROWS_TOTAL.add(rows, &[KeyValue::new("datasource", datasource.to_string())]);
}

/// Rows dropped while exporting to Tinybird (`status` is an HTTP code or `retries_exhausted`).
pub fn tinybird_export_dropped(datasource: &str, status: &str, rows: u64) {
    TINYBIRD_EXPORT_DROPPED_TOTAL.add(
        rows,
        &[
            KeyValue::new("datasource", datasource.to_string()),
            KeyValue::new("status", status.to_string()),
        ],
    );
}

/// A Tinybird export attempt was retried (`status` is an HTTP code or `transport`).
pub fn tinybird_export_retry(datasource: &str, status: &str) {
    TINYBIRD_EXPORT_RETRIES_TOTAL.add(
        1,
        &[
            KeyValue::new("datasource", datasource.to_string()),
            KeyValue::new("status", status.to_string()),
        ],
    );
}

/// A successful ClickHouse export: latency and exported row count.
pub fn clickhouse_export_succeeded(datasource: &str, status: &str, duration_secs: f64, rows: u64) {
    let attrs = [
        KeyValue::new("datasource", datasource.to_string()),
        KeyValue::new("status", status.to_string()),
    ];
    CLICKHOUSE_EXPORT_DURATION_SECONDS.record(duration_secs, &attrs);
    CLICKHOUSE_EXPORT_ROWS_TOTAL.add(rows, &attrs);
}

/// Rows dropped while exporting to ClickHouse (`status` is a bucket or internal reason).
pub fn clickhouse_export_dropped(datasource: &str, status: &str, rows: u64) {
    CLICKHOUSE_EXPORT_DROPPED_TOTAL.add(
        rows,
        &[
            KeyValue::new("datasource", datasource.to_string()),
            KeyValue::new("status", status.to_string()),
        ],
    );
}

/// A ClickHouse export attempt was retried (`status` is a bucket or internal reason).
pub fn clickhouse_export_retry(datasource: &str, status: &str) {
    CLICKHOUSE_EXPORT_RETRIES_TOTAL.add(
        1,
        &[
            KeyValue::new("datasource", datasource.to_string()),
            KeyValue::new("status", status.to_string()),
        ],
    );
}

/// An OTLP Summary metric data point was dropped (unsupported by the encoder).
pub fn metrics_summary_dropped() {
    METRICS_SUMMARY_DROPPED_TOTAL.add(1, &[]);
}

/// An Autumn usage-tracking flush cycle completed (`status` is `ok` or `error`).
pub fn autumn_flush(status: &'static str, duration_secs: f64) {
    AUTUMN_FLUSH_DURATION_SECONDS.record(duration_secs, &[]);
    AUTUMN_FLUSHES_TOTAL.add(1, &[KeyValue::new("status", status)]);
}

/// Unflushed Autumn usage currently held in memory, in GB.
pub fn autumn_pending_gb(value: f64) {
    AUTUMN_PENDING_GB.record(value, &[]);
}
