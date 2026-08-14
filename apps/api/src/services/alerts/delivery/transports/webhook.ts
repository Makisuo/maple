import { createHmac } from "node:crypto"
import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"webhook">

/**
 * The customer's own endpoint. Unlike every other provider this ships the
 * canonical wire payload verbatim — the body is a published contract, and the
 * signature is computed over exactly the bytes sent, so consumers can verify it
 * by re-HMACing the raw request body.
 */
export const webhookTransport: HttpTransport<Config> = {
	kind: "http",
	type: "webhook",
	peerService: "webhook",
	providerLabel: "Webhook",
	render: (input: RenderInput<Config>) => ({
		url: input.config.url,
		headers: {
			"content-type": "application/json",
			"x-maple-event-type": input.context.eventType,
			"x-maple-delivery-key": input.context.deliveryKey,
			...(input.config.signingSecret
				? {
						"x-maple-signature": createHmac("sha256", input.config.signingSecret)
							.update(input.payloadJson)
							.digest("hex"),
					}
				: {}),
		},
		body: input.payloadJson,
		// Customer-supplied host: this is exactly what the SSRF guard is for.
		guarded: true,
		// The token, if any, rides in the signature header rather than the path.
		sensitivePath: false,
	}),
	ack: (input) => ({
		providerMessage: "Delivered to webhook",
		providerReference: input.context.dedupeKey,
	}),
}
