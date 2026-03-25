/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Body from "./HttpBody.ts"

/**
 * @since 4.0.0
 * @category models
 */
export type Etag = Weak | Strong

/**
 * @since 4.0.0
 * @category models
 */
export interface Weak {
  readonly _tag: "Weak"
  readonly value: string
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Strong {
  readonly _tag: "Strong"
  readonly value: string
}

/**
 * @since 4.0.0
 * @category convertions
 */
export const toString = (self: Etag): string => {
  switch (self._tag) {
    case "Weak":
      return `W/"${self.value}"`
    case "Strong":
      return `"${self.value}"`
  }
}

/**
 * @since 4.0.0
 * @category models
 */
export class Generator extends ServiceMap.Service<Generator, {
  readonly fromFileInfo: (info: FileSystem.File.Info) => Effect.Effect<Etag>
  readonly fromFileWeb: (file: Body.HttpBody.FileLike) => Effect.Effect<Etag>
}>()("effect/http/Etag/Generator") {}

const fromFileInfo = (info: FileSystem.File.Info) => {
  const mtime = Option.match(info.mtime, {
    onNone: () => "0",
    onSome: (mtime) => mtime.getTime().toString(16)
  })
  return `${info.size.toString(16)}-${mtime}`
}

const fromFileWeb = (file: Body.HttpBody.FileLike) => {
  return `${file.size.toString(16)}-${file.lastModified.toString(16)}`
}

/**
 * @since 4.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Generator> = Layer.succeed(
  Generator
)({
  fromFileInfo(info) {
    return Effect.sync(() => ({ _tag: "Strong", value: fromFileInfo(info) }))
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({ _tag: "Strong", value: fromFileWeb(file) }))
  }
})

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerWeak: Layer.Layer<Generator> = Layer.succeed(
  Generator
)({
  fromFileInfo(info) {
    return Effect.sync(() => ({ _tag: "Weak", value: fromFileInfo(info) }))
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({ _tag: "Weak", value: fromFileWeb(file) }))
  }
})
