/**
 * The uniform half of every delivery: spans, timeout, SSRF guard, error
 * construction. A transport contributes only what is provider-specific.
 */
import { AlertDeliveryError, type AlertDestinationType } from "@maple/domain/http"
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
	new AlertDeliveryError({ message, destinationType, ...(cause === undefined ? {} : { cause }) })

/**
 * Best-effort read of a failure body for the error message. Truncated and
 * whitespace-collapsed: this ends up in a delivery row and a log line, and some
 * providers answer with an HTML error page.
 */
const readErrorBody = (response: Response) =>
	Effect.tryPromise({ try: () => response.text(), catch: () => null }).pipe(
		Effect.map((text) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 500)),
		Effect.orElseSucceed(() => ""),
	)

/**
 * The one copy of the sentence that used to be hand-concatenated in five
 * separate provider arms.
 */
const statusFailureMessage = (providerLabel: string, status: number, detail: string) =>
	`${providerLabel} delivery failed with ${status}${detail ? `: ${detail}` : ""}`

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
		...(Option.isSome(parsed) ? { "server.address": parsed.value.host } : {}),
		// Never `url.full`, and `url.path` only when the path carries no secret:
		// Discord and Hazel webhook URLs embed their delivery token in the path.
		...(Option.isSome(parsed) && !spec.sensitivePath ? { "url.path": parsed.value.pathname } : {}),
	})

	const response = yield* Effect.tryPromise({
		try: () =>
			spec.guarded
				? safeFetch(spec.url, {
						method: "POST",
						headers: { ...spec.headers },
						body: spec.body,
						fetchFn: runtime.fetchFn,
					})
				: runtime.fetchFn(spec.url, {
						method: "POST",
						headers: { ...spec.headers },
						body: spec.body,
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
): Effect.Effect<DispatchResult, AlertDeliveryError> =>
	Effect.gen(function* () {
		const prepared = transport.prepare
			? yield* transport.prepare(input)
			: // `void` for every transport that declares no prepare step.
				(undefined as Prepared)
		const spec = transport.render(input, prepared)
		const response = yield* sendHttp(spec, transport, runtime)

		if (!response.ok) {
			const detail = yield* readErrorBody(response)
			const described = transport.describeStatus?.(response.status) ?? null
			return yield* Effect.fail(
				makeDeliveryError(
					described ?? statusFailureMessage(transport.providerLabel, response.status, detail),
					transport.type,
				),
			)
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
): Effect.Effect<DispatchResult, AlertDeliveryError> => transport.send(input, deps)
