/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * An Effect-native module for working with child processes.
 *
 * This module uses an AST-based approach where commands are built first
 * using `make` and `pipeTo`, then executed using `spawn`.
 *
 * @example
 * ```ts
 * import { NodeServices } from "@effect/platform-node"
 * import { Effect, Stream } from "effect"
 * import { ChildProcess } from "effect/unstable/process"
 *
 * // Build a command
 * const command = ChildProcess.make`echo "hello world"`
 *
 * // Spawn and collect output
 * const program = Effect.gen(function*() {
 *   // You can `yield*` a command, which calls `ChildProcess.spawn`
 *   const handle = yield* command
 *   const chunks = yield* Stream.runCollect(handle.stdout)
 *   const exitCode = yield* handle.exitCode
 *   return { chunks, exitCode }
 * }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
 *
 * // With options
 * const withOptions = ChildProcess.make({ cwd: "/tmp" })`ls -la`
 *
 * // Piping commands
 * const pipeline = ChildProcess.make`cat package.json`.pipe(
 *   ChildProcess.pipeTo(ChildProcess.make`grep name`)
 * )
 *
 * // Spawn the pipeline
 * const pipelineProgram = Effect.gen(function*() {
 *   const handle = yield* pipeline
 *   const chunks = yield* Stream.runCollect(handle.stdout)
 *   return chunks
 * }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
 * ```
 *
 * @since 4.0.0
 */
export * as ChildProcess from "./ChildProcess.ts"

/**
 * A module providing a generic service interface for spawning child processes.
 *
 * This module provides the `ChildProcessSpawner` service tag which can be
 * implemented by platform-specific packages (e.g., Node.js).
 *
 * @since 4.0.0
 */
export * as ChildProcessSpawner from "./ChildProcessSpawner.ts"
