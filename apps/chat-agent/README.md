# @maple/chat-agent

Node HTTP server that hosts the Maple AI chat handler on top of the
[Electric Agents](https://electric.ax) runtime. Replaces the previous
Cloudflare Worker chat agent.

## Quick start

```bash
# 1. Start postgres + electric + agents-server (Docker)
bun electric:up

# 2. Make sure your .env.local has OPENROUTER_API_KEY + Clerk vars set
#    (see .env.example at the repo root for the full block)

# 3. Run the chat-agent
bun --filter @maple/chat-agent dev
```

Expected output:

```
[chat-agent] agents-server reachable at http://localhost:4440
[agent-runtime] Registered entity type: assistant
[chat-agent] listening on :4700 (agents-server: http://localhost:4440, types: assistant)
```

When state drifts (orphaned entities, stale streams, schema mismatch after
an `agents-server` image bump), reset with `bun electric:reset` followed by
`bun electric:up`.

`bun electric:logs` tails the agents-server container.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│   web app                                                     │
│   POST /init        → spawn entity (idempotent)               │
│   POST /message     → server writes user message              │
│   useChatroom(id)   → TanStack DB collection (live)           │
└──────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│   chat-agent (Node :4700)                                      │
│   /init → spawnEntity (returns chatroomId)                     │
│   /message → POST shared-state event to agents-server          │
│   /webhook → rewrite loopback URLs → runtime.handleWebhook     │
└─────────────────────────────┬─────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│   electric-agents stack (Docker)                               │
│   agents-server :4440  postgres  electric                      │
└─────────────────────────────┬─────────────────────────────────┘
                              │ (wake-on-change → webhook)
┌─────────────────────────────▼─────────────────────────────────┐
│   assistant entity (src/agents/assistant.ts)                   │
│   observe(db(chatroomId, chatroomSchema))                      │
│   useAgent({ tools: [...mapleTools, send_message] })           │
│   send_message writes back into shared state                   │
└──────────────────────────────────────────────────────────────┘
```

Messages live in a **shared-state collection** keyed by the entity id
(`${orgId}--${tabId}`). Both the agent and the web client subscribe to the
same collection — the agent via `ctx.observe(db(...))`, the client via
`createAgentsClient().observe(db(...))` + TanStack DB's `useLiveQuery`.

Schema lives in [`@maple/domain/chat`](../../packages/domain/src/chat/).

## Environment

| Variable | Purpose |
|----------|---------|
| `AGENTS_URL` | Host-mapped port of the agents-server (default `http://localhost:4440`) |
| `AGENTS_INTERNAL_BASE_URL` | In-container loopback URL embedded in wake webhooks; rewritten back to `AGENTS_URL` |
| `PORT` | Port chat-agent listens on (default `4700`) |
| `SERVE_URL` | URL the agents-server uses to reach chat-agent (default `http://host.docker.internal:4700`) |
| `OPENROUTER_API_KEY` | Required — passes through to the assistant agent |
| `MAPLE_AUTH_MODE` | `clerk` (default) or `self_hosted` |
| `CLERK_SECRET_KEY` etc. | Clerk credentials when `MAPLE_AUTH_MODE=clerk` |
| `MAPLE_ROOT_PASSWORD` | HMAC secret when `MAPLE_AUTH_MODE=self_hosted` |
| `INTERNAL_SERVICE_TOKEN` | Used by Maple-tools to authenticate against the API service layer |

## HTTP routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/health` | Health + registered types |
| `POST` | `/webhook` | Wake events from agents-server (internal) |
| `POST` | `/api/chat/:tabId/init` | Auth + spawn entity (idempotent) — returns `{ entityUrl, chatroomId, agentsUrl }` |
| `POST` | `/api/chat/:tabId/message` | Auth + write user message into chatroom shared state |

Entity URL convention: `/assistant/{orgId}--{tabId}`. The `chatroomId` is
the same string — one shared-state stream per (orgId, tabId).

## Upstream issues

The chat-agent works around several agents-runtime / agents-server quirks
that are still open upstream. See
[`docs/electric-agents-upstream-issues.md`](../../docs/electric-agents-upstream-issues.md)
for the full list, what we do, and when each one can be deleted.
