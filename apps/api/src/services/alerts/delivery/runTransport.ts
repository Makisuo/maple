/**
 * The uniform half of every delivery: spans, timeout, SSRF guard, error
 * construction. A transport contributes only what is provider-specific.
 */
import {
	AlertDeliveryAuthError,
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	AlertDeliveryTargetMissingError,
	type AlertDeliveryFailure,
	type AlertDestinationType,
} from "@maple/domain/http"
import { Duration, Effect, Option, Result } from "effect"
import { safeFetch } from "@/http/url-validator"
import type {
	EffectTransport,
	EffectTransportDeps,
	HttpRequestSpec,
	HttpTransport,
	RenderInput,
} from "./Transport"
import type { DispatchResult } from "./context"

export interface TransportRuntime {
	readonly fetchFn: typeof fetch
	readonly timeoutMs: number
}

export const makeDeliveryError = (message: string, destinationType?: AlertDestinationType, cause?: unknown) =>
	new AlertDeliveryError({ message, destinationType, ...(!(cause === undefined) ? { cause } : undefined) })

/**
 * Best-effort read of a failure body for the error message. Truncated and
 * whitespace-collapsed: this ends up in a delivery row and a log line, and some
 * providers answer with an HTML error page.
 */
const readErrorBody = (response: Response) =>
	Effect.tryPromise({ try: () => response.text(), catch: () => null }).pipe(
		Effect.map((text) => {
			const detail = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 500)
			if (detail.length > 0) return detail
			// An empty body used to render as `"<Provider> delivery failed with 400"`
			// with nothing after it, which reads like we dropped the reason rather
			// than the provider never having sent one. Saying so — with the
			// content-type the provider did declare — is the difference between
			// "our bug" and "ask the provider".
			const contentType = response.headers.get("content-type")
			return contentType ? `<empty body> (content-type: ${contentType})` : "<empty body>"
		}),
		Effect.orElseSucceed(() => ""),
	)

/**
 * The one copy of the sentence that used to be hand-concatenated in five
 * separate provider arms.
 */
const statusFailureMessage = (providerLabel: string, status: number, detail: string) =>
	`${providerLabel} delivery failed with ${status}${detail ? `: ${detail}` : ""}`

/**
 * Provider HTTP status → the failure class whose policy says whether the queue
 * should retry. This is the single place that decision is made; the classes
 * themselves carry `retry`/`recovery`, and `AlertsService` reads
 * `error.error.retryable` off whichever one it gets.
 *
 * A transport overrides this only when its provider disagrees with the HTTP
 * convention — see `slack-bot`, which reports channel failures as 200 + a body.
 */
export const failureForStatus = (
	status: number,
	fields: {
		readonly message: string
		readonly destinationType: AlertDestinationType
		readonly providerStatus: number
	},
): AlertDeliveryFailure => {
	if (status === 401 || status === 403) return new AlertDeliveryAuthError(fields)
	if (status === 404 || status === 410) return new AlertDeliveryTargetMissingError(fields)
	// 408/429 are the provider asking us to come back, not a rejection.
	if (status === 408 || status === 429 || status >= 500) return new AlertDeliveryError(fields)
	if (status >= 400) return new AlertDeliveryRejectedError(fields)
	return new AlertDeliveryError(fields)
}

const hostOf = (url: string) => Option.liftThrowable(() => new URL(url))()

/**
 * The outbound provider call, as a Client-kind span.
 *
 * `kind: "client"` + `peer.service` is what draws the provider as a node on the
 * service map and makes its latency and status attributable — without it the
 * dependency is invisible, which is what it was before this existed. Same
 * reasoning as `GithubAppClient.request`.
 *
 * `Effect.fn` already opens the span, so the body must NOT be wrapped in
 * `Effect.withSpan` too — that emits two spans that disagree on timeout (the
 * inner closes Ok+interrupted while the outer records Error). The timeout stays
 * INSIDE the span so the elapsed time is attributed to the call that hung.
 */
const sendHttp = Effect.fn("AlertDelivery.http", { kind: "client" })(function* (
	spec: HttpRequestSpec,
	transport: {
		readonly peerService: string
		readonly providerLabel: string
		readonly type: AlertDestinationType
	},
	runtime: TransportRuntime,
) {
	const parsed = hostOf(spec.url)
	yield* Effect.annotateCurrentSpan({
		"peer.service": transport.peerService,
		"http.request.method": "POST",
		...(Option.isSome(parsed) ? { "server.address": parsed.value.host } : undefined),
		// Never `url.full`, and `url.path` only when the path carries no secret:
		// Discord and Hazel webhook URLs embed their delivery token in the path.
		...(Option.isSome(parsed) && !spec.sensitivePath ? { "url.path": parsed.value.pathname } : undefined),
	})

	// Detached from `runtime` on purpose: `runtime.fetchFn(...)` is a METHOD
	// call, so workerd's global `fetch` runs with `this === runtime` and throws
	// "Illegal invocation". Only the unguarded transports (slack-bot, pagerduty)
	// hit it — the guarded ones already launder `fetch` through `safeFetch`,
	// which calls it as a bare local.
	const { fetchFn } = runtime

	// The signal is what makes the timeout below real: `timeoutOrElse` interrupts
	// this Effect, and without wiring the interruption to `RequestInit.signal`
	// the POST would keep running and could still deliver after we reported a
	// retryable timeout — a duplicate page once the retry lands.
	const response = yield* Effect.tryPromise({
		try: (signal) =>
			spec.guarded
				? safeFetch(spec.url, {
						method: "POST",
						headers: { ...spec.headers },
						body: spec.body,
						signal,
						fetchFn,
					})
				: fetchFn(spec.url, {
						method: "POST",
						headers: { ...spec.headers },
						body: spec.body,
						signal,
					}),
		catch: (error) =>
			makeDeliveryError(
				error instanceof Error ? error.message : `${transport.providerLabel} delivery failed`,
				transport.type,
				error,
			),
	}).pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(runtime.timeoutMs),
			orElse: () =>
				Effect.fail(
					makeDeliveryError(
						`${transport.providerLabel} delivery timed out after ${runtime.timeoutMs}ms`,
						transport.type,
					),
				),
		}),
	)

	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	return response
})

export const runHttpTransport = <Config, Prepared>(
	transport: HttpTransport<Config, Prepared>,
	input: RenderInput<Config>,
	runtime: TransportRuntime,
): Effect.Effect<DispatchResult, AlertDeliveryFailure> =>
	Effect.gen(function* () {
		const prepared = transport.prepare
			? yield* transport.prepare(input)
			: // `void` for every transport that declares no prepare step.
				(undefined as Prepared)
		const spec = transport.render(input, prepared)
		const response = yield* sendHttp(spec, transport, runtime)

		if (!response.ok) {
			const detail = yield* readErrorBody(response)
			// A transport may supply a better sentence for a status it knows well;
			// it does not get to change whether the failure is retryable.
			const described = transport.describeStatus?.(response.status) ?? null
			const failure = failureForStatus(response.status, {
				message: described ?? statusFailureMessage(transport.providerLabel, response.status, detail),
				destinationType: transport.type,
				providerStatus: response.status,
			})
			yield* Effect.annotateCurrentSpan({
				"maple.delivery.failure_tag": failure._tag,
				"maple.delivery.retryable": failure.error.retryable,
				// Which destination, not just which provider: a flat rate of
				// identical `retry: "never"` failures is one broken row, and the
				// error issue is only triageable if the span names it.
				"maple.delivery.destination_id": input.context.destination.id,
				"maple.delivery.destination_type": transport.type,
			})
			return yield* Effect.fail(failure)
		}

		// A 2xx is not proof of delivery for every provider — Slack answers 200
		// with `{ ok: false, error }` — so a transport may claim the body.
		if (transport.interpret) {
			const rawBody = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: (error) =>
					makeDeliveryError(
						`${transport.providerLabel} returned an unreadable response`,
						transport.type,
						error,
					),
			})
			const ack = yield* Result.match(transport.interpret(input, rawBody), {
				onSuccess: (value) => Effect.succeed(value),
				onFailure: (error) => Effect.fail(error),
			})
			return { ...ack, responseCode: response.status }
		}

		return { ...transport.ack(input), responseCode: response.status }
	})

export const runEffectTransport = <Config>(
	transport: EffectTransport<Config>,
	input: RenderInput<Config>,
	deps: EffectTransportDeps,
): Effect.Effect<DispatchResult, AlertDeliveryFailure> => transport.send(input, deps)
