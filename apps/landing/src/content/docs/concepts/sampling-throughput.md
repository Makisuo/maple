---
title: "Sampling & Throughput Estimation"
description: "How Maple detects trace sampling and extrapolates throughput metrics."
group: "Concepts"
order: 1
---

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

Maple's Tinybird queries read this value directly from the `TraceState` column:

```sql
countIf(TraceState LIKE '%th:%')                            AS sampledSpanCount,
countIf(TraceState = '' OR TraceState NOT LIKE '%th:%')     AS unsampledSpanCount,
anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold
```

No manual configuration is needed -- if your OTel SDK or Collector sets the `th` value, Maple picks it up automatically.

## How throughput is calculated

The threshold hex value encodes the rejection probability. Maple converts it to an acceptance probability and a corresponding weight:

```typescript
// threshold "e668" -> ~90% rejection -> ~10% acceptance -> weight ~10
const thresholdInt = parseInt(thresholdHex, 16)
const maxInt = Math.pow(16, thresholdHex.length)
const rejectionRate = thresholdInt / maxInt
const acceptanceProbability = 1 - rejectionRate
const weight = 1 / acceptanceProbability
```

Then:

- **No sampling detected** (no `th` in `TraceState`): spans are counted as-is.
- **Sampling detected**: sampled span count is multiplied by the weight, then added to unsampled spans.

```
estimatedTotal = (sampledSpanCount * weight) + unsampledSpanCount
throughput     = estimatedTotal / durationSeconds
```

For example, with 10% sampling (`weight = 10`) and 500 sampled root spans over 60 seconds:

```
estimatedTotal = 500 * 10 = 5000
throughput     = 5000 / 60 = ~83 req/s
```

## UI indicators

When sampling is detected for a service:

- **Tilde prefix (`~`)** -- throughput values are prefixed with `~` to indicate the number is an estimate, not an exact count. This appears in the services table, service map nodes, and service map edges.
- **Secondary "traced" line** -- the services table shows a smaller line below the estimated throughput with the actual traced rate (e.g. `~8.3 traced`), so you can see both values.
- **Tooltip** -- hovering the throughput cell shows the sampling rate and extrapolation factor (e.g. "Estimated from 10% sampled traces (x10 extrapolation)").

## Limitations

- **Dominant threshold** -- Maple uses `any()` (an arbitrary pick) to select the threshold value per service per time window. If the sampling rate changes mid-window, the value used may not perfectly represent all spans in that window.
- **Edge throughput** -- service-to-service call counts on the service map are also extrapolated from sampled traces using the same method. The edge label shows `~` when sampling is active.
- **Error rate is not extrapolated** -- error rate is computed as `errorCount / spanCount` from the spans Maple actually receives. This ratio is generally representative, but could skew if sampling is correlated with error status.
- **Mixed sampling rates** -- if different services use different sampling rates, each service's throughput is extrapolated independently using its own threshold. Cross-service edges use the threshold from the edge's span data.

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
