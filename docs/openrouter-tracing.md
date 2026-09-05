# OpenRouter Attribution And Tracing

Maple attributes every OpenRouter request to its app page on openrouter.ai and tags it with the
surface it came from, the org it ran for, and the session it belongs to. Separately, OpenRouter
Broadcast can send each completion as an OTLP/HTTP trace to any backend that accepts JSON OTLP on
`/v1/traces` — including Maple's own ingest gateway.

References verified on August 4, 2026:

- App attribution: https://openrouter.ai/docs/app-attribution
- User tracking: https://openrouter.ai/docs/guides/guides/administration/user-tracking
- Broadcast to OpenTelemetry Collector: https://openrouter.ai/docs/guides/features/broadcast/otel-collector

## Where OpenRouter Is Called

| Path                                  | Client                                     | Surfaces                                                         |
| ------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `apps/api/src/platform/Llm.ts`        | `@opencode-ai/ai` (`OpenRouter.configure`) | chat turns and investigation planner/hypothesis/validator agents |
| `apps/slack-agent/agent/agent.ts`     | `@openrouter/ai-sdk-provider`              | the Slack agent                                                  |
| `apps/api/src/mcp/__evals__/model.ts` | `@ai-sdk/openai-compatible`                | MCP evals in CI — **not** attributed or tagged                   |

`apps/api` can also run on Cloudflare Workers AI instead (`MAPLE_LLM_PROVIDER=workers-ai`). None of
the attribution below applies on that path — the headers and tag fields are OpenRouter's, and
`resolveTriageModel` deliberately keeps them off the Workers AI branch.

## App Attribution

`HTTP-Referer` is what creates the app page on openrouter.ai; a title on its own does nothing and
usage without a referer never appears in the rankings. Both the API and the Slack agent send the
same URL and title on purpose — the referer _is_ the app's identity, so a second value would mint a
second app entry and split the rankings.

| Header                           | Value               | Set at                                                                                              |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `HTTP-Referer`                   | `https://maple.dev` | `apps/api/src/platform/Llm.ts` (`OPENROUTER_APP_URL`), `apps/slack-agent/agent/agent.ts` (`appUrl`) |
| `X-Title` / `X-OpenRouter-Title` | `Maple`             | same, `OPENROUTER_APP_TITLE` / `appName`                                                            |

Per-app analytics then live at https://openrouter.ai/apps.

## Per-Request Tags

`resolveTriageModel(env, tags)` takes an optional `LlmCallTags` (`surface`, `orgId`, `sessionId`)
and folds it into the OpenRouter request body as route defaults, so every `LLM.request` /
`generate` / `stream` made with the returned model carries it without each call site threading it
through.

| Field              | Maple value                                                                                                | Where it shows up                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`             | Maple org id                                                                                               | the `/activity` page, activity exports, and the `/generations` API. OpenRouter folds it into a hashed identity and never forwards it raw upstream.        |
| `session_id`       | `<chat session id>` or `triage_<incidentKind>_<incidentId>`, truncated to OpenRouter's 256-character limit | groups the requests of one conversation or investigation, and makes OpenRouter route the whole session to a single provider so prompt caches actually hit |
| `trace.trace_name` | `chat`, `ai-triage`, or `slack`                                                                            | forwarded to configured Broadcast destinations only — it does **not** appear in the OpenRouter dashboard                                                  |

The Slack agent sends a static `trace: { trace_name: "slack" }` via the provider's `extraBody`,
since that process is a single surface. It does not send `user` or `session_id`; wiring the Slack
team and thread through would need a per-request hook from `eve`.

## Configure OpenRouter Broadcast To Maple

Use this when you want OpenRouter-generated LLM traces to land in Maple. This is also the only way
the `trace` metadata above becomes visible anywhere.

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

OpenRouter only emits Broadcast traces for traffic under the OpenRouter account or workspace where
Broadcast is enabled. Maple has no BYOK path — every org's traffic runs on Maple's own
`OPENROUTER_API_KEY` — so Broadcast is configured once, on Maple's OpenRouter account.

## Querying In Maple

OpenRouter Broadcast traces use standard GenAI semantic convention attributes such as `gen_ai.*` for
model, usage, and cost data. The tag fields arrive under OpenRouter's `trace.metadata.*` namespace.

Useful filters:

```text
trace.metadata.trace_name = "ai-triage"
session.id = "triage_error_<incidentId>"
```

If prompt or completion content should not leave OpenRouter, enable Privacy Mode for the OpenRouter
observability destination. OpenRouter's docs state that Privacy Mode excludes prompt and completion
content while still sending timing, model, token usage, cost, and metadata.

## Local Test Coverage

The attribution and tagging contract is covered by:

```bash
bun run --cwd apps/api vitest run src/platform/Llm.test.ts
```

Those tests swap `FetchHttpClient.Fetch` for a capture and assert, on the outgoing request, that
Maple sends the attribution headers, the `user` / `session_id` / `trace` fields, omits `session_id`
when there is no session, truncates an over-long one, and sends none of it on the Workers AI path.
