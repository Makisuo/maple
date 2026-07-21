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
| Model | **Cloudflare Workers AI** via REST (`workers-ai-provider`), `@cf/zai-org/glm-5.2` | `createWorkersAI({ accountId, apiKey })` → an AI-SDK model, no Workers runtime needed; streams structured tool calls, 256K window (see Notes) |
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

Create an app at <https://api.slack.com/apps> **From an app manifest** and paste this. Leave the two
`request_url` placeholders as-is for now — you can't verify them until the service is deployed, so
step 3 comes back and fills them in:

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

**a. Create the service.** New service → deploy from this repo; set the service **Root Directory**
to `apps/slack-agent` (so the Docker build context is this folder). `railway.json` handles builder
+ healthcheck.

**b. Add Postgres and reference it.** `Cmd+K` (or right-click the canvas) → **Database** →
**Add PostgreSQL**. This creates a *separate service* — its `DATABASE_URL` is **not** automatically
visible to the agent. On the agent service, add a variable reference:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

(Substitute the Postgres service's name if you renamed it; the Variables UI's "Add Reference" picker
builds this for you.) Use `DATABASE_URL` — the private-network URL — not `DATABASE_PUBLIC_URL`,
which routes over the internet and bills egress. The entrypoint accepts either this or
`WORKFLOW_POSTGRES_URL`.

**c. Generate a public domain.** Railway does **not** expose a service by default — without this,
deploys go healthy but nothing external (including Slack) can reach them. Service → **Settings** →
**Networking** → **Generate Domain**, and give it the port the container listens on — **8080**
(`ENV PORT` in the Dockerfile; also set it as a service variable in (d) so Railway doesn't pick its
own). You get `https://<service>-<hash>.up.railway.app`; that host is what
every `<your-service>.up.railway.app` placeholder below refers to. Do this before setting the
variables in (d), since two of them embed the URL.

**d. Set service variables:**
  - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
  - `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
  - `PORT=8080` — set it explicitly. Railway injects a `PORT` of its own that overrides the image's
    `ENV PORT`, so pinning it here is what makes the value deterministic rather than assigned.
  - `WORKFLOW_LOCAL_BASE_URL=http://localhost:8080` — the durable-run callback target. See the note
    below for why this is loopback and not the public host.
  - (`EVE_WORKFLOW_WORLD` is already baked into the image at build time — no need to set it.)
  - optional: `ROUTE_AUTH_BASIC_PASSWORD` to lock the non-Slack HTTP routes.

Deploy. The entrypoint applies the Postgres-world schema, then starts eve. Check
`https://<your-service>.up.railway.app/eve/v1/health`.

> **`WORKFLOW_LOCAL_BASE_URL` should stay loopback.** `@workflow/world-postgres` runs its Graphile
> Worker *in-process*: when a durable step comes off the queue, `executeMessageOverHttp` POSTs it to
> `getExecutionBaseUrl()` — the service calling itself. Pointing it at the public
> `up.railway.app` host sends every durable step out to Railway's edge and back for no reason —
> billed egress plus a round-trip of latency. `<service>.railway.internal` avoids the egress but is
> still a needless hop and requires binding to `::`. The public domain from step (c) is for *inbound*
> traffic (Slack, health checks); it is not part of the workflow callback path.
>
> Leaving the variable unset also works — `getExecutionBaseUrl` falls back to `http://localhost:${PORT}`,
> and failing that probes for the port over the health endpoint. We set it explicitly anyway: with
> `PORT` pinned there's nothing to discover, and an explicit value is one less thing to reason about
> when a durable step doesn't fire.

The same setup from the CLI:

```bash
railway link                       # pick the project
railway add --database postgres
railway variables --service slack-agent --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway domain --service slack-agent --port 8080
```

Quote the `${{...}}` — it's Railway template syntax, and an unquoted `$` is shell expansion.

### 3. Point Slack at the deployment

The app you created in step 1 still has placeholder `request_url`s. Both must now point at
`https://<your-service>.up.railway.app/eve/v1/slack` (the host from step 2c).

> **The deployment has to be live before you paste the URL.** Slack verifies the endpoint
> *synchronously* when you save: it POSTs a `url_verification` challenge and expects the echoed
> `challenge` value back within ~3s. eve answers this automatically — but only if it's running.
> Confirm `/eve/v1/health` returns `{"ok":true}` first, or the save will just fail with
> "Your request URL didn't respond with the correct challenge value."

Go to <https://api.slack.com/apps> and select your app. Then either:

**Fastest — edit the manifest.** Left sidebar → **Features** → **App Manifest**. It's the same YAML
from step 1 in an editor; replace both `request_url` values and hit **Save Changes**. Slack runs the
challenge against the new URL on save.

**Or the individual pages** (same result, two screens):

| Setting | Where | Field |
| --- | --- | --- |
| Events | Sidebar → **Features** → **Event Subscriptions** | **Request URL** (toggle *Enable Events* on first) |
| Interactivity | Sidebar → **Features** → **Interactivity & Shortcuts** | **Request URL** (toggle on first) |

Both should show a green **Verified ✓** next to the field once saved. Event Subscriptions also needs
`app_mention` and `message.im` listed under *Subscribe to bot events* — the manifest from step 1 sets
these, so they should already be there.

Changing a request URL does **not** require reinstalling the app; only changing *scopes* does. (If
you did edit scopes, the sidebar shows a yellow reinstall banner — follow it, and note that
reinstalling issues a **new** `SLACK_BOT_TOKEN` that you must copy back into Railway.)

Finally, invite the bot to a channel — `/invite @eve-agent` — and `@mention` it.

## Verification

- `curl https://<host>/eve/v1/health` → `{"ok":true,"status":"ready",...}`
- `@mention` the bot → threaded reply with a typing indicator; ask "what time is it in Tokyo?" to
  exercise the `get_time` tool.
- A follow-up mention in the same thread resumes the same durable session.

## Notes

- **Model must support tool calling _while streaming_.** eve's harness is tool-driven and always
  streams, and that second half is the constraint that actually bites. Several Workers AI models
  parse tool calls only on non-streaming requests; streamed, they emit the model's raw tool-call
  JSON as ordinary text deltas, which the agent then posts into Slack verbatim:

  ```
  {"type": "function", "name": "ask_question", "parameters": {"prompt": "…", "allowFreeform": "true"}}
  ```

  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (the previous default) has exactly this bug — it
  returns a proper `tool_calls` array non-streaming, but streams the JSON as text. It also
  stringifies non-string arguments (`"allowFreeform": "true"`) even in the structured form.
  `@cf/zai-org/glm-5.2` (the current default) streams OpenAI-shaped incremental `delta.tool_calls`
  chunks — name and id on the first, argument fragments keyed by `index` after — terminated by
  `finish_reason: "tool_calls"`, which `workers-ai-provider` maps correctly. (The provider does have
  a text-salvage path for leaked tool calls, but it only engages for a *forced* tool choice — eve
  uses auto, so it never fires here.)

  Both `@cf/zai-org/glm-5.2` and `@cf/openai/gpt-oss-120b` are verified good. Workers AI prices
  them very differently, so the choice is a real trade-off:

  | Model | Context | $/M in | $/M out |
  | --- | --- | --- | --- |
  | `@cf/zai-org/glm-5.2` | 256K | 1.40 | 4.40 |
  | `@cf/openai/gpt-oss-120b` | 128K | 0.35 | 0.75 |
  | `@cf/zai-org/glm-4.7-flash` | 128K | 0.06 | 0.40 |

  We're on GLM-5.2 for headroom as Maple domain tools land — reasoning over traces and spans is a
  harder job than the generic tools here, and long Slack threads benefit from the 256K window. If
  spend becomes the concern before the tools get hard, gpt-oss-120b handled the current toolset
  identically at roughly a fifth the output cost.

  Before switching `WORKERS_AI_MODEL`, check the streaming shape directly:

  ```bash
  curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/<model>" \
    -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    -d '{"stream":true,"messages":[{"role":"user","content":"what time is it in Tokyo?"}],
         "tools":[{"type":"function","function":{"name":"get_time","description":"Get the time in a timezone.",
         "parameters":{"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]}}}]}'
  ```

  The SSE must carry `delta.tool_calls`, not a JSON blob inside `response`. Also set
  `WORKERS_AI_CONTEXT_WINDOW` to the new model's window.
- **Auth:** `agent/channels/eve.ts` leaves the browser/API routes public unless
  `ROUTE_AUTH_BASIC_PASSWORD` is set. The Slack webhook is always signature-verified independently.
- Edge Cloudflare Workers isn't used because the only Cloudflare Durable-Objects workflow world is
  built against an older `@workflow` protocol than eve 0.25 requires. Revisit when a `5.0.0-beta`
  Cloudflare world ships.
