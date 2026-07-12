# Semantic Conventions

OpenTelemetry Semantic Conventions ("semconv") define the common attribute names, span/metric naming rules, and per-domain required/recommended fields that give telemetry consistent meaning across languages, libraries, and vendors. They live in a single spec (currently **v1.43.0**) covering traces, metrics, logs, resources, and profiles, published from `github.com/open-telemetry/semantic-conventions` and rendered at `https://opentelemetry.io/docs/specs/semconv/`.

> **Relevance to Maple:** Maple is primarily a **consumer/backend** for OTel data — our ClickHouse/Tinybird schemas, dashboard UI, and query engine all key on semconv attribute names, so drift between "what the spec says" and "what our ingest/query layers expect" causes silent breakage (missing facets, wrong span-status coloring, unmatched filters). Our trace UI keys on `http.request.method`/`http.route`/`http.response.status_code`; our Rust ingest gateway (`apps/ingest`) emits new-semconv HTTP attributes and self-instruments per `service.name="ingest"` (see root `CLAUDE.md`); warehouse read paths alias legacy `db.statement`/`db.system` to `db.query.text`/`db.system.name` for spans recorded before the DB semconv stability migration; and per project convention our own span status values use **title case** (`"Ok"`, `"Error"`, `"Unset"`), matching the OTel API enum names rather than the lowercase wire values some SDKs historically emitted.

---

## General rules

### Attribute naming

Source: https://opentelemetry.io/docs/specs/semconv/general/naming/

- "Names SHOULD be lowercase" and use **namespacing**, delimited by a dot character (e.g. `http.response.status_code` is the `status_code` attribute in the `http` namespace, itself nested under `http.response`).
- Multi-word components within a dot-delimited segment use **snake_case** (`status_code`, not `statusCode` or `status-code`).
- Character rules: names must be a valid Unicode sequence restricted to printable Basic Latin; tooling further limits to lowercase Latin letters, digits, underscore, and dot; names **must start with a letter, end with an alphanumeric character**, and must not contain two or more consecutive delimiters.
- Pluralization: singular for single-valued attributes (`host.name`), plural for array-valued attributes (`process.command_args`).
- Custom/vendor attributes outside the registry should be namespaced under a reverse-DNS-style prefix (e.g. `com.acme.shopname.*`) to avoid collisions with future registry additions.
- Metric names additionally: namespaces and metric names generally **SHOULD NOT be pluralized** (`system.process.count`, not `system.processes`); counters/up-down counters **SHOULD NOT** append `_total`; units follow UCUM (Unified Code for Units of Measure), preferring un-prefixed units (`By` not `MiBy`) and `s` for durations, with bracketed annotations matching grammatical number (`{request}` not `{requests}`).

### Attribute requirement levels

Source: https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/

| Level | Definition |
|---|---|
| **Required** | "All instrumentations MUST populate the attribute." Expected to be efficiently available in the vast majority of cases. |
| **Conditionally Required** | "All instrumentations MUST populate the attribute when the given condition is satisfied." The convention must spell out the triggering condition. |
| **Recommended** | "Instrumentations SHOULD add the attribute by default if it's readily available and can be efficiently populated." May be disabled for perf/security/privacy reasons. |
| **Opt-In** | "Instrumentations SHOULD populate the attribute if and only if the user configures the instrumentation to do so." Reserved for expensive-to-collect or privacy/security-sensitive fields. |

### Span naming

Source: https://opentelemetry.io/docs/specs/otel/trace/api/ (core span-naming rule, part of the tracing API spec that semconv domains implement against)

- "The span name SHOULD be the most general string that identifies a (statistically) interesting class of Spans, rather than individual Span instances" — i.e. **low cardinality is mandatory**. `get_user` is a good name; `get_user/314159` (embedding a user ID) is not.
- Generality is prioritized over human-readability when the two conflict.
- Each domain gives its own concrete template (e.g. HTTP: `{method} {route}`; DB: `{db.query.summary}` or `{db.operation.name} {target}`; see domain sections below) — always built from low-cardinality attribute values, never from raw high-cardinality identifiers (full URLs, raw SQL literals, IDs).

### Recording errors / span status

Source: https://opentelemetry.io/docs/specs/semconv/general/recording-errors/

- "Span Status Code MUST be left unset if the instrumented operation has ended without any errors." Only set `Error` on genuine failures.
- When an operation fails: set span status to `Error` and set `error.type`; an optional status description can add detail but shouldn't just repeat the status code or error type.
- `error.type` must be applied **consistently** between a span and its corresponding metric for the same operation: same value if failed, absent if succeeded.
- Errors that were retried/handled internally (the operation still completes successfully) **SHOULD NOT** be recorded as errors on the span/metric describing that operation.

### Stability levels

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/

OpenTelemetry signals (including semconv domains) move through a lifecycle:

| Level | Meaning |
|---|---|
| **Development** | May have breaking changes; "Long-term dependencies SHOULD NOT be taken against signals in Development." |
| **Stable** | Backward compatibility guaranteed; safe to build long-term dependencies against. |
| **Deprecated** | Being phased out; "Signals MUST NOT be marked as deprecated unless the replacement is stable." Same support guarantees as stable until removed. |
| **Removed** | No longer supported; removal requires a major version bump. |

Per-domain stability (see each section below): **HTTP is Stable**; **Database is Stable** (as of the v1.30-era stability migration); **Messaging is Development**; **RPC is Release Candidate**; **Exceptions**-as-span-events is **Deprecated** in favor of exceptions-on-logs; **Code attributes are Stable**; **General attributes (`server.*`, `client.*`, `network.*`, `url.*`) are Stable** (a handful of derived `url.*` sub-attributes remain Development); **Gen-AI is Development** and has moved to a separate spec repo.

### The `OTEL_SEMCONV_STABILITY_OPT_IN` migration pattern

Source: https://opentelemetry.io/docs/specs/semconv/non-normative/http-migration/ · https://opentelemetry.io/docs/specs/semconv/non-normative/db-migration/

When a domain graduates from experimental to stable, its attribute names/values often change (e.g. `http.method` → `http.request.method`). Because this breaks dashboards/alerts built on the old names, instrumentations expose an env var so users can migrate on their own schedule instead of the instrumentation silently flipping conventions:

- **HTTP** (`OTEL_SEMCONV_STABILITY_OPT_IN`): `http` = emit only the new stable HTTP/network conventions; `http/dup` = emit **both** old and new (phased rollout); unset/default = keep emitting whatever the instrumentation emitted before.
- **Database**: same three-way shape with values `database` / `database/dup` / default.
- **Gen-AI**: `gen_ai_latest_experimental` opts into the newest experimental gen-ai shape instead of the pre-1.36.0 one; default keeps emitting whatever version was previously emitted.
- Constraint: this variable is "only intended to be used when migrating from an experimental semantic convention to its initial stable version" — not a general-purpose versioning knob. Instrumentations must support the `/dup` dual-emit mode for **at least six months** after introducing it, within their current major version, before dropping the old shape in a subsequent major version.
- Exceptions have an analogous but distinct variable, `OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN` (`logs` / `logs/dup` / default) — see the Exceptions section.

### Schema URLs & telemetry schemas

Source: https://opentelemetry.io/docs/specs/otel/schemas/

- A **Schema URL** identifies a specific version of a telemetry schema and is the address from which the schema file can be fetched: `http[s]://server[:port]/path/<version>`. The portion before the version is the **Schema Family** identifier, stable across all versions in that family.
- OTLP carries `schema_url` at the `Resource*` message level and at the `InstrumentationScope`/instrumentation-library level; when both are present, the scope-level one takes precedence for that scope's data.
- Purpose: semantic conventions evolve (attributes get renamed, e.g. `http.method` → `http.request.method`, or `deployment.environment` → `deployment.environment.name`); a schema file formally declares the transformation rules needed to convert telemetry between schema versions, so a consumer that knows the schema version of incoming data (via `schema_url`) can mechanically rewrite it to the version its dashboards/alerts expect, instead of every consumer hand-rolling compatibility shims.
- The schema file format itself is versioned separately (`file_format_v1.0.0`, `file_format_v1.1.0`) from the schema content it describes.

### The semconv registry

Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/ · https://github.com/open-telemetry/semantic-conventions

- The **attribute registry** (`/docs/specs/semconv/registry/attributes/`) is an auto-generated, searchable/browsable catalog of every registered attribute, organized by namespace (`http.*`, `db.*`, `network.*`, `code.*`, …), each with type, stability, and description — this is the fastest way to check an attribute's current name/stability without reading the full domain spec.
- The registry and all domain specs are generated from YAML model definitions in `github.com/open-telemetry/semantic-conventions` (the source of truth); the rendered docs on opentelemetry.io are a build artifact of that repo. Gen-AI conventions have since split out into their own sibling repo, `github.com/open-telemetry/semantic-conventions-genai` (see Gen-AI section).

---

## HTTP

**Stability: Stable** (both client and server spans/metrics).
Source: https://opentelemetry.io/docs/specs/semconv/http/http-spans/ · https://opentelemetry.io/docs/specs/semconv/http/http-metrics/

### Span name

`{method} {target}` when a low-cardinality target is known, else just `{method}`. `{method}` is `http.request.method` if known, else the literal string `HTTP`. Server spans use `http.route` as `{target}`; client spans may use `url.template`. **"Instrumentation MUST NOT default to using URI path as a `{target}`"** (path segments are high-cardinality).

### Required / Conditionally Required attributes

| Attribute | Level | Client / Server | Notes |
|---|---|---|---|
| `http.request.method` | Required | Both | GET, POST, HEAD, … |
| `server.address` | Required | Client | Domain/IP/socket the request targets |
| `server.port` | Required | Client | — |
| `url.full` | Required | Client | Absolute URL, RFC3986; credentials MUST be redacted |
| `url.path` | Required | Server | URI path component |
| `url.scheme` | Required | Server | `http`/`https` |
| `http.response.status_code` | Cond. Required | Both | If a response was received/sent |
| `error.type` | Cond. Required | Both | If the request ended in error |
| `network.protocol.name` | Cond. Required | Both | If not `http` and version is set |
| `http.route` | Cond. Required | Server | If available; must be low-cardinality (static segments + placeholders) |
| `server.port` | Cond. Required | Server | If available and `server.address` set |
| `url.query` | Cond. Required | Server | If a query string was present |

### Span status mapping (the important compliance rule)

- **1xx/2xx/3xx**: leave span status **unset**, unless another error occurred (network failure, redirect-limit exceeded) — then `Error`.
- **4xx**: **SERVER** spans leave status **unset** (client errors aren't the server's fault); **CLIENT** spans **SHOULD** be set to `Error`.
- **5xx**: `Error` for **both** client and server spans, plus `error.type` set.
- Intentionally cancelled client requests (caller-initiated) should **not** be treated as errors.

This asymmetry (4xx = Ok for SERVER, Error for CLIENT) is the single most load-bearing rule for anyone building error-rate dashboards — filtering `StatusCode = 'Error'` on server spans will correctly exclude client 4xx noise, but the same filter on client spans will correctly include it.

### Retries/resends

Each client resend (redirect, auth failure, 5xx, network error — cause doesn't matter) increments `http.request.resend_count`, set to the ordinal number of the resend attempt.

### Metrics (Stable)

| Metric | Type | Unit | Stability | Required attrs |
|---|---|---|---|---|
| `http.server.request.duration` | Histogram | `s` | Stable | `http.request.method`, `url.scheme` |
| `http.client.request.duration` | Histogram | `s` | Stable | `http.request.method`, `server.address`, `server.port` |
| `http.server.active_requests` | UpDownCounter | `{request}` | Development | Opt-in |
| `http.{server,client}.{request,response}.body.size` | Histogram | `By` | Development | Opt-in |

When reported alongside a span, the duration metric value **SHOULD** equal the span's duration.

> **Maple hook:** our trace UI keys directly on `http.request.method` / `http.route` / `http.response.status_code`; the SERVER-4xx-is-Ok rule above is exactly what our error-rate widgets assume when they filter on span status.

---

## Database

**Stability: Stable** (as of the DB semconv stability migration; pre-migration instrumentations used `OTEL_SEMCONV_STABILITY_OPT_IN=database`/`database/dup` to move over — see General rules above).
Source: https://opentelemetry.io/docs/specs/semconv/db/database-spans/ · https://opentelemetry.io/docs/specs/semconv/db/database-metrics/ · https://opentelemetry.io/docs/specs/semconv/non-normative/db-migration/

The stable migration renamed `db.system` → `db.system.name` (and `db.statement` → `db.query.text`), and changed many enum values to a `<vendor>.<product>` pattern.

### Span name

Priority order:
1. `{db.query.summary}` if available
2. `{db.operation.name} {target}` if a low-cardinality operation name is available
3. `{target}` alone
4. `{db.system.name}` as the final fallback

Where `{target}` prefers, in order: `db.collection.name` → `db.stored_procedure.name` → `db.namespace` → `server.address:server.port`.

### Required / Conditionally Required attributes

| Attribute | Level | Notes |
|---|---|---|
| `db.system.name` | Required | DBMS product identifier (e.g. `postgresql`, `clickhouse`) |
| `db.collection.name` | Cond. Required | If readily available and the operation targets a single collection |
| `db.namespace` | Cond. Required | If available |
| `db.operation.name` | Cond. Required | If readily available and describes a single operation |
| `db.response.status_code` | Cond. Required | If the operation failed and a code is available |
| `error.type` | Cond. Required | If and only if the operation failed |
| `server.port` | Cond. Required | If a non-default port is used and `server.address` is set |

### `db.query.text` sanitization

- Raw (non-parameterized) query text should only be collected **if sanitized to exclude sensitive info** — literals replaced with a placeholder (e.g. `?`).
- **"Parameterized query text SHOULD NOT be sanitized."** Using parameters is itself a strong signal from the application that sensitive values are passed out-of-band as parameters, not embedded in the query text.
- IN-clauses may be collapsed for cardinality control (`IN (?, ?, ?, ?)` → `IN (?)`).

### Span status

Follows the general Recording Errors doc; each system-specific DB convention should specify which `db.response.status_code` values count as errors.

### Metrics

| Metric | Type | Unit | Stability |
|---|---|---|---|
| `db.client.operation.duration` | Histogram | `s` | **Stable** |
| `db.client.response.returned_rows` | Histogram | `{row}` | Development |
| `db.client.connection.*` (pool size, idle, pending, timeouts, create/wait/use time) | Counter/UpDownCounter/Histogram | varies | Development |

Batch operations **SHOULD** be recorded as a single operation (not one metric event per row/statement).

> **Maple hook:** warehouse read paths in `WarehouseQueryService` coalesce both the legacy (`db.statement`, `db.system`) and stable (`db.query.text`, `db.system.name`) spellings, since spans recorded before our own migration still carry the legacy names — mirrors exactly the dual-emit window the spec expects instrumentations to support.

---

## Messaging

**Stability: Development** (not yet stable — per the spec, existing instrumentations on v1.24.0-era conventions should not change what they emit by default until this stabilizes).
Source: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/

### Span name

`{messaging.operation.name} {destination}`, where `{destination}` prefers `messaging.destination.template` (low-cardinality template) → `messaging.destination.name` (for known, non-temporary destinations) → `server.address:server.port` (only when no specific destination is targeted).

### Required / Conditionally Required attributes

| Attribute | Level | Notes |
|---|---|---|
| `messaging.system` | Required | e.g. `kafka`, `rabbitmq`, `aws_sqs` |
| `messaging.operation.name` | Required | System-specific operation name (`send`, `publish`, `poll`, …) |
| `messaging.operation.type` | Cond. Required | One of `create`/`send`/`receive`/`process`/`settle` |
| `messaging.destination.name` | Cond. Required | Single-message ops, or batch ops with a uniform destination |
| `messaging.batch.message_count` | Cond. Required | Batch operations |
| `messaging.consumer.group.name` | Cond. Required | If applicable to the system |
| `error.type` | Cond. Required | If the operation failed |

### Span kind by operation type

| Operation | Span kind |
|---|---|
| `create` | PRODUCER |
| `send` | PRODUCER (if the created context is used) or CLIENT |
| `receive` | CLIENT |
| `process` | CONSUMER |
| `settle` | CLIENT |

Status follows the general Recording Errors doc; don't set `error.type` on success.

---

## RPC

**Stability: Release Candidate** (near-stable; minor changes possible before final release).
Source: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/

### Span name

`{rpc.method}` if known and not `_OTHER`; else falls back to `{rpc.system.name}`.

### Required / Conditionally Required attributes

| Attribute | Level | Notes |
|---|---|---|
| `rpc.system.name` | Required | `grpc`, `dubbo`, `connectrpc`, `jsonrpc`, … (client/server systems may legitimately differ for the same call) |
| `rpc.method` | Cond. Required | If available; unrecognized methods **MUST** be set to `_OTHER`, with the original value preserved in `rpc.method_original` |
| `error.type` | Cond. Required | On failure |
| `rpc.response.status_code` | Cond. Required | If available (supersedes the old `rpc.grpc.status_code`) |
| `server.address` / `server.port` | Cond. Required | If available |

---

## Exceptions

**Stability: the span-event form is Deprecated; the log-record form is the current Stable recommendation.**
Source: https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/ · https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/

- Recording exceptions as **span events** (event name `exception`) is deprecated: "Use Semantic conventions for exceptions in logs instead." `exception.escaped` is likewise deprecated — "It's no longer recommended to record exceptions that are handled and do not escape the scope of a span."
- The current guidance: exceptions **SHOULD be recorded as attributes on the LogRecord** passed to `Logger` emit operations, not as span events.
- Migration is gated by `OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN`: `logs` = emit as logs only; `logs/dup` = emit both span events and logs during a phased rollout; default = keep emitting span events. Even after an instrumentation moves to logs-only emission, "users will still have the option to route those to span events at the SDK layer."
- Attributes (same names/semantics in both forms):

| Attribute | Level | Notes |
|---|---|---|
| `exception.type` | Cond. Required | Fully-qualified exception class name; required if `exception.message` unset |
| `exception.message` | Cond. Required | Required if `exception.type` unset; may contain sensitive data |
| `exception.stacktrace` | Recommended | Natural stack-trace string for the language runtime |

- Instrumentations **should not** record artificial/synthetic exceptions manufactured by a framework purely to represent an error status code.

---

## Code

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/ · https://opentelemetry.io/docs/specs/semconv/non-normative/code-attrs-migration/

| Attribute | Description |
|---|---|
| `code.function.name` | Fully-qualified function/method name **without arguments**, in the natural representation for the language runtime |
| `code.file.path` | Source file identifying the code unit as uniquely as possible (prefer absolute path) |
| `code.line.number` | Line in `code.file.path` best representing the operation; should point within the unit named by `code.function.name` |
| `code.column.number` | Column in `code.file.path`, same "should point within" constraint |
| `code.stacktrace` | Stack trace string in the language's natural representation; identical semantics to `exception.stacktrace` |

Note: as of the v1.29.0 → v1.33.0 migration, the older separate `code.namespace` and `code.function` attributes were folded into the single `code.function.name` (which now carries the fully-qualified name). All `code.*` attributes are disallowed on Profile signals (redundant with data profiling already captures).

---

## Network, URL, Server, Client (general attributes)

**Stability: Stable** for the attributes below (a few derived `url.*` sub-attributes are still Development, noted inline).
Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/network/ · https://opentelemetry.io/docs/specs/semconv/registry/attributes/url/ · general attribute registry

### `server.*` / `client.*`

| Attribute | Description |
|---|---|
| `server.address` | Server domain name if resolvable without a reverse DNS lookup, else IP/socket. When observed client-side through an intermediary (proxy), **SHOULD** represent the real server behind it, if known |
| `server.port` | Server port; same "behind the intermediary" preference as `server.address` |
| `client.address` | Client address as observed by the server (may itself be a proxy) |
| `client.port` | Client port as observed by the server |

### `network.*`

| Attribute | Description |
|---|---|
| `network.protocol.name` | OSI application layer or non-OSI equivalent (e.g. `http`, `amqp`); lowercase-normalized |
| `network.protocol.version` | Actual (post-negotiation) protocol version in use |
| `network.transport` | OSI transport layer / IPC method; lowercase-normalized |
| `network.type` | OSI network layer or non-OSI equivalent; lowercase-normalized |
| `network.peer.address` / `network.peer.port` | Peer (remote) address/port of the connection |
| `network.local.address` / `network.local.port` | Local address/port of the connection |
| `network.io.direction` | `transmit`/`receive`, from the observing host's perspective (Release Candidate) |

Guidance: "Consider always setting the transport when setting a port number, since a port number is ambiguous without knowing the transport."

### `url.*`

| Attribute | Stability | Description |
|---|---|---|
| `url.scheme` | Stable | `https`, `ftp`, … |
| `url.full` | Stable | Absolute URL (RFC3986); **MUST NOT** contain credentials; sensitive query params (`X-Amz-Signature`, `sig`, `X-Goog-Signature`, …) should be redacted |
| `url.path` | Stable | URI path component; scrub sensitive content |
| `url.query` | Stable | URI query component; same default redaction list as `url.full` |
| `url.fragment` | Stable | URI fragment |
| `url.template` | Development | Low-cardinality path template, e.g. `/users/{id}` |
| `url.domain`, `url.port`, `url.registered_domain`, `url.subdomain`, `url.top_level_domain`, `url.extension` | Development | Derived sub-components parsed out of `url.full` |
| `url.original` | Development | Unmodified original URL as seen at the source; may retain credentials (unlike `url.full`) |

> **Maple hook:** these are the backbone of the HTTP domain above — our trace UI and ingest gateway's "new-semconv HTTP attributes" are built directly on `server.address`/`server.port`/`network.protocol.*`/`url.*` alongside `http.*`.

---

## Gen-AI

**Stability: Development.** Note: gen-ai semantic conventions **moved out of the main spec** into a dedicated repository, `github.com/open-telemetry/semantic-conventions-genai` (the `opentelemetry.io/docs/specs/semconv/gen-ai/` pages now redirect/point there).
Source: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md

### Span name

- Inference spans: `{gen_ai.operation.name} {gen_ai.request.model}`
- Retrieval spans: `{gen_ai.operation.name} {gen_ai.data_source.id}`
- Individual GenAI systems/frameworks may define their own span-name format.

### Required / Conditionally Required attributes

| Attribute | Level | Notes |
|---|---|---|
| `gen_ai.operation.name` | Required | e.g. `chat`, `embeddings`, `retrieval` |
| `gen_ai.provider.name` | Required | Provider identifier, e.g. `openai`, `anthropic`, `gcp.vertex_ai` (supersedes the deprecated `gen_ai.system`) |
| `gen_ai.request.model` | Cond. Required | If available |
| `gen_ai.response.model` | Cond. Required | If available; the actual model that served the response (may differ from the requested one) |
| `gen_ai.usage.input_tokens` | Recommended | — |
| `gen_ai.usage.output_tokens` | Recommended | — |
| `error.type` | Cond. Required | Should match the provider's/client library's error code |

Span kinds covered by the spec include Inference, Embeddings, Retrieval, Memory, and Execute-Tool spans. Migration is gated by `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` (opt into the newest experimental shape) vs. default (keep emitting whatever pre-1.36.0 shape was already in use) — the spec notes this transition plan will gain a genuine stable value once gen-ai conventions themselves stabilize.

> **Maple hook:** relevant to our AI features — treat `gen_ai.*` as Development/pre-stable, expect attribute churn (`gen_ai.system` → `gen_ai.provider.name` already happened), and don't hard-code assumptions about the current attribute set without checking the genai repo for the version in use.

---

## Key references

- Semconv spec home (v1.43.0): https://opentelemetry.io/docs/specs/semconv/
- Attribute registry (searchable): https://opentelemetry.io/docs/specs/semconv/registry/attributes/
- Naming rules: https://opentelemetry.io/docs/specs/semconv/general/naming/
- Attribute requirement levels: https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/
- Recording errors (span status): https://opentelemetry.io/docs/specs/semconv/general/recording-errors/
- Tracing API span-naming rule: https://opentelemetry.io/docs/specs/otel/trace/api/
- Versioning & stability levels: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/
- Telemetry schemas: https://opentelemetry.io/docs/specs/otel/schemas/
- HTTP spans: https://opentelemetry.io/docs/specs/semconv/http/http-spans/ · HTTP metrics: https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
- HTTP stability migration guide: https://opentelemetry.io/docs/specs/semconv/non-normative/http-migration/
- Database spans: https://opentelemetry.io/docs/specs/semconv/db/database-spans/ · DB metrics: https://opentelemetry.io/docs/specs/semconv/db/database-metrics/
- DB stability migration guide: https://opentelemetry.io/docs/specs/semconv/non-normative/db-migration/
- Messaging spans: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- RPC spans: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
- Exceptions (spans, deprecated form): https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/ · Exceptions (logs, current form): https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/
- Code attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/
- Network attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/network/ · URL attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/url/
- Gen-AI spans (moved repo): https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- Source of truth (YAML model + all specs): https://github.com/open-telemetry/semantic-conventions
