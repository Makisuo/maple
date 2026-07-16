# @maple/chat-flue

Maple chat reworked on the [Flue framework](https://flueframework.com), running
on **Cloudflare Workers AI** and sourcing tools from Maple's existing MCP server.

This is the **Phase 0 de-risking spike** — a minimal vertical slice that proves
the architecture before the full rebuild. See the plan at
`~/.claude/plans/pls-rework-our-chat-eager-octopus.md`.

## What's here

| File                                | Role                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/maple-chat.ts`          | The addressable chat agent. `export const route` exposes it at `POST/GET /agents/maple-chat/:id`; Workers AI model + API Worker RPC → Maple MCP tools (`mcp__maple__*`). |
| `src/lib/env.ts`                    | Worker bindings/vars (`AI`, `MAPLE_API_RPC`, `INTERNAL_SERVICE_TOKEN`).                                                                                                      |
| `src/lib/org.ts`                    | Recovers `orgId` from the `"<orgId>:<tabId>"` instance id.                                                                                                                   |
| `flue.config.ts` / `wrangler.jsonc` | Flue + Cloudflare build config (Workers AI `AI` binding, DO migrations).                                                                                                     |

> No `src/app.ts` yet — it's **optional**, and without it Flue serves the agent
> via its generated app. Phase 1 adds `src/app.ts` (a Hono app mounting
> `flue()`) for auth middleware on `/agents/*` and the `observe()` → OTel bridge.

## How the model layer works

Flue's model layer is `@earendil-works/pi-ai`. A model spec `cloudflare/<id>`
resolves to the **binding-backed Workers AI provider** — the turn runs through
the `AI` Durable-Object binding (`env.AI.run`), no HTTP token. The generated
Cloudflare app registers this provider by default; AI Gateway options and a
per-org model override (`MAPLE_CHAT_MODEL`) layer on top.

Default model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (strongest Workers AI
function-calling model). **Validating tool-calling quality across Maple's full
tool set is the main open risk.**

## Run the spike (live proof — pending)

> Requires installed deps, a running `apps/api` (MCP at `/mcp`), and a Cloudflare
> account with Workers AI.

```bash
# 1. Install (from repo root)
bun install

# 2. Secrets
cp apps/chat-flue/.dev.vars.example apps/chat-flue/.dev.vars
#   set INTERNAL_SERVICE_TOKEN to match apps/api

# 3. Run the Flue dev server (Cloudflare target, port 3583)
cd apps/chat-flue && bun run dev

# 4. Drive the agent from the CLI
bun run connect          # flue connect maple-chat local
```

### Phase 0 acceptance checklist

- [x] Flue packages resolve; Workers AI provider exists (`cloudflare/*` → `env.AI`).
- [x] MCP auth contract confirmed (`Bearer maple_svc_<token>` + `x-org-id`).
- [x] `bun run typecheck` passes against Flue's real types.
- [x] `bun run build` (`flue build --target cloudflare`) discovers `maple-chat` and generates a valid worker (AI binding + `FlueMapleChatAgent`/`FlueRegistry` DOs).
- [x] `flue dev` boots the worker on the Cloudflare target.
- [x] A prompt runs end-to-end on **Workers AI** (`@cf/moonshotai/kimi-k2.6`): `POST /agents/maple-chat/<orgId>:<tab>?wait=result` → HTTP 200 with the model's reply (~1.5s). The binding path works; the legacy-parity kimi model is live.
- [ ] A prompt calls `mcp__maple__search_traces` through the `MAPLE_API_RPC` service binding, with a running `apps/api` and a real org id.
- [ ] A browser page streams the agent's events via `@flue/sdk` (`agents.send` + `agents.stream`).
- [ ] Tool-calling quality across the full tool set is acceptable on the chosen model.

## Phase 1 progress

- [x] **1a — Prompts + modes** (`src/lib/prompts.ts`, `src/lib/modes.ts`): ported
      `SYSTEM_PROMPT` + `DASHBOARD_BUILDER_SYSTEM_PROMPT` and the alert /
      widget-fix / page-context blocks. Mode is derived from the instance-id tab
      prefix (`alert-`, `widget-fix-`, `dashboard-builder-`) via `modeFromInstanceId`;
      `buildSystemPrompt` assembles the turn's instructions. 13 unit tests
      (`src/lib/modes.test.ts`), `bun run test`.
- [x] **1b — Approval** (`src/lib/approval.ts`): propose-then-apply. Mutating tools
      keep their name + schema but their `execute` returns a `{status:"proposed"}`
      marker (no side effect) via `applyApprovalGates` (wired into the chat agent);
      the UI applies on approve. `parseToolProposal` reads the marker. 6 unit tests.
- [x] **1c — Triage workflow** (`src/workflows/triage.ts`, `src/lib/{triage-prompt,triage-result,mcp}.ts`):
      the agentic-investigation half of `AiTriageWorkflow` as a Flue workflow on
      Workers AI. Read-only 18-tool MCP allowlist (shared `connectMapleMcp` helper,
      also now used by the chat agent); structured `AiTriageResult` via Flue's native
      `{ result }` (valibot mirror of `@maple/domain`) — replacing the `submit_triage`
      tool. 8 unit tests. **Boundary:** `apps/api`'s `AiTriageService` keeps the D1
      gate/persist lifecycle and invokes this workflow (`@flue/sdk`
      `workflows.invoke("triage", …)`) for the LLM step — that rewiring is the
      remaining `apps/api`-side follow-up.
- [x] **1d — `app.ts` + auth** (`src/app.ts`, `src/lib/auth.ts`): Hono app mounting
      `flue()`, with auth middleware on `/agents/*` (ported Clerk + self-hosted HS256
      verification; token from header or `?token=`) that checks the caller's org owns
      the addressed `"<orgId>:<tabId>"` instance. Plus an `observe()` bridge logging
      agent/tool/run failures (full OTLP export is a follow-up). 12 auth unit tests
      (`src/lib/auth.test.ts`). Needs deps `hono` + `@clerk/backend`.

> **Open integration point:** the rich per-conversation context payloads
> (`alertContext`, `widgetFixContext`, `pageContext`) still need a delivery
> channel — Flue's `agents.send` only carries `{ message }`. Options: a custom
> `app.ts` route that carries context + dispatches, or a structured message
> preamble. Decided in Phase 2 with the frontend. Until then the agent uses the
> base prompt for the id-derived mode.

## Phase 2 — frontend adapter (designed; ships with the cutover)

`@flue/react` ships `useFlueAgent` whose message shape mirrors AI SDK v5
`UIMessage` (text + `dynamic-tool` parts with
`input-available`/`output-available`/`output-error` states), which the existing
`chat-conversation.tsx` renderer already handles. So the adapter is a thin
wrapper, not a rewrite:

- `useFlueChat({ tabId })` wraps `useFlueAgent` and exposes the same
  `{ messages, sendMessage, status, addToolApprovalResponse }` surface the UI
  consumes — mapping status (`idle`/`connecting` → `ready`) and carrying
  per-conversation context as a first-message preamble.

It's been validated (typechecks against `apps/web` with `@flue/react` +
`@flue/sdk`) but is **deliberately not included in this change** — nothing
imports it until the cutover, and the repo enforces no dead code (knip). It
lands in the cutover step below, where `chat-conversation.tsx` actually swaps to
it.

## Cutover (final, gated on a deployable Flue backend)

Blocked locally only by `apps/api`'s `POST /mcp` hang; the code is ready.

1. Re-point `chat-conversation.tsx`: `useAgentChat` → `useFlueChat`; build the
   first-message context preamble from alert / widget-fix / page context.
2. Approval: detect proposal tool results (`parseToolProposal`) and wire the
   approval card's approve action to Maple's real mutation API.
3. Env: point `VITE_FLUE_CHAT_URL` (and retire `VITE_CHAT_AGENT_URL`) at the
   deployed Flue worker.
4. `apps/api`: rewire `AiTriageService` to invoke the Flue `triage` workflow
   (`@flue/sdk` `workflows.invoke`) for the LLM step.
5. Delete `apps/chat-agent/`; decide on `OrgOpenRouterSettingsService` removal
   (Workers AI drops per-org BYO keys + changes Autumn billing — needs sign-off).
