# Agentic Journeys — Implementation Brief

Companion to [`agentic-journeys-design-brief.md`](agentic-journeys-design-brief.md), which defines
what the screen looks like. This brief defines how to build it.

Scope: the **journey detail view** end to end — warehouse query, API route, web route, components.
The list/index view is out of scope.

## Principle: no new infrastructure

Every `gen_ai.*` attribute already lands in the `traces` datasource today —
`SpanAttributes` is `Map(LowCardinality(String), String)`, so nothing is dropped on ingest. There is
no new deployable, no new signal type, no ingest change. This is a read model plus UI.

**`replays` is the same feature shape** — a chronological transcript reconstructed from warehouse
rows, with a detail route and a filter/list route. Read those files before writing new ones and
follow their structure rather than inventing one.

## Build order

Ship a working view against raw `traces` first. Do **not** start with a materialized view: MVs in
ClickHouse only populate going forward, so an MV-first approach means waiting for new data to
accumulate before you can see anything. Add the MV when the raw query is measurably slow.

Test data exists on day one: Maple's own AI triage loop already emits conformant `gen_ai.*` spans —
`operation.name`, `provider.name`, `request.model`, and token usage in
[`AiTriageWorkflow.run.ts`](../apps/api/src/workflows/AiTriageWorkflow.run.ts) — so a
self-observability org (see `CLAUDE.md`) has real journeys without any new instrumentation. For
multi-turn content-bearing fixtures, OpenRouter Broadcast traces from local chat are the richer
source.

### 1. Warehouse query — `packages/query-engine/src/ch/queries/genai.ts`

Export from `packages/query-engine/src/ch/index.ts`. Follow
[`session-events.ts`](../packages/query-engine/src/ch/queries/session-events.ts) — it is the closest
analogue (an ordered transcript for one entity).

Two queries to start:

- **Journey summary** — one row: duration, models, token totals, cost, turn count, error state.
- **Journey timeline** — all spans for the journey, ordered by `Timestamp`.

Hard requirements:

- Every query **must** filter `OrgId` (`$.OrgId.eq(param.string("orgId"))`) — enforced at runtime.
- `rowSchema` numeric fields use `CH.CHNumber`, never `Schema.Number`.
- `Duration` is UInt64 **nanoseconds** — divide by `1_000_000` for ms, as `traces.ts` does.
- Filter to GenAI spans via `SpanAttributes['gen_ai.operation.name'] != ''`.

**Normalize attribute churn in one place, in the query.** The `gen_ai.*` conventions are still
marked Development and have already renamed once (`gen_ai.system` → `gen_ai.provider.name`). Use the
same `if(a != '', a, b)` coalescing pattern that `trace_list_mv` uses for
`http.method` / `http.request.method`. When the spec churns again it should be one edit here, not a
sweep through components.

### 2. Journey identity

The grouping key is the one real modeling decision. Three attributes compete, and which one is
present depends entirely on who instrumented the caller:

- `gen_ai.conversation.id` — the semconv-blessed one
- `session.id` — what OpenRouter Broadcast emits for Maple's own traffic, from the `session_id`
  Maple sends per request (the `ChatSessionId` `<orgId>:<tabId>` for chat, `triage_<kind>_<id>` for
  triage — see [`chat-session.ts`](../packages/domain/src/chat-session.ts) and
  [`openrouter-tracing.md`](openrouter-tracing.md))
- `TraceId` — always present, but only covers a single turn

Coalesce all three, in that order, into a single derived `JourneyId`. This is the seam that makes the
feature provider-portable — get it wrong and the view only works for one instrumentation stack.

Two subtleties in that coalesce:

- **Check `ResourceAttributes` too.** `session.id` is set as a resource attribute by some emitters
  (browser SDKs, some agent frameworks) and as a span attribute by others. Coalesce across both maps
  before falling back to `TraceId`, and verify where each real emitter puts it.
- **Resolve identity per trace, not per span.** If only some spans in a conversation carry
  `conversation.id`, a per-span coalesce splits one journey into fragments (the bare spans fall back
  to their `TraceId`). All spans of a trace share `TraceId`, so pick the journey key at trace
  granularity — e.g. the best key present anywhere in the trace — then group.

### Attribute names to read

The design brief deliberately speaks in roles; implementation needs names. Coalesce both
generations wherever two exist (new name first):

| Role | Attribute | Legacy fallback |
| --- | --- | --- |
| Operation | `gen_ai.operation.name` | — |
| Provider | `gen_ai.provider.name` | `gen_ai.system` |
| Requested model | `gen_ai.request.model` | — |
| Served model | `gen_ai.response.model` | — |
| Input tokens | `gen_ai.usage.input_tokens` | `gen_ai.usage.prompt_tokens` |
| Output tokens | `gen_ai.usage.output_tokens` | `gen_ai.usage.completion_tokens` |
| Finish reason | `gen_ai.response.finish_reasons` | — |
| Input messages | `gen_ai.input.messages` | `gen_ai.prompt` |
| Output messages | `gen_ai.output.messages` | `gen_ai.completion` |
| System prompt | `gen_ai.system_instructions` | — |
| Tool name / call id | `gen_ai.request.tool.name` / `gen_ai.tool.call.id` | `gen_ai.tool.name` |

Verify each against real rows before trusting this table — query a self-observability org's
`traces` for `SpanAttributeItems` and look at what actually arrives.

**Cost has no stable semconv attribute.** OpenRouter Broadcast sends it; the exact key must be read
off real rows, not this document. Make cost nullable end to end (schema, header, per-message) —
most emitters won't send it, and the header should omit the stat rather than show $0.00.

### 3. API contract — `packages/domain/src/http/genai.ts`

Request/response schemas in Effect Schema (not Zod). Register the group in
`packages/domain/src/http/api.ts`. Use `Schema.optionalKey()` for JSON-decoded fields;
`Schema.optional()` only where `undefined` is a real JS value.

### 4. API route — `apps/api/src/routes/v1/genai.http.ts`

Follow [`session-replay.http.ts`](../apps/api/src/routes/v1/session-replay.http.ts):
`HttpApiBuilder.group(MapleApi, "<group>", …)`, resolve `CurrentTenant.Context`, annotate the span
with `orgId`, then:

```typescript
const compiled = CH.compile(CH.journeyTimelineQuery({ journeyId }), { orgId, startTime, endTime })
const rows = yield* warehouse.compiledQuery(tenant, compiled, {
  profile: "list",
  context: "journeyTimeline",
})
```

Register the layer in `apps/api/src/app.ts`.

### 5. Web read path

- Client function in `apps/web/src/api/warehouse/genai.ts` (`Effect.fn("...")`), mirroring
  [`replays.ts`](../apps/web/src/api/warehouse/replays.ts).
- Wrap it with `makeQueryAtomFamily` in
  [`warehouse-query-atoms.ts`](../apps/web/src/lib/services/atoms/warehouse-query-atoms.ts).
- Route at `apps/web/src/routes/journeys/$journeyId.tsx`, components under
  `apps/web/src/components/journeys/`. Mirror `replays/$sessionId.tsx`.
- Search params via `Schema.toStandardSchemaV1()` for `validateSearch`.

## Two traps specific to this data

**Message arrays are cumulative.** `gen_ai.input.messages` on each inference span contains the
*entire prior conversation*, not just the new turn — that's how chat completion APIs work. Rendering
every span's `input.messages` verbatim produces N² duplication and a wrong-looking transcript. Build
the timeline from **each span's output plus only the newest input message**, or dedupe across spans.
Verify against a real multi-turn journey before wiring up the UI; this is not visible with a
single-turn test fixture.

**Tool calls are sibling spans, not fields.** An `execute_tool` operation is its own span carrying
`gen_ai.request.tool.name`, `.type`, and `.call_id`. Associate it with its triggering assistant
message by `call_id`, falling back to span parentage. The design nests them under that message.

## Content may be absent

`gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions` are optional and
frequently stripped for privacy — OpenRouter's Privacy Mode removes exactly these while keeping all
timing, model, token, and cost data. The design brief specifies a first-class degraded state for
this. Treat missing content as **expected**, not as an error path: no empty-state-that-looks-broken,
no failed decode. Cover it with a test fixture.

**Content may also live in span events, not attributes.** Older GenAI instrumentation (OpenLLMetry
and pre-1.37 SDKs) emitted prompts/completions as span *events* (`gen_ai.content.prompt`,
`gen_ai.choice`, …). The `traces` datasource keeps these — `EventsName` / `EventsAttributes`
parallel arrays. First cut: attributes only is fine, but the row model and decode must tolerate
attribute-less spans whose content sits in events (they render as content-redacted, not as a crash),
and reading events is the obvious follow-up.

## Entry point and time window

The list view is out of scope, so **nothing navigates to this route yet** — that's expected. Don't
build a list to compensate; verify by constructing the URL by hand from a known journey id. Do not
add a sidebar nav entry in this pass.

`CH.compile` requires `startTime`/`endTime`, and a `JourneyId` alone doesn't bound the scan. Give
the route a time-range search param (validated with `Schema.toStandardSchemaV1()`) and default it
wide — e.g. last 7 days — when absent. A journey near the window edge being cut off is acceptable
for now; a required param that makes hand-built URLs fail is not.

## Test data

Extend [`scripts/ingest-dummy-traces.ts`](../scripts/ingest-dummy-traces.ts) (`bun run
ingest:dummy`) with synthetic journeys covering every state the design brief names — this is the
only way to get deterministic coverage; live OpenRouter traffic can't produce a failed tool call on
demand. Gateway is `https://ingest.localhost` (port 3474), OTLP/JSON with camelCase keys and hex
ids. Two local-stack traps: `bun dev` does **not** start the otel-collector — without it running
(contrib image on :4318, forwarding to Tinybird local on :7181) ingested OTLP returns 200 but never
reaches the warehouse; and dashboard-wide 502/503s mean the dev Postgres (5499) or Tinybird local
(7181) docker containers are down. Fixtures to emit, minimum:

1. Multi-turn journey with **cumulative** `input.messages` (each span repeats prior turns) — this is
   what exposes the N² dedupe trap.
2. A turn firing two tool-call spans in parallel, one failed.
3. A content-redacted journey: timing/model/tokens present, all message content absent.
4. A multi-model journey (mid-conversation model switch) with requested ≠ served model.

## Deferred, but don't foreclose

Both of these are in the design brief as structural considerations. Keep the timeline's row model
polymorphic from the start so they slot in without a rewrite:

- **Non-message operations** — `retrieval`, memory operations, `plan`, `invoke_agent` are all
  first-class span types in the standard, not just `chat`.
- **Multi-agent handoffs** — `gen_ai.agent.name` / `.id` / `gen_ai.workflow.name` mean one journey
  can span several agents.

## Later: the materialized view

When the raw query gets slow, add a `genai_spans_mv` → `genai_spans` pair in
`packages/domain/src/tinybird/`, using [`traceListMvMv`](../packages/domain/src/tinybird/materializations.ts)
as the template. Pre-extract operation, provider, requested/served model, token counts, and the
derived `JourneyId`; sort by `(OrgId, JourneyId, Timestamp)` so a journey is a contiguous range scan
— the same trick `session_events` uses. Move the attribute coalescing from the query into the MV SQL.

Then run `bun run tinybird:manifest`.

**Watch the facet/filter invariant.** If list counts come from the MV while filters run against raw
`traces`, any difference in normalization makes filters return zero rows. Trace facets have hit this
exact bug before — whatever normalization the MV applies, the raw-table filter path must apply
identically.

## Conventions

- `@/` path alias. `apps/web/src/routeTree.gen.ts` is generated and regenerates on
  typecheck/vitest/dev — never `git add -A`; revert it before committing.
- Span status codes are Title case: `"Ok"`, `"Error"`, `"Unset"`.
- UI is shadcn/Base UI + Tailwind 4. Icons come from the local Nucleo DB, ported into
  `apps/web/src/components/icons/` — see `CLAUDE.md` for the lookup query.
- Tests: `bun run test` (Vitest via turbo), **not** `bun test` (that's Bun's own runner).
  `bun typecheck` before handing off.
- Done means **verified in the browser**: ingest the dummy journeys, sign in at
  `https://web.localhost` (Clerk test account in `CLAUDE.md`), open each fixture journey by URL,
  and check every design-brief state renders — especially cumulative-input dedupe and the
  redacted journey. jsdom tests alone don't count for this feature; the traps here are visual.
