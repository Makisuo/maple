/**
 * @since 1.0.0
 */
import * as NodePath from "@effect/platform-node-shared/NodePath"
import type * as Layer from "effect/Layer"
import type { Path } from "effect/Path"

/**
 * @since 1.0.0
 * @category layer
 */
export const layer: Layer.Layer<Path> = NodePath.layer

/**
 * @since 1.0.0
 * @category layer
 */
export const layerPosix: Layer.Layer<Path> = NodePath.layerPosix

/**
 * @since 1.0.0
 * @category layer
 */
export const layerWin32: Layer.Layer<Path> = NodePath.layerWin32
