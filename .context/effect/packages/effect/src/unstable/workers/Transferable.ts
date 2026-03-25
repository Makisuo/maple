/**
 * @since 1.0.0
 */
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"
import * as ServiceMap from "../../ServiceMap.ts"

/**
 * @since 1.0.0
 * @category models
 */
export class Collector extends ServiceMap.Service<Collector, {
  readonly addAll: (
    _: Iterable<globalThis.Transferable>
  ) => Effect.Effect<void>
  readonly addAllUnsafe: (_: Iterable<globalThis.Transferable>) => void
  readonly read: Effect.Effect<Array<globalThis.Transferable>>
  readonly readUnsafe: () => Array<globalThis.Transferable>
  readonly clearUnsafe: () => Array<globalThis.Transferable>
  readonly clear: Effect.Effect<Array<globalThis.Transferable>>
}>()("effect/workers/Transferable/Collector") {}

/**
 * @since 1.0.0
 * @category constructors
 */
export const makeCollectorUnsafe = (): Collector["Service"] => {
  let tranferables: Array<globalThis.Transferable> = []
  const unsafeAddAll = (transfers: Iterable<globalThis.Transferable>): void => {
    tranferables.push(...transfers)
  }
  const unsafeRead = (): Array<globalThis.Transferable> => tranferables
  const unsafeClear = (): Array<globalThis.Transferable> => {
    const prev = tranferables
    tranferables = []
    return prev
  }
  return Collector.of({
    addAllUnsafe: unsafeAddAll,
    addAll: (transferables) => Effect.sync(() => unsafeAddAll(transferables)),
    readUnsafe: unsafeRead,
    read: Effect.sync(unsafeRead),
    clearUnsafe: unsafeClear,
    clear: Effect.sync(unsafeClear)
  })
}

/**
 * @since 1.0.0
 * @category constructors
 */
export const makeCollector: Effect.Effect<Collector["Service"]> = Effect.sync(makeCollectorUnsafe)

/**
 * @since 1.0.0
 * @category accessors
 */
export const addAll = (
  tranferables: Iterable<globalThis.Transferable>
): Effect.Effect<void> =>
  Effect.servicesWith((services) => {
    const collector = ServiceMap.getOrUndefined(services, Collector)
    if (!collector) return Effect.void
    collector.addAllUnsafe(tranferables)
    return Effect.void
  })

/**
 * @since 1.0.0
 * @category Getter
 */
export const getterAddAll = <A>(
  f: (_: A) => Iterable<globalThis.Transferable>
): Getter.Getter<A, A> =>
  Getter.transformOrFail((e: A) =>
    Effect.servicesWith((services) => {
      const collector = ServiceMap.getOrUndefined(services, Collector)
      if (!collector) return Effect.succeed(e)
      collector.addAllUnsafe(f(e))
      return Effect.succeed(e)
    })
  )

/**
 * @since 1.0.0
 * @category schema
 */
export interface Transferable<S extends Schema.Top> extends
  Schema.decodeTo<
    Schema.toType<S["~rebuild.out"]>,
    S["~rebuild.out"]
  >
{}

/**
 * @since 1.0.0
 * @category schema
 */
export const schema: {
  <S extends Schema.Top>(
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): (self: S) => Transferable<S>
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S>
} = dual(
  2,
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S> =>
    self
      .annotate({
        serializerJson: () => passthroughLink
      })
      .pipe(
        Schema.decode({
          decode: Getter.passthrough(),
          encode: getterAddAll(f)
        })
      )
)

const passthroughLink = Schema.link()(Schema.Any, {
  decode: Getter.passthrough(),
  encode: Getter.passthrough()
})

/**
 * @since 1.0.0
 * @category schema
 */
export const ImageData: Transferable<Schema.declare<ImageData>> = schema(
  Schema.Any as any as Schema.declare<globalThis.ImageData>,
  (_) => [_.data.buffer]
)

/**
 * @since 1.0.0
 * @category schema
 */
export const MessagePort: Transferable<Schema.declare<MessagePort>> = schema(
  Schema.Any as any as Schema.declare<MessagePort>,
  (_) => [_]
)

/**
 * @since 1.0.0
 * @category schema
 */
export const Uint8Array: Transferable<Schema.Uint8Array> = schema(
  Schema.Uint8Array,
  (_) => [_.buffer]
)
