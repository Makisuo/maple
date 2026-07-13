# OpenRouter Tracing

OpenRouter Broadcast can send each OpenRouter completion as an OTLP/HTTP trace to any backend that accepts JSON OTLP on `/v1/traces`. Maple can receive those traces through the normal ingest gateway, so chat-agent LLM calls can appear alongside application traces.

References verified on June 4, 2026:

- OpenRouter Broadcast to OpenTelemetry Collector: https://openrouter.ai/docs/guides/features/broadcast/otel-collector
- OpenRouter API request fields and app attribution headers: https://openrouter.ai/docs/api/reference/overview

## What Maple Sends

`apps/chat-agent/src/lib/openrouter.ts` centralizes OpenRouter request setup.

Every chat turn sent through `apps/chat-agent/src/index.ts` includes `providerOptions.openrouter.trace`, which the OpenAI-compatible AI SDK forwards into the OpenRouter request body. OpenRouter documents these fields as Broadcast trace metadata:

| Field                   | Maple value                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `trace.trace_id`        | Chat request id, or a generated turn id when the request has none.           |
| `trace.trace_name`      | `Maple Chat Agent`.                                                          |
| `trace.generation_name` | `Chat Turn`.                                                                 |
| `session_id`            | The chat Durable Object name, currently `<orgId>:<tabId>`.                   |
| `trace.orgId`           | Maple org id, surfaced downstream as `trace.metadata.orgId`.                 |
| `trace.operation`       | `chat.turn`.                                                                 |
| `trace.mode`            | Chat mode, such as `default`, `dashboard_builder`, `alert`, or `widget-fix`. |
| `trace.environment`     | `MAPLE_ENVIRONMENT` when configured.                                         |
| `trace.isByok`          | Whether the org's own OpenRouter key was used.                               |

The OpenRouter provider also sends app attribution headers:

| Header               | Maple value                           |
| -------------------- | ------------------------------------- |
| `HTTP-Referer`       | `MAPLE_APP_BASE_URL` when configured. |
| `X-OpenRouter-Title` | `Maple` by default.                   |

## Configure OpenRouter Broadcast To Maple

Use this when you want OpenRouter-generated LLM traces to land in Maple.

1. In Maple, copy the org's private ingest key from Settings -> Ingestion. It has the `maple_sk_...` prefix.
2. In OpenRouter, open Settings -> Observability and enable Broadcast.
3. Edit the OpenTelemetry Collector destination.
4. Set the endpoint:

```text
https://ingest.maple.dev/v1/traces
```

For self-hosted Maple, use the externally reachable ingest gateway URL:

```text
https://<your-ingest-host>/v1/traces
```

5. Set headers to:

```json
{
	"Authorization": "Bearer maple_sk_..."
}
```

6. Use OpenRouter's Test Connection action, then send a Maple chat message.

OpenRouter only emits Broadcast traces for traffic under the OpenRouter account or workspace where Broadcast is enabled. If an org uses BYOK in Maple Settings -> AI, configure Broadcast in that org's OpenRouter account. If the org falls back to Maple's default OpenRouter key, Broadcast must be configured on Maple's OpenRouter account.

## Querying In Maple

OpenRouter Broadcast traces use standard GenAI semantic convention attributes such as `gen_ai.*` for model, usage, and cost data. Maple also receives the custom metadata above under OpenRouter's `trace.metadata.*` namespace.

Maple renders these as first-class LLM calls: any span carrying `gen_ai.*` attributes is badged with a sparkle/provider icon in the waterfall, timeline, and flow views, and the span-detail panel shows a summary block with the provider, operation, model, input/output tokens, cost, request params, and finish reason. In the attribute table, `gen_ai.request.model` / `gen_ai.response.model` render as model chips, token counts are grouped, and `gen_ai.usage.cost` renders as currency. Because OTel renamed `gen_ai.system` → `gen_ai.provider.name`, a provider filter matches spans using either spelling.

Useful filters:

```text
trace.metadata.orgId = "<orgId>"
trace.metadata.operation = "chat.turn"
trace.metadata.mode = "dashboard_builder"
session.id = "<orgId>:<tabId>"
gen_ai.provider.name = "openai"   # also matches the legacy gen_ai.system spelling
gen_ai.request.model = "openai/gpt-4o"
```

If prompt or completion content should not leave OpenRouter, enable Privacy Mode for the OpenRouter observability destination. OpenRouter's docs state that Privacy Mode excludes prompt and completion content while still sending timing, model, token usage, cost, and metadata.

## Local Test Coverage

The OpenRouter request contract is covered by:

```bash
TMPDIR=/tmp bun test apps/chat-agent/src/lib/openrouter.test.ts
```

The tests assert that Maple:

- sends the OpenRouter app attribution headers;
- forwards trace correlation metadata under `providerOptions.openrouter`;
- omits blank optional metadata instead of sending empty attributes;
- rejects an empty `traceId`.
