/**
 * Example stack: a Cloudflare Worker and the Maple resources that observe it,
 * declared side by side.
 *
 * The interesting part is the seam — `Maple.IngestKeys` reads the org's ingest
 * credentials and hands them to the Worker as a secret binding, so the thing
 * being observed and the alerts watching it ship as one unit.
 *
 *   MAPLE_API_KEY=maple_ak_… CLOUDFLARE_ACCOUNT_ID=… bun alchemy deploy
 *
 * Requires `@maple-dev/alchemy` to be built first (`bun run --cwd ../../lib/alchemy-maple build`).
 */
import path from "node:path"
import * as Maple from "@maple-dev/alchemy"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"

const SERVICE_NAME = "checkout"

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
		// The org's ingest keys — a read-only singleton. `privateKey` is a
		// `Redacted<string>` output, so it never lands in logs or plan output.
		const ingest = yield* Maple.IngestKeys("ingest")

		// The workload. Feeding `ingest.privateKey` into `env` is what orders the
		// two: Alchemy reads the keys before it deploys the Worker.
		const checkout = yield* Cloudflare.Worker("checkout-api", {
			name: "checkout-api",
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			url: true,
			env: {
				MAPLE_INGEST_KEY: ingest.privateKey,
				MAPLE_ENDPOINT: "https://ingest.maple.dev",
				OTEL_SERVICE_NAME: SERVICE_NAME,
			},
		})

		// Where alerts go. Channel secrets are write-only server-side.
		const slack = yield* Maple.AlertDestination("oncall-slack", {
			type: "slack",
			name: "On-call Slack",
			webhook_url: process.env.SLACK_WEBHOOK_URL ?? "https://hooks.slack.com/services/CHANGE/ME/PLEASE",
			channel_label: "#incidents",
		})

		// Alerts on the service name the Worker reports as. `destination_ids` takes
		// the destination's output, so Alchemy creates the channel first and
		// refuses to delete it while a rule still points at it.
		yield* Maple.AlertRule("checkout-error-rate", {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05, // error rates are 0–1 ratios, not percentages
			window_minutes: 5,
			service_names: [SERVICE_NAME],
			destination_ids: [slack.destinationId],
		})

		yield* Maple.AlertRule("checkout-p95", {
			name: "Checkout p95 latency",
			severity: "warning",
			signal_type: "p95_latency",
			comparator: "gt",
			threshold: 750,
			window_minutes: 10,
			service_names: [SERVICE_NAME],
			destination_ids: [slack.destinationId],
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

		return { url: checkout.url, ciKeyId: ciKey.keyId }
	}),
)
