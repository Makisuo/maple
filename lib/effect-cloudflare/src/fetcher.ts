// Copied verbatim from alchemy-effect to stay API-compatible for a future
// migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Fetcher.ts
//
// Bidirectional adapters between Cloudflare `Fetcher` / `Socket` and Effect's
// `HttpClient` / `Socket`. Used by the RPC module to wrap DO / service-binding
// stubs.
import type * as cf from "@cloudflare/workers-types"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import { pipe } from "effect/Function"
import * as Latch from "effect/Latch"
import * as Scope from "effect/Scope"
import * as HttpBody from "effect/unstable/http/HttpBody"
import { HttpClientError } from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type { HttpServerError } from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Socket from "effect/unstable/socket/Socket"

export type SocketAddress = cf.SocketAddress
export type SocketOptions = cf.SocketOptions

export interface Fetcher {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>

  connect(
    address: SocketAddress | string,
    options?: SocketOptions,
  ): Socket.Socket
}

export const toCloudflareFetcher = Effect.fnUntraced(function* (
  fetcher: Fetcher,
) {
  const context = yield* Effect.context()
  return {
    fetch: (input, init) =>
      fetcher
        .fetch(
          HttpServerRequest.fromWeb(
            new Request(input as any, init as any) as any as Request,
          ),
        )
        .pipe(
          Effect.map(
            (response) =>
              HttpServerResponse.toWeb(response, {
                context,
              }) as any as cf.Response,
          ),
          Effect.provideContext(context),
          Effect.runPromise,
        ),
    connect() {
      throw new Error("toCloudflareFetcher does not support connect()")
    },
  } satisfies cf.Fetcher
})

export const fromCloudflareFetcher = (fetcher: cf.Fetcher): Fetcher => {
  const fetch = (request: Request) =>
    Effect.promise((signal) =>
      fetcher.fetch(request as any as cf.Request, {
        signal: signal as cf.AbortSignal,
      }),
    )

  return {
    connect: (address, options) =>
      fromCloudflareSocket(fetcher.connect(address, options)),
    fetch: (
      request:
        | HttpClientRequest.HttpClientRequest
        | HttpServerRequest.HttpServerRequest,
    ): any =>
      HttpClientRequest.isHttpClientRequest(request)
        ? pipe(
            HttpServerRequest.toWeb(
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.flatMap(fetch),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response as any as Response),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(error.message, {
                    status:
                      error._tag === "InternalError"
                        ? 500
                        : error._tag === "RequestParseError"
                          ? 400
                          : 404,
                  }),
                ),
              ),
            ),
          )
        : pipe(
            HttpServerRequest.toWeb(request),
            Effect.flatMap(fetch),
            Effect.map((response) => {
              if ((response as any).status === 101) {
                return HttpServerResponse.setBody(
                  HttpServerResponse.empty({ status: 101 }),
                  HttpBody.raw(response),
                )
              }
              return HttpServerResponse.fromWeb(response as any as Response)
            }),
          ),
  }
}

export const fromCloudflareSocket = (cfSocket: cf.Socket): Socket.Socket => {
  const latch = Latch.makeUnsafe(false)
  let currentFiberSet: FiberSet.FiberSet<any, any> | undefined
  let writerRef: WritableStreamDefaultWriter<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const closeError = (code: number, closeReason?: string) =>
    new Socket.SocketError({
      reason: new Socket.SocketCloseError({ code, closeReason }),
    })

  const runRaw = <_, E, R>(
    handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    opts?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scopedWith(
      Effect.fnUntraced(function* (scope) {
        yield* Effect.tryPromise({
          try: () => cfSocket.opened,
          catch: (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({
                kind: "Unknown",
                cause,
              }),
            }),
        })

        const reader = cfSocket.readable.getReader()
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() => reader.cancel()),
        )

        const fiberSet = yield* FiberSet.make<
          any,
          E | Socket.SocketError
        >().pipe(Scope.provide(scope))
        const runFork = yield* FiberSet.runtime(fiberSet)<R>()

        yield* Effect.tryPromise({
          try: async () => {
            await cfSocket.closed
            throw closeError(1000)
          },
          catch: (cause) =>
            Socket.isSocketError(cause) ? cause : closeError(1006),
        }).pipe(FiberSet.run(fiberSet))

        yield* Effect.tryPromise({
          try: async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                throw closeError(1000)
              }
              const result = handler(value)
              if (Effect.isEffect(result)) {
                runFork(result)
              }
            }
          },
          catch: (cause) =>
            Socket.isSocketError(cause)
              ? cause
              : new Socket.SocketError({
                  reason: new Socket.SocketReadError({ cause }),
                }),
        }).pipe(FiberSet.run(fiberSet))

        currentFiberSet = fiberSet
        latch.openUnsafe()
        if (opts?.onOpen) yield* opts.onOpen

        return yield* Effect.catchFilter(
          FiberSet.join(fiberSet),
          Socket.SocketCloseError.filterClean(
            (code) => code === 1000 || code === 1006,
          ),
          () => Effect.void,
        )
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          latch.closeUnsafe()
          currentFiberSet = undefined
        }),
      ),
    )

  const run = <_, E, R>(
    handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void,
    opts?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    runRaw(
      (data) =>
        typeof data === "string"
          ? handler(encoder.encode(data))
          : handler(data),
      opts,
    )

  const write = (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ): Effect.Effect<void, Socket.SocketError> =>
    latch.whenOpen(
      Effect.suspend(() => {
        if (Socket.isCloseEvent(chunk)) {
          return Deferred.fail(
            currentFiberSet!.deferred,
            closeError(chunk.code, chunk.reason),
          )
        }
        if (!writerRef) {
          writerRef = cfSocket.writable.getWriter()
        }
        const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk
        return Effect.tryPromise({
          try: () => writerRef!.write(data),
          catch: (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketWriteError({ cause }),
            }),
        })
      }),
    )

  const writer = Effect.acquireRelease(Effect.succeed(write), () =>
    Effect.promise(async () => {
      if (writerRef) {
        await writerRef.close().catch(() => {})
      }
    }),
  )

  return Socket.Socket.of({
    [Socket.TypeId]: Socket.TypeId,
    run,
    runRaw,
    writer,
  })
}
