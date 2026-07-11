# OpenTelemetry Specification Map

An internal, source-linked map of the OpenTelemetry specifications, built for three uses:

1. **Spec-compliance checks** — especially for the ingest gateway (`apps/ingest`), which is an
   OTLP server and must honor the server-side MUSTs in [otlp.md](otlp.md).
2. **Best-practices material** — the normative rules here are the raw input for an internal
   best-practice skill (instrumentation hygiene, status semantics, attribute rules).
3. **Fact-checking reference** — every section in every file carries inline `Source:` deep links
   to the official spec pages so claims can be re-verified as the spec moves.

**Snapshot:** researched 2026-07-05 against specification **v1.58.0** (released 2026-06-22,
per the [spec CHANGELOG](https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md)).
Method: each file was written from freshly fetched official pages (opentelemetry.io/docs/specs,
the specification/semconv/proto GitHub repos, W3C TRs) — not from model memory. Stability labels
are the spec's own, recorded per section.

## Files

| File | Scope | Headline stability |
| --- | --- | --- |
| [traces.md](traces.md) | Trace API & SDK: span model, SpanKind, status, samplers, processors, span limits, ID generators | Stable (several subsections Development) |
| [metrics.md](metrics.md) | Metrics API, SDK & data model: instruments, temporality, exemplars, views, exponential histograms, cardinality | Stable (reset-detection notes Development) |
| [logs.md](logs.md) | Log data model, severity, bridge API, SDK, events-as-logs | Data model & bridge API Stable; events Development |
| [context-propagation.md](context-propagation.md) | Context, W3C traceparent/tracestate, baggage, B3/Jaeger interop | Stable (OTel `ot=` tracestate extension Development) |
| [otlp.md](otlp.md) | OTLP protocol: transports, partial success, retry semantics, JSON encoding, exporter env vars | Stable for traces/metrics/logs; profiles Development |
| [resource-and-config.md](resource-and-config.md) | Resource spec & merge rules, resource semconv, consolidated SDK env-var table, declarative config, entities | Resource Stable; declarative config Stable (`OTEL_CONFIG_FILE`); entities Development |
| [semantic-conventions.md](semantic-conventions.md) | Naming rules, requirement levels, HTTP/DB/messaging/RPC/exceptions/code/gen-ai domains, schema-URL migrations | HTTP & DB Stable; RPC RC; messaging & gen-ai Development |
| [stability-and-compliance.md](stability-and-compliance.md) | Stability taxonomies, versioning guarantees, compliance matrix, error-handling & performance principles, instrumentation guidelines | Meta-spec (see per-section labels) |
| [emerging-and-compat.md](emerging-and-compat.md) | Profiles signal, telemetry schemas deep-dive, Prometheus/OpenMetrics interop, OpenTracing/OpenCensus shims | Profiles Alpha/Development; schemas Stable (file format 1.1.0 Development); shims Deprecated |

## Maple's three compliance surfaces

**1. Ingest gateway as an OTLP server** ([otlp.md](otlp.md) is the contract):
partial-success responses are a MUST (200 + `rejected_*` counts for partially-bad batches —
never fail the whole batch for a few bad items; 400 only for fully undecodable requests);
the retryable HTTP status set is exactly {429, 502, 503, 504}; every 4xx/5xx body MUST be a
protobuf `Status`; gzip decoding is a server MUST; OTLP/JSON uses hex IDs, lowerCamelCase
fields, numeric enums, and unknown fields MUST be ignored.

**2. Self-instrumentation as an SDK consumer** ([traces.md](traces.md),
[resource-and-config.md](resource-and-config.md), [stability-and-compliance.md](stability-and-compliance.md)):
per-component instrumentation scopes over one global tracer; SDKs MUST NOT throw at runtime;
SERVER-span status = Error only on 5xx (already implemented in `apps/ingest` —
`otel_status_for_rejection`); `deployment.environment.name` is the canonical key (the legacy
`deployment.environment` is formally deprecated — our dual-emission is a migration bridge, not
the end state).

**3. UI/query semantics as a data consumer** ([semantic-conventions.md](semantic-conventions.md),
[logs.md](logs.md), [metrics.md](metrics.md)): span status stored as `"Ok"/"Error"/"Unset"`
matches the spec enum spelling (the wire form `STATUS_CODE_*` is translated once at the OTLP
boundary); log error classification should key on `SeverityNumber >= 17`, not `SeverityText`
string-matching; the `db.statement`→`db.query.text` / `db.system`→`db.system.name` coalescing in
warehouse reads mirrors the official DB-semconv stabilization renames; an "event" is now a
LogRecord with `EventName` set, and span events / `RecordException()` are on a deprecation path
toward log-based events.

## Known gaps / items to re-verify

Honest residue from the research pass — each is also flagged inline in its file:

- **Jaeger `uber-trace-id` format** was sourced via search synthesis (official page 404'd);
  spot-check against current Jaeger docs before quoting externally
  ([context-propagation.md](context-propagation.md)).
- **W3C Baggage document-track status** (Editor's Draft vs Candidate Recommendation) can shift;
  re-check before citing externally.
- **Global metrics cardinality-limit env var**: none found in the general spec — recorded as
  unverified absence, not confirmed absence ([metrics.md](metrics.md)).
- **Env-var vs declarative-config precedence** when both are present is not precisely specified
  by the spec yet ([resource-and-config.md](resource-and-config.md)).
- **Semconv general-naming and registry landing pages** were partially sourced from search
  snippets after URL churn ([semantic-conventions.md](semantic-conventions.md)).
- ~~Attribute value-type unification~~ — resolved 2026-07-05 against raw
  `specification/common/README.md`: attribute values are full `AnyValue` (nested maps/arrays
  allowed); older SDKs emit the stricter primitives+homogeneous-arrays subset.

## Canonical sources

- Spec hub: https://opentelemetry.io/docs/specs/otel/
- Semantic conventions: https://opentelemetry.io/docs/specs/semconv/ ·
  registry repo: https://github.com/open-telemetry/semantic-conventions
- OTLP: https://opentelemetry.io/docs/specs/otlp/ ·
  proto: https://github.com/open-telemetry/opentelemetry-proto
- Specification repo (raw markdown is the ground truth when the website summarizes):
  https://github.com/open-telemetry/opentelemetry-specification
- W3C Trace Context: https://www.w3.org/TR/trace-context/ · W3C Baggage: https://www.w3.org/TR/baggage/
- Compliance matrix (SDK conformance, not receiver conformance):
  https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md
