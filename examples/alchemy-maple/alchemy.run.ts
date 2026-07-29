/**
 * Example stack: a Cloudflare Worker and the Maple resources that observe it,
 * declared side by side.
 *
 *   MAPLE_API_KEY=maple_ak_… CLOUDFLARE_ACCOUNT_ID=… bun alchemy deploy
 *
 * Requires `@maple-dev/alchemy` to be built first (`bun run --cwd ../../lib/alchemy-maple build`).
 */
import * as Maple from "@maple-dev/alchemy"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import Api, { SERVICE_NAME } from "./src/Api.ts"

export default Alchemy.Stack(
	"maple-example",
	{
		providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()),
		// Where deployed state lives. `Cloudflare.state()` keeps it account-wide
		// (bootstrap once with `alchemy bootstrap cloudflare`); `Alchemy.localState()`
		// drops it in ./.alchemy for a throwaway stack.
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		// The Worker. Its ingest-key binding pulls `Maple.IngestKeys` into the
		// graph, so the keys are read before the Worker deploys.
		const api = yield* Api

		// Where alerts go. Channel secrets are write-only server-side.
		const oncall = yield* Maple.AlertDestination("oncall-discord", {
			type: "discord",
			name: "On-call Discord",
			webhook_url:
				process.env.DISCORD_WEBHOOK_URL ?? "https://discord.com/api/webhooks/CHANGE/ME_PLEASE",
		})

		// Alerts on the service name the Worker reports as — `SERVICE_NAME` is the
		// same constant the SDK sends as `service.name`, so the two can't drift.
		// `destination_ids` takes the destination's output, so Alchemy creates the
		// channel first and refuses to delete it while a rule still points at it.
		yield* Maple.AlertRule("checkout-error-rate", {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05, // error rates are 0–1 ratios, not percentages
			window_minutes: 5,
			service_names: [SERVICE_NAME],
			destination_ids: [oncall.destinationId],
		})

		yield* Maple.AlertRule("checkout-p95", {
			name: "Checkout p95 latency",
			severity: "warning",
			signal_type: "p95_latency",
			comparator: "gt",
			threshold: 750,
			window_minutes: 10,
			service_names: [SERVICE_NAME],
			destination_ids: [oncall.destinationId],
		})

		yield* Maple.Dashboard("service-health", {
			name: "Service health",
			description: `Golden signals for ${SERVICE_NAME}`,
			tags: ["golden-signals"],
			time_range: { type: "relative", value: "12h" },
		})

		// A scoped key for CI to push dashboard changes. The secret is minted once
		// and preserved in Alchemy state — the API will never hand it back.
		const ciKey = yield* Maple.ApiKey("ci-key", {
			name: "ci-pipeline",
			scopes: ["dashboards:write"],
		})

		return { url: api.url, ciKeyId: ciKey.keyId }
	}),
)
