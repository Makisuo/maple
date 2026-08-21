//! Per-org ingest volume metrics — the billable quantity, as measured.
//!
//! Distinct from `metrics.rs` in three ways, all deliberate:
//!
//! 1. **Delta temporality.** These instruments live on their own
//!    [`SdkMeterProvider`] (built by `init_usage_metrics` in `main.rs`), never on
//!    the global one, because temporality is an *exporter* setting in
//!    opentelemetry 0.31 — flipping the shared exporter would change every
//!    operational metric at once. Delta matters because each exported value is
//!    then the increment since the last export, so the warehouse can chart these
//!    with a plain `sum(Value)` per bucket. That is exact, and it survives
//!    restarts and multiple replicas. The cumulative alternative has to be read
//!    back through `metricsTimeseriesRateQuery`, which partitions on
//!    `cityHash64(ResourceAttributes)` + `StartTimeUnix` — and since
//!    `service.instance.id` is a fresh UUID per process, every deploy would lose
//!    one export interval per series to a zero first delta, while negative steps
//!    are silently dropped. Neither is acceptable for a number we reconcile
//!    against invoices.
//!
//! 2. **Per-org attribution.** `signal` alone is not enough here — the whole
//!    point is a cross-org view. Kept to exactly two attributes (`org_id`,
//!    `signal`); adding `key_type` / `destination` / `payload_format` would
//!    multiply against the per-interval cardinality limit for no analytical gain.
//!
//! 3. **Recorded at the billing call site.** `record` is called from
//!    `handle_signal`'s `Ok` arm, beside `AutumnTracker::track`, with the same
//!    `decoded_bytes` value — never from the decode site, which fires before
//!    enrich and forward and so counts payloads that were never delivered. That
//!    makes this the gateway's ground truth for what it metered, so any
//!    divergence from Autumn localises to Autumn's delivery layer.
//!
//! `signal` is `TelemetrySignal::path()` — `"logs" | "traces" | "metrics"` —
//! which are also the Autumn feature ids, so one dimension serves both.
//!
//! ## Cardinality
//!
//! Under delta temporality the SDK's `ValueMap::collect_and_reset` swaps out and
//! drains its tracker map on every collect, and the cardinality check tests that
//! same drained counter. So the limit applies **per collection interval**, not
//! per process lifetime, and orgs that go quiet stop emitting entirely rather
//! than re-exporting a stale total forever. That is why there is no hand-rolled
//! org allowlist here: the bound that matters is *concurrently active* orgs, and
//! a persistent set would misattribute every org past its ceiling while adding a
//! lock to the request hot path. [`usage_cardinality_view`] raises the limit
//! explicitly instead; past it the SDK folds excess series into a datapoint
//! tagged `otel.metric.overflow=true`, which is visible in the warehouse and is
//! the thing to alert on.

use opentelemetry::metrics::{Counter, MeterProvider as _};
use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::{Instrument, SdkMeterProvider, Stream};

/// Instrumentation scope for the usage provider. Distinct from `maple-ingest` so
/// the two providers' streams can never collide.
pub const USAGE_METER_NAME: &str = "maple-ingest-usage";

/// Decoded OTLP payload bytes accepted, per org and signal — the exact value
/// metered to billing.
pub const BYTES_INSTRUMENT: &str = "maple_ingest_org_bytes_total";

/// Telemetry items (spans, log records, metric points) accepted, per org and
/// signal.
pub const ITEMS_INSTRUMENT: &str = "maple_ingest_org_items_total";

/// Per-interval series ceiling for the usage instruments, ~4x the SDK's default
/// 2000. With two attributes that is roughly 2,700 concurrently-active orgs
/// across three signals inside one export window. Raise this before the org
/// count gets there, because past the limit per-org attribution degrades into an
/// `otel.metric.overflow=true` bucket rather than failing loudly.
pub const USAGE_CARDINALITY_LIMIT: usize = 8192;

/// Bytes per billed gigabyte. Decimal, not binary — Autumn prices in GB and this
/// is the divisor its invoices are computed from.
pub const BYTES_PER_BILLED_GB: f64 = 1_000_000_000.0;

/// The single conversion from measured bytes to the billable GB value reported to
/// Autumn. Exists so the counter in this module and `AutumnTracker::track` cannot
/// drift onto different bases — `billable_gb_round_trips_measured_bytes` pins it.
#[expect(
    clippy::cast_precision_loss,
    reason = "a byte counter would have to pass 9 petabytes in one process before f64 loses a byte"
)]
pub fn billable_gb(bytes: u64) -> f64 {
    bytes as f64 / BYTES_PER_BILLED_GB
}

/// Attribute key carrying the *tenant* org — the org whose data was ingested,
/// not the org the metric is billed to. These rows are written under the
/// internal org (`maple_org_id` on the resource), which is what lets the
/// internal dashboard read them through the ordinary org-scoped query path with
/// no privileged access.
const ATTR_ORG_ID: &str = "org_id";
const ATTR_SIGNAL: &str = "signal";

/// View raising the per-interval cardinality limit on the two usage instruments.
/// Register with `SdkMeterProvider::builder().with_view(usage_cardinality_view)`.
/// Returning `None` for anything else leaves the default view in place.
pub fn usage_cardinality_view(instrument: &Instrument) -> Option<Stream> {
    if instrument.name() == BYTES_INSTRUMENT || instrument.name() == ITEMS_INSTRUMENT {
        Stream::builder()
            .with_cardinality_limit(USAGE_CARDINALITY_LIMIT)
            .build()
            .ok()
    } else {
        None
    }
}

/// Holder for the usage provider and its two counters. Lives in `AppState`
/// rather than a `LazyLock` static (unlike `metrics.rs`) precisely because the
/// provider is not global — there is nothing to look it up from.
#[derive(Debug)]
pub struct UsageMetrics {
    provider: SdkMeterProvider,
    bytes: Counter<u64>,
    items: Counter<u64>,
}

impl UsageMetrics {
    /// Bind the counters to `provider`. The caller is responsible for having
    /// configured delta temporality and [`usage_cardinality_view`] on it.
    pub fn new(provider: SdkMeterProvider) -> Self {
        let meter = provider.meter(USAGE_METER_NAME);
        let bytes = meter
            .u64_counter(BYTES_INSTRUMENT)
            .with_unit("By")
            .with_description(
                "Decoded OTLP payload bytes accepted, by org and signal (the value metered to billing)",
            )
            .build();
        let items = meter
            .u64_counter(ITEMS_INSTRUMENT)
            .with_unit("{item}")
            .with_description(
                "Telemetry items (spans, log records, metric points) accepted, by org and signal",
            )
            .build();

        Self {
            provider,
            bytes,
            items,
        }
    }

    /// Record one accepted request's contribution. `bytes` must be the raw count
    /// that [`billable_gb`] converts for `AutumnTracker::track`, so the two never
    /// diverge — `billable_gb_round_trips_measured_bytes` pins that basis.
    pub fn record(&self, org_id: &str, signal: &str, bytes: u64, items: u64) {
        let attrs = [
            KeyValue::new(ATTR_ORG_ID, org_id.to_owned()),
            KeyValue::new(ATTR_SIGNAL, signal.to_owned()),
        ];
        self.bytes.add(bytes, &attrs);
        self.items.add(items, &attrs);
    }

    /// Flush and stop the provider. **Load-bearing under delta temporality**: an
    /// interval that is never collected is lost outright, where a cumulative
    /// counter would have folded it into the next export. Must run on the
    /// graceful-shutdown path.
    pub fn shutdown(&self) {
        if let Err(error) = self.provider.shutdown() {
            eprintln!("Failed to shut down usage meter provider: {error}");
        }
    }

    /// Collect and export immediately. Test-only seam — production flushes come
    /// from the `PeriodicReader` and `shutdown`.
    #[cfg(test)]
    fn force_flush(&self) {
        self.provider.force_flush().expect("force_flush");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};
    use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
    use opentelemetry_sdk::metrics::periodic_reader_with_async_runtime::PeriodicReader;
    use opentelemetry_sdk::metrics::Temporality;
    use opentelemetry_sdk::runtime::Tokio as OtelTokio;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// One exported datapoint, flattened for assertions.
    #[derive(Debug, Clone)]
    struct Point {
        metric: String,
        org_id: Option<String>,
        signal: Option<String>,
        overflow: bool,
        value: u64,
        temporality: Temporality,
    }

    /// Captures exports in memory. opentelemetry_sdk 0.31 ships no in-memory
    /// metric exporter (only a shutdown-tracking `TestMetricReader`), so the
    /// pipeline is asserted through a local `PushMetricExporter`.
    #[derive(Clone)]
    struct CaptureExporter {
        points: Arc<Mutex<Vec<Point>>>,
        temporality: Temporality,
    }

    impl CaptureExporter {
        fn new(temporality: Temporality) -> Self {
            Self {
                points: Arc::new(Mutex::new(Vec::new())),
                temporality,
            }
        }

        /// Datapoints captured since the last `drain`, which is one collection
        /// interval's worth under delta temporality.
        fn drain(&self) -> Vec<Point> {
            self.points.lock().expect("points lock").drain(..).collect()
        }
    }

    impl PushMetricExporter for CaptureExporter {
        async fn export(&self, metrics: &ResourceMetrics) -> OTelSdkResult {
            let mut captured = self.points.lock().expect("points lock");
            for scope in metrics.scope_metrics() {
                for metric in scope.metrics() {
                    // Both usage instruments are u64 counters, so anything else
                    // is a bug in the test setup rather than something to skip.
                    let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
                        continue;
                    };
                    for point in sum.data_points() {
                        let attr = |key: &str| {
                            point
                                .attributes()
                                .find(|kv| kv.key.as_str() == key)
                                .map(|kv| kv.value.as_str().to_string())
                        };
                        captured.push(Point {
                            metric: metric.name().to_owned(),
                            org_id: attr(ATTR_ORG_ID),
                            signal: attr(ATTR_SIGNAL),
                            overflow: attr("otel.metric.overflow").is_some(),
                            value: point.value(),
                            temporality: sum.temporality(),
                        });
                    }
                }
            }
            Ok(())
        }

        fn force_flush(&self) -> OTelSdkResult {
            Ok(())
        }

        fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
            Ok(())
        }

        fn temporality(&self) -> Temporality {
            self.temporality
        }
    }

    /// Mirrors `init_usage_metrics` in `main.rs` — delta exporter plus the
    /// cardinality view — with collection driven by `force_flush` instead of a
    /// timer, so the interval is deliberately far longer than any test.
    ///
    /// Every test using this harness must run on a **multi-thread** runtime.
    /// `PeriodicReader` (the async-runtime variant) collects on a background
    /// task, and `force_flush` blocks the calling thread until that task
    /// answers. On the current-thread runtime `#[tokio::test]` gives by default,
    /// the blocked test thread is the only thread that could run the reader, so
    /// the flush deadlocks and the test hangs forever rather than failing.
    fn harness() -> (UsageMetrics, CaptureExporter) {
        let exporter = CaptureExporter::new(Temporality::Delta);
        let reader = PeriodicReader::builder(exporter.clone(), OtelTokio)
            .with_interval(Duration::from_hours(1))
            .build();
        let provider = SdkMeterProvider::builder()
            .with_reader(reader)
            .with_view(usage_cardinality_view)
            .build();
        (UsageMetrics::new(provider), exporter)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn records_bytes_and_items_per_org_and_signal() {
        let (usage, exporter) = harness();

        usage.record("org_a", "logs", 1_000, 10);
        usage.record("org_a", "logs", 500, 5);
        usage.record("org_a", "traces", 2_000, 20);
        usage.record("org_b", "metrics", 3_000, 30);
        usage.force_flush();

        let points = exporter.drain();
        let find = |metric: &str, org: &str, signal: &str| {
            points
                .iter()
                .find(|p| {
                    p.metric == metric
                        && p.org_id.as_deref() == Some(org)
                        && p.signal.as_deref() == Some(signal)
                })
                .unwrap_or_else(|| panic!("missing {metric} for {org}/{signal}: {points:#?}"))
                .value
        };

        // Repeated records for one (org, signal) accumulate within the interval.
        assert_eq!(find(BYTES_INSTRUMENT, "org_a", "logs"), 1_500);
        assert_eq!(find(ITEMS_INSTRUMENT, "org_a", "logs"), 15);
        // Signals stay separate dimensions, not a merged total.
        assert_eq!(find(BYTES_INSTRUMENT, "org_a", "traces"), 2_000);
        assert_eq!(find(ITEMS_INSTRUMENT, "org_a", "traces"), 20);
        // And so do orgs — this is what makes the cross-org view possible.
        assert_eq!(find(BYTES_INSTRUMENT, "org_b", "metrics"), 3_000);
        assert_eq!(find(ITEMS_INSTRUMENT, "org_b", "metrics"), 30);

        assert!(
            points.iter().all(|p| p.temporality == Temporality::Delta),
            "usage instruments must export delta, else the warehouse cannot sum them exactly: {points:#?}"
        );
    }

    /// The property the whole design rests on: each interval exports only its own
    /// increment, and an org that goes quiet stops emitting altogether. That is
    /// what makes `sum(Value)` per bucket exact in ClickHouse, and what keeps row
    /// cost proportional to *active* orgs rather than every org ever seen.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_interval_exports_only_its_own_increment() {
        let (usage, exporter) = harness();

        usage.record("org_a", "logs", 1_000, 10);
        usage.force_flush();
        let first = exporter.drain();
        assert_eq!(
            first
                .iter()
                .find(|p| p.metric == BYTES_INSTRUMENT)
                .map(|p| p.value),
            Some(1_000)
        );

        // org_a is idle this interval; org_b is not.
        usage.record("org_b", "logs", 7, 1);
        usage.force_flush();
        let second = exporter.drain();

        assert!(
            second.iter().all(|p| p.org_id.as_deref() != Some("org_a")),
            "an idle org must drop out of the export entirely, not re-report: {second:#?}"
        );
        assert_eq!(
            second
                .iter()
                .find(|p| p.metric == BYTES_INSTRUMENT && p.org_id.as_deref() == Some("org_b"))
                .map(|p| p.value),
            Some(7),
            "a fresh org's first delta must be its full value, not zero: {second:#?}"
        );
    }

    /// Proves `usage_cardinality_view` is actually applied. The SDK default is
    /// 2000 series per instrument, past which excess series silently collapse
    /// into an `otel.metric.overflow=true` bucket — the worst failure mode for a
    /// billing number, because per-org attribution degrades without erroring.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cardinality_view_admits_more_orgs_than_the_sdk_default() {
        const ORGS: usize = 3_000;
        const _: () = assert!(
            ORGS > 2_000 && ORGS < USAGE_CARDINALITY_LIMIT,
            "test must straddle the SDK default without exceeding our own limit"
        );

        let (usage, exporter) = harness();
        for i in 0..ORGS {
            usage.record(&format!("org_{i}"), "logs", 1, 1);
        }
        usage.force_flush();

        let points = exporter.drain();
        assert!(
            !points.iter().any(|p| p.overflow),
            "{ORGS} orgs must fit under the raised limit without an overflow bucket"
        );
        assert_eq!(
            points
                .iter()
                .filter(|p| p.metric == BYTES_INSTRUMENT)
                .count(),
            ORGS,
            "every org should keep its own series"
        );
    }

    /// The counter and Autumn must never diverge on what a byte is worth. The
    /// call site in `handle_signal` hands the raw byte count to `record` and the
    /// same count through `billable_gb` to `AutumnTracker::track`, so a warehouse
    /// total divided by this divisor is directly comparable to an invoice.
    #[test]
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the cast back to u64 is what the assertion is testing"
    )]
    fn billable_gb_round_trips_measured_bytes() {
        for bytes in [0_u64, 1, 999, 1_000_000_000, 2_500_000_000, 7_812_345_678] {
            assert_eq!(
                (billable_gb(bytes) * BYTES_PER_BILLED_GB).round() as u64,
                bytes,
                "billable_gb must be lossless for {bytes} bytes"
            );
        }
    }
}
