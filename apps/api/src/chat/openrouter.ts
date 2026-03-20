import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { FetchHttpClient } from "effect/unstable/http"
import { Config, Effect, Layer } from "effect"

const OpenRouterClientLayer = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer))

/** For dynamic model selection at request time */
export const makeOpenRouterModel = (model: string) =>
  OpenRouterLanguageModel.make({ model }).pipe(Effect.provide(OpenRouterClientLayer))
