import { buildDiscordEmbeds, buildDiscordEmbedsFromTemplate } from "../../AlertDeliveryDispatch"
import { formatEventTypeLabel } from "../../alert-formatting"
import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"discord">

export const discordTransport: HttpTransport<Config> = {
	kind: "http",
	type: "discord",
	peerService: "discord",
	providerLabel: "Discord",
	render: (input: RenderInput<Config>) => {
		const { context, templated, linkUrl, chatUrl } = input
		const embeds = templated
			? buildDiscordEmbedsFromTemplate(templated.title, templated.body, context, linkUrl, chatUrl)
			: buildDiscordEmbeds(context, linkUrl, chatUrl)
		return {
			url: input.config.webhookUrl,
			headers: { "content-type": "application/json" },
			// User-configured URL, and the webhook token lives IN the path — so it
			// is both SSRF-guarded and excluded from the span's url attributes.
			guarded: true,
			sensitivePath: true,
			body: JSON.stringify({
				username: "Maple Alerts",
				content:
					templated?.title ?? `**${context.ruleName}**: ${formatEventTypeLabel(context.eventType)}`,
				embeds,
			}),
		}
	},
	ack: (input) => ({
		providerMessage: "Delivered to Discord",
		// Discord's plain webhook POST returns 204 with an empty body, so there is
		// no message id to quote back. The dedupe key is the same correlation
		// handle every other provider reports.
		providerReference: input.context.dedupeKey,
	}),
}
