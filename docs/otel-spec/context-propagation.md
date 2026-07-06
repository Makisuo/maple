# Context, Baggage & Propagation

This page covers the OpenTelemetry **Context** abstraction, the **Baggage** API and its W3C wire
format, and the **Propagators API** (W3C TraceContext primary; B3/Jaeger at reference level). It is
part of the internal OTel spec reference used for spec-compliance checks and the best-practices
skill. Every section links to its normative source — verify against the source, not this summary,
before treating anything here as authoritative for a compliance decision.

> **Stability at a glance:** Context API — Stable. Propagators API — Stable (a few per-language
> details, e.g. `GetAll`, are pre-stable). Baggage API — Stable. W3C Trace Context — W3C
> Recommendation (normative, versioned `00`). W3C Baggage — W3C Editor's Draft / Candidate
> Recommendation track (not yet a final REC as of this writing — treat as stable-in-practice but
> re-check status). OTel `tracestate` handling (the `ot=` vendor key, consistent probability
> sampling `th`/`rv`) — **Development** (not stable) at the OTel-spec level.

## Relevance to Maple

- Maple's Rust ingest gateway (`apps/ingest`) is primarily an **OTLP receiver**, not an HTTP
  trace-context propagator: incoming spans already carry `TraceId` / `SpanId` / `ParentSpanId` /
  `TraceState` as OTLP fields (populated upstream by the *sending* SDK's propagator before OTLP
  export), and these are inserted verbatim into ClickHouse/Tinybird (see
  `apps/ingest/src/clickhouse_insert_mappings.rs`, columns `TraceId`, `SpanId`, `ParentSpanId`,
  `TraceState`). Maple does not need to parse a `traceparent` HTTP header to ingest span data.
- Where W3C TraceContext propagation *does* apply directly to Maple: the ingest gateway's own
  **self-instrumentation** (`apps/ingest` exports its own OTLP traces per
  `docs/otel-spec/context-propagation.md`'s sibling doc on self-observability — see root
  `CLAUDE.md` "Self-Observability" section) and any outbound HTTP calls the API/web app makes that
  should carry a live `Context` (e.g. `warehouse.sqlQuery` spans, Hyperdrive calls) rely on
  `@effect/opentelemetry`'s context propagation, which implements this spec under the hood.
  `service.name`, `deployment.environment.name`, etc. are Resource attributes, not part of Context
  propagation, but they ride the same OTel SDK plumbing.
- Because Maple is a **backend/consumer of arbitrary customer OTLP**, expect payloads whose
  `TraceId` came from a variety of upstream propagators (W3C, but also legacy B3/Jaeger bridged by
  some customer collectors). The ingest gateway should treat a **128-bit** `TraceId` and a
  **64-bit** `SpanId`/`ParentSpanId` as the canonical OTel shapes; anything shorter (e.g. a 64-bit
  B3 trace ID zero-padded to 128 bits) is a valid *interop* case, not a data error — see
  [B3/Jaeger interop notes](#b3-and-jaeger-reference-level) below.
- `Baggage` is orthogonal to span data: **baggage entries do not automatically become span
  attributes**. If Maple ever wants baggage values (e.g. a customer's `user.id` propagated via
  baggage) to show up as searchable span/log attributes, an explicit "baggage → span attribute"
  bridge (a processor) is required — this is not implicit OTel behavior. Useful to know when
  triaging "why isn't this baggage key showing up as a facet" questions.
- The W3C `tracestate` field is captured today (`TraceState` column, `LinksTraceState` for span
  links) but Maple does not currently parse or act on the OTel `ot=` sampling sub-keys (`th`, `rv`)
  — that spec area is explicitly **Development**/unstable upstream, so there's no compliance
  expectation to implement it yet. Worth revisiting if/when OTel's consistent probability sampling
  spec stabilizes and Maple wants cross-service consistent sampling.

---

## Context

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/context/

`Context` is defined as "a propagation mechanism which carries execution-scoped values across API
boundaries and between logically associated execution units." It underlies both distributed trace
propagation (via `SpanContext`) and Baggage propagation, but is a general-purpose mechanism — any
cross-cutting concern can ride in `Context`.

### Immutability

> A `Context` **MUST** be immutable, and its write operations **MUST** result in the creation of a
> new `Context` containing the original values and the specified values updated.

A "write" (`SetValue`) never mutates the context you started with; it returns a new `Context`
layered on top of the old one. This is why context propagation composes safely across concurrent
call stacks — nobody can retroactively change a `Context` another goroutine/task/fiber already
captured.

### Core operations

| Operation | Signature (conceptual) | Notes |
|---|---|---|
| `CreateKey` | `(name: string) -> Key` | `name` is for debugging only. "Multiple calls to `CreateKey` with the same name SHOULD NOT return the same value unless language constraints dictate otherwise" — keys are unforgeable/opaque, not string-keyed maps. |
| `GetValue` | `(context, key) -> value` | Read-only lookup against a given `Context`. |
| `SetValue` | `(context, key, value) -> Context` | Returns a **new** `Context`; does not mutate the input. |

### Implicit-context operations (languages with implicit/ambient context, e.g. via thread-locals or async-local storage)

| Operation | Purpose |
|---|---|
| `Get Current Context` | Returns the `Context` associated with the current execution unit. |
| `Attach` | Associates a given `Context` with the current execution unit; returns a **token** for later restoration. |
| `Detach` | Resets the current context using the token returned by `Attach`; implementations are expected to be able to signal incorrect call ordering (e.g. detaching out of order/detaching twice). |

Attach/detach is explicitly a stack-like discipline: detach with the token you got from the
matching attach, not just "restore to whatever was current a moment ago" — misuse (double-detach,
out-of-order detach) is something implementations may — and are encouraged to — detect and signal.

---

## Propagators API

**Stability: Stable** (except where a language explicitly marks a piece, e.g. `GetAll`, as
pre-stable).
Source: https://opentelemetry.io/docs/specs/otel/context/api-propagators/

The Propagators API is how a `Context` (specifically, the active `SpanContext` and `Baggage`)
crosses a wire. It is deliberately format-agnostic; `TextMapPropagator` is the concrete shape used
for HTTP-style string-keyed carriers.

### `TextMapPropagator`

| Method | Contract |
|---|---|
| `Fields(carrier)` | Returns the list of propagation field/header names this propagator uses for a given carrier type — lets a caller pre-clear those fields before re-injecting into a reused carrier ("If your carrier is reused, you should delete the fields here before calling Inject"). |
| `Inject(context, carrier, setter?)` | Writes values from `context` into `carrier` using `setter`. |
| `Extract(context, carrier, getter?)` | Reads values from `carrier`, returns a **new** `Context` (per Context's immutability rule) with the extracted values layered on top of the passed-in `context`. **On parse failure, the implementation MUST NOT throw and MUST NOT store a new value** — i.e., extraction failures degrade to a no-op, they never crash the caller or poison the context. |

### `Setter` / `Getter` carrier interfaces

- **Setter.Set(carrier, key, value)** — writes one field into the carrier. Implementations
  "SHOULD preserve casing" for case-insensitive protocols like HTTP headers (don't rewrite
  `Traceparent` to `traceparent`, etc., gratuitously).
- **Getter.Get(carrier, key)** — returns the first value for `key`, or null/absent if not present;
  for HTTP-like carriers this "MUST be case insensitive."
- **Getter.Keys(carrier)** — returns all keys in the carrier; enables prefix/pattern-based
  extraction (the doc calls out B3's `X-B3-*` family as the motivating example).
- **Getter.GetAll(carrier, key)** — returns *all* values for a repeated key, in original order
  (relevant for headers that can legitimately repeat). Noted as pre-stable in some language
  implementations.

Both Setter and Getter "MUST be stateless and allowed to be saved as constants" — they carry no
per-call state, so a single shared instance is safe to reuse across concurrent injects/extracts.

### Composite Propagator

Multiple `TextMapPropagator`s can be combined into one composite propagator. The composite runs
its constituent propagators **in the order they were specified**, for both `Inject` and `Extract`
— order matters (e.g., running `tracecontext` before `baggage` vs. after can matter if propagators
interact with the same carrier keys, though in the common case they touch disjoint headers).

### Global propagator registration

The API defines a way to get/set a process-wide default propagator. Per spec, implementations
"MUST use no-op propagators unless explicitly configured otherwise" — propagation is opt-in by
default at the raw-API level; SDKs, not the bare API, are what typically wire up sane defaults.
Language/framework integration guidance (e.g. ASP.NET) suggests defaulting to a composite of W3C
TraceContext + W3C Baggage.

### `OTEL_PROPAGATORS` environment variable

Source: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/

| Env var | Description | Default |
|---|---|---|
| `OTEL_PROPAGATORS` | Comma-separated list of propagators to register, composited together | `tracecontext,baggage` |

| Value | Propagator | Status |
|---|---|---|
| `tracecontext` | W3C Trace Context | Stable |
| `baggage` | W3C Baggage | Stable |
| `b3` | B3 Single header | — |
| `b3multi` | B3 Multi header | — |
| `jaeger` | Jaeger `uber-trace-id` | **Deprecated** |
| `xray` | AWS X-Ray (third-party format) | — |
| `ottrace` | OT Trace | **Deprecated** |
| `none` | No automatically configured propagator | — |

Values **MUST be deduplicated** so a propagator is only registered once even if named twice (or
implied twice by other config).

### Propagators distribution

Source: https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution

- **Core/mandatory packages:** W3C TraceContext, W3C Baggage, B3.
- **Additional/optional packages:** Jaeger (Deprecated), OT Trace (Deprecated), OpenCensus
  BinaryFormat.
- Vendor-specific propagator formats "MUST NOT be maintained or distributed as part of the
  OpenTelemetry Core packages" — they live in contrib/vendor repos instead.

---

## W3C Trace Context — `traceparent`

**Status: W3C Recommendation** (normative wire format). Version field in this spec assumes `00`.
Source: https://www.w3.org/TR/trace-context/#traceparent-header

### Grammar (§3.2, ABNF)

```
HEXDIGLC      = DIGIT / "a" / "b" / "c" / "d" / "e" / "f"
value         = version "-" version-format
version       = 2HEXDIGLC
version-format = trace-id "-" parent-id "-" trace-flags
trace-id      = 32HEXDIGLC   ; 16 bytes
parent-id     = 16HEXDIGLC   ; 8 bytes
trace-flags   = 2HEXDIGLC    ; 1 byte
```

Example: `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`

### Field-by-field

| Field | Size | Encoding | Invalid value | On invalid, receiver behavior |
|---|---|---|---|---|
| `version` | 1 byte | 2 lowercase hex digits | `ff` is explicitly forbidden | Reject/ignore the header |
| `trace-id` | 16 bytes | 32 lowercase hex chars | All-zero (`00000000000000000000000000000000`) | Invalid — vendors **must ignore** a `traceparent` with an invalid trace-id (i.e., treat as if no `traceparent` was received; start a new trace) |
| `parent-id` (a.k.a. span-id) | 8 bytes | 16 lowercase hex chars | All-zero (`0000000000000000`) | Invalid — same treatment: ignore the header |
| `trace-flags` | 1 byte | 2 lowercase hex digits | — (all 256 bit-patterns are structurally valid) | Only the least-significant bit is currently defined |

### Sampled flag (§3.2.2.5.1... i.e. the trace-flags LSB)

> When set, the least significant bit (right-most), denotes that the caller may have recorded
> trace data.

This is **not** a command ("you must sample") — it communicates the upstream's own recording
decision so downstream participants can make consistent joint decisions, but each vendor's sampler
still owns its own decision. All other trace-flags bits are reserved for future use and MUST be set
to `0` by a conforming producer that doesn't understand them (don't invent bit meanings).

### Version handling (§3.3 "Versioning of traceparent")

- `version = ff` is invalid outright.
- If a receiver sees a **higher** version number than it knows about, it MUST still try to parse
  the fields it understands from a version-`00`-shaped payload: parse `trace-id` as the 32 hex
  chars after the first dash, `parent-id` as the next 16 hex chars, and the sampled bit from the
  `trace-flags` byte that follows — then ignore any additional trailing fields the newer version
  might append.
  - If the header is shorter than the minimum length required to contain those three fields
    (roughly, under ~55 characters for the version-00 shape), the receiver should not attempt to
    parse it and should restart the trace (treat as if absent) rather than guess.
- When forwarding an unknown-version header onward, unknown/未定义 flag bits must be reset to zero
  on the outgoing request (don't blindly forward bits you don't understand as if you understood
  them).

### Practical MUSTs for an ingest gateway

- Reject (treat as absent / start fresh) a `traceparent` whose `trace-id` or `parent-id` is
  all-zero — these are the two explicitly normative "invalid value" cases.
- Never throw on a malformed `traceparent` — per the Propagators API contract, extraction failure
  degrades to "no context extracted," not an exception.
- Preserve `trace-flags` bits you don't understand as `0` when re-emitting, don't round-trip
  garbage bits.

---

## W3C Trace Context — `tracestate`

**Status: W3C Recommendation.**
Source: https://www.w3.org/TR/trace-context/#tracestate-header

### Grammar (§3.3, ABNF)

```
list         = list-member 0*31( OWS "," OWS list-member )
list-member  = (key "=" value) / OWS ; allows empty list-members
key          = simple-key / multi-tenant-key
simple-key   = lcalpha 0*255( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
multi-tenant-key = tenant-id "@" system-id
tenant-id    = ( lcalpha / DIGIT ) 0*240( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
system-id    = lcalpha 0*13( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
lcalpha      = %x61-7A ; a-z
value        = 0*255(chr) nblk-chr
nblk-chr     = %x21-2B / %x2D-3C / %x3E-7E
chr          = %x20 / nblk-chr
```

### Key rules

| Key form | Format | Purpose |
|---|---|---|
| Simple key | lowercase alphanum + `_ - * /`, ≤256 chars | Single-tenant vendor identifier, e.g. `congo` |
| Multi-tenant key | `tenant-id@system-id` | Lets a multi-tenant vendor (`system-id`) namespace by `tenant-id` so lookups can jump straight to `@system-id` |

### Value rules

Opaque, printable-ASCII (`0x20`–`0x7E`), **excluding** comma and `=`; max **256 characters**.

### Limits

| Limit | Value |
|---|---|
| Max list-members | 32 |
| Max total header size a vendor should be able to propagate | 512 characters |
| Truncation strategy when trimming to fit | Drop entries over 128 characters first; then drop from the end of the list; only whole list-members may be dropped, never partially |

### Mutation rules (§3.4/"Mutating the tracestate field")

- A participant adding a new entry inserts it **at the front (left)** of the list.
- A participant updating its own existing entry **moves it to the front** (as if delete +
  re-add).
- Only one entry per key is allowed — it represents that vendor's *last* position in the trace; a
  vendor re-entering the trace overwrites its previous entry rather than appending a duplicate.
  When a vendor is only reading (not modifying) an entry, order of all *other*, unmodified
  list-members must be preserved.
- Deleting keys: a vendor should not delete keys it did not itself generate — the spec's guidance
  is that removing another vendor's entry breaks that vendor's correlation ability, so participants
  should be conservative about deleting others' state.

### OTel's own `tracestate` usage — the `ot=` vendor key

**Status: Development (not stable).**
Source: https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/ ,
https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/

OpenTelemetry SDKs consolidate all OTel-internal `tracestate` data into a **single** list-member
under the key `ot`, itself an internal `;`-separated set of sub-keys (e.g. `ot=th:c8;rv:1a2b3c...`),
capped at 256 characters total for that entry. Individual instrumentation libraries get their own
separate list-member keys rather than writing into the shared `ot` entry.

| Sub-key | Meaning | Format |
|---|---|---|
| `th` | Sampling **threshold** (rejection threshold `T`), conveys effective sampling probability. `0` = 100% sampling. Probability = `(2^56 - Threshold) / 2^56`. | 1–14 lowercase hex digits (right-padded conceptually to 56 bits) |
| `rv` | Explicit **randomness value** — an alternative source of the common random value `R` used for consistent sampling decisions, instead of relying on the trailing bits of the `trace-id` | Exactly 14 lowercase hex digits |
| `p` | Legacy/older probability encoding predating `th`/`rv` | — |

This mechanism underpins **OTel consistent probability sampling**: every participant compares the
shared randomness `R` (from `rv`, or else derived from the low 7 bytes of the `trace-id`) against
its own rejection threshold `T` (`th`), so independently-configured samplers along a trace make
*consistent* keep/drop decisions without needing to agree out-of-band. This whole area is marked
**Development** stability in the OTel spec — do not treat it as a compliance requirement, but do
recognize `ot=th:...;rv:...` if you see it in customer `tracestate` values.

---

## Baggage

### API

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/baggage/api/

| Operation | Signature | Notes |
|---|---|---|
| `Get Value` | `(baggage, name) -> value \| absent` | Simple lookup. |
| `Get All Values` | `(baggage) -> [(name, value, metadata)]` | Order is **not significant**; may be exposed as an iterator or immutable collection. |
| `Set Value` | `(baggage, name, value, metadata?) -> Baggage` | Returns a new `Baggage`; `metadata` is "an opaque wrapper for a string with no semantic meaning" to the API itself (vendor-defined use, e.g. W3C's `property` syntax). |
| `Remove Value` | `(baggage, name) -> Baggage` | Returns a new `Baggage` without that entry. |

Entry shape: **key** — any non-empty valid UTF-8 string, case-sensitive; **value** — any valid
UTF-8 string, case-sensitive; **metadata** — optional opaque string. Exactly one value is
associated with a given name at a time (setting again replaces).

**Security requirement:** "To avoid sending any name/value pairs to an untrusted process, the
Baggage API MUST provide a way to remove all baggage entries from a context" — i.e., a
`ClearBaggage`-equivalent full-wipe capability is mandatory, specifically framed as a
trust-boundary safeguard.

**Baggage vs. span attributes — explicitly separate concerns.** The Baggage API spec only defines
the `Baggage` value type and its context-scoped CRUD; it says nothing about auto-copying baggage
into span attributes. In practice across OTel: **baggage entries do NOT automatically become span
attributes** (or log/metric attributes). Any such correlation requires an explicit bridge/processor
that reads `Baggage` from `Context` and calls `SetAttribute` on the current span itself. Treat
"baggage shows up as a span attribute" as something that must be deliberately wired, not a
default.

### W3C Baggage header — wire format

**Status:** W3C Editor's Draft (Baggage spec has moved slower through W3C process than Trace
Context — re-verify current REC status before citing as a final Recommendation).
Source: https://www.w3.org/TR/baggage/

#### Grammar

```
baggage-string  = list-member 0*179( OWS "," OWS list-member )
list-member     = key OWS "=" OWS value *( OWS ";" OWS property )
key             = token                     ; RFC 7230 token, ASCII only
value           = *baggage-octet            ; percent-encode anything outside this set
property        = key OWS "=" OWS value / key OWS
```

`baggage-octet` excludes control characters, whitespace, `"`, `,`, `;`, and `\`; any character
outside the allowed set must be percent-encoded per RFC 3986.

#### Limits

| Limit | Requirement |
|---|---|
| Max list-members | Implementations **must** propagate all list-members when the total is **64 or fewer** |
| Max header size | Implementations **must** propagate the full baggage-string when it is **8192 bytes or fewer** |
| Over either limit | Implementations **may** drop list-members to come back into compliance (no single normative drop order is mandated the way `tracestate` prescribes one) |

No minimum-length constraint is specified for individual keys/values.

#### Security considerations

> Application owners should either ensure that no proprietary or confidential information is
> stored in baggage, or they should ensure that baggage isn't present in requests that cross
> trust-boundaries.

The spec also expects implementations to defend against malicious/oversized baggage strings
(length validation, careful parsing) to avoid buffer-overflow/injection-style failure modes on
receipt — relevant directly to Maple's ingest gateway if it ever parses inbound `baggage` headers
rather than only OTLP payloads.

---

## B3 and Jaeger (reference level)

These are **not** part of OTel's core/mandatory propagator set; B3 ships in the optional contrib
distribution, Jaeger propagation is explicitly **Deprecated** in OTel. Documented here because
Maple, as an ingest backend, may see traffic from collectors/proxies still emitting them.

Source (B3): https://github.com/openzipkin/b3-propagation
Source (Jaeger, reference): https://www.jaegertracing.io/docs/1.6/client-libraries/#tracespan-identity ,
deprecation noted at https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution

### B3 multi-header format

| Header | Format |
|---|---|
| `X-B3-TraceId` | 16 (64-bit) or 32 (128-bit) lowercase hex chars |
| `X-B3-SpanId` | 16 lowercase hex chars (64-bit) |
| `X-B3-ParentSpanId` | 16 lowercase hex chars; optional, absent on root spans |
| `X-B3-Sampled` | `1` = accept/sampled, `0` = deny/not-sampled; absent = defer decision downstream |
| `X-B3-Flags` | Debug flag; `1` implies an accept/sampled decision, overriding `X-B3-Sampled` |

### B3 single-header format

Header name: `b3`. Format: `b3: {TraceId}-{SpanId}-{SamplingState}-{ParentSpanId}` — last two
fields optional. `SamplingState`: `1` = accept, `0` = deny, `d` = debug, absent = defer.

Examples: `b3: 80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1-05e3ac9a4f6e3b90`,
`b3: 0` (deny only), `b3: 80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-d` (debug).

When both single- and multi-header forms are present, the single-header (`b3`) form takes
precedence.

### Jaeger `uber-trace-id`

Header: `uber-trace-id: {trace-id}:{span-id}:{parent-span-id}:{flags}`.

- `trace-id`: variable length, 16 or 32 hex chars (64-bit or 128-bit); shorter values are
  zero-padded on the left when converting to/from OTel's fixed 128-bit `TraceId`.
- `span-id`: 16 hex chars.
- `parent-span-id`: historically present but deprecated/unused — conventionally `0`.
- `flags`: one byte as two hex digits (bit 0 = sampled, similar spirit to W3C's trace-flags LSB).

OTel's own docs mark the Jaeger propagator/format as **Deprecated** in favor of W3C Trace Context;
new integrations should not add Jaeger propagation, only consume it for legacy interop.

### 64-bit vs 128-bit trace-id interop note

OTel's canonical `TraceId` is always 128-bit (32 hex chars) internally. B3 and Jaeger both allow
legacy 64-bit trace IDs. The standard interop rule (as implemented by OTel's B3/Jaeger propagators)
is: a 64-bit incoming trace-id is **zero-extended on the left** to fill the 128-bit OTel `TraceId`;
on the way back out to a 64-bit-only system, the low 64 bits are used (the propagator may drop the
high, zero-padded bits). This is why Maple ingest should not treat a `TraceId` with a long run of
leading zero bytes as inherently anomalous — it's a legitimate signature of a bridged 64-bit trace
ID — while still rejecting the fully-all-zero 128-bit case for **W3C `traceparent` parsing
specifically** (that all-zero rule is a W3C traceparent-parsing rule, not a generic "all-zero
trace ids are always invalid" rule for OTLP payloads already carrying a `TraceId` field).

---

## Key references

- OTel Context spec — https://opentelemetry.io/docs/specs/otel/context/
- OTel Propagators API spec — https://opentelemetry.io/docs/specs/otel/context/api-propagators/
- OTel Propagators distribution — https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution
- OTel Baggage API spec — https://opentelemetry.io/docs/specs/otel/baggage/api/
- OTel SDK environment variables (`OTEL_PROPAGATORS`) — https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- OTel TraceState handling (`ot=` vendor key) — https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/
- OTel TraceState probability sampling (`th`/`rv`) — https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/
- W3C Trace Context (Recommendation) — https://www.w3.org/TR/trace-context/
- W3C Baggage (Editor's Draft/CR) — https://www.w3.org/TR/baggage/
- B3 propagation (OpenZipkin) — https://github.com/openzipkin/b3-propagation
- Jaeger client trace/span identity (`uber-trace-id`) — https://www.jaegertracing.io/docs/1.6/client-libraries/#tracespan-identity
- Canonical spec repo — https://github.com/open-telemetry/opentelemetry-specification
