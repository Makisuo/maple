import { ServiceMap, Effect, Layer, Option, Redacted } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Env } from "@/services/Env"
import { ChatConfigurationError } from "./errors"
import { makeOpenRouterModel } from "./openrouter"

const DEFAULT_CHAT_MODEL = "moonshotai/kimi-k2.5:nitro"

export class ChatModelService extends ServiceMap.Service<ChatModelService>()("ChatModelService", {
  make: Effect.gen(function* () {
    const env = yield* Env

    const openrouterKey = Option.match(env.OPENROUTER_API_KEY, {
      onNone: () => undefined,
      onSome: (value) => Redacted.value(value),
    })

    const getDefaultModel = Effect.fn("ChatModelService.getDefaultModel")(function* () {
      if (!openrouterKey) {
        return yield* Effect.fail(
          new ChatConfigurationError({
            message: "OPENROUTER_API_KEY is not configured",
          }),
        )
      }

      return yield* makeOpenRouterModel(DEFAULT_CHAT_MODEL).pipe(
        Effect.mapError((error) =>
          new ChatConfigurationError({
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
    })

    return {
      getDefaultModel,
    } satisfies {
      readonly getDefaultModel: () => Effect.Effect<LanguageModel.Service, ChatConfigurationError>
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Env.layer),
  )
}
