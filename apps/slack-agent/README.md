# @maple/slack-agent

A general-purpose Slack agent built on the [eve](https://eve.dev) framework, **self-deployed to
Railway** (no Vercel). It answers `@mentions` and DMs, runs tools, and keeps durable multi-turn
sessions.

It is **multi-workspace**: a single Slack app is distributed to many workspaces, and each
workspace is linked to one Maple organization. Per-team installs (bot token + Maple API key) live
in Maple's API; the agent resolves them per request and talks to Maple's MCP server for
observability tools. See [Multi-workspace architecture](#multi-workspace-architecture).

## Architecture

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | eve `0.25.x` (durable agent runtime, Nitro HTTP host) | filesystem-first agents |
| Host | **Railway** container running `eve start` (long-running Node) | eve's supported self-host model; edge Workers is blocked today by a workflow-world protocol gap |
| Model | **Cloudflare Workers AI** via REST (`workers-ai-provider`), `@cf/zai-org/glm-5.2` | `createWorkersAI({ accountId, apiKey })` → an AI-SDK model, no Workers runtime needed; streams structured tool calls, 256K window (see Notes) |
| Durability | **`@workflow/world-postgres`** (`5.0.0-beta.27`) + Railway Postgres | protocol-compatible with eve's vendored `@workflow/*` 5.0.0-beta line |
| Slack | **self-managed, multi-workspace** (`slackChannel()` + custom `webhookVerifier` + per-team `botToken`) | one public app across many workspaces; static signing secret verifies inbound, per-team bot token resolved from the Maple API — see [Multi-workspace architecture](#multi-workspace-architecture) |
| Maple | **resolve endpoint** (`/internal/slack/workspaces/:teamId`) + **MCP** (`/mcp`) | per-team install lookup (TTL-cached) and observability tools scoped per org |

Key routes (all served by the one container): `POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`,
`POST /eve/v1/slack` (Slack webhook), `GET /eve/v1/health`, and workflow callbacks under
`/.well-known/workflow/v1/flow`.

## Project layout

```
agent/
  agent.ts            # model (Workers AI) + workflow world selection
  instructions.md     # system prompt (Slack-adapted port of chat-flue's SYSTEM_PROMPT)
  instructions/maple-app-url.ts # injects MAPLE_APP_BASE_URL for deep links at session start
  instrumentation.ts  # OTel NodeSDK export to Maple's ingest (maple-slack-agent service)
  skills/dashboard-builder/     # test-before-propose dashboard workflow (load_skill)
  skills/incident-investigation/ # alert/incident root-cause procedure (load_skill)
  lib/maple.ts        # Maple resolve client (TTL cache), Slack sig verify, per-team bot token
  lib/approval.ts     # mutating-tool set + HITL approval policy for the MCP connection
  hooks/outcome-log.ts # unconditional turn/tool failure logging (Railway logs)
  channels/slack.ts   # multi-workspace Slack channel (webhookVerifier + per-team botToken)
  channels/eve.ts     # auth policy for the browser/API routes
  connections/maple.ts # Maple MCP connection (per-workspace API key auth + approval gate)
  tools/get_time.ts   # sample tool proving the tool loop
  tools/render_chart.ts # renders a PNG chart in-process and posts it into the thread
  lib/chart.ts        # pure SVG chart renderer + unicode-sparkline fallback
  lib/slack-upload.ts # Slack external-upload flow (files.getUploadURLExternal → complete)
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

Run the tests (bun's native runner; covers the signature verification, bot-token resolution, and
the resolve cache in `agent/lib/maple.ts` — no network, fetch is stubbed):

```bash
bun test
```

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
  name: Maple
features:
  bot_user:
    display_name: maple
    always_online: true
oauth_config:
  # OAuth completes at the MAPLE API (not this agent). Maple stores the per-team
  # install (bot token + Maple API key) that this agent later resolves.
  redirect_urls:
    - https://<your-maple-api-host>/oauth/slack/callback
  scopes:
    bot:
      - app_mentions:read   # receive @mentions
      - chat:write          # post replies
      - chat:write.public   # post in channels the bot isn't a member of
      - channels:read       # resolve public channel metadata
      - channels:history
      - files:write         # upload rendered chart images (render_chart tool)
      - groups:read         # resolve private channel metadata
      - groups:history      # thread context + follow-ups in private channels
      - im:history          # read DM history (message.im)
      - im:read             # resolve DM conversation metadata
      - im:write            # open/DM the user
      - users:read          # attribute speakers
settings:
  event_subscriptions:
    request_url: https://<your-service>.up.railway.app/eve/v1/slack
    bot_events:
      - app_mention
      - message.im
      # Thread follow-ups without re-mentioning the bot: replies in threads the
      # bot is engaged in are promoted to app_mention by the webhookVerifier
      # (agent/lib/thread-follow-up.ts). Only channels the bot is a member of
      # deliver these events.
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
    request_url: https://<your-service>.up.railway.app/eve/v1/slack
  socket_mode_enabled: false
  # Enable public distribution so multiple workspaces can install the app.
  # (Slack → Manage Distribution → Activate Public Distribution; requires the
  # redirect URL above and passing Slack's "Remove Hard Coded Information" check.)
  org_deploy_enabled: false
```

Two request URLs point at **this agent** (Event Subscriptions + Interactivity → the Railway host);
the OAuth **redirect URL** points at the **Maple API** — that is where install/OAuth completes and
where the per-team bot token + Maple API key are stored for this agent to resolve. In
single-workspace dev you can skip distribution: install to one workspace and set `SLACK_BOT_TOKEN`.
Copy the **Signing Secret** (Basic Information) in all cases.

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
  - `SLACK_SIGNING_SECRET` — per-app/static; HMAC-verifies every inbound webhook.
  - `MAPLE_API_BASE_URL` — the Maple API base (e.g. `https://api.maple.dev`). **Also needed at build
    time**: it forms the Maple MCP connection URL, which eve bakes into its manifest at build (like
    `EVE_WORKFLOW_WORLD`). Railway exposes service variables as Docker build args (the Dockerfile
    declares `ARG MAPLE_API_BASE_URL`), so setting it as a service variable covers both build and
    runtime. If it is missing at build, the URL silently bakes to `https://api.localhost`.
  - `MAPLE_INTERNAL_SERVICE_TOKEN` — the internal service token; the agent sends it as
    `Authorization: Bearer maple_svc_<token>` to the resolve endpoint. Runtime-only.
  - `SLACK_BOT_TOKEN` — **omit in multi-workspace production** (the bot token is resolved per team
    from Maple). Set it only to run against a single workspace with no Maple mapping (dev).
  - `PORT=8080` — set it explicitly. Railway injects a `PORT` of its own that overrides the image's
    `ENV PORT`, so pinning it here is what makes the value deterministic rather than assigned.
  - `WORKFLOW_LOCAL_BASE_URL=http://localhost:8080` — the durable-run callback target. See the note
    below for why this is loopback and not the public host.
  - (`EVE_WORKFLOW_WORLD` is already baked into the image at build time — no need to set it.)
  - `ROUTE_AUTH_BASIC_PASSWORD` (+ optional `ROUTE_AUTH_BASIC_USER`, default `admin`) — locks the
    non-Slack HTTP routes (session/stream) behind HTTP Basic. **Effectively required in
    production**: route auth fails closed on Railway — if the password is unset at boot, the
    service generates a random one-boot password and logs it once (`[route-auth]` in the deploy
    logs) rather than serving those routes publicly. The Slack webhook and `/eve/v1/health` are
    unaffected either way. (`railway.json` has no mechanism to declare required variables, so this
    is enforced at boot instead.)

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
`app_mention`, `message.im`, `message.channels`, and `message.groups` listed under *Subscribe to bot
events* — the manifest from step 1 sets these, so they should already be there. The two channel
message events power thread follow-ups: once the bot has been mentioned (or replied) in a thread,
further replies in that thread reach it without a new `@mention`.

Changing a request URL does **not** require reinstalling the app; only changing *scopes* does. (If
you did edit scopes, the sidebar shows a yellow reinstall banner — follow it, and note that
reinstalling issues a **new** `SLACK_BOT_TOKEN` that you must copy back into Railway.)

Finally, invite the bot to a channel — `/invite @eve-agent` — and `@mention` it.

## Verification

- `curl https://<host>/eve/v1/health` → `{"ok":true,"status":"ready",...}`
- `@mention` the bot → threaded reply with a typing indicator; ask "what time is it in Tokyo?" to
  exercise the `get_time` tool.
- A follow-up mention in the same thread resumes the same durable session.

## Parity with the web chat (chat-flue)

This agent mirrors the Maple capabilities of `apps/chat-flue` (the Flue web chat) **without
sharing code** — each capability is re-expressed in eve's native idiom (see
`docs/slack-agent-chat-flue-parity.md` for the full matrix):

- **Prompts:** `agent/instructions.md` is the Slack-adapted port of chat-flue's `SYSTEM_PROMPT`
  (tool prefix `maple__<tool>` instead of `mcp__maple__<tool>`; inline `<<maple:...>>` cards
  replaced with Slack markdown + deep links built from `MAPLE_APP_BASE_URL`).
- **Modes → skills:** chat-flue's dashboard-builder and investigate modes are progressive-
  disclosure skills (`agent/skills/dashboard-builder/`, `agent/skills/incident-investigation/`)
  the model loads via `load_skill`. Alert context comes from the Slack thread (Maple delivers
  alert notifications into Slack), not from a request payload.
- **Approvals — the one behavioral difference:** chat-flue uses propose-then-apply (the tool
  returns a `proposed` marker; the web client performs the mutation) because Flue has no
  human-in-the-loop interrupt. eve has native HITL: `agent/lib/approval.ts` gates the same
  `MUTATING_TOOL_NAMES` set behind a Slack approve/deny card, and **on approve the real MCP
  tool executes** with the workspace's `mapleApiKey` — approval is consent; the Maple API
  boundary still enforces authorization. App-principal (automated/scheduled) turns are denied
  mutations outright. The mutating-tool set is mirrored, not imported — keep in sync with
  `apps/api/src/mcp/tools/mutating.ts` (source of truth) and `apps/chat-flue/src/lib/approval.ts`.
- **Telemetry:** `agent/instrumentation.ts` exports AI SDK spans to Maple's ingest as service
  `maple-slack-agent` when `MAPLE_INGEST_KEY` is set (no-op otherwise). Model inputs/outputs are
  never recorded; Slack team/channel/thread/user land as `maple.slack.*` span attributes.
  `agent/hooks/outcome-log.ts` logs turn outcomes + tool failures unconditionally (Railway logs).
- **Deliberately not ported:** page context and widget-fix mode (web-only payloads), the
  `submit_diagnosis` tool (the thread reply *is* the report), and the headless triage workflow
  (apps/api invokes chat-flue for that).
- **Beyond parity — chart images:** the authored `render_chart` tool renders a time-series
  chart in-process (hand-rolled SVG → `@resvg/resvg-js`, no headless browser or external chart
  service) and posts it into the thread via Slack's external-upload flow with the per-team bot
  token (needs the `files:write` scope; the Dockerfile installs `fonts-dejavu-core` for text
  rasterization). On render/upload failure it returns a Unicode sparkline for the model to
  inline. This is net-new: chat-flue renders no images anywhere.

Env vars added by this parity work (set on Railway; all runtime-only):

| Var | Purpose |
| --- | --- |
| `MAPLE_APP_BASE_URL` | Web-app base for deep links in replies (default `https://app.maple.dev`) |
| `MAPLE_INGEST_KEY` | Maple ingest key; enables the OTel export when set |
| `MAPLE_ENDPOINT` | Ingest gateway base (default `https://ingest.maple.dev`) |
| `MAPLE_ENVIRONMENT` | Deployment env label on spans (falls back to `RAILWAY_ENVIRONMENT_NAME`) |

Manual acceptance in a linked workspace: (a) "how are things looking?" routes through
`system_health`; (b) "create an alert rule for checkout p95" produces a Slack approval card —
approve executes, deny is acknowledged without retry, and a parked approval survives a container
restart (Postgres world); (c) an @mention in an alert-notification thread loads the
incident-investigation skill and scopes queries to the alert window; (d) "build me a dashboard
for checkout" loads the dashboard-builder skill and test-queries before proposing; (e) spans for
(a)–(d) visible in Maple under `maple-slack-agent`. For (b), also verify the approval card's
post/`chat.update` paths resolve the right per-team token — they ride the
`patches/eve@0.25.3.patch` interaction call sites, so re-verify after any eve upgrade.

## Multi-workspace architecture

One Slack app, distributed publicly, installed into many workspaces. Each Slack **team** is linked
to one Maple **organization**. The install (bot token + Maple API key) is created and stored by the
**Maple API** during OAuth; this agent only ever *resolves* it.

**Resolve endpoint (fixed contract, owned by the Maple API):**

```
GET {MAPLE_API_BASE_URL}/internal/slack/workspaces/{teamId}
Authorization: Bearer maple_svc_{MAPLE_INTERNAL_SERVICE_TOKEN}

200 → { "orgId": "...", "teamId": "...", "teamName": "..."|null,
        "botToken": "xoxb-...", "mapleApiKey": "maple_ak_..." }
404 → team not installed / revoked
```

`agent/lib/maple.ts` wraps this in `resolveWorkspace(teamId)` with an in-memory TTL cache (5 min
positive, 30 s negative, in-flight de-dupe). It never caches 5xx/network errors as "not installed".

**Inbound (webhook verification):** `agent/channels/slack.ts` installs a custom `webhookVerifier`.
Because a `webhookVerifier` is set, eve skips its built-in signing-secret check and this verifier
owns verification: it HMAC-verifies the Slack **v0** signature (`v0:{timestamp}:{rawBody}`, SHA-256,
5-minute skew reject, constant-time compare) against the static `SLACK_SIGNING_SECRET`.

**Outbound bot token (which team → token):** upstream eve's `botToken` credential is **arg-less**
(`() => Promise<string>`), so it receives no request context — the exact subject of open issue
[vercel/eve#222](https://github.com/vercel/eve/issues/222). We carry a small patch
(`patches/eve@0.25.3.patch`, applied via bun `patchedDependencies`; the Dockerfile copies `patches/`
before `bun install`) that threads `{ teamId, channelId, threadTs }` from `buildSlackBinding` — whose
call sites all already hold `teamId` — into the credential function, and does the same for the three
HITL/interaction call sites in `interactions.js` (modal open, answered-card `chat.update`s). With it,
every outbound reply path (post, ephemeral, DM, typing, refresh, uploads, `slack.request`, HITL)
resolves the token for the correct team explicitly, including inside durable workflow steps. The
patch mirrors the resolver shape proposed in #222 and can be dropped when upstream ships it.

`resolveBotToken(context?)` (`agent/lib/maple.ts`) resolves `context.teamId` via the resolve
endpoint → else `SLACK_BOT_TOKEN` → throw. The env fallback serves single-workspace dev and the
one path the patch does not cover — eve's inbound-attachment file fetch, constructed once at
channel definition with no per-event context, which calls the credential with no argument.

**MCP tools (per-workspace API key):** `agent/connections/maple.ts` connects to
`{MAPLE_API_BASE_URL}/mcp` (streamable HTTP). Unlike `botToken`, the connection `auth` resolver
receives the session context, and the Slack auth context carries `team_id` in
`ctx.session.auth.current.attributes` (persisted with the session by eve's `buildSlackAuthContext`).
So this path resolves the right org's `mapleApiKey` reliably — including in durable reply steps. If
the workspace isn't linked, the resolver throws a clear message and the model (per
`instructions.md`) tells the user to connect from the Maple dashboard → Integrations → Slack. The
tool list is left **unfiltered**: the Maple MCP tool names are resolved at runtime from the live
server, not known at authoring time, so an allow/block list would be a guess — restrict mutating
tools server-side (or add a `tools.allow` here once the concrete names are confirmed).

**Slack app manifest changes for multi-workspace** (see the manifest in
[Deploy → step 1](#1-create-the-slack-app)): add the OAuth **redirect URL** pointing at the Maple
API callback (`/oauth/slack/callback`), broaden the bot scopes to
`app_mentions:read,chat:write,chat:write.public,channels:read,files:write,groups:read,im:history,im:read,im:write,users:read`,
and **activate public distribution** so the app can be installed into any workspace.

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
- **Auth:** `agent/channels/eve.ts` fails closed in deployed environments (`RAILWAY_ENVIRONMENT_NAME`
  set, or `NODE_ENV=production`): the browser/API routes always require HTTP Basic there. With
  `ROUTE_AUTH_BASIC_PASSWORD` set that's your stable credential; without it, a random per-boot
  password is generated and logged once at startup (`[route-auth]`), so the routes are never
  public in production. Purely local runs without a password keep the old open-demo behavior.
  The Slack webhook is always signature-verified independently, and `/eve/v1/health` is a separate
  unauthenticated route (Railway's healthcheck is unaffected).
- Edge Cloudflare Workers isn't used because the only Cloudflare Durable-Objects workflow world is
  built against an older `@workflow` protocol than eve 0.25 requires. Revisit when a `5.0.0-beta`
  Cloudflare world ships.
