import * as Config from "effect/Config"
import { Effect, Layer, Redacted, ServiceMap } from "effect"

export interface CliConfigShape {
  readonly mcpUrl: string
  readonly apiToken: Redacted.Redacted<string>
}

export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "CliConfig",
  {
    make: Effect.gen(function* () {
      const mcpUrl = yield* Config.string("MAPLE_MCP_URL").pipe(
        Config.withDefault("http://localhost:3472/mcp"),
      )
      const apiToken = yield* Config.redacted("MAPLE_API_TOKEN")
      return { mcpUrl, apiToken }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
