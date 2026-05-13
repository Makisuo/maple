# @maple/chat-agent

Node HTTP server that hosts the Maple AI chat handler on top of the [Electric Agents](https://electric.ax) runtime. Replaces the previous Cloudflare Worker chat agent.

## Prerequisites

The Electric Agents stack (postgres + Electric + agents-server) must be running locally. Use docker compose directly so we can pin server-side env that the CLI's `start` command doesn't expose:

```bash
ELECTRIC_AGENTS_PORT=4440 \
ELECTRIC_AGENTS_BASE_URL=http://localhost:4437 \
ELECTRIC_AGENTS_REWRITE_LOOPBACK_WEBHOOKS_TO=host.docker.internal:4700 \
ELECTRIC_AGENTS_SERVER_IMAGE_TAG=0.4.0 \
docker compose \
  -p electric-agents \
  -f node_modules/.bun/electric-ax@*/node_modules/electric-ax/docker-compose.full.yml \
  up -d
```

What these envs do:
- `ELECTRIC_AGENTS_PORT=4440` — host port (image listens on 4437 internally; this avoids the case where stale OrbStack forwards hold 4437).
- `ELECTRIC_AGENTS_BASE_URL=http://localhost:4437` — must be a **loopback** URL for the agents-server's internal webhook-forward to satisfy its own allowlist. (See upstream-bug #5 below.)
- `ELECTRIC_AGENTS_REWRITE_LOOPBACK_WEBHOOKS_TO=host.docker.internal:4700` — when the agents-server forwards a wake to our chat-agent, rewrite the stored `localhost:4700` URL to `host.docker.internal:4700` so it routes out of Docker back to the host.
- `ELECTRIC_AGENTS_SERVER_IMAGE_TAG=0.4.0` — 0.3.0 has a broken webhook-forward body parser; 0.4.0 fixes it.

## Environment (chat-agent itself)

```bash
# Where the agents-server is listening (the host-mapped port)
AGENTS_URL=http://localhost:4440

# This Node server
PORT=4700
SERVE_URL=http://host.docker.internal:4700

# Internal base URL the agents-server uses in wake payloads. We rewrite
# this back to AGENTS_URL inside `handleWebhookWithCallbackRewrite` so
# the runtime's claim/callback fetches work from the host.
AGENTS_INTERNAL_BASE_URL=http://localhost:4437

# Model
OPENROUTER_API_KEY=...

# Auth (matches the rest of the Maple stack)
MAPLE_AUTH_MODE=clerk          # or "self_hosted"
CLERK_SECRET_KEY=...
CLERK_PUBLISHABLE_KEY=...
CLERK_JWT_KEY=...
# OR for self-hosted:
MAPLE_ROOT_PASSWORD=...
```

## Run

```bash
bun --filter @maple/chat-agent dev
```

You should see:

```
[agent-runtime] Registered entity type: assistant
[chat-agent] listening on :4700 (agents-server: http://localhost:4440, types: assistant)
```

## HTTP routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/health` | Health + registered types |
| `POST` | `/webhook` | Wake events from agents-server (internal; body is rewritten to swap loopback URLs before delegating to the runtime) |
| `POST` | `/api/chat/:tabId/init` | Auth + spawn entity (idempotent) + return entity stream URL |
| `POST` | `/api/chat/:tabId/message` | Auth + spawn (idempotent) + post user message |

Entity URL convention: `/assistant/{orgId}--{tabId}`.

## Frontend integration

The web app's [`chat-conversation.tsx`](../web/src/components/chat/chat-conversation.tsx) calls:
1. `POST /api/chat/:tabId/init` once per tab to get the entity's `streamUrl`.
2. Polls that `streamUrl` every 1s via plain JSON GET. (See upstream-bug #3 — the bundled `useChat` + `useLiveQuery` + `db.preload()` integration doesn't surface events in v0.1.3.)
3. Builds user/assistant message sections from the stream events directly.
4. `POST /api/chat/:tabId/message` to send each user prompt.

## Known upstream issues (`@electric-ax/agents-runtime@0.1.3` / agents-server)

Every published version we tested still hits ≥1 of these. Pin to newer versions as they ship; revisit when the runtime stabilizes.

1. **`createRuntimeServerClient` / `createAgentsClient` drop the `/_electric/entities` prefix.** `spawnEntity` PUTs to `/${type}/${id}` and `getEntityInfo` GETs at the bare entity URL — both 404. Worked around: `src/server.ts` calls the REST API directly; frontend polls the stream JSON directly.

2. **`registerTypes()` uses the wrong subscription URL and body shape.** It PUTs to `${baseUrl}/${type}/**?subscription=...` with `{ webhook: "url" }`. The agents-server only routes `/v1/stream-meta/subscriptions/{id}` for subscription registration and expects `{ type: "webhook", webhook: { url }, pattern }`. The runtime's call silently no-ops, leaving `subscription_webhooks` empty and **wake events never fire**. Worked around: `registerWebhookSubscription()` re-issues the PUT with the correct URL/body. *(Only needed on agents-server <0.4.0; 0.4.0 auto-registers a per-entity webhook from `dispatch_policy`, so we no longer call this at startup — see the comment in `server.ts`.)*

3. **`db.preload()` + `useChat`/`useLiveQuery` never surface events.** The state-beta v0.3.1 client subscribes via `?live=sse` but its `subscribeJson`/`markUpToDate` plumbing doesn't reliably fire the `up-to-date` signal that commits pending writes to the live collections. So even when the stream returns the right data, the collections stay empty and `useChat` returns 0 sections. Worked around: the frontend polls the stream JSON URL directly and rebuilds `user_message` + `agent_response` sections from raw events. Drop this poller once the durable-streams stack stabilizes and re-test `useChat(db)`.

4. **Two concurrent PUTs for the same entity URL = both 500.** The bundled durable-streams server's `streamMetaToStream` returns `undefined` when racing on a freshly-committed LMDB row, throwing `TypeError: Cannot read properties of undefined (reading 'producers')`. React StrictMode double-mounts the chat panel in dev, so every new tab fires two simultaneous `/init` requests. Worked around: `spawnAssistantEntity()` single-flights concurrent spawns by `entityId`; the 500-but-actually-committed false-negative is recovered via `GET`.

5. **`publicUrl` must be loopback or webhook registration fails.** The agents-server's webhook URL allowlist rejects anything that isn't `localhost`/`127.0.0.x`. Setting `ELECTRIC_AGENTS_BASE_URL=http://localhost:4437` keeps the internal `webhook-forward` URL valid; we then use `ELECTRIC_AGENTS_REWRITE_LOOPBACK_WEBHOOKS_TO` to redirect the *outbound* delivery to `host.docker.internal:4700`. The wake notification we get still contains the in-container URL though, so `handleWebhookWithCallbackRewrite()` swaps `AGENTS_INTERNAL_BASE_URL` → `AGENTS_URL` before passing the body to the runtime.

6. **`runtime.onEnter` passes `Buffer` to `new Request(url, { body })`.** Node 24's undici rejects Buffer with `Cannot read properties of undefined (reading 'Symbol(kState)')`. Worked around: we construct the fetch Request ourselves (Uint8Array body) and call `runtime.handleWebhookRequest(req)` directly instead of `onEnter`. We also rewrite the runtime's `204 No Content` reply to `200 OK` because the agents-server proxy that relays our reply upstream uses undici's `new Response(body, { status })`, which throws on status 204.

7. **agents-server <0.4.0's webhook-forward body parser crashes on any non-empty body.** Tags as the same "Symbol(kState)" undici error. Upgrade to 0.4.0+.

8. **The runtime's `ctx.firstWake` is true on every wake.** Don't gate the handler on `if (ctx.firstWake) return` (per the philosopher example) — that pattern only sets up shared state. For a single-entity assistant, gate on whether `ctx.events` actually contains a `message_received` of type `user_message`. See `src/agents/assistant.ts`.

## Local-infra gotchas

- **Don't ever use the default `ELECTRIC_AGENTS_PORT=4437`.** OrbStack's container port-forward can survive a `docker rm`, leaving an unbindable phantom on 4437. We bind 4440 → 4437 to sidestep it.
- **`docker compose -p electric-agents down -v` is the surgical reset** when state drifts (orphaned entity rows, stale durable streams, Electric publication caches). The volumes only hold local dev data.
- **Schema drift on long-lived volumes.** The persistent `electric-agents-postgres-data` volume from older agents-server versions can leave Electric's cached publication out of sync (e.g. `tenant_id not found`). The `down -v` reset above clears it.
