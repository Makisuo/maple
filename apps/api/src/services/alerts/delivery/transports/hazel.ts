import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"hazel-oauth">

/**
 * Hazel exposes per-integration sibling endpoints under the same
 * `:webhookId/:token` prefix. The stored `webhookUrl` is the base; `/maple`
 * selects the `executeMaple` handler — without it the payload routes to the
 * Discord-style `execute` endpoint and is rejected.
 */
export const hazelTransport: HttpTransport<Config> = {
	kind: "http",
	type: "hazel-oauth",
	peerService: "hazel",
	providerLabel: "Hazel",
	render: (input: RenderInput<Config>) => ({
		url: `${input.config.webhookUrl.replace(/\/$/, "")}/maple`,
		headers: {
			"content-type": "application/json",
			"x-maple-event-type": input.context.eventType,
			"x-maple-delivery-key": input.context.deliveryKey,
		},
		// User-configured host, and the delivery token is a path segment.
		guarded: true,
		sensitivePath: true,
		// Hazel used to build its own near-copy of the wire payload, which had
		// drifted (it dropped `thresholdUpper` and recomputed `incidentStatus`
		// from `eventType` instead of carrying it). It now ships the canonical
		// payload, same as the webhook destination.
		body: input.payloadJson,
	}),
	describeStatus: (status) => {
		if (status === 401 || status === 403) {
			return "Hazel rejected the webhook token — reconfigure the channel"
		}
		if (status === 404) return "Hazel webhook no longer exists — pick a different channel"
		return null
	},
	ack: (input) => ({
		providerMessage: `Delivered to Hazel #${input.config.hazelChannelName}`,
		providerReference: input.context.dedupeKey,
	}),
}
