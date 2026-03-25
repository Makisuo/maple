/**
 * @since 1.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type { SizeInput } from "effect/FileSystem"
import { dual, type LazyArg } from "effect/Function"
import * as Latch from "effect/Latch"
import * as MutableRef from "effect/MutableRef"
import * as Pull from "effect/Pull"
import * as Scope from "effect/Scope"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import type { Duplex } from "node:stream"
import { Readable } from "node:stream"
import { pullIntoWritable } from "./NodeSink.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export const fromReadable = <A = Uint8Array, E = Cause.UnknownError>(options: {
  readonly evaluate: LazyArg<Readable | NodeJS.ReadableStream>
  readonly onError?: (error: unknown) => E
  readonly chunkSize?: number | undefined
  readonly bufferSize?: number | undefined
  readonly closeOnDone?: boolean | undefined
}): Stream.Stream<A, E> => Stream.fromChannel(fromReadableChannel<A, E>(options))

/**
 * @category constructors
 * @since 1.0.0
 */
export const fromReadableChannel = <A = Uint8Array, E = Cause.UnknownError>(options: {
  readonly evaluate: LazyArg<Readable | NodeJS.ReadableStream>
  readonly onError?: (error: unknown) => E
  readonly chunkSize?: number | undefined
  readonly closeOnDone?: boolean | undefined
}): Channel.Channel<Arr.NonEmptyReadonlyArray<A>, E> =>
  Channel.fromTransform((_, scope) =>
    readableToPullUnsafe({
      scope,
      readable: options.evaluate(),
      onError: options.onError ?? defaultOnError as any,
      chunkSize: options.chunkSize,
      closeOnDone: options.closeOnDone
    })
  )

/**
 * @category constructors
 * @since 1.0.0
 */
export const fromDuplex = <IE, I = Uint8Array, O = Uint8Array, E = Cause.UnknownError>(
  options: {
    readonly evaluate: LazyArg<Duplex>
    readonly onError?: (error: unknown) => E
    readonly chunkSize?: number | undefined
    readonly bufferSize?: number | undefined
    readonly endOnDone?: boolean | undefined
    readonly encoding?: BufferEncoding | undefined
  }
): Channel.Channel<Arr.NonEmptyReadonlyArray<O>, IE | E, void, Arr.NonEmptyReadonlyArray<I>, IE> =>
  Channel.fromTransform((upstream, scope) => {
    const duplex = options.evaluate()
    const exit = MutableRef.make<Exit.Exit<never, IE | E | Cause.Done> | undefined>(undefined)

    return pullIntoWritable({
      pull: upstream,
      writable: duplex,
      onError: options.onError ?? defaultOnError as any,
      endOnDone: options.endOnDone,
      encoding: options.encoding
    }).pipe(
      Effect.catchCause((cause) => {
        if (Pull.isDoneCause(cause)) return Effect.void
        exit.current = Exit.failCause(cause as Cause.Cause<IE | E | Cause.Done>)
        return Effect.void
      }),
      Effect.forkIn(scope),
      Effect.flatMap(() =>
        readableToPullUnsafe({
          scope,
          exit,
          readable: duplex,
          onError: options.onError ?? defaultOnError as any,
          chunkSize: options.chunkSize
        })
      )
    )
  })

/**
 * @category combinators
 * @since 1.0.0
 */
export const pipeThroughDuplex: {
  <B = Uint8Array, E2 = Cause.UnknownError>(
    options: {
      readonly evaluate: LazyArg<Duplex>
      readonly onError?: (error: unknown) => E2
      readonly chunkSize?: number | undefined
      readonly bufferSize?: number | undefined
      readonly endOnDone?: boolean | undefined
      readonly encoding?: BufferEncoding | undefined
    }
  ): <R, E, A>(self: Stream.Stream<A, E, R>) => Stream.Stream<B, E2 | E, R>
  <R, E, A, B = Uint8Array, E2 = Cause.UnknownError>(
    self: Stream.Stream<A, E, R>,
    options: {
      readonly evaluate: LazyArg<Duplex>
      readonly onError?: (error: unknown) => E2
      readonly chunkSize?: number | undefined
      readonly bufferSize?: number | undefined
      readonly endOnDone?: boolean | undefined
      readonly encoding?: BufferEncoding | undefined
    }
  ): Stream.Stream<B, E | E2, R>
} = dual(2, <R, E, A, B = Uint8Array, E2 = Cause.UnknownError>(
  self: Stream.Stream<A, E, R>,
  options: {
    readonly evaluate: LazyArg<Duplex>
    readonly onError?: (error: unknown) => E2
    readonly chunkSize?: number | undefined
    readonly bufferSize?: number | undefined
    readonly endOnDone?: boolean | undefined
    readonly encoding?: BufferEncoding | undefined
  }
): Stream.Stream<B, E | E2, R> =>
  Stream.pipeThroughChannelOrFail(
    self,
    fromDuplex(options)
  ))

/**
 * @category combinators
 * @since 1.0.0
 */
export const pipeThroughSimple: {
  (
    duplex: LazyArg<Duplex>
  ): <R, E>(self: Stream.Stream<string | Uint8Array, E, R>) => Stream.Stream<Uint8Array, E | Cause.UnknownError, R>
  <R, E>(
    self: Stream.Stream<string | Uint8Array, E, R>,
    duplex: LazyArg<Duplex>
  ): Stream.Stream<Uint8Array, Cause.UnknownError | E, R>
} = dual(2, <R, E>(
  self: Stream.Stream<string | Uint8Array, E, R>,
  duplex: LazyArg<Duplex>
): Stream.Stream<Uint8Array, Cause.UnknownError | E, R> => pipeThroughDuplex(self, { evaluate: duplex }))

/**
 * @since 1.0.0
 * @category conversions
 */
export const toReadable = <E, R>(stream: Stream.Stream<string | Uint8Array, E, R>): Effect.Effect<Readable, never, R> =>
  Effect.map(
    Effect.services<R>(),
    (context) => new StreamAdapter(context, stream)
  )

/**
 * @since 1.0.0
 * @category conversions
 */
export const toReadableNever = <E>(stream: Stream.Stream<string | Uint8Array, E, never>): Readable =>
  new StreamAdapter(
    ServiceMap.empty(),
    stream
  )

/**
 * @since 1.0.0
 * @category conversions
 */
export const toString = <E = Cause.UnknownError>(
  readable: LazyArg<Readable | NodeJS.ReadableStream>,
  options?: {
    readonly onError?: (error: unknown) => E
    readonly encoding?: BufferEncoding | undefined
    readonly maxBytes?: SizeInput | undefined
  }
): Effect.Effect<string, E> => {
  const maxBytesNumber = options?.maxBytes ? Number(options.maxBytes) : undefined
  const onError = options?.onError ?? defaultOnError
  const encoding = options?.encoding ?? "utf8"
  return Effect.callback((resume) => {
    const stream = readable() as Readable
    stream.setEncoding(encoding)

    stream.once("error", (err) => {
      if ("closed" in stream && !stream.closed) {
        stream.destroy()
      }
      resume(Effect.fail(onError(err) as E))
    })
    stream.once("error", (err) => {
      resume(Effect.fail(onError(err) as E))
    })

    let string = ""
    let bytes = 0
    stream.once("end", () => {
      resume(Effect.succeed(string))
    })
    stream.on("data", (chunk) => {
      string += chunk
      bytes += Buffer.byteLength(chunk)
      if (maxBytesNumber && bytes > maxBytesNumber) {
        resume(Effect.fail(onError(new Error("maxBytes exceeded")) as E))
      }
    })
    return Effect.sync(() => {
      if ("closed" in stream && !stream.closed) {
        stream.destroy()
      }
    })
  })
}

/**
 * @since 1.0.0
 * @category conversions
 */
export const toArrayBuffer = <E = Cause.UnknownError>(
  readable: LazyArg<Readable | NodeJS.ReadableStream>,
  options?: {
    readonly onError?: (error: unknown) => E
    readonly maxBytes?: SizeInput | undefined
  }
): Effect.Effect<ArrayBuffer, E> => {
  const maxBytesNumber = options?.maxBytes ? Number(options.maxBytes) : undefined
  const onError = options?.onError ?? defaultOnError
  return Effect.callback((resume) => {
    const stream = readable() as Readable
    let buffer = Buffer.alloc(0)
    let bytes = 0
    stream.once("error", (err) => {
      if ("closed" in stream && !stream.closed) {
        stream.destroy()
      }
      resume(Effect.fail(onError(err) as E))
    })
    stream.once("end", () => {
      if (buffer.buffer.byteLength === buffer.byteLength) {
        return resume(Effect.succeed(buffer.buffer))
      }
      resume(Effect.succeed(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)))
    })
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      bytes += chunk.length
      if (maxBytesNumber && bytes > maxBytesNumber) {
        resume(Effect.fail(onError(new Error("maxBytes exceeded")) as E))
      }
    })
    return Effect.sync(() => {
      if ("closed" in stream && !stream.closed) {
        stream.destroy()
      }
    })
  })
}

/**
 * @since 1.0.0
 * @category conversions
 */
export const toUint8Array = <E = Cause.UnknownError>(
  readable: LazyArg<Readable | NodeJS.ReadableStream>,
  options?: {
    readonly onError?: (error: unknown) => E
    readonly maxBytes?: SizeInput | undefined
  }
): Effect.Effect<Uint8Array, E> => Effect.map(toArrayBuffer(readable, options), (buffer) => new Uint8Array(buffer))

// ----------------------------------------------------------------------------
// internal
// ----------------------------------------------------------------------------

const readableToPullUnsafe = <A, E>(options: {
  readonly scope: Scope.Scope
  readonly exit?: MutableRef.MutableRef<Exit.Exit<never, E | Cause.Done> | undefined> | undefined
  readonly readable: Readable | NodeJS.ReadableStream
  readonly onError: (error: unknown) => E
  readonly chunkSize: number | undefined
  readonly closeOnDone?: boolean | undefined
}) => {
  const readable = options.readable as Readable
  if (readable.readableEnded) return Effect.succeed(Cause.done())

  const closeOnDone = options.closeOnDone ?? true
  const exit = options.exit ?? MutableRef.make(undefined)
  const latch = Latch.makeUnsafe(false)
  function onReadable() {
    latch.openUnsafe()
  }
  function onError(error: unknown) {
    exit.current = Exit.fail(options.onError(error))
    latch.openUnsafe()
  }
  function onEnd() {
    exit.current = Exit.fail(Cause.Done())
    latch.openUnsafe()
  }
  readable.on("readable", onReadable)
  readable.once("error", onError)
  readable.once("end", onEnd)

  const pull = Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> {
    let item = options.readable.read(options.chunkSize) as A | null
    if (item === null) {
      if (exit.current) {
        return exit.current
      }
      latch.closeUnsafe()
      return Effect.flatMap(latch.await, loop)
    }
    const chunk = Arr.of(item as A)
    while (true) {
      item = options.readable.read(options.chunkSize)
      if (item === null) break
      chunk.push(item)
    }
    return Effect.succeed(chunk)
  })

  return Effect.as(
    Scope.addFinalizer(
      options.scope,
      Effect.sync(() => {
        readable.off("readable", onReadable)
        readable.off("error", onError)
        readable.off("end", onEnd)
        if (closeOnDone && "closed" in options.readable && !options.readable.closed) {
          options.readable.destroy()
        }
      })
    ),
    pull
  )
}

class StreamAdapter<E, R> extends Readable {
  private readonly readLatch: Latch.Latch
  private fiber: Fiber.Fiber<void, E> | undefined = undefined

  constructor(
    context: ServiceMap.ServiceMap<R>,
    stream: Stream.Stream<Uint8Array | string, E, R>
  ) {
    super({})
    this.readLatch = Latch.makeUnsafe(false)
    this.fiber = Stream.runForEachArray(stream, (chunk) =>
      this.readLatch.whenOpen(Effect.sync(() => {
        this.readLatch.closeUnsafe()
        for (let i = 0; i < chunk.length; i++) {
          const item = chunk[i]
          if (typeof item === "string") {
            this.push(item, "utf8")
          } else {
            this.push(item)
          }
        }
      }))).pipe(
        this.readLatch.whenOpen,
        Effect.provideServices(context),
        Effect.runFork
      )
    this.fiber.addObserver((exit) => {
      this.fiber = undefined
      if (Exit.isSuccess(exit)) {
        this.push(null)
      } else {
        this.destroy(Cause.squash(exit.cause) as any)
      }
    })
  }

  override _read(_size: number): void {
    this.readLatch.openUnsafe()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null | undefined) => void): void {
    if (!this.fiber) {
      return callback(error)
    }
    Effect.runFork(Fiber.interrupt(this.fiber)).addObserver((exit) => {
      callback(exit._tag === "Failure" ? Cause.squash(exit.cause) as any : error)
    })
  }
}

const defaultOnError = (error: unknown): Cause.UnknownError => new Cause.UnknownError(error)
