// Copied (with minimal adaptation) from alchemy-effect to stay API-compatible
// for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Http.ts
//
// Keep names and signatures aligned with upstream. When alchemy-effect ships,
// swapping the `@maple/effect-cloudflare` import for `alchemy/Http` should be
// a mechanical find-and-replace.
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Scope } from "effect/Scope"
import type { HttpBodyError } from "effect/unstable/http/HttpBody"
import type { HttpServerError } from "effect/unstable/http/HttpServerError"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export type HttpEffect<Req = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError | HttpBodyError,
  HttpServerRequest | Scope | Req
>

export const safeHttpEffect = <Req = never>(handler: HttpEffect<Req>) =>
  Effect.catchCause(handler, (cause) => {
    const message = Option.match(Cause.findErrorOption(cause), {
      onNone: () => "Internal Server Error",
      onSome: (error) => error.message ?? "Internal Server Error",
    })

    return Effect.map(
      Effect.all([Effect.logInfo(message), Effect.logInfo(cause)]),
      () =>
        HttpServerResponse.text(message, {
          status: 500,
          statusText: message,
        }),
    )
  })

// Request moved to ./request.ts to match upstream layout. Re-exported here so
// existing imports of `@maple/effect-cloudflare`'s Request continue to resolve.
export { Request } from "./request.ts"
