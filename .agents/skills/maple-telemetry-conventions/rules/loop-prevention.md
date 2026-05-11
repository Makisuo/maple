# Loop prevention and sampling

Maple traces itself. The API ships spans to the ingest gateway, which forwards them to the same Tinybird datasources customer traffic lands in. Viewing a trace in the dashboard issues API calls, which create more spans. Without the guards in this file, that loop blows out span volume.

**⚠ NEVER remove any of these without a documented replacement.** The CLAUDE.md is explicit: "NEVER remove the `withTracerDisabledWhen` filter — it prevents noisy health check spans".

---

## Guard 1: TypeScript API — `HttpMiddleware.TracerDisabledWhen`

**Where:** `apps/api/src/app.ts:169-175`

```typescript
export const ApiObservabilityLive = Layer.succeed(
    HttpMiddleware.TracerDisabledWhen,
    (request: { url: string; method: string }) =>
        request.url === "/health" ||
        request.method === "OPTIONS" ||
        /\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(request.url),
)
```

Disables span creation for:

| Request kind | Why |
|---|---|
| `/health` exact path | Pinged constantly by orchestrators; would dominate trace volume |
| `OPTIONS` (any path) | CORS preflights — high-volume, low-value |
| Static asset extensions (`.png`, `.ico`, `.jpg`, `.jpeg`, `.gif`, `.css`, `.js`, `.svg`, `.webp`, `.woff`, `.woff2`) | Asset fetches — produce no useful trace data |

### Rules

- **Do not extend this filter** to skip paths that you find noisy — silence is debugging-hostile. Investigate the volume source first.
- **Do not remove paths from this filter** without a replacement. Health-check spans alone can double Maple's daily trace count.
- **Be careful adding spans to internal high-frequency paths** like auth token validation that runs on every request. CLAUDE.md calls this out.

---

## Guard 2: Rust ingest — OTLP loopback guard

**Where:** `apps/ingest/src/main.rs:499-514`

```rust
let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
let skip_dev = deployment_env == "development" && !forward_explicit;
let loopback = endpoint_loopback_to_self(forward_endpoint, bind_port);

if skip_dev || loopback {
    if loopback {
        eprintln!(
            "INGEST_FORWARD_OTLP_ENDPOINT={forward_endpoint} resolves to this server's bind port {bind_port}; \
             skipping OTel exporter to avoid recursion"
        );
    }
    // Init tracing-subscriber WITHOUT the OTel layer.
    // ...
    return None;
}
```

Two refusals:

1. **Loopback detection** — if `INGEST_FORWARD_OTLP_ENDPOINT` resolves to ingest's own bind port (via hostname/IP comparison in `endpoint_loopback_to_self()` at `main.rs:588+`), the OTel exporter setup is skipped. Otherwise ingest would forward its own spans to itself recursively.
2. **Dev no-op** — in `development` deployment with no explicit `INGEST_FORWARD_OTLP_ENDPOINT` set, the OTel exporter is skipped (logs-only). Prevents accidental local trace floods.

### Rule

If you add another OTLP-emitting service that lives at the same hostname as the ingest gateway, write a similar loopback guard. Don't rely on configuration alone to prevent loops.

---

## Guard 3: Sampling

For high-QPS deployments where unsampled tracing would saturate ingest, use OTel's parent-based ratio sampler:

```bash
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

This keeps 10% of root traces and inherits the sampling decision through children — so a trace is either fully kept or fully dropped (no broken trace trees).

### `SampleRate` column

Maple's traces datasource has a first-class `SampleRate` column (computed from `SpanAttributes['SampleRate']` or W3C TraceState `th:` threshold). Sampling-aware aggregations should multiply or sum by `SampleRate` to recover unbiased counts:

```sql
-- WRONG: under-counts when sampled
SELECT count() FROM spans WHERE …

-- RIGHT: scales each sampled span back up
SELECT sum(SampleRate) FROM spans WHERE …
```

See `docs/sampling-throughput.md` for the full pattern.

### Rule

If you're adding a new throughput / count widget on the traces datasource, use `sum(SampleRate)` unless you have a specific reason to undercount. Span-count aggregates without `SampleRate` weighting will silently drift downward as sampling ratio decreases.

---

## What is **not** a loop-prevention guard

To avoid confusion:

- **OTLP batch export** is async but is **not** a loop prevention measure — it just keeps the export off the request path. Removing batch export would slow requests, not cause a loop.
- **The OTLP export itself does not go through the API** — it ships directly to the ingest gateway from each service. CLAUDE.md confirms this: "The OTLP export itself does NOT go through the API (it goes directly to the ingest gateway), so it won't create recursive traces."

So the three guards above are the entirety of Maple's loop-prevention strategy. Touching any of them requires a thought-through replacement.
