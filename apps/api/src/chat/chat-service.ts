import { LanguageModel, type Response, type Toolkit } from "effect/unstable/ai"
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

      const toolkit = yield* chatToolkitService.buildForMode(decodedRequest.mode).pipe(
        Effect.provide(requestContextLayer),
      )
      const model = yield* chatModelService.getDefaultModel()

      const stream = streamAgentLoop({
        prompt: buildPrompt(decodedRequest),
        toolkit,
      }).pipe(
        Stream.provideService(LanguageModel.LanguageModel, model),
      ) as Stream.Stream<Response.AnyPart, unknown, never>

      return effectStreamToResponse(stream)
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
