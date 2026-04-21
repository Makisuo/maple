// Copied (with minimal adaptation) from alchemy-effect to stay API-compatible
// for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/HttpServer.ts
//
// Keep names and signatures aligned with upstream. When alchemy-effect ships,
// swapping the `@maple/effect-cloudflare` import for `alchemy/Cloudflare`
// should be a mechanical find-and-replace.
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Scope } from "effect/Scope"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { type HttpEffect, safeHttpEffect } from "./http.ts"
import { Request as RequestService } from "./request.ts"

/**
 * Adapt a CF/Web `Request` into an Effect handler that provides
 * `HttpServerRequest` + the raw `Request` service, runs the handler, and
 * returns a `Response`. Any uncaught cause is converted into a 500 via
 * `safeHttpEffect`.
 */
export const serveWebRequest = <Req = never>(
  webRequest: globalThis.Request,
  handler: HttpEffect<Req>,
  options: {
    remoteAddress?: string
    acceptWebSocket?: (socket: unknown) => void
  } = {},
): Effect.Effect<
  globalThis.Response,
  never,
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
> =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(webRequest).modify({
      remoteAddress: Option.fromUndefinedOr(options.remoteAddress),
    })

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    })

    const response = yield* safeHttpEffect(handler).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(RequestService, webRequest),
      Effect.catchCause((cause) => {
        const message = Option.match(Cause.findErrorOption(cause), {
          onNone: () => "Internal Server Error",
          onSome: (error: unknown) =>
            error instanceof Error && error.message
              ? error.message
              : "Internal Server Error",
        })
        return Effect.succeed(
          HttpServerResponse.text(message, {
            status: 500,
            statusText: message,
          }),
        )
      }),
    )

    return HttpServerResponse.toWeb(response, {
      context: yield* Effect.context(),
    })
  }) as Effect.Effect<
    globalThis.Response,
    never,
    Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
  >
