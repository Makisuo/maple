# alchemy-maple example

A Cloudflare Worker and the Maple resources that observe it, in one stack — via
[`@maple-dev/alchemy`](../../lib/alchemy-maple) and [`@maple-dev/effect-sdk`](../../lib/effect-sdk).

| | |
| --- | --- |
| [`src/Api.ts`](src/Api.ts) | The Worker: Alchemy's Effect-native style, instrumented with the Maple SDK |
| [`alchemy.run.ts`](alchemy.run.ts) | A Slack destination, two alert rules, a dashboard, a scoped API key |

## The seam

`Maple.IngestKeys` reads the org's ingest credentials, and the Worker takes `privateKey` as an `env`
binding:

```typescript
env: {
	MAPLE_INGEST_KEY: IngestKeys.pipe(Effect.map((keys) => keys.privateKey)),
}
```

Three things follow from that one line. Alchemy ships the value as a Cloudflare `secret_text`
binding, so it never appears in plan output. It orders the deploy behind the key read, because the
binding puts `IngestKeys` in the Worker's dependency graph. And the SDK picks the key up from `env`
by name with no further wiring — **without it the SDK runs in no-op mode and nothing is exported.**

`SERVICE_NAME` is exported from `src/Api.ts` and used in both places: the SDK reports it as
`service.name`, and the alert rules filter on it. Let those drift and the alerts watch a service
that never reports.

## Deploy

```bash
bun run --cwd ../../lib/alchemy-maple build && bun run --cwd ../../lib/effect-sdk build
```

```bash
MAPLE_API_KEY=maple_ak_… CLOUDFLARE_ACCOUNT_ID=… SLACK_WEBHOOK_URL=https://hooks.slack.com/… bun alchemy deploy
```

Needs an org-admin `maple_ak_…` key (alert rules and API keys require one); set `MAPLE_API_URL` to
target a non-prod Maple. State lives in `Cloudflare.state()`, so bootstrap it once with
`alchemy bootstrap cloudflare` — or switch the stack to `Alchemy.localState()` for a throwaway run.

```bash
MAPLE_API_KEY=maple_ak_… bun alchemy destroy
```

Hit the Worker's URL a few times, then look for the `checkout` service in Maple: one span per
request, plus the handler's log line, both drained through `ctx.waitUntil` after the response.
