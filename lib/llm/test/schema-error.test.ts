/**
 * Maple-added (not upstream). effect beta.84 made `Schema.SchemaError` extend `Data.TaggedError`,
 * and `src/tool-runtime.ts` reads `.message` off it in two places to build a `ToolFailure` message.
 * The vendored source targets beta.83; Maple runs beta.101. These tests pin that behaviour so an
 * upstream `effect` bump can't silently degrade tool failures into `"undefined"` strings.
 */
import { Cause, Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ToolCallPart } from "../src/schema"
import { Tool } from "../src/tool"
import { ToolRuntime } from "../src/tool-runtime"
import { it } from "./lib/effect"

const echo = Tool.make({
  description: "Echo a city back.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String }),
  execute: ({ city }) => Effect.succeed({ city }),
})

/** Declares a `Number` success but returns a string, so `_encode` fails. */
const badOutput = Tool.make({
  description: "Return a value that does not match its success schema.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ temperature: Schema.Number }),
  execute: () => Effect.succeed({ temperature: "warm" } as unknown as { temperature: number }),
})

const boom = new Error("tool exploded")

const defective = Tool.make({
  description: "Fail with a non-schema, non-ToolFailure cause.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({}),
  execute: () => Effect.die(boom),
})

const call = (name: string, input: unknown) => ToolCallPart.make({ id: "call_1", name, input })

describe("Schema.SchemaError under effect beta.101", () => {
  it.effect("carries a non-empty message that survives into the tool-input ToolFailure", () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(Schema.Struct({ city: Schema.String }))({
        city: 42,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Error)
      expect(typeof error.message).toBe("string")
      expect(error.message.length).toBeGreaterThan(0)

      const dispatched = yield* ToolRuntime.dispatch({ echo }, call("echo", { city: 42 }))
      expect(dispatched.result.type).toBe("error")
      expect(String(dispatched.result.value)).toContain("Invalid tool input:")
      // The interpolated `error.message` must actually be there — not `undefined`.
      expect(String(dispatched.result.value)).not.toContain("undefined")
    }),
  )

  it.effect("carries a message into the success-schema ToolFailure too", () =>
    Effect.gen(function* () {
      const dispatched = yield* ToolRuntime.dispatch({ badOutput }, call("badOutput", {}))
      expect(dispatched.result.type).toBe("error")
      expect(String(dispatched.result.value)).toContain("Tool returned an invalid value for its success schema:")
      expect(String(dispatched.result.value)).not.toContain("undefined")
    }),
  )

  it.effect("lets non-schema causes stay real Errors instead of being mapped to a tool error", () =>
    Effect.gen(function* () {
      // `dispatch` only catches `LLM.ToolFailure`; a defect must propagate as the original `Error`.
      const exit = yield* ToolRuntime.dispatch({ defective }, call("defective", {})).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const defects = exit.cause.reasons.filter(Cause.isDieReason)
      expect(defects).toHaveLength(1)
      expect(defects[0]?.defect).toBe(boom)
      expect(defects[0]?.defect).toBeInstanceOf(Error)
    }),
  )
})
