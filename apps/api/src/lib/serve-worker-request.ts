import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Scope } from "effect/Scope"
import type { HttpBodyError } from "effect/unstable/http/HttpBody"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export const serveWorkerRequest = <Req = never, E = never>(
  webRequest: Request,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E | HttpServerError.HttpServerError | HttpBodyError,
    Req
  >,
  options: {
    remoteAddress?: string
  } = {},
): Effect.Effect<
  Response,
  never,
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
> =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      webRequest as globalThis.Request,
    ).modify({
      remoteAddress:
        options.remoteAddress == null
          ? Option.none()
          : Option.some(options.remoteAddress),
    })

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    })

    const response = yield* handler.pipe(
      Effect.scoped,
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.catchCause((cause) => {
        const message = Option.match(Cause.findErrorOption(cause), {
          onNone: () => "Internal Server Error",
          onSome: (error) =>
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
  }) as never
