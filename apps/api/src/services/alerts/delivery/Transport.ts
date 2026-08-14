/**
 * The provider → message seam.
 *
 * Before this existed, the six providers were inline arms of one `Match` inside
 * `dispatchDelivery`, each re-deriving the same boilerplate: build a body,
 * time the fetch, check `!response.ok`, read the body, hand-concatenate
 * `"<Provider> delivery failed with <status>: <detail>"`. That sentence was
 * written out five separate times, and no arm had a span, so the outbound calls
 * to Slack/PagerDuty/Discord/Hazel were invisible.
 *
 * Here each provider declares only what is genuinely provider-specific, and
 * `runHttpTransport` owns everything shared: the spans, the timeout, the SSRF
 * guard, the error construction and the metrics.
 *
 * `render` is deliberately PURE — no Effect, no fetch, no Clock. That is what
 * makes a provider assertable as `render(input) → HttpRequestSpec` with no stub
 * of any kind, which is why the four unverified providers were expensive to
 * cover before and are cheap now.
 */
import type { AlertDeliveryFailure, AlertDestinationType } from "@maple/domain/http"
import type { Effect, Result } from "effect"
import type { DestinationSecretConfig } from "../AlertDestinationHydration"
import type { DispatchContext, DispatchResult } from "./context"

/** Everything a transport is given. Assembled once by the runner. */
export interface RenderInput<Config> {
	/** Narrowed secret config — a transport never re-discriminates on `type`. */
	readonly config: Config
	readonly context: DispatchContext
	readonly linkUrl: string
	readonly chatUrl: string
	/**
	 * The canonical wire payload. `webhook` ships it verbatim and HMAC-signs it,
	 * so it is a customer-facing contract, not an internal detail.
	 */
	readonly payloadJson: string
	/**
	 * The rule's custom template resolved for THIS destination type, or null
	 * when it has none (the transport then uses its hardcoded format). Resolved
	 * once by the runner instead of by six separate per-arm calls.
	 */
	readonly templated: ResolvedTitleBody | null
}

export interface ResolvedTitleBody {
	readonly title: string
	readonly body: string
}

/** What a transport wants sent. Pure data. */
export interface HttpRequestSpec {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
	/**
	 * `true` → route through `safeFetch` (the SSRF guard), because the host came
	 * from user configuration. `false` → call `fetch` directly, because the host
	 * is a compile-time vendor constant and there is nothing to validate.
	 */
	readonly guarded: boolean
	/**
	 * `true` when the URL path itself carries a credential — Discord and Hazel
	 * webhook URLs embed their delivery token in the path. The runner then
	 * annotates `server.address` only, never `url.path`.
	 *
	 * Declared rather than inferred from `guarded`: the two coincide today and
	 * a future provider could easily break that.
	 */
	readonly sensitivePath: boolean
}

/** What the provider said on success. */
export interface ProviderAck {
	readonly providerMessage: string
	readonly providerReference: string | null
}

/**
 * @typeParam Prepared - value produced by the optional effectful `prepare` step
 * and handed to `render`. `void` for every provider except `slack-bot`, which
 * resolves the org's bot token. The parameter is closed at the call site in
 * `dispatchDelivery`, so it never needs an existential in a union type.
 */
export interface HttpTransport<Config, Prepared = void> {
	readonly kind: "http"
	readonly type: AlertDestinationType
	/** Span `peer.service` — this is what draws the provider on the service map. */
	readonly peerService: string
	/** The noun in generated error messages: "Slack delivery failed with 500". */
	readonly providerLabel: string
	/**
	 * The only effectful step, and the only place a secret is fetched. Omitted
	 * by every provider whose credentials are already in the secret config.
	 */
	readonly prepare?: (input: RenderInput<Config>) => Effect.Effect<Prepared, AlertDeliveryFailure>
	/** PURE. The unit-testable heart of each provider. */
	readonly render: (input: RenderInput<Config>, prepared: Prepared) => HttpRequestSpec
	/**
	 * PURE. Give a non-2xx a better message than the generic one. Return null to
	 * fall through to the runner's default. Only `hazel-oauth` implements this.
	 */
	readonly describeStatus?: (status: number) => string | null
	/**
	 * PURE. For a provider that answers 200 and reports failure in the body.
	 * Only `slack-bot` implements this — Slack returns `{ ok: false, error }`
	 * with HTTP 200, so the body is the source of truth, not the status.
	 */
	readonly interpret?: (
		input: RenderInput<Config>,
		rawBody: string,
	) => Result.Result<ProviderAck, AlertDeliveryFailure>
	/** PURE. The success shape when `interpret` is absent. */
	readonly ack: (input: RenderInput<Config>) => ProviderAck
}

/**
 * A provider that is not an HTTP request at all. Only `email`: it fans out over
 * workspace members through the platform email channel, and its partial-success
 * case is a *success* with a degraded message — there is no per-member attempt
 * state, so retrying would re-mail the members who already received it.
 */
export interface EffectTransport<Config> {
	readonly kind: "effect"
	readonly type: AlertDestinationType
	readonly peerService: string
	readonly providerLabel: string
	readonly send: (
		input: RenderInput<Config>,
		deps: EffectTransportDeps,
	) => Effect.Effect<DispatchResult, AlertDeliveryFailure>
}

export interface EffectTransportDeps {
	readonly sendEmail: (
		to: string,
		subject: string,
		html: string,
	) => Effect.Effect<void, AlertDeliveryFailure>
}

/** Narrows the secret-config union to the member a given destination type carries. */
export type SecretConfigOf<T extends DestinationSecretConfig["type"]> = Extract<
	DestinationSecretConfig,
	{ type: T }
>
