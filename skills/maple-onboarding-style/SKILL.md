---
name: maple-onboarding-style
description: "General OpenTelemetry onboarding style for Maple: native APIs, signal quality, inline keys, VCS resource attributes, LLM metrics, and smoke checks."
---

# Maple OTel onboarding style

Use native OpenTelemetry APIs. Do not invent helper APIs.

In TypeScript/JavaScript, use the published `@maple/otel-helpers` `withSpan` helper for bounded business spans and add `@maple/otel-helpers` to `package.json` when it is not already present. This is required when the package can be installed. `withSpan` is the intended replacement for expanding a whole function into `tracer.startActiveSpan(...)` plus `try` / `catch` / `finally`. Do not use helpers to wrap provider SDK calls that OpenInference / provider instrumentation can observe directly.

Do:

```ts
import { trace, metrics } from "@opentelemetry/api"
import { withSpan } from "@maple/otel-helpers"

const tracer = trace.getTracer("orders.api")
const meter = metrics.getMeter("orders.api")
const ordersSubmitted = meter.createCounter("orders.submitted")

await withSpan(
	"order.submit",
	async (span) => {
		span.setAttributes({
			"tenant.id": tenantId,
			"order.id": orderId,
			outcome: "success",
		})
		ordersSubmitted.add(1, { "tenant.id": tenantId, outcome: "success" })
	},
	{ tracer },
)
```

Do not:

```ts
await sendMapleSpan(...)
recordCounter(...)
withTelemetry(...)
```

## Naming

- Files/functions are provider-neutral: `telemetry.ts`, `observability.ts`, `initTelemetry()`, `initObservability()`.
- The word Maple belongs only in endpoint/key setup comments or PR instructions.
- Span names are conventional and low-cardinality: `checkout.process`, `voice.session`, `llm.generate_copy`.
- Prefer semantic product-operation span names over provider transport names. `llm.generate_copy` or `llm.voice_response` is usually more useful than `llm.anthropic.messages.create`.

## Endpoint and key

Inline the endpoint and the project's ingest key directly in the bootstrap source — don't read from `OTEL_EXPORTER_OTLP_*` env vars and don't write `.env` files. The Maple ingest key is project-scoped + write-only (Sentry DSN shaped), so source-level configuration is the right default; env-var indirection only adds deploy-time failure modes.

```text
MAPLE_ENDPOINT = "https://ingest.maple.dev"
MAPLE_KEY      = "maple_…"        # or "MAPLE_TEST" while pairing
```

While pairing is in flight, use the literal `MAPLE_TEST` sentinel — Maple's ingest accepts it without forwarding events anywhere, so the bootstrap exercises the full code path before the real key arrives.

Pass the inline values to the SDK explicitly via the exporter constructor's `endpoint` / `headers` options. Do not configure the SDK off implicit env-var reads.

If the repo can call telemetry init from multiple paths, guard provider/exporter setup so repeated imports, tests, reloads, or framework callbacks do not install duplicate processors or log handlers. For a single-entrypoint app that starts cleanly, keep this simple.

Include standard resource attributes when values are available: `service.name`, `service.version`, `deployment.environment.name`, and the VCS attributes below.

## VCS resource attributes

Set `vcs.repository.url.full` on the OTel resource for every instrumented service. The value is the canonical https URL of the repo (e.g. `https://github.com/acme/api`) — the same URL the user would paste in a browser, not an SSH URL, not a local working-tree path. This is the important one: it lets Maple link telemetry back to the source of truth. It is fine to hardcode this string alongside `service.name` in the SDK init; if a build env already exposes the slug (e.g. `VERCEL_GIT_REPO_OWNER` + `VERCEL_GIT_REPO_SLUG`, `RAILWAY_GIT_REPO_OWNER` + `RAILWAY_GIT_REPO_NAME`), prefer reading from env so a fork or rename doesn't drift.

Also set `vcs.ref.head.revision` (the commit SHA) on a best-effort basis. Read it from whatever env var the runtime/build platform already injects: `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`, `GITHUB_SHA`, `SOURCE_COMMIT`, `GIT_COMMIT`, `HEROKU_SLUG_COMMIT`, etc. Do not shell out to `git` from the running process — many production images do not have git or a working tree. If no env source is available, omit the attribute; skipping the SHA is fine, skipping the URL is not.

Use `vcs.repository.url.full` and `vcs.ref.head.revision` exactly as named — these are the OTel semantic-convention keys. Do not invent parallel attributes like `git.repo`, `app.repo_url`, or `deployment.commit_sha`.

## Signals

- Traces: all critical operations have spans with relevant attributes.
- Logs: structured, concise, OTLP-forwarded, and trace/span-correlated.
- Metrics: critical operations have low-cardinality counters/histograms.
- Tenant/org/project information is included where available.
- Do not put raw user ids or request ids in metric tags unless the repo already treats them as bounded tenant-like ids.

## LLM metrics

If the app uses LLMs, first look for provider instrumentation that already captures model/provider/token/error spans. In JavaScript/TypeScript, prefer OpenInference packages such as `@arizeai/openinference-instrumentation-anthropic` for supported SDKs. Keep the real provider call native and readable.

```ts
const response = await client.messages.create({
	model,
	max_tokens: 100,
	messages,
})
```

Every provider/call site still needs enough telemetry to answer usage questions. Let provider instrumentation own model/provider/token spans where it supports them. Do not duplicate those attributes at every application call site, and do not put provider pricing tables or cost math in product handlers. Maple computes estimated LLM cost centrally in the UI/query layer from captured provider/model/token data.

```ts
llmInputTokens.add(inputTokens, {
	"tenant.id": tenantId,
	"gen_ai.provider.name": "anthropic",
	"gen_ai.request.model": model,
	"app.gen_ai.use_case": "voice.initial_greeting",
	"app.gen_ai.call_site": "_callMugCopyLlm",
	outcome: "success",
})
```

Use counters for additive totals only when provider instrumentation cannot capture token usage:

- `llm.tokens.input`
- `llm.tokens.output`

Token counters use `unit="tokens"` or the SDK equivalent. If OpenInference / provider instrumentation already captures token usage, do not duplicate token counters just to mirror it. Do not add `llm.cost_usd` or equivalent app-side cost metrics for normal LLM calls; cost belongs in Maple's central pricing layer.

Use histograms for latency/duration distributions.

Prefer current `gen_ai.*` semantic-convention-style attribute names for LLM provider/model/token attributes, plus `app.gen_ai.*` for bounded application dimensions such as use case and call site. Avoid inventing parallel `llm.*` attributes unless the repo already standardizes on them.

If the app has OpenAI, Anthropic, and Google callers, instrument all three.

## Smoke checks

Add a durable smoke path when the repo has a natural place for it: README, TESTING guide, script, npm command, pytest, or checked-in command note.

The smoke should explicitly prove startup/import with the OTel bootstrap loaded so provider setup, exporter construction, log bridging, and framework instrumentation initialize without errors. Then, where practical, exercise an actual instrumented span/log/metric or OTLP export attempt. A generic health route only proves the server responds; prefer an operation that crosses the instrumentation you added.
