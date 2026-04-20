/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type * as Cause from "../../Cause.ts"
import * as Channel from "../../Channel.ts"
import * as Context from "../../Context.ts"
import * as Deferred from "../../Deferred.ts"
import type * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as FiberSet from "../../FiberSet.ts"
import { constVoid, dual, flow } from "../../Function.ts"
import * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as Predicate from "../../Predicate.ts"
import * as Pull from "../../Pull.ts"
import * as Queue from "../../Queue.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as Scope from "../../Scope.ts"

/**
 * @since 4.0.0
 * @category Type IDs
 */
export const TypeId = "~effect/socket/Socket"

/**
 * @since 4.0.0
 * @category guards
 */
export const isSocket = (u: unknown): u is Socket => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category tags
 */
export const Socket: Context.Service<Socket, Socket> = Context.Service<Socket>("effect/socket/Socket")

/**
 * @since 4.0.0
 * @category models
 */
export interface Socket {
  readonly [TypeId]: typeof TypeId
  readonly run: <_, E = never, R = never>(
    handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }
  ) => Effect.Effect<void, SocketError | E, R>
  readonly runRaw: <_, E = never, R = never>(
    handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }
  ) => Effect.Effect<void, SocketError | E, R>
  readonly writer: Effect.Effect<
    (chunk: Uint8Array | string | CloseEvent) => Effect.Effect<void, SocketError>,
    never,
    Scope.Scope
  >
}

const CloseEventTypeId = "~effect/socket/Socket/CloseEvent"

/**
 * @since 4.0.0
 * @category models
 */
export class CloseEvent {
  /**
   * @since 4.0.0
   */
  readonly [CloseEventTypeId]: typeof CloseEventTypeId
  readonly code: number
  readonly reason?: string | undefined

  constructor(code = 1000, reason?: string) {
    this[CloseEventTypeId] = CloseEventTypeId
    this.code = code
    this.reason = reason
  }
  /**
   * @since 4.0.0
   */
  toString() {
    return this.reason ? `${this.code}: ${this.reason}` : `${this.code}`
  }
}

/**
 * @since 4.0.0
 * @category refinements
 */
export const isCloseEvent = (u: unknown): u is CloseEvent => Predicate.hasProperty(u, CloseEventTypeId)

/**
 * @since 4.0.0
 * @category type ids
 */
export type SocketErrorTypeId = "~effect/socket/Socket/SocketError"

/**
 * @since 4.0.0
 * @category type ids
 */
export const SocketErrorTypeId: SocketErrorTypeId = "~effect/socket/Socket/SocketError"

/**
 * @since 4.0.0
 * @category refinements
 */
export const isSocketError = (u: unknown): u is SocketError => Predicate.hasProperty(u, SocketErrorTypeId)

/**
 * @since 4.0.0
 * @category errors
 */
export class SocketReadError extends Schema.ErrorClass<SocketReadError>("effect/socket/Socket/SocketReadError")({
  _tag: Schema.tag("SocketReadError"),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  override readonly message = `An error occurred during Read`
}

/**
 * @since 4.0.0
 * @category errors
 */
export class SocketWriteError extends Schema.ErrorClass<SocketWriteError>("effect/socket/Socket/SocketWriteError")({
  _tag: Schema.tag("SocketWriteError"),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  override readonly message = `An error occurred during Write`
}

/**
 * @since 4.0.0
 * @category errors
 */
export class SocketOpenError extends Schema.ErrorClass<SocketOpenError>("effect/socket/Socket/SocketOpenError")({
  _tag: Schema.tag("SocketOpenError"),
  kind: Schema.Literals(["Unknown", "Timeout"]),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  override get message() {
    return this.kind === "Timeout"
      ? `timeout waiting for "open"`
      : `An error occurred during Open`
  }
}

/**
 * @since 4.0.0
 * @category errors
 */
export class SocketCloseError extends Schema.ErrorClass<SocketCloseError>("effect/socket/Socket/SocketCloseError")({
  _tag: Schema.tag("SocketCloseError"),
  code: Schema.Number,
  closeReason: Schema.optional(Schema.String)
}) {
  /**
   * @since 4.0.0
   */
  static filterClean(isClean: (code: number) => boolean): <E>(u: E) => Result.Result<SocketCloseError, E> {
    return function<E>(u: E) {
      return SocketError.is(u) && u.reason._tag === "SocketCloseError" && isClean(u.reason.code)
        ? Result.succeed(u.reason)
        : Result.fail(u)
    }
  }

  override get message() {
    if (this.closeReason) {
      return `${this.code}: ${this.closeReason}`
    }
    return `${this.code}`
  }
}

/**
 * @since 4.0.0
 * @category errors
 */
export const SocketErrorReason = Schema.Union([
  SocketReadError,
  SocketWriteError,
  SocketOpenError,
  SocketCloseError
])

/**
 * @since 4.0.0
 * @category errors
 */
export type SocketErrorReason =
  | SocketReadError
  | SocketWriteError
  | SocketOpenError
  | SocketCloseError

/**
 * @since 4.0.0
 * @category errors
 */
export class SocketError extends Schema.TaggedErrorClass<SocketError>(SocketErrorTypeId)("SocketError", {
  _tag: Schema.tag("SocketError"),
  reason: SocketErrorReason
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: SocketReadError | SocketWriteError | SocketOpenError | SocketCloseError
  }) {
    if ("cause" in props.reason) {
      super({
        ...props,
        cause: props.reason.cause
      } as any)
    } else {
      super(props)
    }
  }

  /**
   * @since 4.0.0
   */
  readonly [SocketErrorTypeId]: SocketErrorTypeId = SocketErrorTypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is SocketError {
    return isSocketError(u)
  }

  override readonly message = this.reason.message
}

/**
 * @since 4.0.0
 * @category combinators
 */
export const toChannelMap = <IE, A>(
  self: Socket,
  f: (data: Uint8Array | string) => A
): Channel.Channel<
  NonEmptyReadonlyArray<A>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE
> =>
  Channel.fromTransform(Effect.fnUntraced(function*(upstream, scope) {
    const queue = yield* Queue.make<A, SocketError | IE | Cause.Done>()

    const writeScope = yield* Scope.fork(scope)
    const write = yield* Scope.provide(self.writer, writeScope)

    let chunk: NonEmptyReadonlyArray<Uint8Array | string | CloseEvent> | undefined
    let index = 0
    const writeChunk = Effect.whileLoop({
      while: () => index < chunk!.length,
      body: () => write(chunk![index++]),
      step: constVoid
    })

    yield* upstream.pipe(
      Effect.flatMap((arr) => {
        if (arr.length === 1) return write(arr[0])
        chunk = arr
        index = 0
        return writeChunk
      }),
      Effect.forever({ disableYield: true }),
      Effect.catchCauseFilter(
        Pull.filterNoDone,
        (cause) => Queue.failCause(queue, cause)
      ),
      Effect.ensuring(Scope.close(writeScope, Exit.void)),
      Effect.forkIn(scope)
    )

    yield* self.runRaw((data) => {
      Queue.offerUnsafe(queue, f(data))
    }).pipe(
      Queue.into(queue),
      Effect.forkIn(scope)
    )

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Queue.takeAll(queue)
  }))

/**
 * @since 4.0.0
 * @category combinators
 */
export const toChannel = <IE>(
  self: Socket
): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE
> => {
  const encoder = new TextEncoder()
  return toChannelMap(self, (data) => typeof data === "string" ? encoder.encode(data) : data)
}

/**
 * @since 4.0.0
 * @category combinators
 */
export const toChannelString: {
  (encoding?: string | undefined): <IE>(self: Socket) => Channel.Channel<
    NonEmptyReadonlyArray<string>,
    SocketError | IE,
    void,
    NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
    IE
  >
  <IE>(
    self: Socket,
    encoding?: string | undefined
  ): Channel.Channel<
    NonEmptyReadonlyArray<string>,
    SocketError | IE,
    void,
    NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
    IE
  >
} = dual((args) => isSocket(args[0]), <IE>(
  self: Socket,
  encoding?: string | undefined
): Channel.Channel<
  NonEmptyReadonlyArray<string>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE
> => {
  const decoder = new TextDecoder(encoding)
  return toChannelMap(self, (data) => typeof data === "string" ? data : decoder.decode(data))
})

/**
 * @since 4.0.0
 * @category combinators
 */
export const toChannelWith = <IE = never>() =>
(
  self: Socket
): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE
> => toChannel(self)

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeChannel = <IE = never>(): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE,
  unknown,
  Socket
> => Channel.unwrap(Effect.map(Socket.asEffect(), toChannelWith<IE>()))

/**
 * @since 4.0.0
 */
export const defaultCloseCodeIsError = (_code: number) => true

/**
 * @since 4.0.0
 * @category tags
 */
export class WebSocket extends Context.Service<WebSocket, globalThis.WebSocket>()(
  "~effect/socket/Socket/WebSocket"
) {}

/**
 * @since 4.0.0
 * @category tags
 */
export class WebSocketConstructor extends Context.Service<
  WebSocketConstructor,
  (url: string, protocols?: string | Array<string> | undefined) => globalThis.WebSocket
>()("@effect/platform/Socket/WebSocketConstructor") {}

/**
 * @since 4.0.0
 * @category layers
 */
export const layerWebSocketConstructorGlobal: Layer.Layer<WebSocketConstructor> = Layer.succeed(WebSocketConstructor)(
  (url, protocols) => new globalThis.WebSocket(url, protocols)
)

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeWebSocket = (url: string | Effect.Effect<string>, options?: {
  readonly closeCodeIsError?: ((code: number) => boolean) | undefined
  readonly openTimeout?: Duration.Input | undefined
  readonly protocols?: string | Array<string> | undefined
}): Effect.Effect<Socket, never, WebSocketConstructor> =>
  WebSocketConstructor.use((makeWs) =>
    fromWebSocket(
      Effect.acquireRelease(
        (typeof url === "string" ? Effect.succeed(url) : url).pipe(
          Effect.map((url) => makeWs(url, options?.protocols))
        ),
        (ws) => Effect.sync(() => ws.close(1000))
      ),
      options
    )
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromWebSocket = <RO>(
  acquire: Effect.Effect<globalThis.WebSocket, SocketError, RO>,
  options?: {
    readonly closeCodeIsError?: ((code: number) => boolean) | undefined
    readonly openTimeout?: Duration.Input | undefined
  } | undefined
): Effect.Effect<Socket, never, Exclude<RO, Scope.Scope>> =>
  Effect.withFiber((fiber) => {
    let currentWS: globalThis.WebSocket | undefined
    const latch = Latch.makeUnsafe(false)
    const acquireContext = fiber.context as Context.Context<RO>
    const closeCodeIsError = options?.closeCodeIsError ?? defaultCloseCodeIsError

    const runRaw = <_, E, R>(handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void, opts?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      Effect.scopedWith(Effect.fnUntraced(function*(scope) {
        const fiberSet = yield* FiberSet.make<any, E | SocketError>().pipe(
          Scope.provide(scope)
        )
        const ws = yield* Scope.provide(acquire, scope)
        const run = yield* Effect.provideService(FiberSet.runtime(fiberSet)<R>(), WebSocket, ws)
        let open = false

        function onMessage(event: MessageEvent) {
          if (event.data instanceof Blob) {
            const effect = Effect.flatMap(
              Effect.promise(() => event.data.arrayBuffer() as Promise<ArrayBuffer>),
              (buffer) => {
                const result = handler(new Uint8Array(buffer))
                return Effect.isEffect(result) ? result : Effect.void
              }
            )
            return run(effect)
          }
          const result = handler(event.data)
          if (Effect.isEffect(result)) {
            run(result)
          }
        }
        function onError(cause: Event) {
          ws.removeEventListener("message", onMessage)
          ws.removeEventListener("close", onClose)
          Deferred.doneUnsafe(
            fiberSet.deferred,
            Effect.fail(
              new SocketError({
                reason: open ?
                  new SocketReadError({
                    cause
                  }) :
                  new SocketOpenError({
                    kind: "Unknown",
                    cause
                  })
              })
            )
          )
        }
        function onClose(event: globalThis.CloseEvent) {
          const code = typeof event.code === "number" ? event.code : 1001
          ws.removeEventListener("message", onMessage)
          ws.removeEventListener("error", onError)
          Deferred.doneUnsafe(
            fiberSet.deferred,
            Effect.fail(
              new SocketError({
                reason: new SocketCloseError({
                  code,
                  closeReason: event.reason
                })
              })
            )
          )
        }

        ws.addEventListener("close", onClose, { once: true })
        ws.addEventListener("error", onError, { once: true })
        ws.addEventListener("message", onMessage)

        if (ws.readyState !== 1) {
          const openDeferred = Deferred.makeUnsafe<void>()
          ws.addEventListener("open", () => {
            open = true
            Deferred.doneUnsafe(openDeferred, Effect.void)
          }, { once: true })
          yield* Deferred.await(openDeferred).pipe(
            Effect.timeoutOrElse({
              duration: options?.openTimeout ?? 10000,
              orElse: () =>
                Effect.fail(
                  new SocketError({
                    reason: new SocketOpenError({
                      kind: "Timeout",
                      cause: new Error("timeout waiting for \"open\"")
                    })
                  })
                )
            }),
            Effect.raceFirst(FiberSet.join(fiberSet))
          )
        }
        open = true
        currentWS = ws
        latch.openUnsafe()
        if (opts?.onOpen) yield* opts.onOpen
        return yield* Effect.catchFilter(
          FiberSet.join(fiberSet),
          SocketCloseError.filterClean((_) => !closeCodeIsError(_)),
          () => Effect.void
        )
      })).pipe(
        Effect.updateContext((input: Context.Context<R>) => Context.merge(acquireContext, input)),
        Effect.ensuring(Effect.sync(() => {
          latch.closeUnsafe()
          currentWS = undefined
        }))
      )

    const encoder = new TextEncoder()
    const run = <_, E, R>(handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void, opts?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      runRaw((data) =>
        typeof data === "string"
          ? handler(encoder.encode(data))
          : data instanceof Uint8Array
          ? handler(data)
          : handler(new Uint8Array(data)), opts)

    const write = (chunk: Uint8Array | string | CloseEvent) =>
      latch.whenOpen(Effect.sync(() => {
        const ws = currentWS!
        if (isCloseEvent(chunk)) {
          ws.close(chunk.code, chunk.reason)
        } else {
          ws.send(chunk as string | Uint8Array<ArrayBuffer>)
        }
      }))
    const writer = Effect.succeed(write)

    return Effect.succeed(Socket.of({
      [TypeId]: TypeId,
      run,
      runRaw,
      writer
    }))
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeWebSocketChannel = <IE = never>(
  url: string,
  options?: {
    readonly closeCodeIsError?: (code: number) => boolean
  }
): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE,
  unknown,
  WebSocketConstructor
> =>
  Channel.unwrap(
    Effect.map(makeWebSocket(url, options), toChannelWith<IE>())
  )

/**
 * @since 4.0.0
 * @category layers
 */
export const layerWebSocket: (
  url: string | Effect.Effect<string>,
  options?: {
    readonly closeCodeIsError?: ((code: number) => boolean) | undefined
    readonly openTimeout?: Duration.Input | undefined
    readonly protocols?: string | Array<string> | undefined
  } | undefined
) => Layer.Layer<Socket, never, WebSocketConstructor> = flow(makeWebSocket, Layer.effect(Socket))

/**
 * @since 4.0.0
 * @category fiber refs
 */
export const SendQueueCapacity = Context.Reference<number>("~effect/socket/Socket/SendQueueCapacity", {
  defaultValue: () => 16
})

/**
 * @since 4.0.0
 * @category models
 */
export interface InputTransformStream {
  readonly readable: ReadableStream<Uint8Array> | ReadableStream<string> | ReadableStream<Uint8Array | string>
  readonly writable: WritableStream<Uint8Array>
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromTransformStream = <R>(acquire: Effect.Effect<InputTransformStream, SocketError, R>, options?: {
  readonly closeCodeIsError?: (code: number) => boolean
}): Effect.Effect<Socket, never, Exclude<R, Scope.Scope>> =>
  Effect.withFiber((fiber) => {
    const latch = Latch.makeUnsafe(false)
    let currentStream: {
      readonly stream: InputTransformStream
      readonly fiberSet: FiberSet.FiberSet<any, any>
    } | undefined
    const acquireServices = fiber.context as Context.Context<R>
    const closeCodeIsError = options?.closeCodeIsError ?? defaultCloseCodeIsError
    const runRaw = <_, E, R>(handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void, opts?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      Effect.scopedWith(Effect.fnUntraced(function*(scope) {
        const stream = yield* Scope.provide(acquire, scope)
        const reader = stream.readable.getReader()
        yield* Scope.addFinalizer(scope, Effect.promise(() => reader.cancel()))
        const fiberSet = yield* FiberSet.make<any, E | SocketError>().pipe(
          Scope.provide(scope)
        )
        const runFork = yield* FiberSet.runtime(fiberSet)<R>()

        yield* Effect.tryPromise({
          try: async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                throw new SocketError({ reason: new SocketCloseError({ code: 1000 }) })
              }
              const result = handler(value)
              if (Effect.isEffect(result)) {
                runFork(result)
              }
            }
          },
          catch: (cause) =>
            isSocketError(cause) ? cause : new SocketError({
              reason: new SocketReadError({ cause })
            })
        }).pipe(
          FiberSet.run(fiberSet)
        )

        currentStream = { stream, fiberSet }
        yield* latch.open
        if (opts?.onOpen) yield* opts.onOpen

        return yield* Effect.catchFilter(
          FiberSet.join(fiberSet),
          SocketCloseError.filterClean((_) => !closeCodeIsError(_)),
          () => Effect.void
        )
      })).pipe(
        (_) => _,
        Effect.updateContext((input: Context.Context<R>) => Context.merge(acquireServices, input)),
        Effect.ensuring(Effect.sync(() => {
          latch.closeUnsafe()
          currentStream = undefined
        }))
      )

    const encoder = new TextEncoder()
    const run = <_, E, R>(handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void, opts?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      runRaw((data) =>
        typeof data === "string"
          ? handler(encoder.encode(data))
          : handler(data), opts)

    const writers = new WeakMap<InputTransformStream, WritableStreamDefaultWriter<Uint8Array>>()
    const getWriter = (stream: InputTransformStream) => {
      let writer = writers.get(stream)
      if (!writer) {
        writer = stream.writable.getWriter()
        writers.set(stream, writer)
      }
      return writer
    }
    const write = (chunk: Uint8Array | string | CloseEvent) =>
      latch.whenOpen(Effect.suspend(() => {
        const { fiberSet, stream } = currentStream!
        if (isCloseEvent(chunk)) {
          return Deferred.fail(
            fiberSet.deferred,
            new SocketError({
              reason: new SocketCloseError({ code: chunk.code, closeReason: chunk.reason })
            })
          )
        }
        return Effect.promise(() => getWriter(stream).write(typeof chunk === "string" ? encoder.encode(chunk) : chunk))
      }))
    const writer = Effect.acquireRelease(
      Effect.succeed(write),
      () =>
        Effect.promise(async () => {
          if (!currentStream) return
          await getWriter(currentStream.stream).close()
        })
    )

    return Effect.succeed(Socket.of({
      [TypeId]: TypeId,
      run,
      runRaw,
      writer
    }))
  })
