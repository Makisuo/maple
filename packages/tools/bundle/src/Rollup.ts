/**
 * @since 1.0.0
 */
import * as NodeStream from "@effect/platform-node/NodeStream"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { createGzip } from "node:zlib"
import type { RollupOptions } from "rollup"
import { rollup } from "rollup"
import { createPlugins } from "./Plugins.ts"

/**
 * @since 1.0.0
 * @category errors
 */
export class RollupError extends Data.TaggedError("RollupError")<{
  readonly cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export class BundleStats extends Data.TaggedClass("BundleStats")<{
  readonly path: string
  readonly sizeInBytes: number
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export interface BundleOptions {
  readonly path: string
  readonly visualize?: boolean | undefined
  readonly outputDirectory?: string | undefined
}

/**
 * @since 1.0.0
 * @category models
 */
export interface BundleAllOptions {
  readonly paths: ReadonlyArray<string>
  readonly visualize?: boolean | undefined
  readonly outputDirectory?: string | undefined
}

/**
 * @since 1.0.0
 * @category services
 */
export class Rollup extends Context.Service<Rollup>()(
  "@effect/bundle/Rollup",
  {
    make: Effect.gen(function*() {
      const pathService = yield* Path.Path
      const fs = yield* FileSystem.FileSystem

      const getRollupOptions = (options: BundleOptions): RollupOptions => ({
        input: options.path,
        output: {
          format: "esm"
        },
        plugins: createPlugins(pathService, { visualize: options.visualize }),
        onwarn: (warning, next) => {
          if (warning.code === "THIS_IS_UNDEFINED") return
          next(warning)
        }
      })

      const bundle = Effect.fn("Rollup.bundle")(
        function*(options: BundleOptions) {
          const bundle = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => rollup(getRollupOptions(options)),
              catch: (cause) => new RollupError({ cause })
            }),
            (bundle) => Effect.promise(() => bundle.close())
          )
          const fibers = yield* FiberSet.make()

          const { output } = yield* Effect.tryPromise({
            try: () => bundle.generate({ format: "esm" }),
            catch: (cause) => new RollupError({ cause })
          })

          const stream = yield* Stream.fromIterable(output).pipe(
            Stream.filter((output) => output.type === "chunk"),
            Stream.map((chunk) => chunk.code),
            Stream.encodeText,
            Stream.broadcast({ capacity: 8, replay: 8 })
          )

          if (options.outputDirectory) {
            const outputPath = pathService.join(
              options.outputDirectory,
              `${pathService.parse(options.path).name}.min.js`
            )
            yield* FiberSet.run(
              fibers,
              stream.pipe(
                Stream.run(fs.sink(outputPath))
              )
            )
          }

          const sizeInBytes = yield* stream.pipe(
            NodeStream.pipeThroughDuplex({
              evaluate: () => createGzip({ level: 9 }),
              onError: (cause) => new RollupError({ cause })
            }),
            Stream.runFold(
              () => 0,
              (totalBytes, chunkBytes) => chunkBytes.length + totalBytes
            )
          )

          yield* FiberSet.awaitEmpty(fibers)

          yield* Effect.log(`Bundled ${options.path}`).pipe(
            Effect.annotateLogs({ size: `${(sizeInBytes / 1000).toFixed(2)} kB` })
          )

          return new BundleStats({ path: options.path, sizeInBytes })
        },
        Effect.scoped
      )

      const bundleAll = Effect.fn("Rollup.bundleAll")(
        function*(options: BundleAllOptions) {
          return yield* Effect.forEach(
            options.paths,
            (path) => bundle({ path, visualize: options.visualize, outputDirectory: options.outputDirectory }),
            { concurrency: options.paths.length }
          )
        }
      )

      return {
        bundle,
        bundleAll
      } as const
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}
