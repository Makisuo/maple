# Span status codes and span kinds

## Status codes — always Title Case

Maple stores span status as the **rendered string**, in Title Case. The values are:

| Value | When | Note |
|---|---|---|
| `"Ok"` | Successful operation | Not `OK`, `SUCCESS`, `ok`, or `Success` |
| `"Error"` | Failed operation | Not `ERROR`, `FAILED`, `error`, or `Failed` |
| `"Unset"` | Status not explicitly set (rare) | OTel default; usually only on Internal-kind spans that don't represent a discrete success/fail outcome |

### Why this matters — it's load-bearing

Tinybird MVs and dashboard widgets filter on the literal string. The error analytics path uses `WHERE StatusCode = 'Error'`. Uppercase or lowercase variants silently produce zero rows on the error-rate widget and zero traces in the errors list. CLAUDE.md states this explicitly: "**Span Status Codes:** Use title case (`"Ok"`, `"Error"`, `"Unset"`), not uppercase".

### How status is set

**TypeScript (Effect):** The Effect tracer maps an effect's failure to span status. When you call `Effect.fail(...)` or the effect dies, the tracer records `Error`. On success, the tracer records `Ok`. Do not set the string manually in TS — let the runtime do it.

**Rust (ingest gateway):** Status is set explicitly via the `otel.status_code` field on the span:

```rust
let span = tracing::info_span!(
    "ingest",
    otel.name = %otel_name,
    otel.kind = "server",
    otel.status_code = tracing::field::Empty,  // declared empty, recorded later
    // ...
);
// on success:
span_handle.record("otel.status_code", "Ok");
// on error:
span_handle.record("otel.status_code", "Error");
```

See `apps/ingest/src/main.rs:874, 895, 949, 978, 1201, 1306`.

**Python (forward-looking):** `span.set_status(Status(StatusCode.ERROR))` — Python SDK maps `StatusCode.ERROR` to the wire-level `Error` string before export, so no manual conversion is needed. But never call `span.set_attribute("otel.status_code", "ERROR")` (uppercase) — it bypasses the SDK conversion.

---

## Span kinds

The OTel spec defines five kinds. Maple uses three actively:

| Kind | Use for | Example |
|---|---|---|
| `Server` | Inbound network request handlers | Ingest gateway `POST /v1/traces`, API HTTP handlers |
| `Client` | Outbound network calls | Ingest forward to downstream collector, fetch to ClickHouse, Resend email API |
| `Internal` | Everything in-process | Query compilation, cache lookups, validation, DSL evaluation |
| `Producer` | (not currently used) | Reserved for future queue producers |
| `Consumer` | (not currently used) | Reserved for future queue consumers |

### How span kind is set

**TypeScript (Effect):** `Effect.withSpan(name, { kind: "server" })`. The Effect SDK uses lowercase string kinds. Most Effect spans default to `Internal`; set `server` / `client` explicitly when they cross a network boundary.

**Rust (tracing crate):** Use the `otel.kind` field:

```rust
let span = tracing::info_span!("ingest", otel.kind = "server", /* ... */);
```

See `apps/ingest/src/main.rs:846` (Server inbound), `:923` (Server inbound for logpush), `:1135` (Client downstream forward), `:1300` (Client logpush downstream).

**Python:** `tracer.start_as_current_span(name, kind=trace.SpanKind.SERVER)`.

### Rule: always set Server / Client at boundaries

If a span handles an inbound request, set `Server`. If it makes an outbound network call, set `Client`. Dashboards and the service map rely on this for correct attribution. Leaving the default `Internal` on a network handler causes the service map to miss the edge.

---

## Reserved OTel fields (Rust ingest)

The `tracing` crate field names below are special — they are interpreted by `tracing-opentelemetry` to populate corresponding OTel span fields rather than custom attributes:

| Field | Maps to | Example value |
|---|---|---|
| `otel.name` | Span name | `"POST /v1/traces"` |
| `otel.kind` | Span kind | `"server"`, `"client"`, `"internal"` (lowercase in `tracing`; rendered as Title Case `Server`/`Client`/`Internal` on the wire) |
| `otel.status_code` | Span status | `"Ok"` / `"Error"` / `"Unset"` (Title Case — these go directly to the wire string) |

Do not invent custom span attributes named `otel.*` — those slots are reserved.
