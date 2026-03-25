/**
 * Glob pattern matching service.
 *
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"
import * as GlobLib from "glob"

/**
 * Error during glob pattern matching.
 *
 * @since 1.0.0
 * @category errors
 */
export class GlobError extends Data.TaggedError("GlobError")<{
  readonly pattern: string | ReadonlyArray<string>
  readonly cause: unknown
}> {}

/**
 * Service for glob pattern matching.
 *
 * @since 1.0.0
 * @category models
 */
export interface Glob {
  readonly glob: (
    pattern: string | ReadonlyArray<string>,
    options?: GlobLib.GlobOptions
  ) => Effect.Effect<Array<string>, GlobError>
}

/**
 * @since 1.0.0
 * @category tags
 */
export const Glob: ServiceMap.Service<Glob, Glob> = ServiceMap.Service("@effect/ai-codegen/Glob")

/**
 * Layer providing the Glob service.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Glob> = Layer.succeed(Glob, {
  glob: (pattern, options) =>
    Effect.tryPromise({
      try: () => GlobLib.glob(pattern as string | Array<string>, options ?? {}) as Promise<Array<string>>,
      catch: (cause) => new GlobError({ pattern, cause })
    })
})
