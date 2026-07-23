# Slack agent ↔ chat-flue parity — implementation plan

Bring `apps/slack-agent` (eve on Railway) to functional parity with `apps/chat-flue` (Flue on
Cloudflare Workers) **without sharing code**: each chat-flue capability is re-expressed in eve's
native idiom (instructions / skills / connection `approval` / hooks / `instrumentation.ts`), not
imported. Where chat-flue carries a workaround for a Flue limitation, the eve version uses the
native mechanism instead of porting the workaround.

## Parity matrix

| chat-flue capability | Where it lives in chat-flue | eve-native equivalent | Verdict |
| --- | --- | --- | --- |
| Maple domain system prompt (`SYSTEM_PROMPT`) | `src/lib/prompts.ts` | `agent/instructions.md` (rewritten, Slack-adapted) | **Port** |
| Dashboard-builder mode prompt | `src/lib/prompts.ts` + instance-id mode | `agent/skills/dashboard-builder/SKILL.md` | **Port as skill** |
| Investigate mode prompt (`INVESTIGATE_SYSTEM_PROMPT`) | `src/lib/prompts.ts` | `agent/skills/incident-investigation/SKILL.md` | **Port as skill** |
| Alert context block (`formatAlertContextBlock` + signal-type tool hints) | `src/lib/modes.ts` | Folded into the incident-investigation skill (context comes from the Slack thread, not a payload) | **Adapt** |
| Approval gating of mutating tools (propose-then-apply) | `src/lib/approval.ts` | Native `approval` policy on the MCP connection → Slack approve/deny buttons, durable pause | **Port, upgraded** |
| `MUTATING_TOOL_NAMES` set | `src/lib/approval.ts` (mirrors `apps/api/src/mcp/tools/mutating.ts`) | Mirrored copy in `agent/lib/approval.ts` (no code sharing; sync comment on all three) | **Port** |
| Inline reference cards (`<<maple:trace:...>>`) | `SYSTEM_PROMPT` | Slack markdown + Maple deep links (per `docs/slack-rich-notifications.md`) | **Adapt** |
| OTel telemetry → Maple ingest (`maple-chat-flue` service) | `src/lib/telemetry.ts`, `src/lib/tracing.ts`, `src/app.ts` | `agent/instrumentation.ts` (`defineInstrumentation` + NodeSDK OTLP exporter), service `maple-slack-agent` | **Port** |
| Structured run/tool-failure logging (`observe()` bridge) | `src/app.ts` | `agent/hooks/outcome-log.ts` (`defineHook`, `turn.failed` / `action.result` errors) | **Port** |
| MCP connect resilience (timeout, degrade-without-tools) | `src/lib/mcp.ts` | eve owns the connection lifecycle; instructions already handle the not-linked path; keep as-is | **N/A (framework-owned)** |
| Page context (`pageContext`) | `src/lib/modes.ts` | No page in Slack; the thread is the context | **Not ported** |
| Widget-fix mode | `src/lib/modes.ts` | Web-UI-only flow (broken widget card on a dashboard) | **Not ported** |
| `submit_diagnosis` tool + investigation persistence | `src/lib/submit-diagnosis.ts` | The Slack thread reply *is* the report; no investigation row to persist | **Not ported** |
| Headless triage workflow | `src/workflows/triage.ts` | apps/api invokes chat-flue for triage; slack-agent is not a triage host | **Not ported** |
| `/agents/*` auth middleware (Clerk/org matching) | `src/app.ts`, `src/lib/auth.ts` | Already covered: Slack signature verify + per-team resolve + route Basic auth | **Already at parity** |
| Workers AI model + per-env override | `DEFAULT_MODEL` + `MAPLE_CHAT_MODEL` | Already covered: `WORKERS_AI_MODEL` (`@cf/zai-org/glm-5.2`) | **Already at parity** |

Key idiom difference driving the design: chat-flue's propose-then-apply exists **only because Flue
has no human-in-the-loop interrupt** — the tool returns a `{status:"proposed"}` marker and the web
client performs the real mutation. eve has native HITL: an `approval` policy on the connection
parks the run durably at `session.waiting`, the Slack channel renders approve/deny buttons, and on
approval **the real MCP tool executes**. No apply endpoint, no marker parsing, and our
`patches/eve@0.25.3.patch` already threads per-team bot tokens through the HITL interaction call
sites (`interactions.js`), so the buttons work multi-workspace.

---

## Phase 1 — Prompt parity (`agent/instructions.md`)

Rewrite `agent/instructions.md` as the Slack-adapted port of `SYSTEM_PROMPT`
(`apps/chat-flue/src/lib/prompts.ts`), keeping the existing Slack-specific sections (workspace↔org
scoping, not-linked fallback, thread etiquette):

- **Capabilities + guidelines**: port the full capability list and the tool-routing guidance
  (system_health first for "how are things", find_errors → error_detail, list_metrics before
  query_data, etc.).
- **Tool prefix note**: eve qualifies connection tools as `maple__<tool>` (filename-derived), not
  `mcp__maple__<tool>`. One up-front note, prompts use short names — mirroring chat-flue's
  `TOOL_PREFIX_NOTE` shape with the eve prefix.
- **Approval note**: port `APPROVAL_NOTE`, reworded for Slack: mutating tools pause for an
  approve/deny prompt rendered *by Slack* — never imitate the approval UI in prose, never retry a
  denied action.
- **Response style**: port "lead with findings, don't narrate tool calls, no unsolicited next
  steps". Replace the `<<maple:TYPE:JSON>>` inline-card syntax with Slack-native referencing:
  markdown links to Maple detail pages (`<https://app.maple.dev/traces/<id>|trace>` style), code
  formatting for IDs, tables for comparisons (Block Kit markdown now renders tables/code —
  `docs/slack-rich-notifications.md` §1). Requires a **new env var `MAPLE_APP_BASE_URL`** for
  absolute deep links (chat-flue never needed it; the web UI was the host).

Keep `instructions.md` to identity + standing rules per eve guidance; the long procedural content
moves to skills (Phase 2).

## Phase 2 — Modes as skills (`agent/skills/`)

Chat-flue selects a mode from the instance-id tab prefix. Slack has no instance ids — the
eve-idiomatic equivalent is **progressive disclosure via skills** (`load_skill`), which also keeps
the always-on prompt small:

- `agent/skills/dashboard-builder/SKILL.md` — the full `DASHBOARD_BUILDER_SYSTEM_PROMPT` port:
  mandatory test-before-propose workflow, widget types, query-builder shapes, common mistakes,
  units. Frontmatter description written as a routing hint ("Use when the user asks to build,
  add, or fix dashboards or widgets"). This is exactly the "long situational procedure" the eve
  docs say belongs in a skill, and it composes with Phase 3: `add_dashboard_widget` etc. still
  pause for approval when called from the skill flow.
- `agent/skills/incident-investigation/SKILL.md` — port of `INVESTIGATE_SYSTEM_PROMPT` merged with
  the alert-context guidance from `formatAlertContextBlock`: establish the incident interval and
  pass explicit time bounds, signal-type → tool routing (error_rate → find_errors, latency →
  find_slow_traces, throughput → compare_periods), pull 1–2 representative traces, correlate logs,
  VCS/source-correlation rules, untrusted-source-content rule, ~16-tool-call budget, evidence
  discipline (never invent identifiers). Routing hint: "Use when investigating an alert, incident,
  error spike, or 'why is X slow/failing' question." Since Maple's alert notifications are
  delivered into Slack (AlertDeliveryDispatch), an @mention in an alert thread arrives with the
  alert message already in thread context — the skill tells the model to read rule/threshold/window
  from that message and fetch the rest via `get_alert_rule` / `list_alert_incidents`.

Not ported as skills: widget-fix (needs the web's broken-widget payload) and page context (no
page). Structured diagnosis submission is replaced by the thread reply itself.

## Phase 3 — Approval gating (`agent/lib/approval.ts` + `agent/connections/maple.ts`)

1. `agent/lib/approval.ts`:
   - `MUTATING_TOOL_NAMES: ReadonlySet<string>` — mirrored from
     `apps/api/src/mcp/tools/mutating.ts` (same 19 names). Add the keep-in-sync comment to all
     three copies (api, chat-flue, slack-agent). No cross-project import — the mirror-not-share
     rule of this plan, and the app is outside the bun workspace anyway.
   - `mapleToolApproval(ctx: ApprovalContext): ApprovalStatus` —
     `ctx.toolName` arrives qualified (`maple__create_alert_rule`); strip the `maple__` prefix and:
     - app-principal turns (`authenticator === "app"`, `principalId === "eve:app"`,
       `principalType === "runtime"` — future schedules/digests): return
       `{ type: "denied", reason: "Automated turns cannot perform mutations." }`. Fail closed;
       chat-flue has no unattended mutation path either.
     - mutating name → `"user-approval"`; everything else → `"not-applicable"`.
2. `agent/connections/maple.ts`: add `approval: mapleToolApproval` to
   `defineMcpClientConnection`. Tool list stays unfiltered (same decision as today: names resolve
   at runtime; the approval gate — not an allowlist guess — is the safety boundary, matching
   chat-flue's full-list-plus-gates posture).
3. Verify end-to-end in a real workspace that the Slack approval card's post/`chat.update` paths
   resolve the right per-team token (the patch's `interactions.js` call sites) and that a parked
   approval survives a container restart (Postgres world).

Behavioral note for the README: unlike chat-flue, an approved action **executes the real
mutation** through MCP with the workspace's `mapleApiKey` — approval is consent, and the API
boundary still enforces authorization.

## Phase 4 — Telemetry (`agent/instrumentation.ts`)

Port the *outcome* of chat-flue's telemetry (spans in Maple, attributed to a first-class service)
using eve's `instrumentation.ts` surface instead of Flue's `observe()`/OTel bridge:

- `defineInstrumentation({ setup })` registering a **NodeSDK** tracer provider (long-running Node
  on Railway — none of chat-flue's workerd flush/isolate pain applies; `BatchSpanProcessor` timers
  just work): OTLP/HTTP exporter to `${MAPLE_ENDPOINT}/v1/traces` with
  `Authorization: Bearer ${MAPLE_INGEST_KEY}`; disabled (no-op) when `MAPLE_INGEST_KEY` is unset,
  keeping local dev silent — same contract as chat-flue's `setupTelemetry`.
- Resource attributes mirroring `apps/chat-flue/src/lib/telemetry.ts`: `service.name =
  "maple-slack-agent"`, `service.namespace = "backend"`, per-process `service.instance.id`,
  `maple.sdk.type = "eve"`, `vcs.repository.url.full`, and the **dual-emitted**
  `deployment.environment` + `deployment.environment.name` (Tinybird MVs still pre-extract the
  legacy key). Do not set `maple_org_id` — the ingest gateway injects org from the key.
- `events["step.started"]` runtime context: `maple.slack.team_id`, `maple.slack.channel_id`,
  `maple.slack.thread_ts`, `maple.slack.user_id` from the Slack channel metadata (narrow with
  `isChannel(input.channel, slackChannel)`), so per-workspace latency/failures are queryable —
  the analog of chat-flue's `chat.turn` span attributes (`maple.chat.mode`, `maple.org_id`).
- `recordInputs: false`, `recordOutputs: false` — customer telemetry content must not land in
  spans; chat-flue's OTel observer omits content by default for the same reason.
- New env vars (Railway + `.env.local.example` + README): `MAPLE_INGEST_KEY`, `MAPLE_ENDPOINT`
  (default `https://ingest.maple.dev`), `MAPLE_ENVIRONMENT`.

## Phase 5 — Failure-outcome hook (`agent/hooks/outcome-log.ts`)

Chat-flue registers an **unconditional** structured logger (`run_end errored=…`, tool-failure
lines) as the primary "chat did nothing" signal, independent of OTel. Mirror with `defineHook`:
log `turn.completed`/`turn.failed` outcomes and `action.result` errors (`isError`) with session
id + team id to stdout — Railway's logs are the equivalent sink. Keep it on whether or not
telemetry is enabled.

## Phase 6 — Tests + docs

Mirror chat-flue's test discipline with bun-native tests (no network):

- `agent/lib/approval.test.ts` — mutating vs read-only names, `maple__` prefix stripping,
  app-principal denial, unknown tools pass through, the full mirrored set matches a literal
  snapshot (drift canary against accidental edits).
- Skill/instructions sanity — files exist, frontmatter descriptions present, `maple__` prefix
  note present, no `mcp__maple__` or `<<maple:` remnants.
- README: new "Parity with the web chat" section (what's ported, what's deliberately not, the
  approval-executes-for-real difference), new env vars, and the sync-note pointing at
  `apps/api/src/mcp/tools/mutating.ts`.
- Manual acceptance in a linked workspace: (a) "how are things looking?" routes through
  system_health; (b) "create an alert rule for checkout p95" produces a Slack approval card,
  approve executes, deny is acknowledged without retry; (c) @mention in an alert-notification
  thread loads the incident-investigation skill and scopes queries to the alert window; (d)
  "build me a dashboard for checkout" loads the dashboard-builder skill and test-queries before
  proposing; (e) spans for (a)–(d) visible in Maple under `maple-slack-agent`.

## Phase 7 — Rich visuals: rendered chart images (beyond parity)

Explicitly **net-new, not parity**: chat-flue renders no images anywhere — its `<<maple:...>>`
annotations are parsed client-side (`apps/web/src/components/ai-elements/inline/`) into live React
stat cards, and charts only exist as dashboard widgets. Slack can only show images, so a richer
Slack experience needs a render → upload → reference pipeline that no Maple surface has today.

- **Render in-process**: the slack-agent is a long-running Node container — use Satori or
  `@resvg/resvg-js` (SVG→PNG), no headless browser, no external chart service (QuickChart would
  leak org telemetry into URLs and add public-serving infra).
- **Deliver via `files.uploadV2`** with the per-team bot token, referenced through `slack_file` in
  an `image` block. Files live in the customer's workspace under Slack's own ACLs; nothing is
  publicly served. The eve patch already threads per-team tokens through the upload call sites —
  add an explicit multi-workspace upload e2e check, since this makes that patch surface
  load-bearing.
- **Expose as an authored tool** `agent/tools/render_chart.ts`: typed spec (title, unit, kind,
  series of `[ts, value]`), fills from data the model already fetched via MCP, renders + uploads
  to the current thread, returns the file reference (so the model knows the image is posted and
  doesn't re-describe it). Unicode-sparkline fallback on render/upload failure
  (`docs/slack-rich-notifications.md` §3).
- **Open decisions at execution time**: match the Maple dashboard chart aesthetic (mirrored
  template, not imported) vs. a plain clean style first; whether `render_chart` later also powers
  structured alert cards (same renderer, different entry point — out of scope here).

## Risks / open questions

- **Model quality through skills**: GLM-5.2 must reliably call `load_skill` off the routing
  descriptions. If it under-triggers, fall back to folding the investigation guidance into
  `instructions.md` (bigger always-on prompt, chat-flue's shape) — decide on evidence from (c)/(d).
- **Approval UX volume**: `always`-style per-call approval on every mutating tool can spam a
  thread during dashboard building (one card per widget). If that bites, consider `once()`
  semantics per session for `add_dashboard_widget`/`test`-adjacent tools — explicitly a product
  decision, not a default in this plan.
- **Patched-eve surface**: Phase 3 leans on the HITL interaction paths patched in
  `patches/eve@0.25.3.patch`. When upstream vercel/eve#222 ships and the patch drops, re-verify
  approvals multi-workspace.
- **Mutating-set drift**: three mirrored copies now exist. If drift becomes real, add a CI check
  that diffs the literals across the three files (a script, not a shared import).

## Suggested sequencing

1 → 2 → 3 ship together as the user-visible parity change (prompts + skills + approvals are one
coherent behavior change); 4 → 5 follow as the observability change; 6 lands with both.
