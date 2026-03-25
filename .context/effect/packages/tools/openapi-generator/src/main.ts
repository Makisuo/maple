import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as CliError from "effect/unstable/cli/CliError"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi"
import * as OpenApiGenerator from "./OpenApiGenerator.ts"
import * as OpenApiPatch from "./OpenApiPatch.ts"

const spec = Flag.fileParse("spec").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("The OpenAPI spec file to generate the client from")
)

const name = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("The name of the generated client"),
  Flag.withDefault("Client")
)

const typeOnly = Flag.boolean("type-only").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Generate a type-only client without schemas")
)

const patch = Flag.string("patch").pipe(
  Flag.withAlias("p"),
  Flag.withDescription(
    "JSON patch to apply to OpenAPI spec before generation. " +
      "Can be a file path (.json, .yaml, .yml) or inline JSON array. " +
      "Multiple patches are applied in order."
  ),
  Flag.between(0, Infinity)
)

const root = Command.make("openapigen", { spec, typeOnly, name, patch }).pipe(
  Command.withHandler(Effect.fnUntraced(function*({ name, spec, typeOnly, patch }) {
    let patchedSpec: Schema.Json = spec as Schema.Json

    if (patch.length > 0) {
      const parsedPatches = yield* Effect.forEach(
        patch,
        (input) =>
          OpenApiPatch.parsePatchInput(input).pipe(
            Effect.map((p) => ({ source: input, patch: p })),
            Effect.mapError((error) => new CliError.UserError({ cause: error }))
          )
      )
      patchedSpec = yield* OpenApiPatch.applyPatches(parsedPatches, patchedSpec).pipe(
        Effect.mapError((error) => new CliError.UserError({ cause: error }))
      )
    }

    const generator = yield* OpenApiGenerator.OpenApiGenerator
    const source = yield* generator.generate(patchedSpec as unknown as OpenAPISpec, { name, typeOnly })
    return yield* Console.log(source)
  })),
  Command.provide(({ typeOnly }) =>
    typeOnly
      ? OpenApiGenerator.layerTransformerTs
      : OpenApiGenerator.layerTransformerSchema
  )
)

export const run: Effect.Effect<void, CliError.CliError, Command.Environment> = Command.run(root, {
  version: "0.0.0"
})
