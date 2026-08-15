import { Duration, Effect } from "effect"
import { displayGroupKey, truncate } from "../../alert-formatting"
import type { HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"pagerduty">

/**
 * PagerDuty Events API v2. The body is machine-facing, so `custom_details`
 * carries raw numbers rather than the formatted strings the chat providers
 * render, and a custom template contributes only the summary line and a
 * `message` detail — the envelope itself is fixed by the API.
 */
export const pagerDutyTransport: HttpTransport<Config> = {
	kind: "http",
	type: "pagerduty",
	peerService: "pagerduty",
	providerLabel: "PagerDuty",
	render: (input: RenderInput<Config>) => {
		const { context, templated, linkUrl, chatUrl } = input
		return {
			// Fixed vendor host: nothing user-supplied to guard against, and the
			// path carries no credential (the routing key rides in the body).
			url: "https://events.pagerduty.com/v2/enqueue",
			headers: { "content-type": "application/json" },
			guarded: false,
			sensitivePath: false,
			body: JSON.stringify({
				routing_key: input.config.integrationKey,
				event_action: context.eventType === "resolve" ? "resolve" : "trigger",
				dedup_key: context.dedupeKey,
				payload: {
					summary: truncate(templated?.title ?? `${context.ruleName} ${context.eventType}`, 1024),
					source: displayGroupKey(context.groupKey) ?? "maple-alerts",
					severity: context.severity === "critical" ? "critical" : "warning",
					custom_details: {
						...(templated ? { message: templated.body } : undefined),
						ruleName: context.ruleName,
						signalType: context.signalType,
						value: context.value,
						threshold: context.threshold,
						thresholdUpper: context.thresholdUpper,
						comparator: context.comparator,
						groupKey: context.groupKey,
						linkUrl,
						chatUrl,
					},
				},
				links: [
					{ href: linkUrl, text: "Open in Maple" },
					{ href: chatUrl, text: "Ask Maple AI" },
				],
			}),
		}
	},
	ack: (input) => ({
		providerMessage: "Delivered to PagerDuty",
		providerReference: input.context.dedupeKey,
	}),
}

/**
 * A PagerDuty Events API v2 integration ("routing") key is exactly 32
 * alphanumeric characters. A REST API token — the usual wrong paste — is shorter
 * and may contain `+`/`_`/`-`, so the length+charset check alone rejects it.
 */
export const PAGERDUTY_ROUTING_KEY_PATTERN = /^[A-Za-z0-9]{32}$/

export type PagerDutyKeyVerification =
	| { status: "valid" }
	| { status: "invalid"; reason: string }
	/** Network error / timeout / 429 / 5xx — can't conclude; caller should fail open. */
	| { status: "unknown" }

/**
 * Verify a PagerDuty routing key actually works by enqueuing a no-op `resolve`
 * event. PagerDuty validates the routing key before the action, so a valid key
 * returns 2xx (resolving an unknown dedup_key creates no incident and pages no
 * one) and an invalid key returns 400 "Invalid routing key". Never fails — any
 * transport/ambiguous response collapses to `unknown` so the caller owns policy.
 *
 * This runs at destination-save time, not delivery time, so it deliberately does
 * not go through the transport runner: there is no notification to render and no
 * delivery span to attribute it to.
 */
export const verifyPagerDutyRoutingKey = (
	integrationKey: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	dedupKey: string,
): Effect.Effect<PagerDutyKeyVerification> =>
	Effect.tryPromise(() =>
		fetchFn("https://events.pagerduty.com/v2/enqueue", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				routing_key: integrationKey,
				event_action: "resolve",
				dedup_key: dedupKey,
			}),
		}),
	).pipe(
		Effect.flatMap((response) => {
			if (response.ok) return Effect.succeed<PagerDutyKeyVerification>({ status: "valid" })
			if (response.status === 400) {
				return Effect.promise(() => response.text().catch(() => "")).pipe(
					Effect.map((body): PagerDutyKeyVerification => {
						const reason = truncate(body.trim().replace(/\s+/g, " "), 500)
						return { status: "invalid", reason: reason || "Invalid routing key" }
					}),
				)
			}
			return Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" })
		}),
		// A timeout is one more way to not know, so it produces the verdict
		// directly rather than a placeholder failure for `orElseSucceed` to
		// swallow one line later. Wrapping the whole pipeline also bounds the
		// 400-body read, which the previous fetch-only timeout left open.
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () => Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" }),
		}),
		Effect.orElseSucceed(() => ({ status: "unknown" as const })),
	)
