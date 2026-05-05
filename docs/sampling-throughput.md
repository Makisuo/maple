# Sampling & Throughput Estimation

Maple automatically detects trace sampling and extrapolates throughput metrics so you see realistic request rates even when only a fraction of traces are collected.

## What is trace sampling?

Distributed tracing at scale generates a large volume of spans. Sampling reduces this volume by only exporting a subset of traces:

- **Head sampling** -- a decision made at the start of a trace (e.g. "keep 10% of traces"). The OTel SDK or Collector makes the choice before any spans are processed.
- **Tail sampling** -- a decision made after the full trace completes, typically based on latency, errors, or other attributes.

Both approaches reduce storage and processing costs, but mean the raw span count no longer reflects actual throughput.

## How Maple detects sampling

OpenTelemetry propagates a `TraceState` header on every span. When probability-based sampling is active, the `TraceState` contains a `th` (threshold) key:

```
tracestate: ot=th:e668
```

At ingest time, Maple computes a per-row `SampleRate` weight on the `traces` datasource. The expression resolves three sources in priority order:

1. `SpanAttributes['SampleRate']` -- explicit collector-set value, takes precedence.
2. `TraceState th:<hex>` -- W3C threshold sampling, parsed inline.
3. Default `1.0` -- unsampled.

Because the weight is materialized per row, downstream queries don't need to know anything about TraceState parsing -- they just sum `SampleRate`.

No manual configuration is needed -- if your OTel SDK or Collector sets the `th` value, Maple picks it up automatically.

## How throughput is calculated

The threshold hex value encodes the rejection probability. The per-row `SampleRate` is the inverse of the acceptance probability:

```typescript
// threshold "e668" -> ~90% rejection -> ~10% acceptance -> SampleRate ~10
const thresholdInt = parseInt(thresholdHex, 16)
const maxInt = Math.pow(16, thresholdHex.length)
const rejectionRate = thresholdInt / maxInt
const acceptanceProbability = 1 - rejectionRate
const sampleRate = 1 / acceptanceProbability
```

Then the query engine simply sums the column:

```
estimatedTotal = sum(SampleRate)        -- per-row weighted sum
throughput     = estimatedTotal / durationSeconds
```

For example, with 10% sampling (`SampleRate = 10`) and 500 sampled service entry point spans over 60 seconds:

```
estimatedTotal = 500 * 10 = 5000
throughput     = 5000 / 60 = ~83 req/s
```

Critically, this also handles **mixed sampling rates** correctly. If 99 of those 500 spans were sampled at 50% (weight 2) and 1 was sampled at 99.99% rejection (weight 8192), the per-row sum yields `99 * 2 + 1 * 8192 ≈ 8390` -- not `500 * 8192` like a single-weight-per-bucket approximation would.

## UI indicators

When sampling is detected for a service:

- **Tilde prefix (`~`)** -- throughput values are prefixed with `~` to indicate the number is an estimate, not an exact count. This appears in the services table, service map nodes, and service map edges.
- **Secondary "traced" line** -- the services table shows a smaller line below the estimated throughput with the actual traced rate (e.g. `~8.3 traced`), so you can see both values.
- **Tooltip** -- hovering the throughput cell shows the sampling rate and extrapolation factor (e.g. "Estimated from 10% sampled traces (x10 extrapolation)").

## Limitations

- **Edge throughput** -- service-to-service call counts on the service map use the same per-row `SampleRate` weighting. The edge label shows `~` when sampling is active.
- **Error rate is not extrapolated** -- error rate is computed as `errorCount / spanCount` from the spans Maple actually receives. This ratio is generally representative, but could skew if sampling is correlated with error status.

## For best results

If you need 100%-accurate RED metrics (Rate, Errors, Duration) alongside sampled traces, use the **OpenTelemetry Collector SpanMetrics Connector**. It derives metrics from every span before sampling is applied, giving you exact counts regardless of trace sampling configuration.

- [SpanMetrics Connector docs](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector)

A typical Collector pipeline:

```yaml
connectors:
    spanmetrics:
        namespace: span.metrics

service:
    pipelines:
        traces:
            receivers: [otlp]
            processors: [batch]
            exporters: [otlp, spanmetrics] # fork to both export + metrics
        metrics:
            receivers: [spanmetrics]
            exporters: [otlp]
```

This way, your metrics pipeline sees every request while your traces pipeline can sample aggressively.
