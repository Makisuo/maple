/**
 * Provider discovery service for AI codegen.
 *
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as Yaml from "yaml"
import { CodegenConfig, type SpecSource, SpecSource as SpecSourceUtils } from "./Config.ts"
import * as Glob from "./Glob.ts"

/**
 * A discovered AI provider with resolved paths.
 *
 * @example
 * ```ts
 * import type * as Discovery from "@effect/ai-codegen/Discovery"
 *
 * declare const provider: Discovery.DiscoveredProvider
 *
 * console.log(provider.name) // "openai"
 * console.log(provider.specSource._tag) // "Url" | "File"
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface DiscoveredProvider {
  readonly name: string
  readonly packagePath: string
  readonly config: CodegenConfig
  readonly specSource: SpecSource
  readonly outputPath: string
}

/**
 * Service for discovering AI provider configurations.
 *
 * @since 1.0.0
 * @category models
 */
export interface ProviderDiscovery {
  readonly discover: () => Effect.Effect<
    Array<DiscoveredProvider>,
    DiscoveryError | Glob.GlobError
  >
  readonly discoverOne: (
    name: string
  ) => Effect.Effect<
    DiscoveredProvider,
    DiscoveryError | ProviderNotFoundError | Glob.GlobError
  >
}

/**
 * @since 1.0.0
 * @category tags
 */
export const ProviderDiscovery: ServiceMap.Service<ProviderDiscovery, ProviderDiscovery> = ServiceMap.Service(
  "@effect/ai-codegen/ProviderDiscovery"
)

/**
 * Error during provider discovery.
 *
 * @example
 * ```ts
 * import * as Discovery from "@effect/ai-codegen/Discovery"
 *
 * const error = new Discovery.DiscoveryError({
 *   message: "Failed to parse config",
 *   cause: new Error("Invalid JSON")
 * })
 * ```
 *
 * @since 1.0.0
 * @category errors
 */
export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error when a specific provider is not found.
 *
 * @example
 * ```ts
 * import * as Discovery from "@effect/ai-codegen/Discovery"
 *
 * const error = new Discovery.ProviderNotFoundError({
 *   provider: "openai",
 *   available: ["anthropic", "google"]
 * })
 * ```
 *
 * @since 1.0.0
 * @category errors
 */
export class ProviderNotFoundError extends Data.TaggedError("ProviderNotFoundError")<{
  readonly provider: string
  readonly available: ReadonlyArray<string>
}> {}

/**
 * Layer providing the ProviderDiscovery service.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<
  ProviderDiscovery,
  never,
  Glob.Glob | FileSystem.FileSystem | Path.Path
> = Effect.gen(function*() {
  const glob = yield* Glob.Glob
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const parseConfig = Effect.fn("parseConfig")(function*(configPath: string) {
    const packagePath = pathService.dirname(configPath)
    const name = pathService.basename(packagePath)
    const isYaml = configPath.endsWith(".yaml") || configPath.endsWith(".yml")

    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError((cause) =>
        new DiscoveryError({
          message: `Failed to read config at ${configPath}`,
          cause
        })
      )
    )

    const parsed = yield* Effect.try({
      try: () => isYaml ? Yaml.parse(content) : JSON.parse(content),
      catch: (cause) =>
        new DiscoveryError({
          message: `Failed to parse ${isYaml ? "YAML" : "JSON"} at ${configPath}`,
          cause
        })
    })

    const config = yield* Schema.decodeUnknownEffect(CodegenConfig)(parsed).pipe(
      Effect.mapError((cause) =>
        new DiscoveryError({
          message: `Invalid config schema at ${configPath}`,
          cause
        })
      )
    )

    const provider: DiscoveredProvider = {
      name,
      packagePath,
      config,
      specSource: SpecSourceUtils.fromConfig(config.spec, packagePath, pathService),
      outputPath: pathService.join(packagePath, config.output)
    }

    return provider
  })

  const discover = Effect.fn("discover")(function*() {
    const configFiles = yield* glob.glob("packages/ai/*/codegen.{json,yaml,yml}", {
      cwd: process.cwd(),
      absolute: true
    })

    return yield* Effect.forEach(configFiles, parseConfig)
  })

  const discoverOne = Effect.fn("discoverOne")(function*(providerName: string) {
    const providers = yield* discover()
    const found = providers.find((p) => p.name === providerName)

    if (!found) {
      return yield* new ProviderNotFoundError({
        provider: providerName,
        available: providers.map((p) => p.name)
      })
    }

    return found
  })

  return { discover, discoverOne }
}).pipe(Layer.effect(ProviderDiscovery))
