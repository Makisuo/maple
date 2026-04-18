import { Cause, Effect } from "effect"
import { HttpMiddleware, HttpServerResponse } from "effect/unstable/http"

const RESPONDABLE_SYMBOL = "~effect/http/HttpServerRespondable"

const hasRespondable = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (reason._tag !== "Fail" && reason._tag !== "Die") return false
    const value = reason._tag === "Fail" ? reason.error : reason.defect
    return (
      typeof value === "object" &&
      value !== null &&
      RESPONDABLE_SYMBOL in value
    )
  })

const extractMessage = (value: unknown): string | null => {
  if (value == null) return null
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record._tag === "string") return record._tag
  }
  return null
}

const extractTag = (value: unknown): string | null => {
  if (value == null) return null
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record._tag === "string") return record._tag
    if (value instanceof Error) return value.name
  }
  return null
}

const buildBody = (cause: Cause.Cause<unknown>) => {
  const messages: string[] = []
  let tag: string | null = null
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail" || reason._tag === "Die") {
      const value = reason._tag === "Fail" ? reason.error : reason.defect
      const message = extractMessage(value)
      if (message) messages.push(message)
      tag = tag ?? extractTag(value)
    } else if (reason._tag === "Interrupt" && tag == null) {
      tag = "Interrupt"
    }
  }
  return {
    error: tag ?? "InternalError",
    message: messages.join("; ") || "Internal server error",
  }
}

// Replaces Effect's default empty-body 500 responses with a JSON body that
// actually tells the client (and our traces) what failed. For errors that
// implement Respondable (Schema.TaggedErrorClass with httpApiStatus, etc.),
// we defer to Effect's default behavior so the registered status stays.
export const errorResponder = HttpMiddleware.make((httpApp) =>
  Effect.catchCauseIf(
    httpApp,
    (cause) => !hasRespondable(cause),
    (cause) => {
      const body = buildBody(cause)
      return Effect.gen(function* () {
        yield* Effect.logError(`Unhandled HTTP error: ${body.message}`, {
          error: body.error,
          cause: Cause.pretty(cause),
        })
        return yield* HttpServerResponse.json(body, { status: 500 })
      })
    },
  ),
)
