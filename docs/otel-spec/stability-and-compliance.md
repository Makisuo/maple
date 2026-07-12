# Versioning, Stability & Compliance

This document is the meta-spec reference: it covers how the OpenTelemetry
specification itself defines maturity/stability, what "stable" legally forbids
implementations from doing, the error-handling and performance principles
every SDK/instrumentation must follow, and how to read the cross-language
compliance matrix. Everything else in `docs/otel-spec/` (semconv, OTLP, etc.)
inherits its stability guarantees from the concepts defined here.

> **Spec version referenced:** OpenTelemetry Specification **v1.58.0**
> (released 2026-06-22, per the
> [specification CHANGELOG](https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md)).
> Stability language quoted below is current as of that release; re-check the
> CHANGELOG's "Unreleased" section when bumping this doc.

> [!NOTE] Relevance to Maple
> Maple is primarily a **consumer/backend** of OTel data (Rust ingest gateway →
> collector → ClickHouse/Tinybird → web dashboard), plus a **self-instrumented
> emitter** of its own telemetry via `@effect/opentelemetry`. That means three
> of the four stability domains below (API, SDK, telemetry/semconv) matter to
> us mostly as *producers* (our own services) and the fourth (OTLP wire format)
> matters as a *server implementor* (`apps/ingest` accepting arbitrary
> upstream OTLP). We do not ship an OTel API/SDK for others to depend on, so
> the API/SDK LTS clauses are not obligations we owe — they're read as
> "what guarantees can we assume from the SDKs instrumenting the services that
> send us data."

---

## 1. Four stability domains, disentangled

The spec deliberately separates stability into independent domains that
version and evolve on their own schedules. Conflating them is the most common
compliance mistake.

| Domain | What it governs | Governing doc | Versioning |
|---|---|---|---|
| **API stability** | Method signatures in `opentelemetry-api` packages (Tracer, Meter, Logger, Context, Propagators) | [Versioning and stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) | All stable API packages across all signals version together, one number, SemVer 2.0.0 |
| **SDK stability** | Public SDK surface: plugin interfaces (`SpanProcessor`, `Exporter`, `Sampler`) and constructors/config/builders | Same doc, "SDK" sections | SDK packages for all signals version together, independently from API |
| **Telemetry/semconv stability** | The *shape* of emitted telemetry (span/metric/log names, attribute keys) that a stable instrumentation produces | [Telemetry Stability](https://opentelemetry.io/docs/specs/otel/telemetry-stability/) | Semantic Conventions have their own single version number, independent of API/SDK |
| **Wire (OTLP) stability** | The protobuf/JSON wire protocol between SDKs, collectors, and backends | OTLP protocol spec (see `docs/otel-spec` OTLP page if present) | Its own protocol version field, independent again |

Each of these can be at a different maturity level simultaneously. For
example, the Trace **API** has been Stable since v1.0.0, but a given
**instrumentation library's telemetry** (e.g., HTTP semconv attribute names)
can still be in `Development`/`Alpha` even while riding on top of a fully
stable API and SDK. Maple's ingest gateway sees this directly: many spans
we accept still carry `http.method`/`net.peer.name` (old semconv) alongside
`http.request.method`/`server.address` (new semconv) because instrumentation
libraries move through telemetry-stability transitions independently of their
host language's API/SDK version.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/, https://opentelemetry.io/docs/specs/otel/telemetry-stability/

---

## 2. Signal lifecycle levels (spec-wide)

The specification's versioning-and-stability doc defines the lifecycle a
**signal** (Traces, Metrics, Logs, Profiles, Baggage) or a spec **feature**
moves through:

| Level | Guarantee | Notes |
|---|---|---|
| **Development** | None. "While signals are in development, breaking changes and performance issues MAY occur." | Not feature-complete; may be discarded entirely. Long-term dependencies discouraged. |
| **Stable** | Backward compatible going forward. "Once a signal in Development has gone through rigorous testing, it MAY transition to Stable." | Long-term dependencies now permissible. Transition itself must not break existing users: "OpenTelemetry clients MUST NOT be designed in a manner that breaks existing users when a signal transitions from Development to Stable." |
| **Deprecated** | Same support guarantees as Stable, but scheduled for removal. Requires a stable replacement to exist first. | |
| **Removed** | Gone. "Support is ended by the removal of a signal from the release. The release MUST make a major version bump when this happens." | |

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/

### Document-level status markers (separate taxonomy)

Individual **specification documents** (not signals) carry their own,
more granular maturity marker at the top of the page — this is the taxonomy
most relevant to reading any given spec page correctly:

| Status | Guarantee | Exact language |
|---|---|---|
| **Development** | None; may be incomplete or unavailable. | "Bugs and performance issues are expected to be reported." Should not be used in production; may be removed without notice. |
| **Alpha** | Usable for "limited non-critical production workloads." | Interfaces/config "can change often without backward compatibility." Component may be dropped anytime without warning. |
| **Beta** | Interfaces "treated as stable whenever possible." | Breaking changes should be minimized between releases (still possible). |
| **Release Candidate** | Feature-complete. | "Breaking changes, including configuration options and the component's output, are only allowed under special circumstances." |
| **Stable** | General availability. | "Breaking changes ... are only allowed under special circumstances," with prior notice when possible. |
| **Deprecated** | Frozen, sunset scheduled. | "Components that are included in distributions are expected to exist for at least two minor releases or six months." |
| **Unmaintained** | No active code owner. | After six months in this state, may transition to Deprecated. |
| *(no marker)* | Treated as **Alpha**. | Absence of a status is not "stable by default." |

Documents whose sections carry differing statuses are labeled **"Mixed"** at
the top — always check the per-section status inline, not just the doc
banner, before treating any single paragraph as a stability guarantee.

Source: https://opentelemetry.io/docs/specs/otel/document-status/

**Practical rule for our compliance checks:** when citing a spec page as
justification for a design decision, always record the status banner (and,
for Mixed docs, the section-level status) alongside the citation — a
"Development"-status paragraph is not a compliance requirement, it's a
preview.

---

## 3. What "Stable" forbids — breaking-change policy

### API packages

> "Backward-incompatible changes to API packages MUST NOT be made unless the
> major version number is incremented."
>
> "All existing API calls MUST continue to compile and function against all
> future minor versions of the same major version."

Languages that ship binaries should additionally provide **ABI compatibility**
for API packages across minor versions.

### SDK packages

> "Public portions of SDK packages MUST remain backward compatible."

"Public" is scoped to two categories:

1. **Plugin interfaces** — `SpanProcessor`, `Exporter`, `Sampler`, and
   equivalents. New methods may be *added* to these interfaces without a
   major bump only if the host language allows it in a backward-compatible
   way (e.g., default interface methods).
2. **Constructors** — configuration objects, environment variables, builder
   APIs.

### Semantic conventions

Semconv defines a *breaking change* as one that breaks "common usage of
tooling written against the telemetry it produces" — a narrower, more
practical bar than pure API compatibility. Two tiers:

- **Allowed only via a published schema file** (so old→new transforms are
  mechanical): renaming span/metric/log/resource attributes; renaming
  metrics and span events.
- **Always allowed, no schema needed**: adding new attributes to an existing
  convention; adding entirely new conventions for resource/span/metric types
  that didn't exist before.
- **Prohibited outright**: anything else that would require inventing a new
  schema transform format.

### Deprecation process

A signal/feature can only be marked Deprecated once a Stable replacement
exists. Deprecated code retains full Stable-level support guarantees (no
extra breakage) until formally Removed, which itself requires a major version
bump.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/, https://opentelemetry.io/docs/specs/otel/telemetry-stability/

---

## 4. Versioning scheme

- Follows **Semantic Versioning 2.0.0**.
- **Independent version tracks:** all stable API packages (across every
  signal) share one version number; all SDK packages share a separate one;
  Semantic Conventions have their own single version number; contrib
  packages version independently again. A major bump in one track does not
  imply a bump in another.
- **Major bump** required for: any breaking change to a stable interface, or
  removal of a deprecated signal.
- **Minor bump**: backward-compatible additions, changes to Development-level
  signals, or a signal's maturity transition (e.g., Development → Stable).
- **Patch bump**: "Make no changes which would require recompilation or
  potentially break application code" — bug fixes, security fixes, docs only.

### Long-term support (LTS)

| Track | Minimum support window after next major release |
|---|---|
| API | 3 years |
| SDK | 1 year |
| Contrib | 1 year |

During the API LTS window, the latest SDK minor version keeps receiving
bug/security fixes, and contrib packages from that era keep receiving fixes
too.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/

---

## 5. Error-handling principles (fail-safe requirements)

These are the rules that should drive our best-practices skill's "never let
telemetry take down the host app" checks — both for our own
`@effect/opentelemetry` self-instrumentation and for anything we tell users
to expect from well-behaved upstream SDKs sending us data.

- **No unhandled exceptions, ever, at runtime:**
  > "OpenTelemetry implementations MUST NOT throw unhandled exceptions at
  > runtime." / "API methods MUST NOT throw unhandled exceptions when used
  > incorrectly by end users."
- **Fail-safe defaults over runtime failure:** implementations must "provide
  safe defaults for missing or invalid arguments" instead of failing.
- **Init-time failure is the one allowed exception:** libraries "MAY fail
  fast and cause the application to fail on initialization" but "MUST NOT
  cause the application to fail later at runtime." (I.e., blow up at startup
  if misconfigured — never mid-request.)
- **SDK internal errors are isolated:** SDKs "MUST NOT throw unhandled
  exceptions for errors in their own operations" — e.g. an exporter's
  connection to the collector dropping must not propagate into user code.
- **Callback safety:** "API methods that accept external callbacks MUST
  handle all errors" raised by those callbacks.
- **No-op over null:** on suppressed error, implementations "MUST return a
  'no-op' or any other 'default' object" rather than `null`/an exception.
- **Self-diagnostics instead of silent failure:** "Whenever the library
  suppresses an error that would otherwise have been exposed to the user,
  the library SHOULD log the error using language-specific conventions."
  Libraries are further "encouraged to expose self-troubleshooting metrics,
  spans, and other telemetry that can be easily enabled and filtered out by
  default."
- **User override:** "SDK implementations MUST allow end users to change the
  library's default error handling behavior for relevant errors."

Source: https://opentelemetry.io/docs/specs/otel/error-handling/

**Best-practice-skill translation:** any span/metric/log emission path we
write (in `apps/api`, `apps/ingest`, or client SDKs we recommend) must never
be able to throw past its call site into request-handling code; it should
swallow-and-self-log instead. This is exactly the shape of our own
`withTracerDisabledWhen` / OTLP-export-is-async design already documented in
CLAUDE.md's Self-Observability section — that design *is* spec compliance
with error-handling, not just an internal safety measure.

---

## 6. Performance / blocking guidance

- **Non-blocking by default:** "Library should not block end user
  application by default."
- **Bounded memory:** "Library should not consume unbounded memory
  resource." The spec explicitly frames overhead as a trade-off the
  implementation must actively manage, not ignore: instrumentation "should
  not degrade the end user application as possible."
- **Under load, choose consciously between two failure modes:**
  1. *Preserve everything, risk memory pressure* — "Preserve all information
     but possible to consume many resources", or
  2. *Bound memory, drop data* — "Dropping some information under
     overwhelming load and show warning log to inform when information loss
     starts and when recovered." This mode should have configurable
     thresholds and ideally expose a metric approximating the effective
     sampling ratio caused by the drops.
- **Logs need their own filter valve:** "Logging could consume much memory
  by default if the end user application emits too many logs" — the spec
  says implementations should "provide a way to filter logs to capture by
  OpenTelemetry" independent of the application's own logging volume.
- **Shutdown/flush must be boundedly blocking:** "The OpenTelemetry client
  could block the end user application when it shut down." Both `shutdown()`
  and explicit `flush()` should "support user-configurable timeout."

No concrete numeric overhead/allocation targets are specified — this is
qualitative guidance only, left to each SDK's own benchmarking.

Source: https://opentelemetry.io/docs/specs/otel/performance/

**Maple-specific read:** `apps/ingest`'s WAL + async OTLP forward and its
startup loopback guard are the kind of bounded-blocking / configurable-drop
behavior this section calls for. Any new self-instrumentation on hot paths
(e.g. per-request auth token validation, per-span-batch processing) should be
checked against "does this block the request" and "is memory bounded under
burst," not just "does it produce useful telemetry."

---

## 7. Library / instrumentation guidelines

Two source documents cover this, one on general client design principles and
one specifically on native instrumentation practice.

### General client design (spec: library-guidelines)

- **Depend on API only, never SDK:** "Libraries, frameworks, and applications
  that want to be instrumented with OpenTelemetry take a dependency only on
  the API packages." This is what lets a library be instrumented without
  forcing a specific backend on its consumers.
- **Negligible overhead is a design constraint, not an afterthought:** "It is
  also important that minimal implementation incurs as little performance
  penalty as possible, so that third-party frameworks and libraries that are
  instrumented with OpenTelemetry impose negligible overheads..."
- **Exporter package naming:** separately-published exporters should be
  named with the `opentelemetry-exporter-{vendor_name}` pattern (prefixed
  with "OpenTelemetry" and "Exporter").
- This document explicitly does *not* cover span-granularity or attribute
  hygiene — it defers to other spec sections (semantic conventions, API spec)
  for that level of detail.

Source: https://opentelemetry.io/docs/specs/otel/library-guidelines/

### Native instrumentation practice (concepts: instrumentation/libraries)

- **Why native over external hooks:** "Native library instrumentation with
  OpenTelemetry provides better observability and developer experience for
  users, removing the need for libraries to expose and document hooks."
  Custom logging hooks get replaced by the common OTel API, and
  traces/logs/metrics from library and application code end up "correlated
  and coherent."
- **Scope naming when you call `getTracer`/`getMeter`/`getLogger`:** "When
  obtaining the tracer, provide your library (or tracing plugin) name and
  version: they show up on the telemetry and help users process and filter
  telemetry." Example: `getTracer("demo-db-client", "0.1.0-beta1")`.
- **Pin to the earliest stable API:** "Use the earliest stable OpenTelemetry
  API (1.0.*) and avoid updating it unless you have to use new features" —
  minimizes forced version churn for consumers of the instrumented library.
- **Register it:** "Add your instrumentation library to the OpenTelemetry
  registry so users can find it."

### Instrumentation Scope — identity and naming (concepts: instrumentation-scope)

An Instrumentation Scope is "a logical unit of software with which emitted
telemetry is associated. It can represent a module, package, class, library,
or framework." It is identified by a `(name, version, schema_url,
attributes)` tuple — only `name` is required, and "the `name` should uniquely
identify the logical unit of software — for example, the fully qualified name
of a library, class, or module."

Naming guidance by situation:

| Situation | Convention | Example |
|---|---|---|
| Library/framework with native instrumentation | Library's own fully qualified name + version | — |
| Third-party library, no native support (external instrumentation library) | Fully qualified name/version of the *instrumentation* library itself, often reverse-DNS | `io.opentelemetry.contrib.mongodb`, `io.opentelemetry.instrumentation.flask` |
| OpenTelemetry-hosted contrib instrumentation | `opentelemetry-instrumentation-<instrumented-lib>` package-name prefix | `opentelemetry-instrumentation-flask` |
| Application-level code (not a library) | Class or module name | `CheckoutService` |

Every span/metric/log record produced by a given tracer/meter/logger
instance is tagged with that instance's scope — this is what lets backends
group/filter telemetry by originating component and compare across library
versions.

Source: https://opentelemetry.io/docs/specs/otel/library-guidelines/, https://opentelemetry.io/docs/concepts/instrumentation/libraries/, https://opentelemetry.io/docs/concepts/instrumentation-scope/

**Maple-specific read:** our own service names already follow the spec's
identity model at the *Resource* level (`service.name="ingest"`,
`service.version`, `service.instance.id` — see CLAUDE.md's
Self-Observability section). Instrumentation Scope is the finer-grained
sibling of that: if we ever split internal tracer usage across modules
inside `apps/api` (e.g. a distinct tracer for the alerting service vs. the
query engine), each should get its own scope name (e.g.
`maple.alerting`, `maple.query-engine`) and version, not one blanket
service-wide tracer — so dashboard users can filter by component the same
way they filter by service.

---

## 8. Telemetry stability guarantees (semconv-adjacent, distinct from API/SDK)

This document governs **the shape of telemetry emitted by instrumentations**
specifically — a different axis from API/SDK code stability.

- **Unstable instrumentations:** no guarantees at all. "Unstable
  instrumentations provide no guarantees about the shape of the telemetry
  they produce and how that shape changes over time."
- **Stable instrumentations** split into two sub-cases:
  - **Fixed-schema producers** (stable, but no Schema URL attached to their
    telemetry): "Such instrumentations are prohibited from changing any
    produced telemetry" — full stop, even to adopt a newer semconv release,
    unless they migrate to schema-file-driven status.
  - **Schema-file-driven producers** (stable, Schema URL attached): as of the
    fetched page, this path is **under moratorium** — currently held to the
    same no-change restriction as fixed-schema producers. Once the
    moratorium lifts, changes become allowed only if they (a) match a
    released OTel semconv version, (b) ship a corresponding published schema
    file, and (c) correctly update the Schema URL.
- **Universally allowed regardless of tier:** "Adding of new metrics, spans,
  span events or log records and adding of new attributes."

Source: https://opentelemetry.io/docs/specs/otel/telemetry-stability/

**Why this matters for our ingest gateway specifically:** because
telemetry-shape stability is decoupled from API/SDK stability, a
long-since-1.0 SDK can still be emitting spans whose attribute names are
mid-migration (old vs. new HTTP semconv, for instance). Maple's ingest path
and ClickHouse materialized views (`service_overview_spans_mv`, etc.) already
coalesce legacy and current attribute spellings for this exact reason — see
CLAUDE.md's note on dual-emitting `deployment.environment.name`/
`deployment.environment`. That coalescing logic is not a hack; it's the
correct way to consume telemetry from instrumentations that are Stable at the
API level but still transitioning at the telemetry-shape level.

### Schema URL / Telemetry Schema mechanics

A **Schema URL** identifies a **Schema File** — a YAML document describing
one version of a Schema Family, plus the transforms needed to convert older
compatible telemetry in that family up to this version. Mechanically:

- The URL's last path segment is the schema version; everything before it is
  the **Schema Family identifier** — all schema versions in one family share
  that prefix.
- Fetchers **must** follow HTTP redirects when resolving a Schema URL.
- In OTLP, `schema_url` on `ResourceSpans`/`ResourceMetrics`/`ResourceLogs`
  applies to the contained `Resource` and its spans/metrics/logs; a
  scope-level `schema_url` (on `ScopeSpans`/`ScopeMetrics`/`ScopeLogs`, the
  successor to the deprecated `InstrumentationLibrarySpans` etc.) applies
  only to the contained telemetry items for that scope.
- The whole mechanism exists for one narrow purpose: "to allow OpenTelemetry
  Semantic Conventions to evolve over time" without breaking consumers who
  pin to an older schema version.

Source: https://opentelemetry.io/docs/specs/otel/schemas/, https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/schemas/README.md

---

## 9. Glossary — terms load-bearing for this doc

| Term | Definition | Source |
|---|---|---|
| **Signal** | "OpenTelemetry is structured around signals, or categories of telemetry. Metrics, logs, traces, profiles, and baggage are examples of signals." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Instrumented Library** | "The library for which the telemetry signals (traces, metrics, logs) are gathered." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Instrumentation Library** | "The library that provides the instrumentation for a given Instrumented Library. Instrumented Library and Instrumentation Library may be the same library if it has built-in OpenTelemetry instrumentation." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Instrumentation Scope** | "A logical unit of software with which emitted telemetry is associated. It can represent a module, package, class, library, or framework." Identified by `(name, version, schema_url, attributes)`. | [Instrumentation Scope concept](https://opentelemetry.io/docs/concepts/instrumentation-scope/) |
| **Telemetry SDK** | "The library that implements the OpenTelemetry API." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Manual Instrumentation** | "Coding against the OpenTelemetry API to collect telemetry from end user code or shared frameworks." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Automatic Instrumentation** | "Telemetry collection methods that do not require the end user to modify application's source code." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/) |
| **Schema URL** | Identifier for a Schema File; last path segment is the version, the prefix is the Schema Family identifier; resolution must follow redirects. | [Telemetry Schemas](https://opentelemetry.io/docs/specs/otel/schemas/) |
| **Telemetry Schema** | "The expected shape and composition of emitted telemetry data," versioned so Semantic Conventions can evolve without breaking pinned consumers. | [Telemetry Schemas](https://opentelemetry.io/docs/specs/otel/schemas/) |

Note: the canonical glossary page does not itself define Resource, Baggage,
Sampler, or Context Propagation with standalone entries — those are defined
in their respective spec sections (Resource SDK spec, Baggage API spec,
Trace SDK spec, Context API spec) rather than the glossary. Treat the
glossary as authoritative only for the terms actually listed on it.

Source: https://opentelemetry.io/docs/specs/otel/glossary/

---

## 10. The spec compliance matrix — how to read it

The living source of truth for "does implementation X support feature Y" is:

**https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md**

Structure (do not copy the matrix itself — it changes frequently; always
link and re-fetch):

- **Rows** are individual spec requirements/features, grouped under section
  headers for the major component areas:
  1. **Traces** — TracerProvider ops, context interaction, Tracer ops,
     SpanContext, span creation/lifecycle, attributes, links, events,
     exceptions, sampling, ID generation.
  2. **Baggage** — basic support, header naming.
  3. **Metrics** — MeterProvider, Meter ops, instrument types, Views,
     aggregations, exemplars, cardinality limits.
  4. **Logs** — LoggerProvider, Logger ops, LogRecord handling, processors.
  5. **Resource** — creation, merging, detection.
  6. **Context Propagation** — Context management, composite propagators,
     standard propagators (TraceContext, B3, Jaeger, OpenCensus).
  7. **Environment Variables** — `OTEL_*` configuration knobs.
  8. **Declarative Configuration** — YAML-based SDK setup.
  9. **Exporters** — stdout, in-memory, OTLP, Zipkin, Prometheus
     compatibility.
- **Columns** are per-language implementations: Go, Java, JavaScript, Python,
  Ruby, Erlang, PHP, **Rust**, C++, .NET, Swift, Kotlin.
- **Legend:** `+` supported, `-` unsupported, `N/A` not applicable, blank =
  unknown/unreported. An **Optional** column marks features with `X` when a
  feature is optional rather than required — unmarked rows are required for
  a language to claim compliance.

**Caveats relevant to Maple's stack:**
- **Rust** has its own column (relevant to `apps/ingest`) — but note the
  matrix tracks *SDK/client* conformance (an implementation emitting
  telemetry), not *server/collector* conformance (accepting OTLP). Our
  ingest gateway is architecturally closer to an OTLP *receiver* than to any
  row in this matrix — the matrix doesn't directly grade us, but it's the
  right place to check what guarantees we can assume from Rust-instrumented
  services sending us data.
- **JavaScript** is the column that governs `@effect/opentelemetry`'s
  underlying `@opentelemetry/sdk-*` dependencies (apps/web, apps/api on
  Workers). There is no separate "Bun" column — Bun is a JS runtime, so it
  inherits the JavaScript column's conformance status; any Bun-specific gaps
  (e.g. Workers-runtime clock/timer quirks — see the `workerd-trace-timestamp-bug`
  memory entry) are Bun/workerd runtime bugs, not spec non-compliance, and
  won't show up in this matrix.
- The matrix is **self-reported per language SIG** and updated
  asynchronously from actual releases — treat a blank cell as "unverified,"
  not "unsupported."

Source: https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md

---

## 11. How Maple should use this spec

**(a) The ingest gateway as an OTLP server.** `apps/ingest` is not a client
SDK, so most of Sections 1–4 (API/SDK versioning obligations) don't bind us
directly. What does bind us:
- **Error-handling principles (Section 5) apply symmetrically to servers.**
  A malformed/oversized/undecodable payload from a misbehaving client must
  never crash the gateway — this is already implemented via the documented
  4xx-vs-5xx `otel_status_for_rejection` split (only 5xx sets span status to
  `Error`; auth/billing/throttle/payload 4xx rejections stay `Ok` but fully
  observable via `http.response.status_code`/`error.type`). That design *is*
  the fail-safe-defaults principle applied to a receiver role.
- **Performance/blocking guidance (Section 6)** governs the WAL + async
  forward design and the startup loopback guard — bounded memory and
  non-blocking behavior under load are exactly what the spec calls out.
- **Telemetry-shape stability (Section 8)** is why we must tolerate mixed
  old/new semantic conventions in inbound payloads indefinitely — clients
  are never obligated to be on the latest semconv, and "Stable" telemetry
  producers are largely frozen at whatever shape they shipped. Schema-URL
  coalescing (Section 8's mechanism) is the spec-sanctioned way to handle
  this, and is exactly what our materialized views already do by convention
  even though we don't yet key off literal `schema_url` values.

**(b) Our self-instrumentation.** When `apps/ingest`, `apps/api`, or any new
service adds tracing:
- Use **Instrumentation Scope naming** (Section 7) deliberately — one scope
  per logical component (e.g. `maple.ingest`, `maple.alerting`), not one
  global tracer, so the scope tuple is actually useful for filtering.
- New spans on hot/high-frequency paths must be justified against the
  performance guidance (Section 6) — non-blocking, bounded memory, and ideally
  covered by the existing `withTracerDisabledWhen` pattern for noisy paths.
  CLAUDE.md's explicit warning not to remove that filter, and to be careful
  adding spans to auth-token validation, is a direct application of Section 6.
- Any place we might swallow/re-throw telemetry-related errors should follow
  Section 5 exactly: log-and-continue, never propagate into request handling,
  never let OTLP export failures affect the response to the end user (already
  true today since export is async and bypasses the API entirely per
  CLAUDE.md).

**(c) The UI's interpretation of data.** The dashboard trusts specific
semconv-adjacent contracts as if they were part of the wire stability
guarantee (Section 1's fourth domain) — e.g., **span status codes** should be
title case (`"Ok"`, `"Error"`, `"Unset"`) per Maple's own data convention, and
error-rate dashboards filter strictly on `StatusCode='Error'`. Per Section 5's
"only 5xx is Error" SERVER-span rule, the UI's error dashboards are implicitly
depending on upstream instrumentations following that exact OTEL HTTP
semconv status-mapping rule. If an upstream SDK sets status to `Error` for a
4xx (a spec violation, or simply an older/nonconforming instrumentation), our
dashboards will over-count errors — this is a real spec-compliance risk
surface worth a validation/lint pass on ingest, not just a UI concern. More
generally: any dashboard heuristic that assumes "stable telemetry never
changes shape" (Section 8) is safe **only** for genuinely Stable, fixed-schema
producers — Alpha/Beta/Development-status instrumentations (the document
status ladder in Section 2) can and will change attribute names under us
without notice, and the UI/query layer should degrade gracefully (missing
attribute → omit facet, not crash) rather than assume presence.

---

## Key references

- Versioning and stability — https://opentelemetry.io/docs/specs/otel/versioning-and-stability/
- Document status (Development/Alpha/Beta/RC/Stable/Deprecated/Unmaintained) — https://opentelemetry.io/docs/specs/otel/document-status/
- Telemetry stability guarantees — https://opentelemetry.io/docs/specs/otel/telemetry-stability/
- Error handling principles — https://opentelemetry.io/docs/specs/otel/error-handling/
- Performance and blocking guidance — https://opentelemetry.io/docs/specs/otel/performance/
- Library guidelines (client design principles) — https://opentelemetry.io/docs/specs/otel/library-guidelines/
- Native instrumentation for libraries — https://opentelemetry.io/docs/concepts/instrumentation/libraries/
- Instrumentation Scope concept — https://opentelemetry.io/docs/concepts/instrumentation-scope/
- Telemetry Schemas — https://opentelemetry.io/docs/specs/otel/schemas/ and https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/schemas/README.md
- Glossary — https://opentelemetry.io/docs/specs/otel/glossary/
- Spec compliance matrix (living source, re-fetch before relying on cell values) — https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md
- Specification CHANGELOG (version history) — https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md
