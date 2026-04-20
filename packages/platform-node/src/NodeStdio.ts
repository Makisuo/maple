/**
 * @since 1.0.0
 */
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import type * as Layer from "effect/Layer"
import type { Stdio } from "effect/Stdio"

/**
 * @since 1.0.0
 * @category layer
 */
export const layer: Layer.Layer<Stdio> = NodeStdio.layer
