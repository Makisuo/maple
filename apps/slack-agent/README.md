# @maple/slack-agent

A general-purpose Slack agent built on the [eve](https://eve.dev) framework, **self-deployed to
Railway** (no Vercel). It answers `@mentions` and DMs, runs tools, and keeps durable multi-turn
sessions.

It is **multi-workspace**: a single Slack app is distributed to many workspaces, and each
workspace is linked to one Maple organization. Per-team installs (bot token + Maple API key) live
in Maple's API; the agent resolves them per request and talks to Maple's MCP server for
observability tools. See [Multi-workspace architecture](#multi-workspace-architecture).

## Architecture

| Concern    | Choice                                                                                                | Why                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | eve `0.25.x` (durable agent runtime, Nitro HTTP host)                                                 | filesystem-first agents                                                                                                                                                                           |
| Host       | **Railway** container running `eve start` (long-running Node)                                         | eve's supported self-host model; edge Workers is blocked today by a workflow-world protocol gap                                                                                                   |
| Model      | **OpenRouter** via REST (`@openrouter/ai-sdk-provider`), `openai/gpt-5.6-luna`                        | `createOpenRouter({ apiKey })` → an AI-SDK model; streams structured tool calls (see Notes)                                                                                                       |
| Durability | **`@workflow/world-postgres`** (`5.0.0-beta.27`) + Railway Postgres                                   | protocol-compatible with eve's vendored `@workflow/*` 5.0.0-beta line                                                                                                                             |
| Slack      | **self-managed, multi-workspace** (`slackChannel()` + custom `webhookVerifier` + per-team `botToken`) | one public app across many workspaces; static signing secret verifies inbound, per-team bot token resolved from the Maple API — see [Multi-workspace architecture](#multi-workspace-architecture) |
| Maple      | **resolve endpoint** (`/internal/slack/workspaces/:teamId`) + **MCP** (`/mcp`)                        | per-team install lookup (TTL-cached) and observability tools scoped per org                                                                                                                       |

Key routes (all served by the one container): `POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`,
`POST /eve/v1/slack` (Slack webhook), `GET /eve/v1/health`, and workflow callbacks under
`/.well-known/workflow/v1/flow`.

## Project layout

```
agent/
  agent.ts            # model (OpenRouter) + workflow world selection
  instructions.md     # system prompt (Slack-adapted port of the web chat's SYSTEM_PROMPT)
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
  tools/render_chart.ts # renders a PNG chart in-process and posts it into the thread
  tools/read_channel_history.ts # on-demand read of the channel's recent top-level messages
  tools/{bash,glob,grep,read_file,write_file,web_fetch,web_search}.ts
                      # `disableTool()` sentinels — see Framework tools below
  lib/thread-context.ts # full-thread turn context (renders Block Kit / alert cards too)
  lib/channel-context.ts # channel turn context for a mention that starts its own thread
  lib/slack-context-format.ts # shared renderer for both (blocks/attachments + attribution)
  lib/turn-time.ts    # per-turn `<current_time>` block (nothing else dates the prompt)
  lib/bot-identity.ts # per-team bot user id learned from the webhook envelope
  lib/chart.ts        # pure SVG chart renderer + unicode-sparkline fallback
  lib/slack-upload.ts # Slack external-upload flow (files.getUploadURLExternal → complete)
  lib/env.ts          # shared is-this-deployed predicate (route auth + token fallback)
  lib/telemetry-log.ts # structured logging → OTel logs, JSON console fallback
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
> _does_ happen to run on bun, but we deliberately use Node in both places so local and container
> match. Bun is still the package manager (`bun install`, `bun.lock`), and `bun run <script>` is fine
> — it honors the `#!/usr/bin/env node` shebang and hands off to Node.

## Local development

```bash
cd apps/slack-agent
cp .env.local.example .env.local   # fill in OPENROUTER_API_KEY
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

Run the tests (bun's native runner; no network — `agent/lib/fetch-stub.ts` swaps `globalThis.fetch`).
They cover signature verification, per-team bot-token resolution and the resolve cache
(`agent/lib/maple.ts`), thread follow-up promotion, the Slack upload flow, and three drift canaries
that matter because **this app is outside CI**: the framework-tool lockdown
(`framework-tools.test.ts`), the eve patch + version pin (`eve-patch.test.ts`), and
`MUTATING_TOOL_NAMES` vs `apps/api/src/mcp/tools/mutating.ts` (`approval.test.ts`):

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
    app_home:
        # The agent surface (split pane) opens the Messages tab; without these the
        # composer is disabled ("Sending messages to this app has been turned off").
        messages_tab_enabled: true
        messages_tab_read_only_enabled: false
oauth_config:
    # OAuth completes at the MAPLE API (not this agent). Maple stores the per-team
    # install (bot token + Maple API key) that this agent later resolves.
    redirect_urls:
        - https://<your-maple-api-host>/oauth/slack/callback
    scopes:
        bot:
            - app_mentions:read # receive @mentions
            - assistant:write # agent surface: suggested prompts, thread titles, status
            - chat:write # post replies
            - chat:write.public # post in channels the bot isn't a member of
            - channels:read # resolve public channel metadata
            - channels:history # thread + channel context, follow-ups (no mpim:history — group DMs opt out)
            - files:write # upload rendered chart images (render_chart tool)
            - groups:read # resolve private channel metadata
            - groups:history # thread + channel context + follow-ups in private channels
            - im:history # read DM history (message.im)
            - im:read # resolve DM conversation metadata
            - im:write # open/DM the user
            - reactions:write # :eyes: ack + add_reaction tool (agent/lib/ack-reaction.ts)
            - users:read # attribute speakers
settings:
    event_subscriptions:
        request_url: https://<your-service>.up.railway.app/eve/v1/slack
        bot_events:
            - app_mention
            - message.im
            # Thread follow-ups without re-mentioning the bot: candidate thread
            # replies are promoted to app_mention by the webhookVerifier, and
            # confirmed (or dropped) after the 200 by the mention handler
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

- healthcheck.

**b. Add Postgres and reference it.** `Cmd+K` (or right-click the canvas) → **Database** →
**Add PostgreSQL**. This creates a _separate service_ — its `DATABASE_URL` is **not** automatically
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

- `OPENROUTER_API_KEY`
- `SLACK_SIGNING_SECRET` — per-app/static; HMAC-verifies every inbound webhook.
- `MAPLE_API_BASE_URL` — the Maple API base (e.g. `https://api.maple.dev`). **Also needed at build
  time**: it forms the Maple MCP connection URL, which eve bakes into its manifest at build (like
  `EVE_WORKFLOW_WORLD`). Railway exposes service variables as Docker build args (the Dockerfile
  declares `ARG MAPLE_API_BASE_URL`), so setting it as a service variable covers both build and
  runtime. If it is missing at build, the URL silently bakes to `https://api.localhost`.
- `MAPLE_INTERNAL_SERVICE_TOKEN` — the internal service token; the agent sends it as
  `Authorization: Bearer maple_svc_<token>` to the resolve endpoint. Runtime-only.
- `SLACK_BOT_TOKEN` — **omit in multi-workspace production** (the bot token is resolved per team
  from Maple). This is now enforced, not advisory: in a deployed environment the env token is
  ignored and an unresolvable team errors, because the app is publicly installable and a shared
  env token would sign one tenant's outbound calls with another tenant's credential. Set
  `SLACK_ALLOW_ENV_BOT_TOKEN=true` alongside it only for a private single-workspace deployment.
- `PORT=8080` — set it explicitly. Railway injects a `PORT` of its own that overrides the image's
  `ENV PORT`, so pinning it here is what makes the value deterministic rather than assigned.
- `WORKFLOW_LOCAL_BASE_URL=http://localhost:8080` — the durable-run callback target. See the note
  below for why this is loopback and not the public host.
- (`EVE_WORKFLOW_WORLD` is already baked into the image at build time — no need to set it.)
- `ROUTE_AUTH_BASIC_PASSWORD` (+ optional `ROUTE_AUTH_BASIC_USER`, default `admin`) — locks the
  non-Slack HTTP routes (session/stream) behind HTTP Basic. **Required in production to use
  those routes at all**: route auth fails closed on Railway — if the password is unset at boot,
  the routes are locked behind a random secret that is generated per boot and deliberately never
  logged, so they are unreachable until you set this. (Printing the generated password, the
  original behavior, parks a working credential in Railway's log store for the life of the
  process.) The Slack webhook and `/eve/v1/health` are unaffected either way. (`railway.json` has
  no mechanism to declare required variables, so this is enforced at boot instead.)

Deploy. The entrypoint applies the Postgres-world schema, then starts eve. Check
`https://<your-service>.up.railway.app/eve/v1/health`.

> **`WORKFLOW_LOCAL_BASE_URL` should stay loopback.** `@workflow/world-postgres` runs its Graphile
> Worker _in-process_: when a durable step comes off the queue, `executeMessageOverHttp` POSTs it to
> `getExecutionBaseUrl()` — the service calling itself. Pointing it at the public
> `up.railway.app` host sends every durable step out to Railway's edge and back for no reason —
> billed egress plus a round-trip of latency. `<service>.railway.internal` avoids the egress but is
> still a needless hop and requires binding to `::`. The public domain from step (c) is for _inbound_
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
> _synchronously_ when you save: it POSTs a `url_verification` challenge and expects the echoed
> `challenge` value back within ~3s. eve answers this automatically — but only if it's running.
> Confirm `/eve/v1/health` returns `{"ok":true}` first, or the save will just fail with
> "Your request URL didn't respond with the correct challenge value."

Go to <https://api.slack.com/apps> and select your app. Then either:

**Fastest — edit the manifest.** Left sidebar → **Features** → **App Manifest**. It's the same YAML
from step 1 in an editor; replace both `request_url` values and hit **Save Changes**. Slack runs the
challenge against the new URL on save.

**Or the individual pages** (same result, two screens):

| Setting       | Where                                                  | Field                                             |
| ------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Events        | Sidebar → **Features** → **Event Subscriptions**       | **Request URL** (toggle _Enable Events_ on first) |
| Interactivity | Sidebar → **Features** → **Interactivity & Shortcuts** | **Request URL** (toggle on first)                 |

Both should show a green **Verified ✓** next to the field once saved. Event Subscriptions also needs
`app_mention`, `message.im`, `message.channels`, and `message.groups` listed under _Subscribe to bot
events_ — the manifest from step 1 sets these, so they should already be there. The two channel
message events power thread follow-ups: once the bot has been mentioned (or replied) in a thread,
further replies in that thread reach it without a new `@mention` — but only while the thread is
still **alive** (nobody has touched it for less than 24 hours) and the bot is still within its
**last 15 messages**. Past either bound the reply is dropped, everyone who spoke in the thread gets
a DM saying so, and one `@mention` brings the bot back (`agent/lib/thread-follow-up.ts`,
`agent/lib/disengage-notice.ts`). Unbounded, one mention would turn every later reply by anyone into
a full agent turn, forever.

The decision deliberately does **not** happen in the webhook verifier — that is the only awaited work
before eve's 200, so anything it fetches is spent out of Slack's ~3s delivery budget. Promotion there
is parse-only and optimistic; the mention handler confirms it afterwards, against the thread it loads
for turn context anyway.

Changing a request URL does **not** require reinstalling the app; only changing _scopes_ does. (If
you did edit scopes, the sidebar shows a yellow reinstall banner — follow it, and note that
reinstalling issues a **new** `SLACK_BOT_TOKEN` that you must copy back into Railway.)

Finally, invite the bot to a channel — `/invite @eve-agent` — and `@mention` it.

## Verification

- `curl https://<host>/eve/v1/health` → `{"ok":true,"status":"ready",...}`
- `@mention` the bot → threaded reply with a typing indicator; ask "how are things looking?" to
  exercise the Maple MCP tool loop.
- A follow-up mention in the same thread resumes the same durable session.

## Framework tools (the built-ins are locked down)

eve enables ten framework tools by default (`bash`, `glob`, `grep`, `read_file`, `write_file`,
`web_fetch`, `web_search`, `todo`, `ask_question`, `load_skill`), and **none of them go through
`agent/lib/approval.ts`** — that policy only answers for `maple__*` names, so a framework tool runs
with no approval prompt at all. This agent reads attacker-influenced text by design (log bodies,
exception messages, span attributes from a customer's production traffic), so every enabled tool is
one crafted log line away from being called. `web_fetch` was the sharp edge: as of eve 0.25.3 it has
no SSRF protection whatsoever (no loopback / link-local / private-range blocklist, no redirect
pinning) and runs in the **host** process, i.e. inside Railway's private network.

All seven are disabled with a `disableTool()` sentinel per file under `agent/tools/`. Only
`ask_question` (the HITL prompt Slack renders), `todo` (durable task list, no egress) and
`load_skill` (how `agent/skills/*` reach the model) stay on.

> The **filename is the identity.** eve derives the tool slug from the path and does no
> kebab→snake normalization, so `agent/tools/web-fetch.ts` would disable _nothing_ while looking
> right, and `render-chart.ts` would register the authored tool as `render-chart` while
> `instructions.md` tells the model to call `render_chart`. `agent/lib/framework-tools.test.ts`
> reconstructs eve's own resolution (its real framework-tool list, its real slug rule, its real
> `isDisabledToolSentinel`) and fails on both mistakes; `eve build` also writes the decision to
> `.output/.eve/compile/compiled-agent-manifest.json` under `disabledFrameworkTools`.

## Parity with the web chat

This agent mirrors the Maple capabilities of the web chat (`apps/api/src/chat/`, which replaced the
Flue-based `apps/chat-flue` worker) **without sharing code** — each capability is re-expressed in
eve's native idiom:

- **Prompts:** `agent/instructions.md` is the Slack-adapted port of the web chat's `SYSTEM_PROMPT`
  (`apps/api/src/chat/prompts.ts`)
  (tool prefix `maple__<tool>` instead of `mcp__maple__<tool>`; inline `<<maple:...>>` cards
  replaced with Slack markdown + deep links built from `MAPLE_APP_BASE_URL`).
- **Modes → skills:** the web chat's dashboard-builder and investigate modes are progressive-
  disclosure skills (`agent/skills/dashboard-builder/`, `agent/skills/incident-investigation/`)
  the model loads via `load_skill`. Alert context comes from the Slack thread (Maple delivers
  alert notifications into Slack), not from a request payload — including the alert card itself,
  which `agent/lib/thread-context.ts` renders out of its Block Kit attachment (see Notes).
- **Approvals — both sides now interrupt, by different mechanisms:** the web chat stops the turn on
  a gated tool and emits a `tool-call` with `proposed: true` and no result
  (`apps/api/src/chat/agent.ts`); the user approves and `POST /api/chat/apply` performs the
  mutation, which is then recorded back into the transcript as that call's result. (Under Flue this
  was propose-then-apply with a fabricated `proposed` marker as the tool's _output_, because Flue's
  event stream had no human-in-the-loop primitive; that marker no longer exists.) eve has native
  HITL: `agent/lib/approval.ts` gates the same `MUTATING_TOOL_NAMES` set behind a Slack
  approve/deny card, and **on approve the real MCP tool executes** with the workspace's
  `mapleApiKey` — approval is consent; the Maple API boundary still enforces authorization.
  App-principal (automated/scheduled) turns are denied mutations outright. The mutating-tool set is
  mirrored, not imported — keep in sync with `apps/api/src/mcp/tools/mutating.ts`, which is the
  source of truth for both.
- **Telemetry:** `agent/instrumentation.ts` exports AI SDK spans to Maple's ingest as service
  `maple-slack-agent` when `MAPLE_INGEST_KEY` is set (no-op otherwise), with `service.version` +
  `deployment.commit_sha` from Railway's `RAILWAY_GIT_COMMIT_SHA` so releases show up in the
  commit-hover UI. Model inputs/outputs are never recorded; Slack team/channel/thread/user land as
  `maple.slack.*` span attributes (omitted rather than empty-string when absent).
  `agent/hooks/outcome-log.ts` logs turn outcomes + tool failures unconditionally, through
  `lib/telemetry-log.ts` — OTLP `/v1/logs` when the ingest key is set (queryable and
  trace-correlated, like the web chat), a structured JSON line on stdout otherwise.
- **Deliberately not ported:** page context and the widget-fix entry point (web-only payloads —
  the surgical fix _rules_ live in the dashboard-builder skill, with `get_dashboard` standing in
  for the attached widget JSON), the `submit_diagnosis` tool (the thread reply _is_ the report),
  and the headless triage agent (`apps/api/src/workflows/triage-agent.ts`).
- **Beyond parity — chart images:** the authored `render_chart` tool renders a time-series
  chart in-process (hand-rolled SVG → `@resvg/resvg-js`, no headless browser or external chart
  service) and posts it into the thread via Slack's external-upload flow with the per-team bot
  token (needs the `files:write` scope; the Dockerfile installs `fonts-dejavu-core` for text
  rasterization). On render/upload failure it returns a Unicode sparkline for the model to
  inline. This is net-new: the web chat renders no images anywhere.

Env vars added by this parity work (set on Railway; all runtime-only):

| Var                                          | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `MAPLE_APP_BASE_URL`                         | Web-app base for deep links in replies (default `https://app.maple.dev`) |
| `MAPLE_INGEST_KEY`                           | Maple ingest key; enables the OTel span **and log** export when set      |
| `MAPLE_ENDPOINT`                             | Ingest gateway base (default `https://ingest.maple.dev`)                 |
| `MAPLE_ENVIRONMENT`                          | Deployment env label on spans (falls back to `RAILWAY_ENVIRONMENT_NAME`) |
| `MAPLE_COMMIT_SHA` / `MAPLE_SERVICE_VERSION` | Release attribution; both default to `RAILWAY_GIT_COMMIT_SHA`            |
| `SLACK_ALLOW_ENV_BOT_TOKEN`                  | Opt-in to the `SLACK_BOT_TOKEN` fallback in a deployed environment       |

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
**Maple API** during OAuth; this agent only ever _resolves_ it.

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

The same patch file carries a second, Maple-specific hunk: `McpConnectionClient.executeTool`
(`dist/src/runtime/connections/mcp-client.js`) strips tool-result content entries tagged
`__maple_ui`. Maple's MCP server emits those structured payloads for the web chat's tables and
charts (`createDualContent` in apps/api); the web chat splits them off client-side
(`splitToolResult`), and eve has no result-transform hook, so without the patch the model would
receive the raw UI JSON duplicated next to the text report on every Maple tool call. Guarded by
`agent/lib/eve-patch.test.ts` alongside the botToken canary.

`resolveBotToken(context?)` (`agent/lib/maple.ts`) resolves `context.teamId` via the resolve
endpoint → else `SLACK_BOT_TOKEN` → throw. The env fallback serves single-workspace dev and the
one path the patch does not cover — eve's inbound-attachment file fetch, constructed once at
channel definition with no per-event context, which calls the credential with no argument. **It is
gated on not-being-deployed** (`agent/lib/env.ts`, shared with the route-auth gate): anyone can
install a publicly distributed Slack app, and an unlinked workspace's events must not borrow the
one token in the environment, which belongs to a different tenant. `SLACK_ALLOW_ENV_BOT_TOKEN=true`
re-enables it for a deliberately private single-workspace deployment.

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
`app_mentions:read,assistant:write,chat:write,chat:write.public,channels:read,channels:history,files:write,groups:read,groups:history,im:history,im:read,im:write,reactions:write,users:read`
(keep in sync with `SLACK_BOT_SCOPE_LIST` in `apps/api/src/services/SlackIntegrationService.ts`),
and **activate public distribution** so the app can be installed into any workspace.

## Notes

- **Model must support tool calling _while streaming_.** eve's harness is tool-driven and always
  streams, and that second half is the constraint that actually bites. Some models/providers parse
  tool calls only on non-streaming requests; streamed, they emit the model's raw tool-call JSON as
  ordinary text deltas, which the agent then posts into Slack verbatim:

    ```
    {"type": "function", "name": "ask_question", "parameters": {"prompt": "…", "allowFreeform": "true"}}
    ```

    (We hit exactly this on Workers AI's `@cf/meta/llama-3.3-70b-instruct-fp8-fast` before moving
    to OpenRouter — proper `tool_calls` array non-streaming, JSON-as-text when streamed.)

    The current default is `openai/gpt-5.6-luna` via OpenRouter, which streams OpenAI-shaped
    incremental `delta.tool_calls` chunks that `@openrouter/ai-sdk-provider` maps correctly. When
    switching `OPENROUTER_MODEL`, verify the streaming shape directly:

    ```bash
    curl https://openrouter.ai/api/v1/chat/completions \
      -H "authorization: Bearer $OPENROUTER_API_KEY" -H 'content-type: application/json' \
      -d '{"model":"<model>","stream":true,"messages":[{"role":"user","content":"what time is it in Tokyo?"}],
           "tools":[{"type":"function","function":{"name":"get_time","description":"Get the time in a timezone.",
           "parameters":{"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]}}}]}'
    ```

    The SSE must carry `delta.tool_calls`, not a JSON blob inside the text content. Also set
    `OPENROUTER_CONTEXT_WINDOW` to the new model's window.

- **Thread context is ours, not `slackChannel({ threadContext })`.** Every mention and DM ships the
  whole thread transcript with the turn, rendered by `agent/lib/thread-context.ts` and returned as
  the mention result's `context` from `onAppMention` / `onDirectMessage`. eve's built-in option
  couldn't carry an alert thread — the case that matters most, since the user is replying to
  something Maple posted rather than opening a topic. It reads a message's content from `text`
  alone, and Maple's alert notifications have none: the blocks ride inside a colored attachment
  (`apps/api/src/services/alerts/AlertDeliveryDispatch.ts`), so the model saw an empty
  `<content></content>`. Worse, `since: "last-agent-reply"` counted the alert as the agent's own
  reply (eve's `isMe` is `bot_id !== undefined` — any bot) and cut context off _after_ it, dropping
  the alert entirely. The user had to hand the bot a recap of the alert it had just sent. Ours
  falls back to blocks/attachments for content, keeps the full thread (which also survives a
  session lost to a redeploy), and attributes speakers with the workspace's real bot user id from
  `agent/lib/bot-identity.ts` so a third-party app in the channel isn't quoted back as the agent.
- **A mention that isn't in a thread gets the channel instead.** Maple posts alert cards to a
  channel; people answer them by writing a new channel message ("the ship is sinking @Maple"), not
  by replying inside a card's thread. That mention is its own thread root, so the thread transcript
  is one message long — the user's own. `agent/lib/channel-context.ts` fills the gap with the
  channel's last few top-level messages (`conversations.history`) as `<slack_channel_context>`,
  rendered by the same code, on the same `waitUntil` path, degrading the same way. The trigger is
  structural (`threadTs === ts`), not a model judgment call: the model cannot ask for context it
  has never been shown a trace of. Inside a thread the same fetch is available on demand as the
  `read_channel_history` tool. `conversations.history` returns top-level messages only, so the two
  surfaces never quote the same message twice. Scope-wise this is free — `channels:history` /
  `groups:history` / `im:history` are already installed. `mpim:history` is not requested, so a
  group DM answers `missing_scope`; that degrades to a note telling the model not to retry, and
  adding the scope would make every existing install report missing scopes until reinstalled.
- **Every turn carries the clock.** Nothing else in the prompt dates it: eve injects no current
  date, `instructions.md` is compiled at build time, and dynamic instructions resolve on
  `session.started` — which for Slack is the _first_ mention in a thread, since sessions are keyed
  `channelId:threadTs`. The model's only temporal signal was the `message_ts` values in the
  transcript, and it read the oldest as "about now", so "chart that now" an hour into an alert
  thread came back anchored to when the alert fired. `agent/lib/turn-time.ts` appends a
  `<current_time>` block (now in UTC + unix seconds, plus the thread's age) to each turn's
  `context`, and `instructions.md` § Time says the last one is now. Deliberately turn `context`
  rather than a `turn.started` dynamic instruction: instructions lower into the system prompt, and
  a value that changes every turn would invalidate the prompt cache at its first token and
  re-ingest the whole conversation each turn.
- **Auth:** `agent/channels/eve.ts` fails closed in deployed environments (`RAILWAY_ENVIRONMENT_NAME`
  set, or `NODE_ENV=production`): the browser/API routes always require HTTP Basic there. With
  `ROUTE_AUTH_BASIC_PASSWORD` set that's your stable credential; without it, a random per-boot
  secret is generated and **never logged**, so the routes are simply unreachable in production
  until you set one (`[route-auth]` says so at startup). Purely local runs without a password keep
  the old open-demo behavior. The Slack webhook is always signature-verified independently, and
  `/eve/v1/health` is a separate unauthenticated route (Railway's healthcheck is unaffected).
- **eve is pinned exactly (`"eve": "0.25.3"`, no caret).** `patches/eve@0.25.3.patch` only applies
  to that version, and it is what threads `{ teamId, … }` into the `botToken` credential. A
  lockfile refresh onto 0.25.4 would drop the patch silently, the credential would go back to being
  arg-less, and every workspace would fall through to the env fallback — failing _open_ onto the
  wrong credential. `agent/lib/eve-patch.test.ts` asserts both the pin and that the patched code
  path is the one loaded (it calls the credential and checks the context arrives). Bump the
  `dependencies` and `patchedDependencies` strings together, regenerate the patch, re-run the test.
- Edge Cloudflare Workers isn't used because the only Cloudflare Durable-Objects workflow world is
  built against an older `@workflow` protocol than eve 0.25 requires. Revisit when a `5.0.0-beta`
  Cloudflare world ships.
