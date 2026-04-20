/**
 * @since 1.0.0
 */
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import type { Effect } from "effect/Effect"
import type { Layer } from "effect/Layer"
import type { Scope } from "effect/Scope"
import type { Terminal, UserInput } from "effect/Terminal"

/**
 * @since 1.0.0
 * @category constructors
 */
export const make: (shouldQuit?: (input: UserInput) => boolean) => Effect<Terminal, never, Scope> = NodeTerminal.make

/**
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer<Terminal> = NodeTerminal.layer
