import { LanguageModel, type Response } from "effect/unstable/ai"
import { Effect, Layer, ServiceMap, Stream } from "effect"
import type { TenantContext } from "@/services/AuthService"
import { ApiKeysService } from "@/services/ApiKeysService"
import { AuthService } from "@/services/AuthService"
import { Env } from "@/services/Env"
import { QueryEngineService } from "@/services/QueryEngineService"
import { TinybirdService } from "@/services/TinybirdService"
import { streamAgentLoop } from "./agent-loop"
import { ChatModelService } from "./model-service"
import { buildPrompt } from "./prompt"
import { decodeChatRequest } from "./request"
import { ChatRequestContextLive } from "./request-context"
import { effectStreamToResponse } from "./stream-bridge"
import { ChatToolkitService } from "./tools"
import {
  ChatConfigurationError,
  InvalidChatRequestError,
} from "./errors"

export interface ChatServiceRequest {
  readonly body: unknown
  readonly tenant: TenantContext
  readonly headers: Record<string, string>
}

export class ChatService extends ServiceMap.Service<ChatService>()("ChatService", {
  make: Effect.gen(function* () {
    const chatModelService = yield* ChatModelService
    const chatToolkitService = yield* ChatToolkitService

    const handleRequest = Effect.fn("ChatService.handleRequest")(function* (
      request: ChatServiceRequest,
    ) {
      const decodedRequest = yield* decodeChatRequest(request.body)
      const requestContextLayer = ChatRequestContextLive({
        tenant: request.tenant,
        headers: request.headers,
      })

      const model = yield* chatModelService.getDefaultModel()
      const prompt = buildPrompt(decodedRequest)

      if (decodedRequest.mode === "dashboard_builder") {
        const toolkit = yield* chatToolkitService.buildForMode("dashboard_builder").pipe(
          Effect.provide(requestContextLayer),
        )
        return effectStreamToResponse(
          streamAgentLoop({
            prompt,
            toolkit,
          }).pipe(
            Stream.provideService(LanguageModel.LanguageModel, model),
          ),
        )
      }

      const toolkit = yield* chatToolkitService.buildForMode("default").pipe(
        Effect.provide(requestContextLayer),
      )
      return effectStreamToResponse(
        streamAgentLoop({
          prompt,
          toolkit,
        }).pipe(
          Stream.provideService(LanguageModel.LanguageModel, model),
        ),
      )
    })

    return {
      handleRequest,
    } satisfies {
      readonly handleRequest: (
        request: ChatServiceRequest,
      ) => Effect.Effect<
        Response,
        InvalidChatRequestError | ChatConfigurationError,
        Env | ApiKeysService | AuthService | TinybirdService | QueryEngineService
      >
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(ChatModelService.layer),
    Layer.provide(ChatToolkitService.layer),
  )
}
