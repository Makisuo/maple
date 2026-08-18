# Profiling as Maple's fourth signal

_Plan, 2026-08-18. Status: proposal — nothing here is built. Companion to
[`otel-spec/emerging-and-compat.md`](otel-spec/emerging-and-compat.md) §1 (the spec digest)
and item 17 of [`otel-coverage-roadmap.md`](otel-coverage-roadmap.md)._

## TL;DR

- **Yes, it is a standard** — OpenTelemetry Profiles is the official fourth OTLP signal
  (traces, metrics, logs, profiles). It is pprof-derived, round-trips losslessly with pprof,
  and links samples to spans by `trace_id`/`span_id`. It entered **public Alpha on
  2026-03-26**; the OTLP transport is **Development**, the HTTP path is
  `/v1development/profiles`, and the proto is `opentelemetry.proto.profiles.v1development`.
  Community talk of GA in Q3 2026 is not confirmed by the spec.
- **The backend market is thin.** Grafana Pyroscope ingests OTLP profiles as _experimental_;
  Elastic's Universal Profiling is the mature one; ClickStack/HyperDX has no profiles signal;
  the OTel blog itself says "production-ready backends have not yet emerged". A trace-native
  platform that answers _"which function burned this span's time"_ in the same UI is
  differentiated today, not in 2027.
- **Recommendation:** build it — but as a scoped MVP that flattens the pprof-shaped payload
  into ClickHouse rows at the ingest gateway (the same "denormalize at ingest" trade Maple
  already makes for span attributes), ships a pure-JS CPU profiler in `effect-sdk` (Node and
  Bun via `node:inspector`, verified today), and puts a flame graph on the service page and on
  the span detail panel. Roughly **3 engineer-weeks to MVP** on the seams named below, plus a
  2–3 day spike first. Alpha status is handled by pinning the proto version and never storing
  the raw wire format — only our own flattened rows.
- **What hotpath does not solve and this does:** hotpath profiles _Maple's ingest process
  locally_. This gives every Maple customer CPU/allocation attribution for their own services,
  correlated with their traces. Different product.

## 1. Where the standard actually is

| Aspect | State (Aug 2026) | Source |
| --- | --- | --- |
| Signal / data model | **Alpha** (pre-Experimental; "should not be used for critical production workloads") | [spec](https://opentelemetry.io/docs/specs/otel/profiles/), [alpha post](https://opentelemetry.io/blog/2026/profiles-alpha/) |
| OTLP transport | **Development** — Stable only for traces/metrics/logs | [OTLP spec](https://opentelemetry.io/docs/specs/otlp/) |
| HTTP path / RPC | `POST /v1development/profiles`, `ProfilesService/Export`, `ExportProfilesServiceRequest{resource_profiles}` / `partial_success.rejected_profiles` | [OTLP spec](https://opentelemetry.io/docs/specs/otlp/) |
| Wire format | pprof-derived, `ProfilesDictionary` (string / function / location / stack / link / attribute tables shared per request), ~40% smaller than pprof | [alpha post](https://opentelemetry.io/blog/2026/profiles-alpha/) |
| Rust proto crate | `opentelemetry-proto 0.31` ships `profiles.v1development` behind a `profiles` cargo feature (present in our registry copy, **not enabled** in `apps/ingest/Cargo.toml`) | local crate |
| Collector | v0.148+: eBPF profiler receiver (donated by Elastic, in the official distribution), `pprof` receiver, `k8sattributes` enrichment, OTTL on profiles | [alpha post](https://opentelemetry.io/blog/2026/profiles-alpha/) |
| Backends | Pyroscope: experimental OTLP ingest; Elastic: yes; ClickStack: no; others "being built" | [ClickHouse](https://clickhouse.com/resources/engineering/otel-news-profiles-signal), [Pyroscope docs](https://grafana.com/docs/pyroscope/latest/configure-client/opentelemetry/ebpf-profiler/) |

Implications we design around:

1. **The path is versioned.** `/v1development/profiles` will become `/v1/profiles` at RC. Ingest
   must accept both from day one (cheap) and `effect-sdk` must default to whatever the pinned
   proto expects.
2. **Fields may move.** We pin `opentelemetry-proto` and store _our_ row shape, never the wire
   payload. A proto bump is an ingest-only change.
3. **Every message type is Alpha**, so we lean on the parts least likely to change: stacks of
   function names + values + optional span link + resource attributes. That is the pprof core,
   unchanged for a decade.

## 2. Who can actually send us profiles

This is the make-or-break question for a signal — the spec being real does not mean customers
have producers. Four tiers, from zero-code to bespoke:

| Producer | Languages | Where it runs | Trace link | Effort for customer |
| --- | --- | --- | --- | --- |
| **OTel eBPF profiler** (in the collector distro) | Go, JVM, Node, .NET, Ruby, Python, PHP, BEAM, native | Linux hosts / k8s DaemonSet, privileged | per-runtime, partial | Deploy the collector with the receiver + point at Maple. No app changes. |
| **pprof-emitting profilers** → collector `pprof` receiver → OTLP | Go `runtime/pprof`, Rust `pprof`, Node `pprof` npm, Python `py-spy`, JVM `async-profiler` (which now also emits OTLP directly) | anywhere | no (time-window only) | App-side profiler + a collector hop |
| **`effect-sdk` built-in** (new, this plan) | Node ≥18, Bun | Node/Bun servers. **Not Cloudflare Workers** (no profiler API) — must no-op there | time-window in MVP; span-linked later | `profiling: { cpu: true }` |
| **`packages/browser`** | — | — | — | Out of scope: browsers expose no sampling profiler worth shipping (JS Self-Profiling API is Chromium-only, origin-trial-grade). |

**Verified this session:** `node:inspector` `Profiler.start/stop` returns a full V8 sampling
profile (`nodes`, `samples`, `timeDeltas`, `callFrame{functionName,url,lineNumber}`) with **no
native addon**, on both Node and Bun. `HeapProfiler.startSampling` gives allocation profiles the
same way. That is what makes "one config flag" profiling possible for our own SDK; it is the
biggest lever in this plan because most Maple SDK users are on Node/Bun today.

The eBPF path is what makes Maple credible for k8s shops without any SDK change, and it is
_the_ reference producer the OTel SIG tests against — the spike (§8) should start there.

**Deliberately optional (Phase 2): Pyroscope push-API compatibility.** Every Pyroscope SDK
(Go, Node, Python, Ruby, .NET, Java, Rust) already `POST`s pprof to `/ingest?name=…&from=…`. If
ingest accepts that shape too, all of them work against Maple with an endpoint swap. It is one
extra route that decodes plain pprof — the same flattener as §4 — but it is not OTel, so it is
not in the MVP.

## 3. Product surface

Scope for MVP is exactly two questions, both already asked in traces terms elsewhere in Maple:

1. **Service page → "Profiles" tab.** _"Where does this service spend CPU / allocate?"_
   Sample-type selector (`cpu` / `alloc_space` / whatever the producer sent), time range from
   the existing picker, a **flame graph** (aggregate icicle, root at top), and a **top functions**
   table (self / total, share, count) beneath it. Environment/host filters come from the same
   resource-attribute facets the service page already has.
2. **Span detail → "Profile" tab.** _"What was running during this span?"_ Flame graph filtered
   to samples that (a) carry a link to this span (`SpanId = ?`, best fidelity), else (b) fall
   inside `[span.start, span.end]` on the same service instance (time-window fidelity — mark it
   as such in the UI). This is the feature no traces-only tool has and where the OTel spec's own
   pitch lands.

Not in MVP (Phase 2+): diff/compare view (two windows), sandwich view, per-line source view,
alerts on profile metrics, dashboards widgets, MCP tools (`top_functions`, `flame_graph` — small
once the queries exist and very on-brand for the agent story; put it early in Phase 2).

## 4. Data model → storage

Wire shape (per request): a `ProfilesDictionary` of tables + `ResourceProfiles → ScopeProfiles →
Profile{sample_type, samples[], time_unix_nano, duration_nano, period}` where each `Sample` is
`{stack_index, values[], attribute_indices[], link_index, timestamps_unix_nano[]}` and a stack
is a list of `Location → Line → Function{name, filename, start_line}` indices.

**Decision: flatten to one denormalized row per sample at the ingest gateway.** No dictionary
tables in the warehouse. Reasons: (1) it is one NDJSON line per row, which is exactly what the
existing `rows_to_frames` / insert-mapping / Tinybird / BYO-ClickHouse machinery moves — a
multi-table bundle would need new plumbing everywhere; (2) `Array(LowCardinality(String))`
dictionary-encodes repeated frame names per part, so the storage penalty of denormalizing is
modest; (3) flame-graph queries become a single `GROUP BY Frames` with no join.

```
profiles                          -- new datasource, packages/domain/src/tinybird/datasources.ts
  OrgId            LowCardinality(String)      $.resource_attributes.maple_org_id
  Timestamp        DateTime64(9)               sample ts if present else profile time_unix_nano
  TimestampTime    DateTime                    MATERIALIZED toDateTime(Timestamp)
  ServiceName      LowCardinality(String)
  ResourceAttributes Map(LC(String), String)   + ResourceAttributeItems mirror, as logs does
  ProfileId        String                      16-byte hex; groups samples of one profile
  SampleType       LowCardinality(String)      "cpu" | "alloc_space" | "alloc_objects" | "wall" | …
  SampleUnit       LowCardinality(String)      "nanoseconds" | "bytes" | "count"
  Value            Int64                       one row per (sample, value index) — pprof allows N values
  Period           Int64                       sampling interval in SampleUnit terms (0 if unknown)
  StackHash        UInt64                      cityHash64 of the joined frames — toString()'d in every SELECT
  Frames           Array(LowCardinality(String))  leaf-first function names, "pkg.fn" as the producer gave them
  FrameFiles       Array(LowCardinality(String))  parallel; "" when unknown (native/eBPF)
  FrameLines       Array(Int32)                parallel; 0 when unknown
  TraceId          String                      from link_table, "" if none
  SpanId           String
  SampleAttributes Map(LC(String), String)     thread.name, process.pid, etc.
  engine: MergeTree
    partitionKey  toDate(TimestampTime)
    sortingKey    [OrgId, ServiceName, SampleType, toStartOfHour(Timestamp), StackHash]
    ttl           toDate(TimestampTime) + INTERVAL 7 DAY          (raw)
  indexes: bloom_filter on TraceId, SpanId; bloom on Frames (arrayJoin) for function search
```

Plus one rollup MV for the service-page views over longer ranges:

```
profiles_stacks_hourly_mv → profiles_stacks_hourly (SummingMergeTree, 30d TTL)
  OrgId, ServiceName, SampleType, SampleUnit, Hour, StackHash, Frames, FrameFiles, FrameLines,
  Environment (from ResourceAttributes), sum(Value) AS Value, count() AS Samples
```

Queries this supports (all in `packages/query-engine/src/ch/queries/profiles.ts`):

- **flameGraph** — `SELECT Frames, sum(Value) FROM … WHERE OrgId, ServiceName, SampleType,
  window [AND SpanId = ?] GROUP BY Frames` → the client folds the (frames[], value) list into a
  tree. Wire size is bounded by distinct stacks, not samples; cap at N stacks by value and
  report the tail as an "other" node.
- **topFunctions** — `arrayJoin(Frames)` for total; `Frames[1]` for self; both `sum(Value)`.
- **timeseries** — `sum(Value)` per bucket per SampleType (feeds a sparkline on the tab and,
  later, dashboards/alerts).
- **sampleTypes** — distinct `(SampleType, SampleUnit)` for the selector.
- **spanOverlap** — the time-window fallback for the span tab: same service instance
  (`ResourceAttributes['service.instance.id']`) and `Timestamp BETWEEN span.start AND span.end`.

Retention: 7 d raw / 30 d rollup by default, keyed like `logs` in
`packages/domain/src/tinybird/ttl-override.ts` so plan-level overrides apply.

Sizing sanity: the eBPF agent samples at ~20 Hz/core and pre-aggregates per stack before
sending, so a 32-core host is on the order of a few hundred rows/s; a Node process with the SDK
at 1 kHz over a 10 s window is ~10 k samples/10 s _before_ we aggregate them by stack in the SDK
(which we should — see §6). Rows are small (Frames dictionary-encode); this is well inside what
`logs` does today.

## 5. Ingest gateway (`apps/ingest`) — the seams

Everything a new signal touches, from the code as it is on `main` today:

| Seam | File | Change |
| --- | --- | --- |
| Proto | `Cargo.toml` `opentelemetry-proto` features | add `"profiles"`; pin the exact version and note it in the plan doc |
| Signal enums | `main.rs` `Signal` (`Traces\|Logs\|Metrics`), `DecodedPayload`, `item_count`, `encode`; `telemetry.rs` `TelemetrySignal`, `DatasourceNames` | add `Profiles`; `INGEST_TINYBIRD_DATASOURCE_PROFILES` |
| HTTP route | `main.rs` router (`/v1/traces` …) | `POST /v1development/profiles` **and** `/v1/profiles` (future RC path); both map to `Signal::Profiles`. `format!("/v1/{}", signal.path())` at the `ingest` span and `forward_to_collector` needs a `Signal::route_path()` — the profiles path breaks that assumption. |
| gRPC | `run_grpc_server` | 4th service, `ProfilesServiceServer`, same `export` shape as logs |
| Decode + enrich | `decode_and_enrich_payload` (6-arm match), `otlp_json::normalize` root field | `resourceProfiles` arm for protobuf + JSON; `enrich_profiles_request` writes `maple_org_id` etc. into resource attributes exactly like the others |
| Flatten | new `telemetry.rs::encode_profiles` | the real work: resolve dictionary indices → frame name/file/line arrays, `cityHash64` stack, one row per `(sample, value_index)`, link → `TraceId`/`SpanId`, `routing_key = hash64(trace_id)` when linked else `hash64(profile_id)` so a span's samples land in one lane |
| Pipeline | `accept_native_decoded_payload` arm → `accept_profiles_to` (copy of `accept_logs_to`) | export lanes are destination-major, so profiles ride the same WAL/lanes for free |
| Insert mapping | `scripts/generate-clickhouse-insert-mappings.ts` `OTLP_DATASOURCES` | add `"profiles"`; regenerates `apps/ingest/src/clickhouse_insert_mappings.rs` and `apps/cli/src/server/schema/local-inserts.json` |
| BYO ClickHouse | `packages/domain/src/clickhouse/migrations/00NN_profiles.ts` + `migrations/index.ts` | new delta migration; bumps `clickHouseSchemaVersion` → ingest `SCHEMA_VERSION` gate |
| Billing | `usage_metrics.rs` (`"logs" \| "traces" \| "metrics"`), `reserve_autumn_usage`, Autumn feature ids | new feature id `profiles`; re-size `USAGE_CARDINALITY_LIMIT` (sized for 3 signals × orgs) |
| Forward mode | `forward_to_collector` | forward profiles too — collectors ≥0.148 accept them |
| Local CLI | `apps/cli/src/server/serve.ts` `Signal` union, decode/encode/route, `local-schema.sql` | same table in chDB so `maple local` shows profiles too |
| Self-obs | `metrics::native_rows` etc. keyed by `signal.path()` | falls out once the enum exists; add `maple.ingest.frame_count` to the encode span |

Frames come from the producer as-is. eBPF/native frames arrive **unsymbolized** (addresses +
mapping filename); we render those as `mapping!0x1234` in MVP and treat symbolization
(symbol upload / debuginfod) as explicitly out of scope — say so in the docs.

## 6. `effect-sdk` profiler (Node + Bun)

New optional module `packages/effect-sdk/src/server/profiling.ts`, off by default:

```ts
layer({ profiling: { cpu: true, heap: false, windowMs: 10_000, samplingUs: 1_000 } })
```

- Opens one `inspector.Session`; every `windowMs` it stops the current CPU profile, converts the
  V8 `cpuprofile` (`nodes[]` tree + `samples[]` + `timeDeltas[]`) into **our own aggregated form
  first** — group samples by stack, sum `timeDeltas` — then builds one `ExportProfilesServiceRequest`
  with a real `ProfilesDictionary` (dedupe strings/functions/stacks) and posts to
  `${endpoint}/v1development/profiles` on the existing flush path (`flush-core.ts` gets a
  `profilesUrl` next to traces/logs/metrics). Aggregating client-side is what keeps a 1 kHz
  profile at ~hundreds of stacks per window instead of 10 k samples.
- `heap: true` uses `HeapProfiler.startSampling` the same way → `alloc_space` / `alloc_objects`.
- **Span linking (Phase 2):** V8 samples carry timestamps; the SDK knows the active span per
  async context. A cheap first cut is to tag each window's samples with the spans that were open
  during them (`link_index`), accepting that concurrent requests smear. Precise attribution
  needs the eBPF-style per-runtime hooks and is not something the inspector API gives us. MVP
  ships time-window correlation on the query side, honestly labelled.
- Overhead: V8's sampling profiler is ~1–3% CPU at 1 kHz on a busy process; make `samplingUs`
  configurable and document it. `inspector` throws on Workers → the module detects the runtime
  and becomes a no-op layer with one warn log, never a startup failure.
- **Browser SDK loop-prevention:** `packages/browser` ignores `${endpoint}/v1/` — a
  `/v1development/` upload would escape that filter. Fix the regex to `/v1(development)?/` even
  though the browser SDK does not send profiles, so nothing else regresses.

Language guides: `apps/landing/src/content/docs/guides/instrumentation-{go,rust,python,java,…}.md`
each get a "Profiles" section pointing at the collector eBPF receiver or the language's pprof
route; the SDK overview stops saying "traces, logs, and metrics" (nine files say it today).

## 7. Query engine, API, UI

- **Query engine:** `tables.ts` `Profiles`, `queries/profiles.ts` (the five queries in §4),
  `CH.CHNumber` for every numeric column, `StackHash` always `toString()`-wrapped (SQL-catalog
  gate), exported from `ch/index.ts`; registry entries in `registry/profiles.ts` with
  `profile: "aggregation"` and cache policy like the service-overview queries.
- **API:** `V2ProfilesApiGroup` in `packages/domain/src/http/v2/telemetry.ts` (`/v2/profiles/
  flamegraph`, `/top-functions`, `/timeseries`, `/sample-types`) + `HttpV2ProfilesLive` in
  `apps/api/src/routes/v2/telemetry.http.ts`, following the logs group exactly. Flame graph is
  the one user-data-sized response → `compiledQueryBounded`.
- **UI:**
  - `routes/services/$serviceName.tsx`: `ServiceDetailTab` gains `"profiles"` (tab literal +
    trigger + body) → new `components/services/service-profiles-tab.tsx`.
  - `components/traces/span-detail-panel.tsx`: a `profile` tab next to `details / logs /
    infrastructure`, hidden when the service has no profiles in range (one cheap `sampleTypes`
    call).
  - New `packages/ui/src/components/profiles/flame-graph.tsx`: an **aggregate icicle**, not the
    trace waterfall — it folds `(frames[], value)` rows into a tree, lays out by share, and
    renders on canvas (the TanStack-canvas evaluation showed canvas is the right call for dense
    rectangles). Reuse the waterfall's tooltip and `color-by` palette so it reads as one family.
    Click-to-zoom, hover tooltip (self / total / share), text search that highlights matching
    frames. Keep it to that.
  - Data reads through `makeQueryAtomFamily` in `warehouse-query-atoms.ts` like everything else.

## 8. Phasing

**Phase 0 — spike (2–3 days).** Run the collector eBPF profiler on a Linux box → a hand-rolled
`/v1development/profiles` handler on a branch of ingest that dumps flattened rows into a scratch
ClickHouse table → run the flame-graph SQL from §4 by hand and eyeball a `d3-flame-graph` render.
Also point `async-profiler` (JVM) at it. Goals: confirm the proto crate builds, measure rows/s
and bytes/row for real producers, and see what unsymbolized eBPF frames look like in practice.
If the numbers or the shape surprise us, §4 changes _before_ any of the codegen work.

**Phase 1 — MVP (~3 engineer-weeks).**
1. Schema: datasource + MV + migration + insert-mapping regen + `ttl-override` (2 d).
2. Ingest: enums/routes/gRPC/decode/flatten/pipeline/billing + tests with recorded eBPF and
   SDK payloads (4–5 d).
3. Query engine + v2 API (2–3 d).
4. UI: flame graph component, service tab, span tab (4–5 d).
5. `effect-sdk` CPU profiler + docs (3 d).
6. `maple local` parity + landing docs sweep (1–2 d).

**Phase 2.** Heap profiles in the SDK; span-linked samples; MCP `top_functions` /
`flame_graph`; compare/diff view; Pyroscope push-API compatibility; dashboards widget +
alert rules on `timeseries`.

**Phase 3 (on OTel RC/GA).** Bump the proto, flip the SDK default path to `/v1/profiles`,
keep accepting `/v1development/`. Consider symbolization for native frames.

## 9. Risks and how the plan absorbs them

| Risk | Mitigation |
| --- | --- |
| Proto churn while Alpha | pinned crate; ingest is the only place that reads the wire; storage is our shape |
| Producer scarcity | three tiers in §2 — eBPF (zero-code, k8s), pprof via collector, our SDK; the spike proves two of them |
| Volume / cost | producers pre-aggregate; SDK aggregates per window; 7 d raw + 30 d hourly rollup; `Frames` LC-encoded; profiles metered as its own Autumn feature |
| Unsymbolized native frames look bad | render `mapping!addr`, document that symbolization is out of scope, keep JS/JVM/Go/.NET (which arrive symbolized) as the headline |
| Node inspector overhead / Workers | configurable rate, off by default, no-op on Workers |
| Trace correlation over-promised | MVP labels time-window correlation as such; span-linked lands in Phase 2 |
| Cardinality in ingest usage metrics | re-size `USAGE_CARDINALITY_LIMIT` when the 4th signal is added |

## 10. Decisions needed from you

1. **Pricing:** meter profiles as GB at the same rate as logs/traces, or a distinct SKU? (Ingest
   only needs the feature id; Autumn config is where this lands.)
2. **Retention defaults:** 7 d raw / 30 d rollup as proposed?
3. **Pyroscope push compatibility** in Phase 2 — worth it? It is the fastest route to Go/Python/
   Ruby/.NET customers but it is a non-OTel surface to maintain.
4. **Go / no-go on the spike.** It is the only cheap step; the rest of the plan is conditional
   on what it shows.

---

Sources: [OpenTelemetry Profiles enters public Alpha (2026)](https://opentelemetry.io/blog/2026/profiles-alpha/) ·
[Profiles spec](https://opentelemetry.io/docs/specs/otel/profiles/) ·
[Profiles concept page](https://opentelemetry.io/docs/concepts/signals/profiles/) ·
[OTLP spec (status table, paths)](https://opentelemetry.io/docs/specs/otlp/) ·
[The State of Profiling (2024)](https://opentelemetry.io/blog/2024/state-profiling/) ·
[ClickHouse: OTel profiles signal enters public alpha](https://clickhouse.com/resources/engineering/otel-news-profiles-signal) ·
[Elastic: OTel profiling alpha](https://www.elastic.co/observability-labs/blog/otel-profiling-alpha) ·
[Grafana Pyroscope: OTel eBPF profiler](https://grafana.com/docs/pyroscope/latest/configure-client/opentelemetry/ebpf-profiler/) ·
[Pyroscope 1.10 release notes](https://grafana.com/docs/pyroscope/latest/release-notes/v1-10/) ·
[proto `profiles.v1development` on buf.build](https://buf.build/opentelemetry/opentelemetry/file/5f2c7d4f740541589805e0816dad4bb0:opentelemetry/proto/profiles/v1development/profiles.proto)
