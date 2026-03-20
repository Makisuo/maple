import {
  ChatRequest,
  type NormalizedChatRequest,
  type RawChatMessage,
} from "@maple/domain"
import { Effect, Schema } from "effect"
import { InvalidChatRequestError } from "./errors"

const decodeChatRequestSync = Schema.decodeUnknownSync(ChatRequest)

const normalizeMessage = (message: RawChatMessage) => {
  const fromParts = message.parts?.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [],
  ) ?? []

  const fromContent = fromParts.length === 0 && typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : []

  const parts = [...fromParts, ...fromContent]
    .map((part) => ({ ...part, text: part.text.trim() }))
    .filter((part) => part.text.length > 0)

  if (parts.length === 0) {
    return null
  }

  return {
    role: message.role,
    parts,
  }
}

export const decodeChatRequest = (
  body: unknown,
): Effect.Effect<NormalizedChatRequest, InvalidChatRequestError> =>
  Effect.try({
    try: () => {
      const decoded = decodeChatRequestSync(body)
      const messages = decoded.messages
        .map(normalizeMessage)
        .filter((message): message is NonNullable<typeof message> => message !== null)

      return {
        messages,
        mode: decoded.mode ?? "default",
        dashboardContext: decoded.dashboardContext,
      } satisfies NormalizedChatRequest
    },
    catch: (error) =>
      new InvalidChatRequestError({
        message: Schema.isSchemaError(error) ? error.message : String(error),
      }),
  })
