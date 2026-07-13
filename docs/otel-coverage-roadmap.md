# OTel Coverage Roadmap

Tracks OpenTelemetry-standard capabilities Maple does **not** yet surface for filtering and
visualization. Maple ingests the full OTel triad and stores a near-complete span/log/metric model in
ClickHouse/Tinybird — but a lot of stored data (span events, span links, span kind, trace state, log
attributes, metric exemplars, exponential histograms) is never exposed in the product.

**Framing:** most high-value gaps need _zero_ ingestion work — the columns are already populated, they
just need query-engine + UI plumbing. Tier 3 items require changes to the Rust ingest encoder
(`apps/ingest/src/telemetry.rs`).

Effort key: **S** = schema + query + UI wiring · **M** = new query shape or visual component ·
**L** = ingest encoder + datasource + downstream.

---

## Data verification (run 2026-06 against prod traces/logs/metrics)

Before building, we confirmed which columns are actually populated. A "quick win" is only quick if
data exists:

- **Span kind** — all 5 kinds present (Client/Server/Internal/Consumer/Producer). ✅
- **Span status** — Ok / Unset / Error all present; large `Client/Unset` volume the current
  `has_error` boolean can't separate from Ok. ✅
- **Span events** — present, concentrated on error spans (exception events). ✅
- **Span links** — **0 rows have links.** ❌ No producers emit them → #6 deprioritized until data exists.
- **Scope name** — ~100% populated on both traces and logs. ✅
- **Log attributes** — ~100% populated. ✅
- **Log severity** — numbers 5/9/13/17 present; severity _text_ casing is inconsistent
  (`info` vs `Info`, `debug`) → confirms a severity-**number** range filter beats text matching. ✅
- **Metric exemplars** — 6.7M on histograms, ~46K on sums. ✅
- **Exponential histograms** — **0 rows.** ❌ → #10 deprioritized.
- **Explicit histograms** — 36.8M rows. ✅

---

## Tier 1 — Quick wins (data already stored, surface only)

- [ ] ~~**1. Span kind filter** (Server/Client/Producer/Consumer/Internal)~~ — ✗ **REJECTED (tried & reverted).** Built end-to-end and verified working (Client → 36 traces), but judged not useful enough for the sidebar. Don't rebuild without a clearer use case.
- [ ] ~~**2. Span status filter** (Ok / Unset / Error, not just `has_error`)~~ — ✗ **REJECTED (tried & reverted).** Same as #1 — the existing `has_error` toggle covers the common case; granular Ok/Unset/Error wasn't worth the sidebar space.
- [ ] **3. Log attribute filters** (arbitrary `log_attributes`) — _S–M, logs_
      `LogsFilters` has no `attributeFilters` — only service/severity/trace_id/body-search. Reuse `AttributeFilter` + `traces-shared.ts` operators.
- [ ] **4. Log severity range** (`>= ERROR`) — _S, logs_
      `severity_number` is stored but only exact-match on text is exposed. Add a `minSeverityNumber` filter.
- [ ] **5. Span events on the waterfall/timeline** — _M, trace visuals_
      `events_*` arrays stored and completely unrendered. Add event markers to `trace-timeline.tsx` / `span-hierarchy.tsx` + events list in span detail. Highest-visibility visual win.
- [ ] **6. Span links rendered** (clickable links to related traces) — _M, trace visuals_ — ⏸ **DEPRIORITIZED: 0 links in prod data.** `links_*` arrays stored, never shown. Revisit once a producer emits links.
- [ ] **7. Scope / instrumentation filter** (`scope_name` / `scope_version`) — _S, trace + log filtering_
      Stored on all three signals, filterable on none. Isolates one SDK/library.
- [ ] **8. Generic attribute filter UI builder** — _M, trace filtering_
      `attributeFilters` + `resourceAttributeFilters` already work end-to-end in the query engine (and `hasActiveFilters` counts them) — but the sidebar renders no control to add them. Wire a key/op/value row builder backed by `explore-attributes` autocomplete.

## Tier 2 — Medium (data stored, new query/visual work)

- [ ] **9. Exemplar → trace links on charts** — _M, metric visuals_
      `exemplars_trace_id/span_id/value/timestamp` stored per metric point, never read. Overlay exemplar dots on latency/line charts that deep-link to the trace — the canonical OTel metrics↔traces bridge.
- [ ] **10. Exponential-histogram heatmap** — _M–L, metric visuals_ — ⏸ **DEPRIORITIZED: 0 exp-histogram rows in prod.** Revisit once data exists; explicit-bucket histograms (#11) have 36.8M rows and are the better first target.
- [ ] **11. Explicit-bucket histogram distribution view** — _M, metric visuals_
      Histogram datasource has bounds + bucket counts; registry has a generic histogram/heatmap but nothing wired to OTel histogram buckets.
- [ ] **12. trace_state / sampling filter** — _S, trace filtering_
      `TraceState` + `SampleRate` stored; useful for "show only head-sampled" debugging. Lower demand.
- [~] **13. GenAI / LLM semantic conventions** (`gen_ai.*`) — _M, filtering + visuals_
      **Trace-level enrichment shipped:** LLM spans (OpenRouter Broadcast et al.) are detected via
      `getGenAiInfo` (`packages/ui/src/lib/gen-ai.ts`) + a `genAiAdapter`
      (`packages/ui/src/lib/cloud-platforms/gen-ai.ts`), so the waterfall/flame/flow views badge
      them and the span-detail panel shows a model/provider/token/cost summary; `gen_ai.*` keys are
      projected into the trace views (`TREE_SPAN_ATTR_KEYS`), `gen_ai.system`↔`gen_ai.provider.name`
      coalesce in attribute filters (`traces-shared.ts`), and model/token/cost render formatted in
      the attribute table. **Deferred:** dedicated token/cost aggregation + AI page (needs the
      `gen_ai_usage_hourly` rollup and the numeric-attribute aggregation wiring — see below).

## Tier 3 — Needs ingest-encoder changes (`apps/ingest/src/telemetry.rs`)

- [ ] **14. Summary metrics** — _M._ Currently silently dropped at encode time. Add datasource + encode path if customers send Prometheus-summary-style data.
- [ ] **15. Span flags / dropped-attribute counts** — _M._ `flags` and all `dropped_*_count` hardcoded to 0; needed for spec-complete fidelity + "data loss" indicators.
- [ ] **16. Structured (nested) log body** — _M._ OTel AnyValue body is flattened to string; nested bodies lose shape.
- [ ] **17. Profiles signal** — _L._ No OTLP profiles ingestion at all. Large, separable effort.
- [ ] **18. Baggage persistence** — _L._ Parsed but not stored; low product value.

---

## Recommended build order

1. Filter quick-wins batch (Tier 1: #1, #2, #4, #7) — shared schema → query operator → facet → sidebar pattern.
2. Log attribute filters (#3) — logs filtering parity with traces.
3. Span events visualization (#5) — most visible "we have OTel data you can't see" gap.
4. Generic attribute filter UI builder (#8) — backend done; pure UI, multiplies value of every stored attribute.
5. Span links (#6) then exemplar links (#9) — the two OTel correlation bridges.
6. Histogram / exp-histogram visuals (#10, #11) and GenAI conventions (#13).
7. Tier 3 ingest work as separate, demand-driven efforts.

## Critical files (by area)

- **Filter schema / query spec:** `packages/domain/src/query-engine.ts` (`TracesFilters`, `LogsFilters`, `MetricsFilters`, `AttributeFilter`).
- **Filter operator → SQL:** `packages/query-engine/src/traces-shared.ts`.
- **Trace/log search + facets:** `packages/query-engine/src/observability/{search-traces,search-logs,explore-attributes}.ts`.
- **DSL queries:** `packages/query-engine/src/ch/queries/*.ts` (+ export from `packages/query-engine/src/ch/index.ts`).
- **Filter UIs:** `apps/web/src/components/traces/traces-filter-sidebar.tsx`, `apps/web/src/components/logs/logs-filter-sidebar.tsx`, shared `filter-section.tsx`.
- **Trace visuals:** `packages/ui/src/components/traces/{trace-timeline,span-hierarchy,flamegraph,flow-view}.tsx`, `apps/web/src/components/traces/span-detail-panel.tsx`.
- **Chart registry / metric visuals:** `packages/ui/src/components/charts/registry.ts`; verify via `/widget-lab`.
- **Datasource schemas:** `packages/domain/src/tinybird/datasources.ts` (traces, logs, metric\_\* tables).
- **Ingest encoder (Tier 3 only):** `apps/ingest/src/telemetry.rs`.
- **MCP parity:** `apps/api/src/mcp/tools/{search-traces,search-logs,explore-attributes}.ts`.
