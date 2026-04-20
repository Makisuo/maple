/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Path, TypeId } from "effect/Path"
import { BadArgument } from "effect/PlatformError"
import * as NodePath from "node:path"
import * as NodeUrl from "node:url"

const fromFileUrl = (url: URL): Effect.Effect<string, BadArgument> =>
  Effect.try({
    try: () => NodeUrl.fileURLToPath(url),
    catch: (cause) =>
      new BadArgument({
        module: "Path",
        method: "fromFileUrl",
        cause
      })
  })

const toFileUrl = (path: string): Effect.Effect<URL, BadArgument> =>
  Effect.try({
    try: () => NodeUrl.pathToFileURL(path),
    catch: (cause) =>
      new BadArgument({
        module: "Path",
        method: "toFileUrl",
        cause
      })
  })

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerPosix: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath.posix,
  fromFileUrl,
  toFileUrl
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerWin32: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath.win32,
  fromFileUrl,
  toFileUrl
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Path> = Layer.succeed(Path)({
  [TypeId]: TypeId,
  ...NodePath,
  fromFileUrl,
  toFileUrl
})
