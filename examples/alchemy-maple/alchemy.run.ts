/**
 * Example stack: Maple observability resources as infrastructure-as-code.
 *
 * Run with a Maple API key (org-admin, or scope it to what you declare):
 *
 *   MAPLE_API_KEY=maple_ak_… bun alchemy deploy
 *
 * Requires `@maple-dev/alchemy` to be built first (`bun run --cwd ../../lib/alchemy-maple build`).
 */
import * as Alchemy from "alchemy"
import * as Maple from "@maple-dev/alchemy"
import { Effect } from "effect"

export default Alchemy.Stack(
	"maple-example",
	{ providers: Maple.providers() },
	Effect.gen(function* () {
		// A Slack notification channel. The webhook URL is write-only server-side.
		const slack = yield* Maple.AlertDestination("oncall-slack", {
			type: "slack",
			name: "On-call Slack",
			webhook_url: process.env.SLACK_WEBHOOK_URL ?? "https://hooks.slack.com/services/CHANGE/ME/PLEASE",
			channel_label: "#incidents",
		})

		// An error-rate alert delivering to it — Alchemy orders the dependency.
		yield* Maple.AlertRule("checkout-error-rate", {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			service_names: ["checkout"],
			destination_ids: [slack.destinationId],
		})

		// A latency alert on the same channel.
		yield* Maple.AlertRule("checkout-p95", {
			name: "Checkout p95 latency",
			severity: "warning",
			signal_type: "p95_latency",
			comparator: "gt",
			threshold: 750,
			window_minutes: 10,
			service_names: ["checkout"],
			destination_ids: [slack.destinationId],
		})

		// A dashboard shell (widgets are the v2 wire shape — see /v2/docs).
		yield* Maple.Dashboard("service-health", {
			name: "Service health",
			description: "Golden signals for the checkout service",
			tags: ["golden-signals"],
			time_range: { type: "relative", value: "12h" },
		})

		// A scoped CI key; the secret is minted once and kept in Alchemy state.
		const ciKey = yield* Maple.ApiKey("ci-key", {
			name: "ci-pipeline",
			scopes: ["dashboards:write"],
		})

		// The org's ingest keys, as Redacted outputs for other resources.
		const ingest = yield* Maple.IngestKeys("ingest")

		return { ciKeyId: ciKey.keyId, ingestRotatedAt: ingest.publicRotatedAt }
	}),
)
