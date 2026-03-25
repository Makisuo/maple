import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as Codegen from "../Codegen.ts"
import * as Glob from "../Glob.ts"

const CodegenLayer = Layer.provideMerge(Codegen.layer, Glob.layer)

export const codegen = Command.make("codegen", {
  cwd: Flag.directory("cwd", { mustExist: true }).pipe(Flag.withDefault(".")),
  pattern: Flag.string("pattern").pipe(Flag.withDefault("src/**/index.ts"))
}, (config) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const generator = yield* Codegen.BarrelGenerator
    const files = yield* generator.discoverFiles(config.pattern, path.resolve(config.cwd))

    yield* Effect.forEach(files, (file) => generator.processFile(file), {
      concurrency: "inherit",
      discard: true
    })
  })).pipe(Command.provide(CodegenLayer))
