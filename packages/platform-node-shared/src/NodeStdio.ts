/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { systemError } from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import { fromWritable } from "./NodeSink.ts"
import { fromReadable } from "./NodeStream.ts"

/**
 * @category Layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Stdio.Stdio> = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdout: (options) =>
      fromWritable({
        evaluate: () => process.stdout,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stdout",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stderr: (options) =>
      fromWritable({
        evaluate: () => process.stderr,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stderr",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stdin: fromReadable({
      evaluate: () => process.stdin,
      onError: (cause) =>
        systemError({
          module: "Stdio",
          method: "stdin",
          _tag: "Unknown",
          cause
        }),
      closeOnDone: false
    })
  })
)
