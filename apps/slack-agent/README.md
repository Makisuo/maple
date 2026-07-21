# @maple/slack-agent

A general-purpose Slack agent built on the [eve](https://eve.dev) framework, **self-deployed to
Railway** (no Vercel). It answers `@mentions` and DMs, runs tools, and keeps durable multi-turn
sessions.

This is intentionally **generic** — no Maple domain logic yet. Get the loop working end-to-end
first, then layer domain tools/instructions on top.

## Architecture

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | eve `0.25.x` (durable agent runtime, Nitro HTTP host) | filesystem-first agents |
| Host | **Railway** container running `eve start` (long-running Node) | eve's supported self-host model; edge Workers is blocked today by a workflow-world protocol gap |
| Model | **Cloudflare Workers AI** via REST (`workers-ai-provider`) | `createWorkersAI({ accountId, apiKey })` → an AI-SDK model, no Workers runtime needed |
| Durability | **`@workflow/world-postgres`** (`5.0.0-beta.27`) + Railway Postgres | protocol-compatible with eve's vendored `@workflow/*` 5.0.0-beta line |
| Slack | **self-managed** (`slackChannel()` + bot token + signing secret) | Vercel Connect is optional; eve verifies webhooks from the signing secret natively |

Key routes (all served by the one container): `POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`,
`POST /eve/v1/slack` (Slack webhook), `GET /eve/v1/health`, and workflow callbacks under
`/.well-known/workflow/v1/flow`.

## Project layout

```
agent/
  agent.ts            # model (Workers AI) + workflow world selection
  instructions.md     # system prompt
  channels/slack.ts   # self-managed Slack channel
  channels/eve.ts     # auth policy for the browser/API routes
  tools/get_time.ts   # sample tool proving the tool loop
Dockerfile            # node:24-slim (+bun for installs), eve build, entrypoint
docker-entrypoint.sh  # runs the Postgres-world migration, then `eve start`
railway.json          # DOCKERFILE builder, /eve/v1/health healthcheck
```

> **Monorepo note:** this app uses **bun** (like the rest of the repo) but is deliberately a
> **standalone bun project, excluded from the bun workspace** (`"!apps/slack-agent"` in the root
> `package.json`). That keeps `eve dev`'s interactive TUI out of `bun dev`/`turbo`, and keeps the
> Docker build hermetic (context = this folder only). It has its own `bun.lock`.

> **Runtime: Node, package manager: bun.** eve runs on **Node ≥24** (it hard-fails below that), and
> **cannot run on bun** — `eve dev`'s HMR server uses `crossws`' Node adapter, which throws
> `[crossws] Using Node.js adapter in an incompatible environment` under bun. Production `.output`
> *does* happen to run on bun, but we deliberately use Node in both places so local and container
> match. Bun is still the package manager (`bun install`, `bun.lock`), and `bun run <script>` is fine
> — it honors the `#!/usr/bin/env node` shebang and hands off to Node.

## Local development

```bash
cd apps/slack-agent
cp .env.local.example .env.local   # fill in CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
bun install
bun run dev                        # eve terminal UI — chat with the agent, test tools
```

Leaving `EVE_WORKFLOW_WORLD` unset locally uses eve's zero-config on-disk world, so you don't need
Postgres to iterate on model + tools. To exercise the Postgres world locally: run a Postgres, set
`DATABASE_URL` **and** `EVE_WORKFLOW_WORLD=@workflow/world-postgres` in `.env.local`, run
`bun run db:setup` once, then `bun run dev`.

> ⚠️ **`EVE_WORKFLOW_WORLD` is resolved at build time**, not runtime — eve compiles `agent.ts` into
> its manifest. It must be set when `eve build` runs. Setting it only as a runtime variable leaves
> you silently on the ephemeral on-disk world. The Dockerfile sets it before `bun run build`.

Drive the HTTP contract without the UI:

```bash
bunx eve dev --no-ui
curl -X POST localhost:<port>/eve/v1/session -H 'content-type: application/json' -d '{"message":"hi"}'
```

## Deploy — external steps (you perform these)

### 1. Create the Slack app

Create an app at <https://api.slack.com/apps> **From an app manifest** and paste this (swap the two
`request_url`s for your Railway URL after step 2, then reinstall):

```yaml
display_information:
  name: Eve Agent
features:
  bot_user:
    display_name: eve-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # receive @mentions
      - chat:write          # post replies
      - im:history          # read DMs (message.im)
      - im:write            # DM the user (auth challenges)
      - users:read          # attribute speakers
settings:
  event_subscriptions:
    request_url: https://<your-service>.up.railway.app/eve/v1/slack
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
    request_url: https://<your-service>.up.railway.app/eve/v1/slack
  socket_mode_enabled: false
```

Install to your workspace, then copy the **Bot User OAuth Token** (`xoxb-…`) and the **Signing
Secret** (Basic Information).

### 2. Create the Railway service

- New service → deploy from this repo; set the service **Root Directory** to `apps/slack-agent`
  (so the Docker build context is this folder). `railway.json` handles builder + healthcheck.
- Add the **Postgres** plugin (provides `DATABASE_URL`).
- Set service variables:
  - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
  - `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
  - `WORKFLOW_LOCAL_BASE_URL=https://<your-service>.up.railway.app` (so durable-run callbacks reach
    `/.well-known/workflow/v1/flow`)
  - (`EVE_WORKFLOW_WORLD` is already baked into the image at build time — no need to set it.)
  - optional: `ROUTE_AUTH_BASIC_PASSWORD` to lock the non-Slack HTTP routes.

Deploy. The entrypoint applies the Postgres-world schema, then starts eve. Check
`https://<your-service>.up.railway.app/eve/v1/health`.

### 3. Point Slack at the deployment

Set both `request_url`s in the Slack app to `https://<your-service>.up.railway.app/eve/v1/slack`.
Slack sends a one-time `url_verification` challenge that eve answers automatically. Invite the bot
to a channel and `@mention` it.

## Verification

- `curl https://<host>/eve/v1/health` → `{"ok":true,"status":"ready",...}`
- `@mention` the bot → threaded reply with a typing indicator; ask "what time is it in Tokyo?" to
  exercise the `get_time` tool.
- A follow-up mention in the same thread resumes the same durable session.

## Notes

- **Model must support tool calling** — eve's default harness is tool-driven. The default
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` does; if you switch models, keep that constraint and
  set `WORKERS_AI_CONTEXT_WINDOW` to the new window.
- **Auth:** `agent/channels/eve.ts` leaves the browser/API routes public unless
  `ROUTE_AUTH_BASIC_PASSWORD` is set. The Slack webhook is always signature-verified independently.
- Edge Cloudflare Workers isn't used because the only Cloudflare Durable-Objects workflow world is
  built against an older `@workflow` protocol than eve 0.25 requires. Revisit when a `5.0.0-beta`
  Cloudflare world ships.
