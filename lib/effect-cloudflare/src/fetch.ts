// Simplified port of alchemy-effect's Fetch binding:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Fetch.ts
//
// Upstream resolves the fetcher through a Policy + WorkerEnvironment lookup
// tied to the alchemy Worker resource. Here we expose the same behaviour
// but keyed on a lightweight logical-id token (the env var name declared
// in wrangler.jsonc's `services:` section).
//
// ```ts
// export const AUTH = ServiceBinding("AUTH")
// const call = yield* ServiceBinding.bind(AUTH)
// yield* call(HttpClientRequest.get("https://auth.local/me"))
// ```
import type * as runtime from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as UrlParams from "effect/unstable/http/UrlParams"
import { WorkerEnvironment } from "./worker-environment.ts"

export interface ServiceBindingToken {
	readonly Type: "Cloudflare.ServiceBinding"
	readonly LogicalId: string
}

const makeToken = (logicalId: string): ServiceBindingToken => ({
	Type: "Cloudflare.ServiceBinding",
	LogicalId: logicalId,
})

export type ServiceBindingFetch = (
	request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.RequestError, WorkerEnvironment>

const makeFetch = (token: ServiceBindingToken): ServiceBindingFetch => {
	return (request) =>
		Effect.gen(function* () {
			const env = yield* WorkerEnvironment
			const fetcher = (env as Record<string, runtime.Fetcher>)[token.LogicalId]
			if (!fetcher) {
				return yield* Effect.fail(
					new HttpClientError.TransportError({
						request,
						cause: new Error(`No service binding named '${token.LogicalId}' in worker env`),
						description: "Service binding lookup failed",
					}),
				)
			}
			return yield* doFetch(fetcher, request)
		})
}

const doFetch = (
	fetcher: runtime.Fetcher,
	request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.RequestError> => {
	const urlResult = UrlParams.makeUrl(
		request.url,
		request.urlParams,
		request.hash.pipe(Option.getOrUndefined),
	)
	if (Result.isFailure(urlResult)) {
		return Effect.fail(
			new HttpClientError.InvalidUrlError({
				request,
				cause: urlResult.failure,
				description: "Failed to construct URL",
			}),
		)
	}
	const url = urlResult.success

	const send = (body: BodyInit | undefined) =>
		Effect.mapError(
			Effect.map(
				Effect.tryPromise({
					try: () =>
						fetcher.fetch(
							url.toString() as runtime.RequestInfo,
							{
								method: request.method,
								headers: request.headers as unknown as runtime.HeadersInit,
								body,
								duplex: request.body._tag === "Stream" ? "half" : undefined,
							} as runtime.RequestInit,
						) as unknown as Promise<Response>,
					catch: (cause) => cause,
				}),
				(response) => HttpClientResponse.fromWeb(request, response),
			),
			(cause) =>
				new HttpClientError.TransportError({
					request,
					cause,
					description: "Service binding fetch failed",
				}),
		)

	switch (request.body._tag) {
		case "Raw":
		case "Uint8Array":
			return send(request.body.body as BodyInit)
		case "FormData":
			return send(request.body.formData)
		case "Stream":
			return Effect.flatMap(
				Effect.mapError(
					Stream.toReadableStreamEffect(request.body.stream),
					(cause) =>
						new HttpClientError.EncodeError({
							request,
							cause,
							description: "Failed to encode stream body",
						}),
				),
				send,
			)
		default:
			return send(undefined)
	}
}

export const ServiceBinding = Object.assign(
	(logicalId: string): ServiceBindingToken => makeToken(logicalId),
	{
		bind: (token: ServiceBindingToken): Effect.Effect<ServiceBindingFetch, never, never> =>
			Effect.succeed(makeFetch(token)),
	},
)
