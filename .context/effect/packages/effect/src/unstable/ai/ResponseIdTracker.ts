/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Prompt from "./Prompt.ts"

/**
 * @since 4.0.0
 * @category models
 */
export interface PrepareResult {
  readonly previousResponseId: string
  readonly prompt: Prompt.Prompt
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Service {
  clearUnsafe(): void
  markParts(parts: ReadonlyArray<object>, responseId: string): void
  prepareUnsafe(prompt: Prompt.Prompt): Option.Option<PrepareResult>
}

/**
 * @since 4.0.0
 * @category Services
 */
export class ResponseIdTracker
  extends ServiceMap.Service<ResponseIdTracker, Service>()("effect/ai/ResponseIdTracker")
{}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make: Effect.Effect<Service> = Effect.sync(() => {
  const sentParts = new Map<object, string>()

  const none = () => {
    sentParts.clear()
    return Option.none<PrepareResult>()
  }

  return {
    clearUnsafe() {
      sentParts.clear()
    },
    markParts(parts, responseId) {
      for (let i = 0; i < parts.length; i++) {
        sentParts.set(parts[i], responseId)
      }
    },
    prepareUnsafe(prompt) {
      const messages = prompt.content

      let anyTracked = false
      for (let i = 0; i < messages.length; i++) {
        if (sentParts.has(messages[i])) {
          anyTracked = true
          break
        }
      }
      if (!anyTracked) return none()

      let lastAssistantIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          lastAssistantIndex = i
          break
        }
      }
      if (lastAssistantIndex === -1) return none()

      let responseId: string | undefined
      for (let i = 0; i < lastAssistantIndex; i++) {
        const id = sentParts.get(messages[i])
        if (id === undefined) return none()
        responseId = id
      }
      if (responseId === undefined) return none()

      const partsAfterLastAssistant = messages.slice(lastAssistantIndex + 1)
      if (partsAfterLastAssistant.length === 0) {
        return none()
      }

      return Option.some({
        previousResponseId: responseId,
        prompt: Prompt.fromMessages(partsAfterLastAssistant)
      })
    }
  }
})
