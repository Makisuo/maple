/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Layer from "../../Layer.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as Headers from "./Headers.ts"
import * as HttpClient from "./HttpClient.ts"
import * as HttpClientError from "./HttpClientError.ts"
import * as HttpClientResponse from "./HttpClientResponse.ts"

/**
 * @since 4.0.0
 * @category tags
 */
export const Fetch = ServiceMap.Reference<typeof globalThis.fetch>("effect/http/FetchHttpClient/Fetch", {
  defaultValue: () => globalThis.fetch
})

/**
 * @since 4.0.0
 * @category tags
 */
export class RequestInit extends ServiceMap.Service<RequestInit, globalThis.RequestInit>()(
  "effect/http/FetchHttpClient/RequestInit"
) {}

const fetch: HttpClient.HttpClient = HttpClient.make((request, url, signal, fiber) => {
  const fetch = fiber.getRef(Fetch)
  const options: globalThis.RequestInit = fiber.services.mapUnsafe.get(RequestInit.key) ?? {}
  const headers = options.headers ? Headers.merge(Headers.fromInput(options.headers), request.headers) : request.headers
  const send = (body: BodyInit | undefined) =>
    Effect.map(
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            ...options,
            method: request.method,
            headers,
            body,
            duplex: request.body._tag === "Stream" ? "half" : undefined,
            signal
          } as any),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause
            })
          })
      }),
      (response) => HttpClientResponse.fromWeb(request, response)
    )
  switch (request.body._tag) {
    case "Raw":
    case "Uint8Array":
      return send(request.body.body as any)
    case "FormData":
      return send(request.body.formData)
    case "Stream":
      return Effect.flatMap(Stream.toReadableStreamEffect(request.body.stream), send)
  }
  return send(undefined)
})

/**
 * @since 4.0.0
 * @category layers
 */
export const layer: Layer.Layer<HttpClient.HttpClient> = HttpClient.layerMergedServices(Effect.succeed(fetch))
