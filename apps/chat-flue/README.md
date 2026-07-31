# @maple/chat-flue

Maple's AI chat and headless triage, built on the [Flue framework](https://flueframework.com)
and running on **Cloudflare Workers AI**. It backs three surfaces in the product:

- `/chat` and the global chat sheet — general questions about your telemetry.
- `/investigations/*` — a durable war room per incident. `apps/api` starts the first
  autonomous turn; the browser joins the same agent instance and continues it.
- The headless `triage` workflow, invoked by `apps/api` when an incident opens.

## Layout

| File                                | Role                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                        | Hono app mounting `flue()`. Owns CORS, auth on `/agents/*`, the internal-token guard on `/workflows/*`, and the OpenTelemetry bridge.                    |
| `src/agents/maple-chat.ts`          | The addressable chat agent, at `POST/GET /agents/maple-chat/:id`. Picks the model, loads Maple's tools, and adds `submit_diagnosis` in investigate mode. |
| `src/lib/mcp.ts`                    | Adapts Maple's tool registry (over the `MAPLE_API_RPC` service binding) into Flue tools.                                                                 |
| `src/lib/json-schema-to-valibot.ts` | Bridges the two schema languages: the registry describes tools in JSON Schema, `defineTool` requires Valibot.                                            |
| `src/lib/approval.ts`               | Propose-then-apply. Mutating tools return a proposal instead of mutating; the web renders an approval card and applies via Maple's API.                  |
| `src/lib/submit-diagnosis.ts`       | The structured-output channel for an investigation's diagnosis. Writes through to `apps/api`, which persists the report.                                 |
| `src/workflows/triage.ts`           | The headless triage workflow. Owns only the LLM step; the incident lifecycle stays in `apps/api`.                                                        |
| `src/lib/auth.ts`                   | Clerk or self-hosted HS256 verification, plus the check that the caller's org owns the addressed instance.                                               |

## How a turn works

An instance is addressed as `"<orgId>:<tabId>"`, and the tab prefix selects the mode
(`inv-` → investigate, `alert-`, `widget-fix-`). The org is recovered from the instance id
server-side and never trusted from the request body.

Tools come from `apps/api`'s MCP registry over the `MAPLE_API_RPC` binding — the binding
authenticates the Worker-to-Worker hop, and the org is passed explicitly and re-validated
at the API boundary. Each tool returns `{ text, ui? }`: the report the model reasons over,
and the structured payload the web renders as a table or chart.

Models resolve through `@earendil-works/pi-ai`. A `cloudflare/<id>` spec runs on the `AI`
binding — keyless, billed as Workers AI. See `DEFAULT_MODEL` in `src/agents/maple-chat.ts`
for the current default; `MAPLE_CHAT_MODEL` overrides it, and `MAPLE_TRIAGE_MODEL`
overrides it for the triage workflow. The catalog churns, so check a new id against
`bunx wrangler ai models list` — a retired id returns 410.

## Run it

```bash
bun dev                                  # from the repo root: everything, via portless
bun --filter=@maple/chat-flue dev:app    # just this worker
```

`dev:app` regenerates `.dev.vars` from the repo-root `.env.local`
(`scripts/sync-chat-flue-dev-vars.ts`) before starting, so the internal-service token and
auth config always match `apps/api`. Local overrides go below the marker in `.dev.vars`.

**`apps/api` must be running too**, under wrangler: the two workers call each other over
service bindings that resolve through wrangler's local dev registry. See CONTRIBUTING §5
for the failure signatures.

```bash
bun run test        # vitest
bun run typecheck
bun run build       # vite build (@flue/vite + @cloudflare/vite-plugin)
```

## Deploying

Alchemy owns the deploy (`alchemy.run.ts`, wired into the root `alchemy.run.ts`). It runs
`vite build` and uploads the prebuilt worker from `dist/maple_chat_flue/` with bindings it
declares itself — the generated `wrangler.json` and `.dev.vars` are not read. The `deploy`
script is a Flue-native fallback.

**Redeploy this worker before shipping a web change that alters the conversation format.**
The browser and the worker have to agree on it.
