---
name: maple-onboard
description: "Onboard a project to Maple by installing OpenTelemetry traces, logs, and metrics across every app and service in the repo. Triggers on requests like 'install Maple', 'set up Maple', 'add Maple telemetry', 'onboard this repo to Maple', 'instrument with OpenTelemetry for Maple'."
---

# Maple onboarding

Wire OpenTelemetry traces, logs, and metrics into the user's project so telemetry streams to Maple. Cover **every app and service in the repo** — not just the one the user is currently sitting in.

Prefer native OpenTelemetry APIs and the framework's documented bootstrap over custom helper layers. If a specific stack stumps you, search the OTel docs for that language; don't guess.

Before editing, read the applicable companion skills:

- `maple-onboarding-style` for general OTel taste, VCS attributes, and smoke checks.
- `maple-nextjs-style` for Next.js / Vercel apps.
- `maple-nodejs-style` for plain Node servers (Express, Fastify, Hono, Bun).
- `maple-python-style` for Python services (FastAPI, Django, Flask).
- `maple-effect-style` for Effect-based services — Maple's first-class SDK.
- `maple-go-style`, `maple-rust-style`, `maple-java-style`, `maple-csharp-style`, `maple-kotlin-style` for those stacks.

If none match (Ruby, Elixir, PHP, plain Deno, …), use `maple-onboarding-style` as the fallback and consult the upstream OTel docs for that language.

## Step 0 — Endpoint and key handling

The **OTLP endpoint** is always `https://ingest.maple.dev` and **goes inline** in the bootstrap code — it's not a secret, no env-var indirection needed.

The **ingest API key** is **project-scoped + write-only** — it can only ingest events for one project, can't read anything, can't change settings. Treat it like a Sentry DSN, a PostHog public key, or a Datadog RUM client token: **inline it directly in the OTel bootstrap source** alongside the endpoint. No `.env` files, no deploy-target wiring, no `process.env.OTEL_EXPORTER_OTLP_HEADERS`. The user deploys their code and events flow.

Two paths, no questions asked:

### Key in the prompt

If the invoking prompt already contains a Maple ingest key, inline it in every bootstrap file you write. Done — move on to Step 1.

### No key

Inline the literal sentinel `MAPLE_TEST` in the bootstrap source as a placeholder. Maple's ingest gateway accepts it from anyone, returns 200 without forwarding anywhere, so the user's app can boot and exercise the OTel bootstrap path while they go create a real key.

Tell the user *briefly* at the top of your work: "I'm using `MAPLE_TEST` as a placeholder so the bootstrap can run. Create a real key at https://app.maple.dev/settings (Settings → API Keys) and search-replace the literal `MAPLE_TEST` in the files I write to swap it in."

Then keep going. Don't block install on signup.

## Step 1 — Map every app/service in the repo

Before instrumenting anything, enumerate what's here. Check workspace manifests (`pnpm-workspace.yaml`, root `package.json` `workspaces`, `bun` workspaces, `go.work`, Cargo workspace, Python `pyproject.toml` workspace setups, `apps/*` and `services/*` conventions). Identify each service: web frontend, API, workers, background jobs, CLIs, sample/demo apps, mobile apps, Supabase and/or server functions. Mobile and serverless/edge functions are in scope; do not skip them merely because they are client-side or short-lived. Skip pure type/config packages with no runtime entry point. Do not skip any runnable services or leave them "out of scope": instrument absolutely everything in this run; there may be no follow-up.

Show the user the list before you start, so they can correct it.

## Step 2 — For each service, install native OTel and bootstrap

**Use the language's native OpenTelemetry SDK.** Don't reach for vendor wrappers or hand-rolled helpers when an official package exists. Examples of what "native" means here: `@opentelemetry/sdk-node` for Node servers, `@vercel/otel` for normal Next.js/Vercel apps (sdk-node breaks Next's webpack and misses the framework bootstrap), `@opentelemetry/sdk-trace-web` + browser/mobile-compatible exporters for Vite/SPA/Expo, `opentelemetry-instrumentation-*` + `opentelemetry-sdk` for Python, `go.opentelemetry.io/otel` for Go.

No broad wrapper APIs. Avoid reusable helpers like `sendMapleSpan`, `recordCounter`, `recordLog`, `startTelemetrySpan`, or `withTelemetry`. Acquire native tracers/meters/loggers at module scope and use the SDK's own APIs directly. In TypeScript/JavaScript, use the published `@maple/otel-helpers` `withSpan` helper for bounded business spans and add `@maple/otel-helpers` to `package.json`; this is required when the package can be installed because it avoids expanding a whole function into `startActiveSpan` plus `try` / `catch` / `finally`. Do not use helpers around provider SDK calls that OpenInference/provider instrumentation can observe directly.

Wire all three signals — traces, logs, metrics. **Logs go through OTLP, not just stdout** — set up the OTel log bridge for the language so app logs (with their existing log levels and structured fields) carry the active `trace_id` / `span_id` automatically. The user's existing logger keeps working; you're just adding an OTLP handler/processor underneath.

Bootstrap rules:

- The bootstrap file must run before any framework imports. Use the language/framework's documented hook (`--import` flag, `instrumentation.ts`, top-of-`main.py` import, etc.).
- Inline the endpoint (`https://ingest.maple.dev`) and the project's ingest key directly in the bootstrap source. Don't read from `process.env.OTEL_EXPORTER_OTLP_*` or write any `.env` files — the key is write-only, and inline configuration removes a whole class of "OTel didn't start because env vars weren't set" deploy failures. (See the framework-specific style skills for the exact shape per stack.)
- Use HTTP OTLP exporters, not gRPC. gRPC pulls in native bindings that break bundlers and complicate containers.
- Use the project's existing package manager (detect via lockfile).
- Prefer idempotent edits. If a config file already exists, edit don't overwrite.
- Set resource attributes on the OTel resource for every service: `service.name`, `service.version`, `deployment.environment.name`, and **`vcs.repository.url.full`** — the canonical https URL of the repo (e.g. `https://github.com/acme/api`). The repo URL is the important one and is fine to hardcode alongside `service.name` in the SDK init; if the build platform exposes the slug (Vercel `VERCEL_GIT_REPO_OWNER`/`VERCEL_GIT_REPO_SLUG`, Railway `RAILWAY_GIT_REPO_OWNER`/`RAILWAY_GIT_REPO_NAME`), prefer reading from env. Also set **`vcs.ref.head.revision`** (commit SHA) on a best-effort basis from whatever env the runtime already injects (`VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `GITHUB_SHA`, `SOURCE_COMMIT`, `GIT_COMMIT`, `HEROKU_SLUG_COMMIT`, …). Do not shell out to `git` from the running process. Skipping the SHA is fine, skipping the URL is not. Use the OTel semantic-convention keys exactly — do not invent `git.repo` / `app.repo_url` / `deployment.commit_sha`.

Framework rules:

- **Next.js/Vercel:** use `instrumentation.ts` with `@vercel/otel` `registerOTel(...)` as the bootstrap. Do not substitute a raw `@opentelemetry/sdk-node` / `NodeSDK` bootstrap unless the repo already uses that architecture and you are extending it. Use `@opentelemetry/api` tracers/meters inside route handlers only where auto-instrumentation is blind.
- **Expo/React Native:** preserve existing Expo Go / unsupported-runtime guards. In supported builds, call `initObservability()` before Sentry and before app registration/user code. Inline the endpoint + ingest key in the observability module — no `EXPO_PUBLIC_*` env vars. The bootstrap reads them straight from constants.
- **Supabase Edge Functions / Cloudflare Workers:** native Deno / Workers OpenTelemetry can be quirky. Keep the exporter shim tiny, provider-neutral, and OTel-shaped: `tracer.startActiveSpan`, `span.setAttributes`, `SpanStatusCode`, `meter.createCounter`, `histogram.record`. For Effect-on-Workers, prefer `@maple/effect-cloudflare` (see `maple-effect-style`).
- **Python/FastAPI:** use native instrumentation such as `FastAPIInstrumentor.instrument_app(app)` rather than replacing request handling with manual middleware.

**Coexist with existing observability vendors. Don't remove Sentry, Datadog, New Relic, Honeycomb, Logtail, Pino transports, etc.** OTel sits alongside them. The user explicitly wants both signals flowing during migration; ripping out the incumbent is not your call.

## Step 3 — Add custom spans, metrics, and logs around business operations

Auto-instrumentation gets you HTTP in/out, DB queries, framework lifecycle. That's the floor, not the ceiling. Read the project to find the operations a human operator would actually want to see when something looks wrong.

### Traces

Wrap **every critical business operation** with an active span. Auto-instrumented spans are fine where they exist — but if an operation isn't already getting a span, add one.

- Naming: `domain.verb` (`order.process`, `payment.charge`, `email.send`, `agent.run`, `interview.create`, `job.<type>`).
- Attributes: entity IDs (order.id, user.id, workspace.id, tenant.id), counts, key boolean branch outcomes, model name / provider for LLM calls.
- Record exceptions: `span.recordException(err)` + `span.setStatus({ code: ERROR })` on failure paths. **In TS/JS use `withSpan` from `@maple/otel-helpers`** so the body stays flat instead of nested under `try` / `catch` / `finally`.
- For Python functions with clear boundaries, prefer `@tracer.start_as_current_span("operation.name")`. Use a context manager when a decorator does not fit. Do not use detached `start_span()` + manual `end()` for bounded work.
- Skip trivial getters, pure transforms, internal helpers — anything with no real latency or failure mode.
- **Never put PII in attributes** (emails, passwords, tokens, full request bodies).

### Logs

Make sure logs are **structured and carry operation context**. Concretely: every log line emitted inside a span should arrive at Maple with `trace_id` / `span_id` populated and any structured fields (orderId, userId, etc.) preserved as attributes. Trace/span context may be added natively by the log bridge or integration, or may require additional work.

Use logs for narrative ("starting batch reconcile", "retrying after 3xx") and exceptional events. An error log must only be emitted if the operation cannot recover and manual intervention is required.

### Metrics

Cover **business + performance + cost**. Three categories to look for:

- **Business logic counters.** Every meaningful state transition: created, started, completed, failed, retried. Per-tenant, per-channel, per-status — low-cardinality dimensions only (never user/order IDs).
- **Performance histograms.** Latency of operations the user cares about, queue depth, batch sizes, payload sizes. Reuse existing timing instrumentation if the project already has any (`time.perf_counter` blocks, custom `LatencyTracker`s, "[TIMING]" log lines) — emit a histogram from those measurements rather than measuring twice.
- **Costs — especially LLM costs.** If the project calls OpenAI / Anthropic / Google / any LLM provider, prefer provider instrumentation such as OpenInference where available so native SDK calls stay readable. Do not add pricing constants or LLM cost math in product handlers; Maple computes estimated cost centrally in the UI/query layer from captured provider/model/token attributes. Avoid duplicating token counters already captured by provider instrumentation.

Get the meter once at module level, create instruments at module level, increment in the hot path. Don't create a fresh meter per call.

## Step 4 — Verify the app still works

Per service:

1. **Run the project's own dev or build command** (whatever its `package.json` / `pyproject` / `Makefile` already wires up). Confirm it starts cleanly with no errors that trace back to your OTel install. Also run a telemetry bootstrap smoke that imports or starts the app, so provider setup, exporter construction, log bridging, and framework instrumentation all initialize. For a Python server this can be an import/startup command such as `uv run python -c 'from app.main import app; print(app.title)'`; for Node/Next use the repo's build/start path. For a server, hit at least one route with curl so traffic flows through the instrumentation; choose a route that exercises an instrumented operation when practical, not only a static health route. For a CLI, invoke a real command. **Don't ship if the app's own startup is now broken** — that's a regression.
2. **Confirm telemetry leaves the process.** With the inline `MAPLE_TEST` (or real key) in the bootstrap, OTLP POSTs from the dev server should return 2xx — that proves the bootstrap is reaching the network. As an extra sanity check, you can `curl -X POST https://ingest.maple.dev/v1/traces -H "authorization: Bearer MAPLE_TEST" -H "content-type: application/json" -d '{}'` and confirm 200. The real signal is the running app's own POSTs succeeding by the time the dev server shuts down — if they don't, the bootstrap is wrong (most often: SDK loaded too late, or shutdown not flushing).

A bootstrap that loads but never POSTs is not a partial success. Fix it before moving on.

## Step 5 — Hand-off (final message to the user)

### What changed

3–7 short factual bullets covering: packages installed, files created/modified, business spans/metrics added. Per service if changes differed, grouped if uniform. Mention any existing observability vendor (Sentry, Datadog, Logtail, Pino transports, etc.) you intentionally left in place so the coexistence is explicit.

### Swap the placeholder if you used one

If `MAPLE_TEST` is still inline, tell the user:

> "The bootstrap currently uses `MAPLE_TEST` as a placeholder so the install could complete end-to-end. Create a real key at https://app.maple.dev (Settings → API Keys), then search-replace `MAPLE_TEST` in the files I wrote with your new key and redeploy."

### Deploy

Tell the user to deploy as they normally would — push to their hosting platform, run their existing CI, or run locally. There are no env vars to wire and nothing platform-specific to configure: the endpoint and key are inline in the bootstrap, so events start flowing the moment the instrumented code runs.

If the user asks "where do I put the key in production?" — the answer is "you already did, it's in the source you just deployed."

## Step 6 — Drive Maple MCP install

Suggest installing the Maple MCP server so the agent (Claude Code, Codex, Cursor, etc.) can query telemetry directly next time the user is debugging — search logs, pull traces, check error rates from inside the chat without context-switching to the dashboard.

For **Claude Code** (most common — that's where this skill is running), offer to run it for them:

```
claude mcp add --transport http maple https://api.maple.dev/mcp
```

This edits the user's Claude Code config. **Confirm before running** (the user may have a custom MCP scope or want to install elsewhere). If they decline, print the command so they can run it themselves later.

For other agents the user might also use, mention but do *not* run:

- **Codex:** `codex mcp add maple --url https://api.maple.dev/mcp`
- **Cursor / others:** copy the `mcpServers` snippet from https://app.maple.dev/mcp.

When done (or skipped), close out with a single line directing the user to deploy their app — they're ready to ship.

## Hard rules

- Never modify files outside the project root.
- Never commit, push, or open PRs.
- Inline the ingest key in source. It's a project-scoped, write-only token (think Sentry DSN); env-var indirection just adds deploy-time failure modes for no gain.
- Never remove an existing observability vendor unless the user asks for it.
- Use the project's existing package manager and existing logger.
- Prefer native OTel packages for the language; don't reinvent telemetry plumbing the SDK already provides.
- If the dev/build command errors out *because of* your instrumentation, that's a failure — fix it or report it, don't paper over it.
