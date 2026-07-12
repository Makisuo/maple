---
name: maple-otel-spec-review
description: "Review a diff, PR, or specific file in this repo for OpenTelemetry *specification* compliance, grounded in the source-linked spec corpus at docs/otel-spec/ (snapshot v1.58.0). Triggers on requests like 'is this spec compliant', 'review this PR against the OTel spec', 'spec-review this diff', 'check my partial-success handling', 'are these retryable status codes right', 'does apps/ingest honor the OTLP spec', and on reviews of changes touching the OTLP server surface in apps/ingest (partial success, retryable set {429, 502, 503, 504}, protobuf Status bodies, gzip, OTLP/JSON encoding), self-instrumentation (apps/api tracer setup, apps/ingest/src/otel.rs, lib/effect-sdk), or consumers of span status / SeverityNumber / db.query.text (WarehouseQueryService, query-engine). Spec MUSTs and SHOULDs only — for Maple house conventions use maple-telemetry-conventions; for whole-project instrumentation audits use maple-audit; for general diff correctness use /code-review."
---

# OTel spec-compliance review

Review a diff, PR, or named file of *Maple's own code* against the *OpenTelemetry specification* as snapshotted in `docs/otel-spec/` (spec **v1.58.0**, researched 2026-07-05). This is not `maple-audit` (whole-project instrumentation-quality audit against Maple conventions, mostly for external projects), not `maple-telemetry-conventions` (the house-conventions reference — cross-referenced here, never enforced from here), and not generic `/code-review` (diff correctness). The deliverable is spec findings: MUST/SHOULD violations with normative citations.

`docs/otel-spec/README.md` is the routing hub; the nine spec files are the **only authority this skill may cite**. Every section in them carries an inline `Source:` deep link to the official spec — findings copy that link.

## Severity

Severity comes from the spec's own normative word, not intuition:

| Severity   | Meaning                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical` | Violates a MUST / MUST NOT / SHALL / REQUIRED in a Stable spec section: failing a whole batch instead of returning partial success, wrong retryable status set, non-protobuf error body, an SDK code path that can throw into the host app, dropping gzip decode. |
| `warn`     | Violates a SHOULD / SHOULD NOT, or newly relies on a deprecated path: fresh span-event usage for event-shaped data, deprecated semconv keys without coalescing, missing throttle hints on 429/503.                             |
| `info`     | MAY/recommendation divergence; anything grounded in a Development/Experimental-stability section; **any finding touching a README known-gap item (mandatory cap, tagged "unverified")**.                                       |

## Routing table

Map what the diff touches to the minimal spec sections. Route by heading text, never line numbers. Surfaces are the three from `docs/otel-spec/README.md`: **1** ingest gateway as OTLP server · **2** self-instrumentation as SDK consumer · **3** UI/query as data consumer.

| Diff touches (path or content signal) | Surface | Load (file → `##`/`###` headings) |
| --- | --- | --- |
| `apps/ingest` OTLP handlers: request decode, response building, status codes | 1 | otlp.md → `Request/response shapes` (esp. `Partial success (server MUST rules)`, `When to use partial success vs full failure (server MUST)`), `Failure handling` (esp. `HTTP status codes — retryable matrix`, `Throttling / backpressure (server SHOULD)`) |
| OTLP/JSON parsing or serialization (IDs, enums, unknown fields) | 1 | otlp.md → `JSON encoding (OTLP/HTTP JSON) — deviations from standard protobuf JSON`; proto field questions → `Proto schema essentials` |
| gzip / content-type / transport handling in ingest | 1 | otlp.md → `Transports: gRPC vs HTTP` (esp. `Compression`, `Content types`) |
| Inbound `traceparent`/`tracestate`/baggage handling; propagator config | 1/2 | context-propagation.md → `W3C Trace Context — traceparent` (esp. `Practical MUSTs for an ingest gateway`), `W3C Trace Context — tracestate`, `Baggage`; propagator wiring → `Propagators API` |
| Span creation/status/kind sites: `apps/ingest/src/otel.rs`, `tracing::info_span!` / `otel.kind`, `apps/api` tracer setup, `lib/effect-sdk/` | 2 | traces.md → `3. Span`, `4. SpanKind`, `6. TracerProvider / Tracer`; error-handling posture → stability-and-compliance.md → `5. Error-handling principles (fail-safe requirements)`; scope naming → stability-and-compliance.md → `7. Library / instrumentation guidelines` |
| Span processors, exporters, sampling config | 2 | traces.md → `12. Sampling (SDK)`, `15. Span Processor`, `16. Span Exporter`, `13. Span Limits` |
| Resource attributes, `OTEL_*` env vars, exporter endpoints | 2 | resource-and-config.md → `1. Resource: definition, immutability, merge rules`, `3. Key resource semantic conventions`, `5. SDK environment-variable spec (consolidated table)`; endpoint rules → otlp.md `Exporter configuration ('OTEL_EXPORTER_OTLP_*')` |
| New/renamed attribute keys (`setAttribute`, `annotateCurrentSpan`, `record(...)`, `#[instrument(fields(...))]`) | 2/3 | semantic-conventions.md → `General rules` + the one matching domain section (`HTTP`, `Database`, `Messaging`, `RPC`, `Exceptions`, `Gen-AI`) |
| Consumers of status / severity / db keys: `WarehouseQueryService`, `packages/query-engine`, `packages/domain/src/tinybird/`, UI classification code | 3 | semantic-conventions.md → matching domain section (HTTP status rule: `Span status mapping (the important compliance rule)`); logs.md → `2. Log Data Model` (esp. `2.2 SeverityNumber reference table`), `5. Events` |
| Metrics instruments, views, temporality, cardinality | 2 | metrics.md → `1. Metrics API` (esp. `1.4 Naming rules`), `2. Metrics SDK` (esp. `2.2 Aggregations — default per instrument`, `2.5 Cardinality limits`); data-model questions only → `3. Metrics Data Model` |
| Log bridge wiring / log record emission | 2 | logs.md → `3. Logs API ("Bridge API")`, `4. Logs SDK` |
| Schema URLs, Prometheus interop, profiles | 2/3 | emerging-and-compat.md → `2. Telemetry schemas (deep dive)` / `3. Prometheus & OpenMetrics compatibility` / `1. Profiles signal` |
| Anything OTel-shaped that doesn't map above | — | README `Files` table → pick ONE file; read its `Relevance to Maple` intro (where present), then decide which sections to load |

**Loading rule:** `Grep -n '^##' docs/otel-spec/<file>.md` to locate the routed heading, then `Read` with offset/limit from that line to the next same-level heading. If the file has a `Relevance to Maple` intro (traces, metrics, logs, resource-and-config, context-propagation, emerging-and-compat), read that first (~30 lines) as orientation.

**Budget:** never read a spec file end-to-end (traces.md is 801 lines). Default is ≤2 spec files per review, section-scoped. If a third is genuinely needed, say why in the report's "Spec sections loaded" line.

## Load-bearing MUSTs (quick table)

The most common review facts, cached so trivial reviews load zero spec files. This table is a **cache, not an authority**: any `critical` finding still opens the cited section to quote the normative sentence and copy its `Source:` link.

| # | Surface | Rule | Spec ref |
| --- | --- | --- | --- |
| 1 | 1 | Partially-bad batch → HTTP 200 + `partial_success` with `rejected_*` count and `error_message`. Never fail the whole batch for a few bad items. | otlp.md § Partial success (server MUST rules) |
| 2 | 1 | 400 is only for fully undecodable/invalid requests, and is non-retryable. | otlp.md § When to use partial success vs full failure (server MUST) |
| 3 | 1 | The retryable HTTP status set is exactly {429, 502, 503, 504}. | otlp.md § HTTP status codes — retryable matrix |
| 4 | 1 | Every 4xx/5xx response body MUST be a protobuf `Status`. | otlp.md § Failure handling |
| 5 | 1 | Server MUST accept gzip-compressed request bodies. | otlp.md § Transports: gRPC vs HTTP → Compression |
| 6 | 1 | OTLP/JSON: hex trace/span IDs, lowerCamelCase field names, enums accepted as numbers, unknown fields MUST be ignored. | otlp.md § JSON encoding — deviations |
| 7 | 1 | When throttling, server SHOULD respond 429/503 and MAY include `Retry-After`; clients SHOULD honor it. | otlp.md § Throttling / backpressure (server SHOULD) |
| 8 | 2 | API/SDK calls MUST NOT throw into the host application — fail-safe, self-diagnose to own log. | stability-and-compliance.md § 5. Error-handling principles (fail-safe requirements) |
| 9 | 2 | HTTP SERVER span status = `Error` only for 5xx; 4xx leaves server-span status `Unset`. (CLIENT spans: `Error` on any 4xx/5xx.) | semantic-conventions.md § HTTP → Span status mapping (the important compliance rule) |
| 10 | 2 | Per-component instrumentation scope names, not one global tracer. | stability-and-compliance.md § 7 → Instrumentation Scope — identity and naming |
| 11 | 2 | `deployment.environment.name` is canonical; legacy `deployment.environment` is deprecated. | resource-and-config.md § 3.2 |
| 12 | 2 | Resource is immutable once the provider is built; merge = updating resource wins per key. | resource-and-config.md § 1. Resource: definition, immutability, merge rules |
| 13 | 2 | Metric instrument names: first char alphabetic, ≤255 chars, case-insensitive ASCII, charset `A–Z a–z 0–9 _ . - /`. | metrics.md § 1.4 Naming rules |
| 14 | 3 | Log error classification keys on `SeverityNumber >= 17` (ERROR), never `SeverityText` string-matching. | logs.md § 2.2 SeverityNumber reference table |
| 15 | 3 | An "event" is a LogRecord with `EventName` set; span events / `RecordException()` are deprecating toward log-based events. | logs.md § 5. Events |
| 16 | 1/2 | All-zero `trace-id`/`parent-id` in `traceparent` is invalid → treat as absent, start fresh; extraction never throws — malformed degrades to "no context extracted". | context-propagation.md § traceparent → Practical MUSTs for an ingest gateway |

## Step 1 — Scope the diff

Resolve what's under review: the working diff (`git diff` / `git diff --staged`), a PR (its diff via the GitHub tooling available), a commit (`git show <sha>`), or files the user named. List the touched files grouped by path. If nothing touches a compliance surface or OTel-shaped content (no spans, exporters, OTLP handling, telemetry attributes, or telemetry consumers), say so in two lines and stop — don't spec-review generic code.

## Step 2 — Classify

Map each file group to surface(s) and routing-table row(s). Show the classification before reviewing so the user can correct it:

```
apps/ingest/src/main.rs (response building)  → surface 1 → otlp.md §Request/response shapes, §Failure handling
apps/api/src/services/WarehouseQueryService.ts → surface 3 → semantic-conventions.md §Database
```

## Step 3 — Load minimally

Check the quick table first. If every implicated rule is covered there and no finding looks `critical`, skip spec loading entirely. Otherwise grep-then-read only the routed sections per the loading rule. Track what you loaded — it goes in the report header.

## Step 4 — Review

Walk the diff hunks against the loaded normative text. For each candidate finding: quote (to yourself) the normative sentence, take severity from its MUST/SHOULD/MAY word and the section's stability label, and record evidence as `file:line` in the diff. Keep two piles as you go: spec findings, and house-convention observations (Maple-specific rules from `maple-telemetry-conventions` that the spec doesn't mandate).

## Step 5 — Findings report

Present the report **before making any edit**. Format:

```
## OTel spec review — <diff/PR ref>

Spec snapshot: v1.58.0, researched 2026-07-05 (docs/otel-spec/). Re-verify Source links before quoting externally.
Surfaces touched: <1 OTLP server | 2 SDK consumer | 3 data consumer | none>
Spec sections loaded: otlp.md §Partial success, §HTTP status codes — retryable matrix <or "none — quick table sufficed">

| Severity | Spec ref | Finding | Evidence | Source |
| critical | otlp.md §Partial success (server MUST rules) | returns 400 for a batch with 3 bad spans instead of 200 + rejected_spans | apps/ingest/src/main.rs:512 | <Source: URL copied from that section> |
...

### House-convention notes (not spec findings)
- <observation> — see maple-telemetry-conventions rules/<file>.md

### Summary
N critical · N warn · N info. Known-gap caveats: <or "none">.
```

If the user only wants the review, stop here — the report is a complete deliverable.

## Step 6 — Apply fixes (only if asked)

Fix in severity order. *What* to change comes from the cited spec section; *how* to write it defers to the style skills (`maple-rust-style` for `apps/ingest`, `maple-effect-style` for `apps/api`) and `maple-telemetry-conventions` for attribute spellings. After edits, re-verify: the touched app's build/dev command starts cleanly (`bun typecheck` for TS, `cargo check` for `apps/ingest`). A fix that breaks the build is a regression — fix or revert it.

## Hard rules

- Every finding cites a `docs/otel-spec/` file + section heading and copies that section's inline `Source:` link. If the corpus is silent on a question, report "not covered by the corpus — not reviewed"; never reason from model memory about what the spec says.
- The README known-gap items (Jaeger `uber-trace-id`, W3C Baggage doc status, global metrics cardinality-limit env var, env-var vs declarative-config precedence) are capped at `info` and tagged "unverified"; re-check the canonical URL before asserting them as fact.
- Documented intentional Maple deviations are **not** findings: title-case `"Ok"/"Error"/"Unset"` status storage (one-time translation at the OTLP boundary), the `deployment.environment` dual-emit migration bridge, and `db.statement`→`db.query.text` read-side coalescing (all in README §Maple's three compliance surfaces). Flag one only if the diff *breaks* the documented pattern.
- No edits before the findings report. Never commit, push, or open PRs. Never expand into a whole-repo audit — that's `maple-audit`.
- Maple-convention issues go under "House-convention notes" pointing at the specific `maple-telemetry-conventions` `rules/*.md`, never mislabeled as spec violations. A line violating both gets a spec finding plus a cross-reference.
- Respect the loading budget: section-scoped reads only, ≤2 spec files by default, never a full file.
