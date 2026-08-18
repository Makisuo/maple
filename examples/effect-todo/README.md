# Effect Todo — traced into Maple local mode

A tiny end-to-end demo of Maple's value: a real browser click produces **one
distributed trace** that flows **browser → Effect backend → downstream service →
simulated webhook**, visible live in Maple's local-mode UI.

```
┌──────────────┐  HTTP + traceparent  ┌──────────────┐  HTTP + traceparent  ┌────────────────┐
│   todo-web    │ ───────────────────▶ │   todo-api    │ ───────────────────▶ │  todo-notifier  │
│ React +       │                      │ Effect (Bun)  │                      │ Effect (Bun)    │
│ effect-atom   │                      │ cache + store │                      │ template cache  │
└──────┬───────┘                      └──────┬───────┘                      └───────┬────────┘
       │  OTLP                                │  OTLP                                │  OTLP
       │                                      │                                      │ ┄▶ webhooks
       └──────────────────┬───────────────────┴──────────────────────────────────────┘   (simulated)
                          ▼
            maple start  (OTLP ingest :4318, embedded ClickHouse)
```

All three services are instrumented with `@maple-dev/effect-sdk` (client +
server presets). Because they all speak Effect's HTTP stack, every request
auto-carries a W3C `traceparent` header, so the browser span, the API span and
the notifier span share one trace — which is what draws the service-map chain.

## Stack

- **Frontend** — React + Vite + [`effect-atom`](https://github.com/tim-smart/effect-atom),
  talking to the backend through a shared `HttpApi` contract (`shared/api.ts`).
  Each interaction runs inside its own `ui.todo.*` span (`web/src/lib/actions.ts`),
  so the trace records what the user did, not just which URL was hit.
- **Backend** (`todo-api`) — Effect HTTP server on Bun with a `Ref`-backed store
  behind a read-through cache. Emits `cache.get` / `cache.set` / `db.*` spans
  with OTel database semconv attributes, span events, counters + a latency
  histogram, structured logs, and two distinct error classes.
- **Notifier** (`todo-notifier`) — a second Effect service called on every
  mutation. Template cache spans, a simulated outbound webhook (CLIENT span with
  `peer.service`, so an external dependency node appears on the service map), a
  slow tail on ~8% of dispatches, and its own `NotifyDispatchError` on ~10%.
- **Sink** — Maple local mode (`maple start`).

## Run it

From the repo root, once: `bun install`.

Then four terminals (or one `bun run dev`, which starts all three services):

```bash
# 1. Telemetry sink (embedded ClickHouse, OTLP on :4318)
maple start

# 2. Effect backend   → http://localhost:4500
cd examples/effect-todo && bun run server

# 3. Notifier service → http://localhost:4502
cd examples/effect-todo && bun run notifier

# 4. React frontend   → http://localhost:4501
cd examples/effect-todo && bun run web
```

Open <http://localhost:4501>, add / toggle / delete a few todos (some toggles
fail on purpose; submitting an empty title is rejected on purpose). Then explore
the telemetry:

```bash
maple services                 # todo-web, todo-api, todo-notifier
maple service-map              # the todo-web → todo-api → todo-notifier chain
maple traces                   # recent traces; copy an id…
maple trace <id>               # …to see the full browser → api → notifier tree
maple slow-traces              # the notifier's simulated slow tail
maple errors                   # ToggleFailedError / InvalidTodoError / NotifyDispatchError
maple logs                     # todo.created / todo.toggled / notification.dispatched / …
maple metrics                  # todo.operations, todo.operation.duration, todo.items
```

…or open the local-mode dashboard the `maple start` banner prints.

### What's worth looking at

- **One trace, three services.** `ui.todo.toggle` (browser) → `POST /api/todos/:id/toggle`
  (api) → `TodoService.toggle` → `db.persist` → `todo.notify` → the notifier's
  server span → `cache.get` → `POST /v1/notify`.
- **Cache behaviour in the waterfall.** Load the list twice without changing
  anything: the second `TodoService.list` is a `cache.hit` and skips `db.read`
  entirely. Any write invalidates it (a `todo.cache.invalidated` span event).
- **An error the status code hides.** When the notifier fails, `todo-api`
  swallows it — the user's request returns 200 while the trace shows an `Error`
  span two levels down, plus a `webhook.retry_exhausted` span event.
- **Two shapes of failure.** `ToggleFailedError` is a random flake;
  `InvalidTodoError` is deterministic (submit an empty title).

## Config

Everything defaults to the local sink. Override with env vars if needed:

| var                   | side     | default                 |
| --------------------- | -------- | ----------------------- |
| `MAPLE_ENDPOINT`      | server   | `http://127.0.0.1:4318` |
| `VITE_MAPLE_ENDPOINT` | web      | `http://127.0.0.1:4318` |
| `VITE_API_BASE_URL`   | web      | `http://127.0.0.1:4500` |
| `PORT`                | server   | `4500`                  |
| `NOTIFIER_PORT`       | notifier | `4502`                  |
| `NOTIFIER_URL`        | server   | `http://127.0.0.1:4502` |

No ingest key is needed: local mode doesn't authenticate, it gates on request
origin.

### Sessions and replay are not part of this demo

`maple start` serves only the OTLP routes (`/v1/traces`, `/v1/logs`,
`/v1/metrics`). Session metadata and rrweb replay chunks post to
`/v1/sessionReplays/meta` and `/v1/sessionReplays/blob`, which local mode does
not implement — so `web/src/lib/otel.ts` sets `replay: { enabled: false }` and
`emitSessionMeta: false` explicitly. For Sessions and Session Replay, point
`VITE_MAPLE_ENDPOINT` at a hosted Maple ingest and pass an ingest key (or use
`@maple-dev/browser`, the dedicated RUM + replay SDK).

## Layout

```
shared/api.ts          # the todo HttpApi contract, used by web + server
shared/notifier-api.ts # the notifier HttpApi contract, used by server + notifier
server/main.ts         # Bun server: HttpApiBuilder handler + CORS + Maple telemetry
server/TodoService.ts  # store, cache spans, span events, metrics, notifier call
server/NotifierClient.ts # typed client for todo-notifier (traceparent propagation)
notifier/main.ts       # the todo-notifier Bun server
notifier/NotificationService.ts # template cache, simulated webhook, slow tail, failures
web/src/lib/           # otel.ts (client tracing), actions.ts (traced UI actions), …
web/src/App.tsx        # the todo UI
```
