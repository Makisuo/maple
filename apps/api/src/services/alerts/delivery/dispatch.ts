/**
 * The delivery entry point: pick the transport for the destination, hand it the
 * shared render input, run it under the uniform wrapper.
 *
 * The `Match` is what makes the registry exhaustive — adding a member to
 * `DestinationSecretConfig` fails to compile here until it has a transport.
 * It also narrows the config to the exact member each transport declares, which
 * is why no transport re-discriminates on `type` and no `any` is needed to hold
 * the transports in one collection.
 */
import type { AlertDeliveryFailure, OrgId } from "@maple/domain/http"
import { Effect, Match } from "effect"
import { renderTitleBody } from "../AlertDeliveryDispatch"
import { discordTransport } from "./transports/discord"
import { emailTransport } from "./transports/email"
import { hazelTransport } from "./transports/hazel"
import { pagerDutyTransport } from "./transports/pagerduty"
import { makeSlackTransport } from "./transports/slack"
import { webhookTransport } from "./transports/webhook"
import { runEffectTransport, runHttpTransport, type TransportRuntime } from "./runTransport"
import type { RenderInput } from "./Transport"
import type { DispatchContext, DispatchResult } from "./context"

export interface DispatchDeps {
	/**
	 * Sends one email via the platform email channel (Cloudflare `EMAIL`
	 * binding). Injected so this module stays dependency-free.
	 */
	readonly sendEmail: (
		to: string,
		subject: string,
		html: string,
	) => Effect.Effect<void, AlertDeliveryFailure>
	/**
	 * Resolves the decrypted Slack bot token for an org from its
	 * `slack_workspaces` row. Only the `slack-bot` transport invokes it. Fails
	 * when the org has no active Slack installation.
	 */
	readonly resolveSlackBotToken: (orgId: OrgId) => Effect.Effect<string, AlertDeliveryFailure>
}

export const dispatchDelivery = (
	context: DispatchContext,
	payloadJson: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	linkUrl: string,
	chatUrl: string,
	deps: DispatchDeps,
): Effect.Effect<DispatchResult, AlertDeliveryFailure> => {
	const runtime: TransportRuntime = { fetchFn, timeoutMs }
	/**
	 * Resolved once here rather than by each provider: the template is a
	 * property of the rule and the destination TYPE, not of the transport's
	 * wire format.
	 */
	const templated = renderTitleBody(context, context.secretConfig.type, linkUrl, chatUrl)
	const shared = { context, linkUrl, chatUrl, payloadJson, templated }
	const input = <Config>(config: Config): RenderInput<Config> => ({ config, ...shared })

	return Match.value(context.secretConfig).pipe(
		Match.discriminatorsExhaustive("type")({
			"slack-bot": (config) => runHttpTransport(makeSlackTransport(deps), input(config), runtime),
			pagerduty: (config) => runHttpTransport(pagerDutyTransport, input(config), runtime),
			webhook: (config) => runHttpTransport(webhookTransport, input(config), runtime),
			"hazel-oauth": (config) => runHttpTransport(hazelTransport, input(config), runtime),
			discord: (config) => runHttpTransport(discordTransport, input(config), runtime),
			email: (config) => runEffectTransport(emailTransport, input(config), deps),
		}),
	)
}
