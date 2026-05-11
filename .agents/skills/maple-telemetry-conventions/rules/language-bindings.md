# Language bindings — emit the same attributes everywhere

The whole point of this skill is that **attribute keys are identical across languages**. Snippets below show how to emit the canonical `executeSql`-style annotation block in each language so any reader can copy the pattern into TS, Rust, or (forthcoming) Python.

---

## TypeScript — Effect + `@effect/opentelemetry`

Maple's TS code wraps spans through Effect. Two patterns:

### Pattern A: `Effect.fn(name)` — declarative span on a function

```typescript
import { Effect } from "effect"

const executeQuery = Effect.fn("MyService.executeQuery")(function* (
    tenant: TenantContext,
    sql: string,
) {
    // Span attributes — annotate the current span (created by Effect.fn).
    yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
    yield* Effect.annotateCurrentSpan("tenant.userId", tenant.userId)
    yield* Effect.annotateCurrentSpan("db.system", "clickhouse")
    yield* Effect.annotateCurrentSpan("db.statement", sql.slice(0, 16_384))
    yield* Effect.annotateCurrentSpan("query.context", "myQuery")

    const result = yield* runQuery(sql)
    yield* Effect.annotateCurrentSpan("result.rowCount", result.length)
    return result
})
```

Status is set automatically: if the effect fails, the tracer records `Error`; on success, `Ok`. **Do not call `setStatus` manually.**

### Pattern B: `Effect.withSpan(name, { attributes })` — wrap an inline effect

```typescript
yield* doWork.pipe(
    Effect.withSpan("BucketCacheService.fillMissingRanges", {
        attributes: {
            orgId: request.orgId,
            "cache.missingRangeCount": missing.length,
            "cache.existingBucketCount": existingBuckets.length,
        },
    }),
)
```

Use this when you need attributes set at span-open time rather than via `annotateCurrentSpan` calls inside.

### Cloudflare Workers — `MapleCloudflareSDK`

Workers get their tracer from `MapleCloudflareSDK` in `lib/effect-sdk/src/cloudflare/index.ts`. The setup configures the OTLP exporter and resource — once it's installed via `telemetry.layer`, you use the same `Effect.fn` / `Effect.annotateCurrentSpan` / `Effect.withSpan` API as elsewhere.

### Canonical TS example

The reference implementation is `apps/api/src/services/WarehouseQueryService.ts:441-510` (the `executeSql` function). Read it whenever you're unsure how to structure a new query span.

---

## Rust — `tracing` + `tracing-opentelemetry`

Rust code uses the `tracing` macro to declare spans and field names. Special field names (`otel.name`, `otel.kind`, `otel.status_code`) drive OTel semantics; the rest become custom attributes.

### Pattern A: declarative span via `tracing::info_span!`

```rust
use tracing::Instrument;

let span = tracing::info_span!(
    "ingest",
    otel.name = %otel_name,
    otel.kind = "server",
    otel.status_code = tracing::field::Empty,
    "http.request.method" = "POST",
    "http.route" = %route,
    "http.request.body.size" = body_bytes,
    "http.response.status_code" = tracing::field::Empty,
    "error.type" = tracing::field::Empty,
    "maple.signal" = signal.path(),
    "maple.org_id" = tracing::field::Empty,
);
let span_handle = span.clone();

// Run the work under the span; record fields after the work resolves.
let result = handle_inner().instrument(span).await;
match result {
    Ok(_) => {
        span_handle.record("http.response.status_code", 200);
        span_handle.record("otel.status_code", "Ok");
    }
    Err(err) => {
        span_handle.record("http.response.status_code", err.status_code());
        span_handle.record("error.type", err.kind());
        span_handle.record("otel.status_code", "Error");
    }
}
```

Key idioms:
- **Quote field names with dots** (`"http.request.method"`) — bare identifiers can't contain dots in Rust syntax.
- **Declare empty fields up front** with `tracing::field::Empty` and `record` them later. This keeps the field list visible at the span declaration site.
- **Use `%expr`** to record the `Display` impl, `?expr` for `Debug`. Use plain `field = value` for primitive types.

### Pattern B: `#[instrument]` attribute macro

For function-level spans, use `#[instrument(fields(...))]`:

```rust
#[tracing::instrument(
    name = "resolve_connector",
    skip(state),
    fields(
        otel.kind = "internal",
        "maple.org_id" = tracing::field::Empty,
        "maple.cloudflare.connector_id" = %connector_id,
    ),
)]
async fn resolve_connector(state: &AppState, connector_id: &str) -> Result<Resolved> {
    // ...
    tracing::Span::current().record("maple.org_id", resolved.org_id.as_str());
    Ok(resolved)
}
```

### Canonical Rust example

`apps/ingest/src/main.rs:843-902` (Server-kind inbound signal handler), `:1132-1156` (Client-kind downstream forward).

---

## Python — forward-looking

There's no Python service in this repo today, but the conventions below are the ones to follow when adding one (e.g. a future Python ingest worker or tooling around `tinybird-sdk`).

```python
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode, SpanKind

tracer = trace.get_tracer(__name__)

def execute_query(tenant, sql: str):
    with tracer.start_as_current_span(
        "MyService.execute_query",
        kind=SpanKind.INTERNAL,
    ) as span:
        # Same attribute keys as TS / Rust — do not invent Python-specific ones.
        span.set_attribute("orgId", tenant.org_id)
        span.set_attribute("tenant.userId", tenant.user_id)
        span.set_attribute("db.system", "clickhouse")
        span.set_attribute("db.statement", sql[:16_384])
        span.set_attribute("query.context", "myQuery")

        try:
            result = run_query(sql)
            span.set_attribute("result.rowCount", len(result))
            # On success, leave status alone — the SDK records Ok by default.
            return result
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR))
            span.set_attribute("error.type", classify(exc))
            raise
```

### Python ↔ wire-string boundary

Python's OTel SDK uses the enum `StatusCode.ERROR` and `StatusCode.OK` in code, but the SDK exports them as the wire strings `"Error"` and `"Ok"` (Title Case). So:

- ✅ `span.set_status(Status(StatusCode.ERROR))` — correct, SDK handles conversion
- ❌ `span.set_attribute("otel.status_code", "ERROR")` — never set status as a custom attribute, and never use uppercase

---

## Cross-language consistency table

The same logical attribute must use the same key in every language. Watch out for these — they're the most-confused spots:

| Concept | TypeScript | Rust | Python | Notes |
|---|---|---|---|---|
| Customer org ID (on span) | `orgId` | `maple.org_id` | `orgId` (or `maple.org_id` if mirroring ingest) | TS/Rust mismatch is intentional — preserved for dashboard filter compatibility |
| User ID | `tenant.userId` | `tenant.user_id` is **wrong** — use `tenant.userId` | `tenant.userId` | Dotted-camelCase is canonical |
| SQL statement | `db.statement` | `db.statement` | `db.statement` | Same key everywhere |
| SQL duration | `db.duration_ms` | `db.duration_ms` | `db.duration_ms` | Same key everywhere |
| OTel HTTP method | use `http.method` only for legacy email path; new code `http.request.method` | `http.request.method` | `http.request.method` | New code uses semconv 1.20+ keys |
| OTel status code | (managed by Effect tracer) | `otel.status_code` field on `tracing` span | `span.set_status(Status(...))` | Title Case strings on the wire |

When in doubt, grep the existing codebase for the key name. If it's used in TS and you're writing Rust, use the same spelling.
