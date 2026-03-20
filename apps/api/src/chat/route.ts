import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"
import { AuthService } from "@/services/AuthService"
import { ChatService } from "./chat-service"

const toHeaderRecord = (
  headers: Record<string, string> | Headers,
): Record<string, string> => {
  const record: Record<string, string> = {}

  const entries = headers instanceof Headers
    ? headers.entries()
    : Object.entries(headers)

  for (const [name, value] of entries) {
    record[name.toLowerCase()] = value
  }

  return record
}

export const ChatRouter = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const authService = yield* AuthService
    const chatService = yield* ChatService

    yield* router.add("POST", "/api/chat", (req) =>
      Effect.gen(function* () {
        const headers = toHeaderRecord(req.headers)
        const tenant = yield* authService.resolveTenant(headers)
        const body = yield* req.json

        const response = yield* chatService.handleRequest({
          body,
          tenant,
          headers,
        }).pipe(
          Effect.catchTags({
            InvalidChatRequestError: (error) =>
              HttpServerResponse.json(
                { error: error.message },
                { status: 400 },
              ),
            ChatConfigurationError: (error) =>
              HttpServerResponse.json(
                { error: error.message },
                { status: 503 },
              ),
          }),
        )

        if (response instanceof Response) {
          return HttpServerResponse.raw(response.body, {
            status: response.status,
            contentType: response.headers.get("content-type") ?? undefined,
            headers: {
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          })
        }

        return response
      }),
    )
  }),
)
