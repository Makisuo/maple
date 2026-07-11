# Logs & Events (Data Model, Bridge API & SDK)

This page documents the OpenTelemetry **Logs** specification: the log data model, the Logs API
(a.k.a. the "Bridge API"), the Logs SDK, and the current (2026) direction on **Events** as
log-based records rather than a separate signal. It is a reference for spec-compliance checks and
for a best-practices skill — every claim below is sourced from the official specification (or the
OTLP proto, for wire-level field names).

## Relevance to Maple

> Maple's Rust ingest gateway (`apps/ingest`) receives OTLP logs and forwards them to the
> collector → ClickHouse/Tinybird. Maple is primarily a **consumer/backend** of OTel log data, not
> an app-side log-emitting SDK author. The parts of this spec that matter most to us:
>
> - **Data model field semantics** (`docs/otel-spec/logs.md#logrecord-fields`) — how to interpret
>   `Timestamp` vs `ObservedTimestamp`, `SeverityNumber` vs `SeverityText`, and `Body` as an
>   `AnyValue` when mapping incoming OTLP `LogRecord`s into our ClickHouse schema.
> - **Severity normalization** — our dashboards should key error/warn facets off `SeverityNumber`
>   ranges (see CLAUDE.md: "Span Status Codes: use title case" — analogous care is needed for
>   severity display strings, which the spec also title-cases: `Trace`/`Debug`/`Info`/`Warn`/
>   `Error`/`Fatal`).
> - **Trace correlation fields** (`TraceId`/`SpanId`/`TraceFlags`) — these are how our logs UI
>   should link a log line back to a trace/span; validity rules below (e.g. `SpanId` implies
>   `TraceId`) matter for defensive parsing of malformed producers.
> - **EventName / Events direction** — OpenTelemetry is actively deprecating `Span.AddEvent` in
>   favor of log-based events (see [Events](#events)). If Maple ever ingests or displays
>   "events" as a first-class concept, the wire format is `LogRecord.event_name` (proto field 12),
>   not a separate signal. Self-instrumentation should also check whether our own Rust ingest
>   gateway or web app should switch to log-based events for anything currently using span events.
> - **SDK batch/limits env vars** — not directly consumed by Maple's backend (we don't run a Logs
>   SDK ourselves in the hot ingest path), but relevant if/when Maple's own services (API, web,
>   alerting) adopt an OpenTelemetry Logs SDK for self-instrumented application logging, and for
>   validating third-party SDK behavior when debugging customer data gaps (e.g. "why did 2000 logs
>   arrive in one batch 30s late" → default `OTEL_BLRP_*` values below).

---

## 1. Overview

**Stability: no single badge for the overview page; it links out to Stable Data Model, Stable
API, Stable SDK (see [Stability summary](#stability-summary) below).**
Source: https://opentelemetry.io/docs/specs/otel/logs/

Unlike traces and metrics, OpenTelemetry does **not** introduce a brand-new logging API that
applications are expected to adopt wholesale. Instead the logs spec is designed to **embrace
existing logging libraries** and unify their output with traces/metrics via three correlation
dimensions:

1. **Temporal correlation** — logs, traces, and metrics all carry timestamps, the most basic form
   of correlation.
2. **Contextual (execution) correlation** — a `LogRecord` can carry `TraceId`/`SpanId` so a log
   line is attributable to the exact request/span that produced it.
3. **Resource correlation** — a `LogRecord` carries the same `Resource` model used by traces and
   metrics (e.g. identical `k8s.pod.*` attributes), so a log, trace, and metric from the same
   process describe their origin identically.

Three ways logs reach OpenTelemetry are called out on this page:

- **Existing/legacy log files**, parsed and enriched by the OpenTelemetry Collector (with or
  without an intermediate agent like FluentBit).
- **Log appenders / bridges** — library-specific glue that hooks an existing logging framework
  (e.g. Log4j, Winston, `slog`) so it emits through the OpenTelemetry data model and automatically
  injects trace context into each record.
- **Direct logging** — new application code emits `LogRecord`s straight through the Logs API/SDK
  over OTLP, skipping files/parsers/rotation entirely.

Source: https://opentelemetry.io/docs/specs/otel/logs/

---

## 2. Log Data Model

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/ (spec source:
[`specification/logs/data-model.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/data-model.md))

### 2.1 LogRecord fields

All fields are conceptually optional at the data-model level (a valid `LogRecord` may have zero
fields populated — see [§2.4](#24-minimal-validity--missing-fields)); the table below states each
field's type, meaning, and the specific SHOULD/MUST guidance the spec attaches to it.

| Field | Type | Meaning | Requirement-level notes |
|---|---|---|---|
| `Timestamp` | `uint64` nanoseconds since Unix epoch | Time the event occurred, per the **origin clock** (i.e., the producer's clock, which may be unsynchronized) | Optional. May be omitted for early instrumentation phases per the spec's incremental-adoption note. |
| `ObservedTimestamp` | `uint64` nanoseconds since Unix epoch | Time the OpenTelemetry collection/observation system (SDK, collector, receiver) **first observed/recorded** the event, e.g. file-read time for tailed logs | SHOULD be set when the event's true origin timestamp is unavailable or untrusted. If unspecified by an SDK's `Emit`, the SDK **SHOULD** set it to current time (see [§4 SDK](#41-logrecord-lifecycle--observedtimestamp-default)). |
| `TraceId` | byte sequence (16 bytes on the wire) | W3C Trace Context trace identifier for the request being processed when the log was emitted | Optional. |
| `SpanId` | byte sequence (8 bytes on the wire) | Identifier of the specific span being processed when the log was emitted | Optional, but **if `SpanId` is present, `TraceId` SHOULD also be present.** |
| `TraceFlags` | 1 byte | W3C trace flags (currently only defines the `SAMPLED` bit) | Optional. |
| `SeverityText` | string | The **original**, source-native string representation of severity (e.g. `"WARN"`, `"ERR"`, framework-specific spelling) — preserved as-is, not normalized | Optional. |
| `SeverityNumber` | integer, 0–24 | The **normalized** severity, mapped onto OpenTelemetry's fixed 1–24 numeric scale (0 = unspecified) | Optional. See full table in [§2.2](#22-severitynumber-reference-table). |
| `Body` | `AnyValue` | The log payload: a human-readable message string, **or** structured data (maps/arrays/scalars) | Optional. Body **MUST support `AnyValue`** so structured logs from applications survive without lossy stringification. |
| `Resource` | `Resource` | Describes the entity producing the log (same `Resource` model as traces/metrics) | Optional at the data-model layer; in practice always populated by the SDK. |
| `InstrumentationScope` | `InstrumentationScope` | The logger (name/version/schema_url/attributes) that emitted the record; stable across many log events from the same source | Optional at the data-model layer; populated by the SDK. |
| `Attributes` | collection of key-value pairs | Additional structured data about this **specific occurrence** (as opposed to `Resource`, which describes the origin) | Optional. Subject to the same attribute limits as spans (count/length limits, see [§4.3](#43-logrecord-limits)). |
| `EventName` | string | Identifies the **class/type** of the event this log record represents | Optional. A non-empty `EventName` makes this record an **Event** — see [§5](#5-events). |

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#log-and-event-record-definition

### 2.2 SeverityNumber reference table

The severity scale is a fixed 1–24 integer range divided into six named bands, each with a
"finer-grained" sub-level (`+1`..`+4`) for systems whose native severities don't align exactly:

| SeverityNumber | Name | Meaning |
|---|---|---|
| 0 | *(unspecified)* | No severity information; `SeverityNumber` omitted/zero. |
| 1 | `TRACE` | A fine-grained debugging event. Typically disabled by default. |
| 2 | `TRACE2` | |
| 3 | `TRACE3` | |
| 4 | `TRACE4` | |
| 5 | `DEBUG` | A debugging event. |
| 6 | `DEBUG2` | |
| 7 | `DEBUG3` | |
| 8 | `DEBUG4` | |
| 9 | `INFO` | An informational event. Indicates that an event happened. |
| 10 | `INFO2` | |
| 11 | `INFO3` | |
| 12 | `INFO4` | |
| 13 | `WARN` | A warning event. Not an error but is likely more important than an informational event. |
| 14 | `WARN2` | |
| 15 | `WARN3` | |
| 16 | `WARN4` | |
| 17 | `ERROR` | An error event. Something went wrong. |
| 18 | `ERROR2` | |
| 19 | `ERROR3` | |
| 20 | `ERROR4` | |
| 21 | `FATAL` | A fatal error such as an application or system crash. |
| 22 | `FATAL2` | |
| 23 | `FATAL3` | |
| 24 | `FATAL4` | |

Normative guidance for producers mapping a **source system's own severities** onto this scale:

- If a source severity level maps to a **single** OpenTelemetry `SeverityNumber` range (e.g.
  source "WARN" → the `WARN` band), use the **lowest/smallest** value in that band (i.e. plain
  `WARN` = 13, not 14–16).
- If a source has **multiple** distinct severities that all fall into the same OpenTelemetry band
  (e.g. a framework with both "notice" and "warning" both conceptually "warn-ish"), spread them
  across that band's four values (13–16) in order of increasing importance so relative ordering is
  preserved.
- **`SeverityNumber >= ERROR (17)` is a signal the record represents an erroneous situation** — this
  is the normative hook backends should use to classify a log line as an error for dashboards/alerts,
  not string-matching on `SeverityText`.

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#displaying-severity

### 2.3 Body / AnyValue semantics

`Body` is typed as `AnyValue`, the same recursive value type used for attribute values but
extended to structures: a scalar (string/bool/int/double/bytes), or a structured value — an array
of `AnyValue`, or a map of string keys to `AnyValue`. This is explicitly to preserve **structured
logging** semantics (e.g. a JSON-object log line) without forcing lossy stringification into a
single message field. The spec states the data model **MUST** support `AnyValue` for `Body` for
exactly this reason — different occurrences of a log from the same statement/call-site can still
vary in shape (e.g. conditionally-included fields).

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-body

### 2.4 Minimal validity / missing fields

The data model does not mandate a minimum set of populated fields for a record to be "valid" — an
empty `LogRecord` is technically legal, though useless. Practical guidance:

- **`Timestamp` vs `ObservedTimestamp`**: when a consumer/exporter needs to reduce a record to a
  single timestamp (e.g. exporting to a system that only understands one time field), the rule is:
  **use `Timestamp` if it is present, otherwise fall back to `ObservedTimestamp`.** A consumer
  should never treat a record with only `ObservedTimestamp` set as invalid — that's the expected
  shape for tailed/parsed legacy logs where the true origin time is unknown or untrustworthy.
- **`SpanId` without `TraceId`** should be treated as a malformed/unusual record by a strict
  consumer, since the spec says `TraceId` SHOULD accompany `SpanId`; a defensive backend (like
  Maple's ingest path) should not assume the reverse is disallowed (a record MAY carry `TraceId`
  alone, e.g. no active span at emit time).

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-observedtimestamp and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#trace-context-fields

### 2.5 Data Model Appendix — mappings from other systems

**Stability: Stable (companion to the data model).**
Source: https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/

The appendix gives field-by-field mapping tables from common log formats onto the OpenTelemetry
`LogRecord`, useful when writing or auditing a receiver/exporter. Examples covered: RFC 5424
Syslog, Windows Event Log, SignalFx Events, Splunk HEC, Log4j, Zap, Apache HTTP Server access
logs, AWS CloudTrail, Google Cloud Logging, and the Elastic Common Schema. Pattern is consistent
across all of them: native timestamp → `Timestamp`, native severity/level → `SeverityNumber`
(+ `SeverityText` for the original string), free-form message → `Body`, host/service/cloud
identity fields → `Resource`, everything else structured → `Attributes`. A companion **Appendix B**
gives severity-level equivalency mappings (e.g. Syslog `Debug`/Java `FINEST` → `TRACE`(1); Syslog
`Emergency`/Log4j `FATAL` → `FATAL`(21)), which is the authoritative source if Maple ever needs to
normalize a specific framework's severities for ingestion.

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/

---

## 3. Logs API ("Bridge API")

**Stability: Stable, except where otherwise specified** (the page explicitly calls out an
"Ergonomic API" as still in **Development**).
Source: https://opentelemetry.io/docs/specs/otel/logs/api/ (spec source:
[`specification/logs/api.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/api.md))

### 3.1 Intended audience

This is explicitly called the **Logs Bridge API** in the spec, and it is **not meant for
application developers to call directly in everyday code**. The primary audience is:

- **Log appender / bridge authors** — people writing the glue that lets an existing logging
  library (Log4j, Winston, `slog`, Python `logging`, etc.) emit through OpenTelemetry.
- Secondarily, instrumentation and instrumented-library authors, who *may* call it directly, though
  a language may offer a more ergonomic wrapper for that purpose.

This matters for Maple only insofar as we should not expect our own application code (if we ever
add OTel-based logging to the Rust ingest gateway, `apps/api`, etc.) to call this low-level API
directly — we'd reach for a logging-library integration/bridge, or the language's ergonomic
wrapper, not `Logger.Emit` by hand.

Source: https://opentelemetry.io/docs/specs/otel/logs/api/#overview

### 3.2 LoggerProvider

Entry point; **MUST** provide a "Get a Logger" operation, parameterized by the **Instrumentation
Scope**: `name` (required), `version` (optional), `schema_url` (optional), `attributes` (optional).
Also must support access to a global default `LoggerProvider`.

Source: https://opentelemetry.io/docs/specs/otel/logs/api/#loggerprovider

### 3.3 Logger — Emit a LogRecord

The `Logger` interface's core operation accepts (all optional except where noted):

- `Timestamp`, `ObservedTimestamp`
- `Context` — **"When implicit Context is supported, then this parameter SHOULD be optional and if
  unspecified then MUST use current Context. When only explicit Context is supported, this
  parameter SHOULD be required."** This is the mechanism by which trace correlation
  (`TraceId`/`SpanId`) gets attached to a log record automatically: the SDK reads the active
  span/trace out of whatever `Context` is in scope (implicit ambient context, or an explicitly
  passed one) at emit time and copies its `TraceId`/`SpanId`/`TraceFlags` onto the record.
- `SeverityNumber`, `SeverityText`
- `Body`
- `Attributes`
- `EventName`
- `Exception` — optional/MAY be accepted as a convenience for exception-recording

### 3.4 Enabled

`Logger` **SHOULD** provide an `Enabled(context, severityNumber, eventName)` operation returning a
boolean, so callers can cheaply skip expensive log-construction work when the record would be
dropped anyway. The spec notes the result "is not always static, it can change over time" (e.g.
dynamic sampling/config), so callers should be documented to call it fresh each time rather than
caching the result.

### 3.5 Concurrency

Both `LoggerProvider` and `Logger`: **all methods MUST be documented as safe for concurrent use by
default.**

Source (3.2–3.5): https://opentelemetry.io/docs/specs/otel/logs/api/

---

## 4. Logs SDK

**Stability: Stable, except where otherwise specified** — the page explicitly marks
**`LoggerConfigurator`, per-`LoggerConfig` behavior (`enabled`/`minimum_severity`/`trace_based`),
`Enabled`-based filtering rules, and the "Event to span event bridge processor" as Development.**
Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/ (spec source:
[`specification/logs/sdk.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/sdk.md))

### 4.1 LogRecord lifecycle / ObservedTimestamp default

The SDK-level `Emit` operation implements the data-model rule from [§2.4](#24-minimal-validity--missing-fields):
**"If Observed Timestamp is unspecified, the implementation SHOULD set it equal to the current
time."** This is the concrete SDK-side guarantee behind the data model's "SHOULD be set" language
for `ObservedTimestamp`.

### 4.2 LoggerProvider / Logger (SDK)

- A `LoggerProvider` **MUST** provide a way to configure/attach a `Resource`.
- Owns the set of registered `LogRecordProcessor`s and (Development-status) a `LoggerConfigurator`.
- Supports multiple independent `LoggerProvider` instances in one process.
- **Shutdown**: called once; SDK should make the `Logger` a no-op after shutdown.
- **ForceFlush**: tells all registered processors to flush pending records.
- `LoggerConfig` (Development) parameters, per logger: `enabled` (default `true`),
  `minimum_severity` (default `0`, filters records below this `SeverityNumber`), `trace_based`
  (default `false`; when `true`, drops records for unsampled traces).

### 4.3 LogRecordProcessor

Interface operations:

- **OnEmit** — called synchronously on the emitting thread with a `ReadWriteLogRecord` and the
  resolved `Context`; **SHOULD NOT block or throw**.
- **Enabled** (optional) — filtering hook taking context/instrumentation-scope/severity/event-name,
  returns bool.
- **Shutdown**, **ForceFlush** — as usual for OTel pipeline components.

#### Simple Processor

Passes each finished `LogRecord` to its configured `exporter` **immediately**, synchronized so
`Export` is never called concurrently on the same exporter instance.

#### Batching Processor

Buffers records into batches before handing them to the exporter. Configurable parameters and
**their environment variables** (general SDK env var spec):

| Parameter | Env var | Default | Notes |
|---|---|---|---|
| Max queue size | `OTEL_BLRP_MAX_QUEUE_SIZE` | `2048` | Maximum number of `LogRecord`s buffered before drop. |
| Scheduled delay | `OTEL_BLRP_SCHEDULE_DELAY` | `1000` (ms) | Delay between consecutive batch exports. |
| Export timeout | `OTEL_BLRP_EXPORT_TIMEOUT` | `30000` (ms) | Max time allowed for a single export call. |
| Max export batch size | `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` | `512` | Must be `<=` max queue size. |

All numeric values must be positive. (`BLRP` = **B**atch **L**og**R**ecord **P**rocessor — same
naming pattern as `BSP` for spans.)

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#batching-processor and
https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Batch LogRecord Processor")

### 4.4 LogRecordExporter

- **Export(batch of `ReadableLogRecord`s)** → `Success` | `Failure`. **Must not be called
  concurrently** with other `Export` calls on the same exporter instance (the processor guarantees
  serialization).
- **ForceFlush** — completes pending exports within a timeout.
- **Shutdown** — releases resources; any subsequent `Export` call **MUST** return `Failure`.

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#logrecordexporter

### 4.5 LogRecord limits

The SDK enforces the same family of attribute limits used for spans, applied to `LogRecord.Attributes`:

| Parameter | Env var | Default | Notes |
|---|---|---|---|
| Attribute count limit | `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT` | `128` | Non-negative integer; extra attributes past this count are dropped (and counted in `dropped_attributes_count` on the wire). |
| Attribute value length limit | `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT` | no limit | Non-negative integer; truncates attribute values longer than this. |

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#logrecord-limits and
https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Attribute Limits" / "LogRecord Limits")

### 4.6 Exporter selection

| Env var | Default | Known values |
|---|---|---|
| `OTEL_LOGS_EXPORTER` | `otlp` | `otlp`, `console`, `logging` (deprecated alias for `console`), `none`. Implementations may accept a comma-separated list to configure multiple exporters simultaneously. |

Source: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Exporter Selection")

### 4.7 Concurrency

- `LoggerProvider`: creation of `Logger`s, `ForceFlush`, `Shutdown` must be thread-safe.
- `Logger`: all methods thread-safe.
- `LogRecordExporter`: `ForceFlush`/`Shutdown` thread-safe; `Export` itself is explicitly **not**
  required to be concurrency-safe against itself (the processor serializes calls instead).

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#concurrency-requirements

---

## 5. Events

**Stability: Development / actively changing (2026).** This is the area of the spec most in flux
— report here reflects the *current* normative direction, not a settled long-term API.

### 5.1 Current model: Events are log-based, not a separate signal

As of the current spec, there is **no separate Event API/SDK**. The historical
`specification/logs/event-api.md` document (a standalone Event API layered on top of the Logs API,
present in older spec versions such as
[v1.35.0](https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md))
**no longer exists on `main`** (confirmed 404 against the current `main` branch tree at time of
writing). Events have been folded directly into the log data model:

- An **Event** is defined as **a `LogRecord` with a non-empty `EventName`** — not a distinct
  message type. The proto wire representation is `LogRecord.event_name` (field 12,
  `opentelemetry/proto/logs/v1/logs.proto`), sitting alongside `time_unix_nano`,
  `severity_number`, `body`, `attributes`, `trace_id`, `span_id`, etc. There is no separate
  `EventRecord` proto message.
- All Events sharing the same `EventName` **MUST** conform to the same schema for both their
  `Attributes` and their `Body` — i.e. `EventName` acts like a schema/type discriminator.
- Per the events semantic-conventions page: Events **MUST** have `Timestamp` set to when the event
  actually occurred, and semantic conventions **MUST NOT** define a value for `ObservedTimestamp`
  (that field stays purely about when the observability pipeline itself observed/received the
  record — SDK/collector populated, never spec'd by convention authors).
- Event semantic conventions **MUST NOT** define a `Body` value except to hold a plain string
  display message — structured/queryable data belongs in `Attributes`, preferably flat rather than
  deeply nested.
- Event semantic conventions **MUST** document the event name so that querying by `event.name`
  reliably returns records conforming to that convention's schema.

Source: https://opentelemetry.io/docs/specs/semconv/general/events/ and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-eventname

### 5.2 Deprecation of Span Events in favor of log-based events

A significant, currently-in-progress spec direction (tracked as an accepted OTEP, referenced as
**OTEP 4430** in the announcement): OpenTelemetry is **deprecating the Span Events API**
(`Span.AddEvent()` and `Span.RecordException()`) in favor of emitting **log-based events** through
the Logs API/SDK, correlated back to the active trace/span via `Context` (the same mechanism
described in [§3.3](#33-logger--emit-a-logrecord)) rather than being attached directly to the span
object.

Rationale given: maintaining two overlapping event mechanisms (span events vs. log-based events)
produced inconsistent guidance for library authors, duplicated concepts for operators to learn, and
slowed spec evolution since every improvement had to be designed/implemented twice.

Migration posture (no exact version/date commitments found in the source):

- New instrumentation should prefer log-based events **now**.
- Existing instrumentation's current major version stays behaviorally compatible (no breaking
  removal yet).
- Next major versions of instrumentation libraries and semantic conventions are expected to
  migrate from span events to log-based events.
- Language SDKs are expected to offer compatibility/transform shims during the transition.

**Practical implication for Maple:** if our self-instrumentation (or any vendored instrumentation
we depend on) currently uses `span.addEvent(...)` for things like exception recording, expect
upstream libraries to eventually shift that data into log-based Events (`LogRecord` with
`EventName` set) instead of `SpanEvent`s on the span. Our ingest/consumption path should already
handle both shapes since both arrive as normal OTLP signals (span events inside
`Span.events`, log-based events inside the Logs OTLP stream) — but any dashboard logic that reads
"events" **only** from span data (e.g. `Span.events`) will miss log-based events, and vice versa,
until this migration is complete across the ecosystem.

Source: https://opentelemetry.io/blog/2026/deprecating-span-events/

---

## 6. Stability summary

| Area | Stability (as stated by spec) | Source |
|---|---|---|
| Logs Data Model | Stable | https://opentelemetry.io/docs/specs/otel/logs/data-model/ |
| Data Model Appendix (mappings) | Stable | https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/ |
| Logs API ("Bridge API") | Stable, except Ergonomic API (Development) | https://opentelemetry.io/docs/specs/otel/logs/api/ |
| Logs SDK | Stable, except `LoggerConfigurator`/`LoggerConfig`/`Enabled`-filtering/event-to-span-event-bridge processor (Development) | https://opentelemetry.io/docs/specs/otel/logs/sdk/ |
| OTLP Logs wire format (`logs.proto`) | Stable (part of OTLP) | https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto |
| Events (semantic-convention layer, `EventName`) | **Development** | https://opentelemetry.io/docs/specs/semconv/general/events/ |
| Span Events API (`Span.AddEvent`) | **Deprecated** (transition to log-based events in progress) | https://opentelemetry.io/blog/2026/deprecating-span-events/ |
| Standalone Event API/SDK (`logs/event-api.md`) | **Removed** — folded into Logs Data Model / API | (confirmed absent on `main`; last present at tag [v1.35.0](https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md)) |

---

## Key references

- Logs specification overview — https://opentelemetry.io/docs/specs/otel/logs/
- Logs Data Model — https://opentelemetry.io/docs/specs/otel/logs/data-model/
- Data Model Appendix (format mappings) — https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/
- Logs API (Bridge API) — https://opentelemetry.io/docs/specs/otel/logs/api/
- Logs SDK — https://opentelemetry.io/docs/specs/otel/logs/sdk/
- SDK environment variables (Batch LogRecord Processor, LogRecord Limits, `OTEL_LOGS_EXPORTER`) — https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
- Events semantic conventions (general) — https://opentelemetry.io/docs/specs/semconv/general/events/
- Deprecating Span Events API (blog, 2026) — https://opentelemetry.io/blog/2026/deprecating-span-events/
- OTLP `logs.proto` (wire format, `LogRecord`/`SeverityNumber`/`ResourceLogs`/`ScopeLogs`) — https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto
- Specification status summary — https://opentelemetry.io/docs/specs/status/
- Historical Event API (pre-removal, v1.35.0 snapshot, for context only — not current) — https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md
