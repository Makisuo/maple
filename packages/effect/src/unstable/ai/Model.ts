/**
 * The `Model` module provides a unified interface for AI service providers.
 *
 * This module enables creation of provider-specific AI models that can be used
 * interchangeably within the Effect AI ecosystem. It combines Layer
 * functionality with provider identification, allowing for seamless switching
 * between different AI service providers while maintaining type safety.
 *
 * @example
 * ```ts
 * import type { Layer } from "effect"
 * import { Effect } from "effect"
 * import { LanguageModel, Model } from "effect/unstable/ai"
 *
 * declare const myAnthropicLayer: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const anthropicModel = Model.make("anthropic", "claude-3-5-haiku", myAnthropicLayer)
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Hello, world!"
 *   })
 *   return response.text
 * }).pipe(
 *   Effect.provide(anthropicModel)
 * )
 * ```
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import { PipeInspectableProto, YieldableProto } from "../../internal/core.ts"
import * as Layer from "../../Layer.ts"
import * as ServiceMap from "../../ServiceMap.ts"

const TypeId = "~effect/ai/Model" as const

/**
 * A Model represents a provider-specific AI service.
 *
 * A Model can be used directly as a Layer to provide a particular model
 * implementation to an Effect program.
 *
 * A Model can also be used as an Effect to "lift" dependencies of the Model
 * constructor into the parent Effect. This is particularly useful when you
 * want to use a Model from within an Effect service.
 *
 * @template Provider - String literal type identifying the AI provider.
 * @template Provides - Services that this model provides.
 * @template Requires - Services that this model requires.
 *
 * @since 4.0.0
 * @category models
 */
export interface Model<in out Provider, in out Provides, in out Requires>
  extends
    Layer.Layer<Provides | ProviderName | ModelName, never, Requires>,
    Effect.Yieldable<
      Model<Provider, Provides, Requires>,
      Layer.Layer<Provides | ProviderName | ModelName>,
      never,
      Requires
    >
{
  readonly [TypeId]: typeof TypeId
  /**
   * The provider identifier (e.g., "openai", "anthropic", "amazon-bedrock").
   */
  readonly provider: Provider
}

/**
 * Service tag that provides the current large language model provider name.
 *
 * This tag is automatically provided by Model instances and can be used to
 * access the name of the provider that is currently in use within a given
 * Effect program.
 *
 * @since 4.0.0
 * @category services
 */
export class ProviderName extends ServiceMap.Service<ProviderName, string>()(
  "effect/unstable/ai/Model/ProviderName"
) {}

/**
 * Service tag that provides the current large language model name.
 *
 * This tag is automatically provided by Model instances and can be used to
 * access the name of the model that is currently in use within a given Effect
 * program.
 *
 * @since 4.0.0
 * @category services
 */
export class ModelName extends ServiceMap.Service<ModelName, string>()(
  "effect/unstable/ai/Model/ModelName"
) {}

const Proto = {
  ...YieldableProto,
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  ["~effect/Layer"]: {
    _ROut: identity,
    _E: identity,
    _RIn: identity
  },
  asEffect(this: Model<any, any, any>) {
    return Effect.servicesWith((services: ServiceMap.ServiceMap<never>) =>
      Effect.succeed(Layer.provide(this, Layer.succeedServices(services)))
    )
  },
  toJSON(this: Model<any, any, any>): unknown {
    return {
      _id: "effect/ai/Model",
      provider: this.provider
    }
  }
}

/**
 * Creates a Model from a provider name and a Layer that constructs AI services.
 *
 * @example
 * ```ts
 * import type { Layer } from "effect"
 * import { Effect } from "effect"
 * import { LanguageModel, Model } from "effect/unstable/ai"
 *
 * declare const bedrockLayer: Layer.Layer<LanguageModel.LanguageModel>
 *
 * // Model automatically provides ProviderName and ModelName services
 * const checkProviderAndGenerate = Effect.gen(function*() {
 *   const provider = yield* Model.ProviderName
 *   const modelName = yield* Model.ModelName
 *
 *   console.log(`Generating with: ${provider}/${modelName}`)
 *
 *   return yield* LanguageModel.generateText({
 *     prompt: `Hello from ${provider}!`
 *   })
 * })
 *
 * const program = checkProviderAndGenerate.pipe(
 *   Effect.provide(Model.make("amazon-bedrock", "claude-3-5-haiku", bedrockLayer))
 * )
 * // Will log: "Generating with: amazon-bedrock/claude-3-5-haiku"
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <const Provider extends string, const Name extends string, Provides, Requires>(
  /**
   * Provider identifier (e.g., "openai", "anthropic", "amazon-bedrock").
   */
  provider: Provider,
  /**
   * Model identifier (e.g., "gpt-5", "claude-3-5-haiku").
   */
  modelName: Name,
  /**
   * Layer that provides the AI services for this provider.
   */
  layer: Layer.Layer<Provides, never, Requires>
): Model<Provider, Provides, Requires> =>
  Object.assign(
    Object.create(Proto),
    { provider },
    Layer.merge(
      layer,
      Layer.succeedServices(
        ProviderName.serviceMap(provider).pipe(
          ServiceMap.add(ModelName, modelName)
        )
      )
    )
  )
