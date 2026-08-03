# @maple-dev/alchemy

[Alchemy](https://alchemy.run) provider for [Maple](https://maple.dev) resources. Declare Maple API keys, ingest keys, dashboards, alert destinations, and alert rules in your `alchemy.run.ts` — right next to the infrastructure they observe.

```bash
npm install @maple-dev/alchemy alchemy effect
```

`alchemy` and `effect` are peer dependencies — this release is built and tested against
`alchemy@2.0.0-beta.64` and `effect@4.0.0-beta.101`.

## Usage

```typescript
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Maple from "@maple-dev/alchemy"
import { Effect, Layer } from "effect"

export default Alchemy.Stack(
	"my-app",
	{ providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()) },
	Effect.gen(function* () {
		// A notification channel…
		const oncall = yield* Maple.AlertDestination("oncall", {
			type: "pagerduty",
			name: "On-call PagerDuty",
			integration_key: process.env.PAGERDUTY_ROUTING_KEY!,
		})

		// …an alert rule that delivers to it (dependency resolved automatically)…
		yield* Maple.AlertRule("checkout-errors", {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05, // error rates are 0–1 ratios
			window_minutes: 5,
			destination_ids: [oncall.destinationId],
		})

		// …a dashboard…
		yield* Maple.Dashboard("service-health", {
			name: "Service health",
			tags: ["golden-signals"],
			time_range: { type: "relative", value: "12h" },
		})

		// …a scoped API key (secret captured once, kept in Alchemy state)…
		const key = yield* Maple.ApiKey("ci", {
			name: "ci-pipeline",
			scopes: ["dashboards:write"],
		})

		// …and your org's ingest keys as outputs for other resources.
		const ingest = yield* Maple.IngestKeys("ingest")
		// e.g. env: { MAPLE_INGEST_KEY: ingest.privateKey }
	}),
)
```

```bash
MAPLE_API_KEY=maple_ak_… alchemy deploy
```

## Authentication

Set `MAPLE_API_KEY` to a Maple API key (create one in the Maple dashboard, or with this provider). Requirements:

- **Dashboards** need the `dashboards:write` scope.
- **Alert rules & destinations** need `alerts:write` **and** an org-admin key.
- **API keys & ingest keys** need `api_keys:write` / `ingest_keys:read` **and** an org-admin key.

`MAPLE_API_URL` overrides the API base URL (defaults to `https://api.maple.dev`). To source configuration differently, provide your own `Maple.MapleEnvironment` layer.

## Resources

| Resource                 | Semantics                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Maple.Dashboard`        | Full CRUD. Props are the v2 wire shape (`snake_case`, see `/v2/docs`); widget/variable documents pass through verbatim. Updates PATCH in place.                                                                                                                   |
| `Maple.AlertDestination` | Full CRUD for declaratively provisionable types (PagerDuty, webhook, Discord, email). Channel secrets are write-only — accept `Redacted` values. Slack and Hazel use installed integrations managed in Maple. Changing `type` replaces the destination.           |
| `Maple.AlertRule`        | Full CRUD. `destination_ids` accepts outputs from `Maple.AlertDestination`. Rule names are org-unique, so lost state is re-adopted by name instead of duplicating.                                                                                                |
| `Maple.ApiKey`           | Create / roll / revoke (the API has no key update). Changing props replaces the key; bumping the `rotate` prop rolls it in place (same name/scopes, new secret). `secret` is captured once and preserved in Alchemy state — it can never be re-read from the API. |
| `Maple.IngestKeys`       | Read-only per-org singleton. Surfaces `publicKey` / `privateKey` as `Redacted` outputs; delete only stops tracking it.                                                                                                                                            |

## Notes

- Store your Alchemy state somewhere durable: the `ApiKey.secret` output lives only there.
- The client retries 429/5xx with bounded exponential backoff (the v2 API allows 600 requests per 60s per key).
- Deleting an `AlertDestination` fails with a conflict while alert rules still reference it — Alchemy's dependency ordering handles this automatically when the rule is declared in the same stack.
