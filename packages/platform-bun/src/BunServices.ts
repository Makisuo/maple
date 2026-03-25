/**
 * @since 1.0.0
 */
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type { Path } from "effect/Path"
import type { Stdio } from "effect/Stdio"
import type { Terminal } from "effect/Terminal"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BunChildProcessSpawner from "./BunChildProcessSpawner.ts"
import * as BunFileSystem from "./BunFileSystem.ts"
import * as BunPath from "./BunPath.ts"
import * as BunStdio from "./BunStdio.ts"
import * as BunTerminal from "./BunTerminal.ts"

/**
 * @since 1.0.0
 * @category models
 */
export type BunServices = ChildProcessSpawner | FileSystem | Path | Terminal | Stdio

/**
 * @since 1.0.0
 * @category layer
 */
export const layer: Layer.Layer<BunServices> = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    BunStdio.layer,
    BunTerminal.layer
  ))
)
