/**
 * @since 4.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Layer from "./Layer.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Sink from "./Sink.ts"
import * as Stream from "./Stream.ts"

/**
 * @since 4.0.0
 * @category Type IDs
 */
export type TypeId = "~effect/Stdio"

/**
 * @since 4.0.0
 * @category Type IDs
 */
export const TypeId: TypeId = "~effect/Stdio"

/**
 * @since 4.0.0
 * @category Models
 */
export interface Stdio {
  readonly [TypeId]: TypeId
  readonly args: Effect.Effect<ReadonlyArray<string>>
  stdout(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  stderr(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  readonly stdin: Stream.Stream<Uint8Array, PlatformError>
}
/**
 * @since 4.0.0
 * @category Services
 */
export const Stdio: Context.Service<Stdio, Stdio> = Context.Service<Stdio>(TypeId)

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = (options: Omit<Stdio, TypeId>): Stdio => ({
  [TypeId]: TypeId,
  ...options
})

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerTest = (impl: Partial<Stdio>): Layer.Layer<Stdio> =>
  Layer.succeed(
    Stdio,
    make({
      args: Effect.succeed([]),
      stdout: () => Sink.drain,
      stderr: () => Sink.drain,
      stdin: Stream.empty,
      ...impl
    })
  )
