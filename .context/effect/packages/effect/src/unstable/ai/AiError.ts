/**
 * The `AiError` module provides comprehensive, provider-agnostic error handling
 * for AI operations.
 *
 * This module uses the `reason` pattern where `AiError` is a top-level
 * wrapper error containing `module`, `method`, and a `reason` field that holds
 * the semantic error. This design enables ergonomic error handling while
 * preserving rich context about failures.
 *
 * ## Semantic Error Categories
 *
 * - **RateLimitError** - Request throttled (429s, provider-specific limits)
 * - **QuotaExhaustedError** - Account/billing limits reached
 * - **AuthenticationError** - Invalid/expired credentials
 * - **ContentPolicyError** - Input/output violated content policy
 * - **InvalidRequestError** - Malformed request parameters
 * - **InvalidUserInputError** - Prompt contains unsupported content
 * - **InternalProviderError** - Provider-side failures (5xx)
 * - **NetworkError** - Transport-level failures
 * - **InvalidOutputError** - LLM output parsing/validation failures
 * - **StructuredOutputError** - LLM generated text that doesn't conform to structured output schema
 * - **UnsupportedSchemaError** - Codec transformer rejected a schema with unsupported constructs
 * - **UnknownError** - Catch-all for unknown errors
 *
 * ## Tool Call Errors
 *
 * - **ToolNotFoundError** - Model requested non-existent tool
 * - **ToolParameterValidationError** - Tool call params failed validation
 * - **InvalidToolResultError** - Tool handler returned invalid result
 * - **ToolResultEncodingError** - Tool result encoding failed
 * - **ToolConfigurationError** - Provider tool misconfigured
 *
 * ## Retryability
 *
 * Each reason type has an `isRetryable` getter indicating whether the error is
 * transient. Some errors also provide a `retryAfter` duration hint.
 *
 * @example
 * ```ts
 * import { Effect, Match } from "effect"
 * import type { AiError } from "effect/unstable/ai"
 *
 * // Handle errors using Match on the reason
 * const handleAiError = Match.type<AiError.AiError>().pipe(
 *   Match.when(
 *     { reason: { _tag: "RateLimitError" } },
 *     (err) => Effect.logWarning(`Rate limited, retry after ${err.retryAfter}`)
 *   ),
 *   Match.when(
 *     { reason: { _tag: "AuthenticationError" } },
 *     (err) => Effect.logError(`Auth failed: ${err.reason.kind}`)
 *   ),
 *   Match.when(
 *     { reason: { isRetryable: true } },
 *     (err) => Effect.logWarning(`Transient error, retrying: ${err.message}`)
 *   ),
 *   Match.orElse((err) => Effect.logError(`Permanent error: ${err.message}`))
 * )
 * ```
 *
 * @example
 * ```ts
 * import { Duration, Effect } from "effect"
 * import { AiError } from "effect/unstable/ai"
 *
 * // Create an AiError with a reason
 * const error = AiError.make({
 *   module: "OpenAI",
 *   method: "completion",
 *   reason: new AiError.RateLimitError({
 *     retryAfter: Duration.seconds(60)
 *   })
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message) // "OpenAI.completion: Rate limit exceeded. Retry after 1 minute"
 * ```
 *
 * @since 1.0.0
 */
import * as Duration from "../../Duration.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import { redact } from "../../Redactable.ts"
import * as Redacted from "../../Redacted.ts"
import * as Schema from "../../Schema.ts"
import type * as HttpClientError from "../http/HttpClientError.ts"
import { HttpRequestDetails, HttpResponseDetails } from "./Response.ts"

const ReasonTypeId = "~effect/unstable/ai/AiError/Reason" as const

const providerMetadataWithDefaults = <Metadata extends ProviderMetadata>() =>
  (ProviderMetadata as unknown as typeof ProviderMetadata & Schema.Schema<Metadata>).pipe(
    Schema.withConstructorDefault(() => Option.some({} as Metadata)),
    Schema.withDecodingDefault(() => ({} as Metadata))
  )

const redactHeaders = (headers: Record<string, string>): Record<string, string> => {
  const redacted = redact(headers) as Record<string, string | Redacted.Redacted>
  const result: Record<string, string> = {}
  for (const key in redacted) {
    const value = redacted[key]
    result[key] = Redacted.isRedacted(value) ? value.toString() : value
  }
  return result
}

// =============================================================================
// Http Request Error
// =============================================================================

/**
 * Error indicating a network-level failure before receiving a response.
 *
 * This error is raised when issues arise before receiving an HTTP response,
 * such as network connectivity problems, request encoding issues, or invalid
 * URLs.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.NetworkError({
 *   reason: "TransportError",
 *   request: {
 *     method: "POST",
 *     url: "https://api.openai.com/v1/completions",
 *     urlParams: [],
 *     hash: undefined,
 *     headers: { "Content-Type": "application/json" }
 *   },
 *   description: "Connection timeout after 30 seconds"
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message)
 * // "Transport: Connection timeout after 30 seconds (POST https://api.openai.com/v1/completions)"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class NetworkError extends Schema.ErrorClass<NetworkError>(
  "effect/ai/AiError/NetworkError"
)({
  _tag: Schema.tag("NetworkError"),
  reason: Schema.Literals(["TransportError", "EncodeError", "InvalidUrlError"]),
  request: HttpRequestDetails,
  description: Schema.optional(Schema.String)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Transport errors are retryable; encoding and URL errors are not.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return this.reason === "TransportError"
  }

  /**
   * Creates a NetworkError from a platform HttpClientError.RequestError.
   *
   * @example
   * ```ts
   * import { AiError } from "effect/unstable/ai"
   * import type { HttpClientError } from "effect/unstable/http"
   *
   * declare const platformError: HttpClientError.RequestError
   *
   * const aiError = AiError.NetworkError.fromRequestError(platformError)
   * ```
   *
   * @since 1.0.0
   * @category constructors
   */
  static fromRequestError(error: HttpClientError.RequestError): NetworkError {
    return new NetworkError({
      description: error.description,
      reason: error._tag,
      request: {
        hash: Option.getOrUndefined(error.request.hash),
        headers: redactHeaders(error.request.headers),
        method: error.request.method,
        url: error.request.url,
        urlParams: Array.from(error.request.urlParams)
      }
    })
  }

  override get message(): string {
    const methodAndUrl = `${this.request.method} ${this.request.url}`

    let baseMessage = this.description
      ? `${this.reason}: ${this.description}`
      : `${this.reason}: A network error occurred.`

    baseMessage += ` (${methodAndUrl})`

    let suggestion = ""
    switch (this.reason) {
      case "EncodeError": {
        suggestion += "Check that the request body data is properly formatted and matches the expected content type."
        break
      }

      case "InvalidUrlError": {
        suggestion += "Verify that the URL format is correct and that all required parameters have been provided."
        suggestion += " Check for any special characters that may need encoding."
        break
      }

      case "TransportError": {
        suggestion += "Check your network connection and verify that the requested URL is accessible."
        break
      }
    }

    baseMessage += `\n\n${suggestion}`

    return baseMessage
  }
}

// =============================================================================
// Http Response Error
// =============================================================================

// =============================================================================
// Supporting Schemas
// =============================================================================

/**
 * Schema for provider-specific metadata which can be attached to error reasons.
 *
 * Provider-specific metadata is namespaced by provider and has the structure:
 *
 * ```
 * {
 *   "<provider-name>": {
 *     // Provider-specific metadata (e.g. errorCode, requestId, etc.)
 *   }
 * }
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export const ProviderMetadata: Schema.$Record<
  Schema.String,
  Schema.NullOr<Schema.Codec<Schema.MutableJson>>
> = Schema.Record(Schema.String, Schema.NullOr(Schema.MutableJson))

/**
 * @since 1.0.0
 * @category models
 */
export type ProviderMetadata = typeof ProviderMetadata.Type

/**
 * Provider-specific metadata attached to `RateLimitError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface RateLimitErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `QuotaExhaustedError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface QuotaExhaustedErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `AuthenticationError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface AuthenticationErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `ContentPolicyError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ContentPolicyErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `InvalidRequestError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface InvalidRequestErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `InternalProviderError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface InternalProviderErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `InvalidOutputError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface InvalidOutputErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `StructuredOutputError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface StructuredOutputErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `UnsupportedSchemaError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface UnsupportedSchemaErrorMetadata extends ProviderMetadata {}

/**
 * Provider-specific metadata attached to `UnknownError`.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface UnknownErrorMetadata extends ProviderMetadata {}

/**
 * Token usage information from AI operations.
 *
 * @since 1.0.0
 * @category schemas
 */
export const UsageInfo = Schema.Struct({
  promptTokens: Schema.optional(Schema.Number),
  completionTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number)
}).annotate({ identifier: "UsageInfo" })

/**
 * Combined HTTP context for error reporting.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HttpContext = Schema.Struct({
  request: HttpRequestDetails,
  response: Schema.optional(HttpResponseDetails),
  body: Schema.optional(Schema.String)
}).annotate({ identifier: "HttpContext" })

// =============================================================================
// Reason Classes
// =============================================================================

/**
 * Error indicating the request was rate limited.
 *
 * Rate limit errors are always retryable. When `retryAfter` is provided,
 * callers should wait that duration before retrying.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 * import { AiError } from "effect/unstable/ai"
 *
 * const rateLimitError = new AiError.RateLimitError({
 *   retryAfter: Duration.seconds(60)
 * })
 *
 * console.log(rateLimitError.isRetryable) // true
 * console.log(rateLimitError.message) // "Rate limit exceeded. Retry after 1 minute"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class RateLimitError extends Schema.ErrorClass<RateLimitError>(
  "effect/ai/AiError/RateLimitError"
)({
  _tag: Schema.tag("RateLimitError"),
  retryAfter: Schema.optional(Schema.Duration),
  metadata: providerMetadataWithDefaults<RateLimitErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Rate limit errors are always retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    let msg = "Rate limit exceeded"
    if (this.retryAfter) msg += `. Retry after ${Duration.format(this.retryAfter)}`
    return msg
  }
}

/**
 * Error indicating account or billing limits have been reached.
 *
 * Quota exhausted errors are not retryable without user action.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const quotaError = new AiError.QuotaExhaustedError({})
 *
 * console.log(quotaError.isRetryable) // false
 * console.log(quotaError.message)
 * // "Quota exhausted. Check your account billing and usage limits."
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class QuotaExhaustedError extends Schema.ErrorClass<QuotaExhaustedError>(
  "effect/ai/AiError/QuotaExhaustedError"
)({
  _tag: Schema.tag("QuotaExhaustedError"),
  resetAt: Schema.optional(Schema.DateTimeUtc),
  metadata: providerMetadataWithDefaults<QuotaExhaustedErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Quota exhausted errors require user action and are not retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    let msg = "Quota exhausted"
    if (this.resetAt) msg += `. Resets at ${this.resetAt}`
    return `${msg}. Check your account billing and usage limits.`
  }
}

/**
 * Error indicating authentication or authorization failure.
 *
 * Authentication errors are never retryable without credential changes.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const authError = new AiError.AuthenticationError({
 *   kind: "InvalidKey"
 * })
 *
 * console.log(authError.isRetryable) // false
 * console.log(authError.message)
 * // "InvalidKey: Verify your API key is correct"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class AuthenticationError extends Schema.ErrorClass<AuthenticationError>(
  "effect/ai/AiError/AuthenticationError"
)({
  _tag: Schema.tag("AuthenticationError"),
  kind: Schema.Literals(["InvalidKey", "ExpiredKey", "MissingKey", "InsufficientPermissions", "Unknown"]),
  metadata: providerMetadataWithDefaults<AuthenticationErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Authentication errors require credential changes and are not retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    const suggestions: Record<string, string> = {
      InvalidKey: "Verify your API key is correct",
      ExpiredKey: "Your API key has expired. Generate a new one",
      MissingKey: "No API key provided. Set the appropriate environment variable",
      InsufficientPermissions: "Your API key lacks required permissions",
      Unknown: "Authentication failed. Check your credentials"
    }
    return `${this.kind}: ${suggestions[this.kind]}`
  }
}

/**
 * Error indicating content policy violation.
 *
 * Content policy errors are never retryable without content changes.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const policyError = new AiError.ContentPolicyError({
 *   description: "Input contains prohibited content"
 * })
 *
 * console.log(policyError.isRetryable) // false
 * console.log(policyError.message)
 * // "Content policy violation: Input contains prohibited content"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ContentPolicyError extends Schema.ErrorClass<ContentPolicyError>(
  "effect/ai/AiError/ContentPolicyError"
)({
  _tag: Schema.tag("ContentPolicyError"),
  description: Schema.String,
  metadata: providerMetadataWithDefaults<ContentPolicyErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Content policy errors require content changes and are not retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Content policy violation: ${this.description}`
  }
}

/**
 * Error indicating the request had invalid or malformed parameters.
 *
 * Invalid request errors require fixing the request and are not retryable.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const invalidRequestError = new AiError.InvalidRequestError({
 *   parameter: "temperature",
 *   constraint: "must be between 0 and 2",
 *   description: "Temperature value 5 is out of range"
 * })
 *
 * console.log(invalidRequestError.isRetryable) // false
 * console.log(invalidRequestError.message)
 * // "Invalid request: parameter 'temperature' must be between 0 and 2. Temperature value 5 is out of range"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class InvalidRequestError extends Schema.ErrorClass<InvalidRequestError>(
  "effect/ai/AiError/InvalidRequestError"
)({
  _tag: Schema.tag("InvalidRequestError"),
  parameter: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  metadata: providerMetadataWithDefaults<InvalidRequestErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Invalid request errors require fixing the request and are not retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    let msg = "Invalid request"
    if (this.parameter) msg += `: parameter '${this.parameter}'`
    if (this.constraint) msg += ` ${this.constraint}`
    if (this.description) msg += `. ${this.description}`
    return msg
  }
}

/**
 * Error indicating the AI provider experienced an internal error.
 *
 * Internal provider errors are typically transient and are retryable.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const providerError = new AiError.InternalProviderError({
 *   description: "Server encountered an unexpected error"
 * })
 *
 * console.log(providerError.isRetryable) // true
 * console.log(providerError.message)
 * // "Internal provider error: Server encountered an unexpected error"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class InternalProviderError extends Schema.ErrorClass<InternalProviderError>(
  "effect/ai/AiError/InternalProviderError"
)({
  _tag: Schema.tag("InternalProviderError"),
  description: Schema.String,
  metadata: providerMetadataWithDefaults<InternalProviderErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Internal provider errors are typically transient and are retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return `Internal provider error: ${this.description}`
  }
}

/**
 * Error indicating failure to parse or validate LLM output.
 *
 * Invalid output errors are retryable since LLM outputs are non-deterministic.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const parseError = new AiError.InvalidOutputError({
 *   description: "Expected a string but received a number"
 * })
 *
 * console.log(parseError.isRetryable) // true
 * console.log(parseError.message)
 * // "Invalid output: Expected a string but received a number"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class InvalidOutputError extends Schema.ErrorClass<InvalidOutputError>(
  "effect/ai/AiError/InvalidOutputError"
)({
  _tag: Schema.tag("InvalidOutputError"),
  description: Schema.String,
  metadata: providerMetadataWithDefaults<InvalidOutputErrorMetadata>(),
  usage: Schema.optional(UsageInfo)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Invalid output errors are retryable since LLM outputs are non-deterministic.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  /**
   * Creates an InvalidOutputError from a Schema error.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { AiError } from "effect/unstable/ai"
   *
   * declare const schemaError: Schema.SchemaError
   *
   * const parseError = AiError.InvalidOutputError.fromSchemaError(schemaError)
   * ```
   *
   * @since 1.0.0
   * @category constructors
   */
  static fromSchemaError(error: Schema.SchemaError): InvalidOutputError {
    return new InvalidOutputError({
      description: error.message
    })
  }

  override get message(): string {
    return `Invalid output: ${this.description}`
  }
}

/**
 * Error indicating the LLM generated text that does not conform to the
 * requested structured output schema.
 *
 * Structured output errors are retryable since LLM outputs are non-deterministic.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.StructuredOutputError({
 *   description: "Expected a valid JSON object",
 *   responseText: "{\"foo\":}"
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message)
 * // "Structured output validation failed: Expected a valid JSON object"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class StructuredOutputError extends Schema.ErrorClass<StructuredOutputError>(
  "effect/ai/AiError/StructuredOutputError"
)({
  _tag: Schema.tag("StructuredOutputError"),
  description: Schema.String,
  responseText: Schema.String,
  metadata: providerMetadataWithDefaults<StructuredOutputErrorMetadata>(),
  usage: Schema.optional(UsageInfo)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Structured output errors are retryable since LLM outputs are non-deterministic.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  /**
   * Creates a StructuredOutputError from a Schema error.
   *
   * @example
   * ```ts
   * import { Schema } from "effect"
   * import { AiError } from "effect/unstable/ai"
   *
   * declare const schemaError: Schema.SchemaError
   * declare const rawText: string
   *
   * const parseError = AiError.StructuredOutputError.fromSchemaError(schemaError, rawText)
   * ```
   *
   * @since 1.0.0
   * @category constructors
   */
  static fromSchemaError(error: Schema.SchemaError, responseText: string): StructuredOutputError {
    return new StructuredOutputError({
      description: error.message,
      responseText
    })
  }

  override get message(): string {
    return `Structured output validation failed: ${this.description}`
  }
}

/**
 * Error indicating a codec transformer rejected a schema because it contains
 * unsupported constructs.
 *
 * Unsupported schema errors are not retryable because they indicate a
 * programmer error where the schema is incompatible with the provider.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.UnsupportedSchemaError({
 *   description: "Unions are not supported in Anthropic structured output"
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Unsupported schema: Unions are not supported in Anthropic structured output"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class UnsupportedSchemaError extends Schema.ErrorClass<UnsupportedSchemaError>(
  "effect/ai/AiError/UnsupportedSchemaError"
)({
  _tag: Schema.tag("UnsupportedSchemaError"),
  description: Schema.String,
  metadata: providerMetadataWithDefaults<UnsupportedSchemaErrorMetadata>()
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Unsupported schema errors are not retryable because they indicate a programmer error.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Unsupported schema: ${this.description}`
  }
}

/**
 * Catch-all error for unknown or unexpected errors.
 *
 * Unknown errors are not retryable by default since the cause is unknown.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const unknownError = new AiError.UnknownError({
 *   description: "An unexpected error occurred"
 * })
 *
 * console.log(unknownError.isRetryable) // false
 * console.log(unknownError.message)
 * // "An unexpected error occurred"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class UnknownError extends Schema.ErrorClass<UnknownError>(
  "effect/ai/AiError/UnknownError"
)({
  _tag: Schema.tag("UnknownError"),
  description: Schema.optional(Schema.String),
  metadata: providerMetadataWithDefaults<UnknownErrorMetadata>(),
  http: Schema.optional(HttpContext)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Unknown errors are not retryable by default.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return this.description ?? "Unknown error"
  }
}

// =============================================================================
// Tool Call Error Types
// =============================================================================

/**
 * Error indicating the model requested a tool that doesn't exist in the toolkit.
 *
 * This error is retryable because the model may self-correct when provided
 * with the list of available tools.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.ToolNotFoundError({
 *   toolName: "unknownTool",
 *   availableTools: ["GetWeather", "GetTime"]
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message)
 * // "Tool 'unknownTool' not found. Available tools: GetWeather, GetTime"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolNotFoundError extends Schema.ErrorClass<ToolNotFoundError>(
  "effect/ai/AiError/ToolNotFoundError"
)({
  _tag: Schema.tag("ToolNotFoundError"),
  toolName: Schema.String,
  availableTools: Schema.Array(Schema.String)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Tool not found errors are retryable because the model may self-correct.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    const availableTools = this.availableTools.length > 0 ? this.availableTools.join(", ") : "none"
    return `Tool '${this.toolName}' not found. Available tools: ${availableTools}`
  }
}

/**
 * Error indicating the model's tool call parameters failed schema validation.
 *
 * This error is retryable because the model may correct its parameters
 * on subsequent attempts.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.ToolParameterValidationError({
 *   toolName: "GetWeather",
 *   toolParams: { location: 123 },
 *   description: "Expected string, got number"
 * })
 *
 * console.log(error.isRetryable) // true
 * console.log(error.message)
 * // "Invalid parameters for tool 'GetWeather': Expected string, got number"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolParameterValidationError extends Schema.ErrorClass<ToolParameterValidationError>(
  "effect/ai/AiError/ToolParameterValidationError"
)({
  _tag: Schema.tag("ToolParameterValidationError"),
  toolName: Schema.String,
  toolParams: Schema.Json,
  description: Schema.String
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Parameter validation errors are retryable because the model may correct parameters.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return true
  }

  override get message(): string {
    return `Invalid parameters for tool '${this.toolName}': ${this.description}`
  }
}

/**
 * Error indicating the tool handler returned an invalid result that does not
 * match the tool's schema.
 *
 * This error is not retryable because invalid results indicate a bug in the
 * tool handler implementation.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.InvalidToolResultError({
 *   toolName: "GetWeather",
 *   description: "Tool handler returned invalid result: missing 'temperature' field"
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Tool 'GetWeather' returned invalid result: missing 'temperature' field"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class InvalidToolResultError extends Schema.ErrorClass<InvalidToolResultError>(
  "effect/ai/AiError/InvalidToolResultError"
)({
  _tag: Schema.tag("InvalidToolResultError"),
  toolName: Schema.String,
  description: Schema.String
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Invalid tool result errors are not retryable because they indicate a bug in the handler.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Tool '${this.toolName}' returned invalid result: ${this.description}`
  }
}

/**
 * Error indicating the tool result cannot be encoded for sending back to the model.
 *
 * This error is not retryable because encoding failures indicate a bug in the
 * tool schema definitions.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.ToolResultEncodingError({
 *   toolName: "GetWeather",
 *   toolResult: { circular: "ref" },
 *   description: "Cannot encode circular reference"
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Failed to encode result for tool 'GetWeather': Cannot encode circular reference"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolResultEncodingError extends Schema.ErrorClass<ToolResultEncodingError>(
  "effect/ai/AiError/ToolResultEncodingError"
)({
  _tag: Schema.tag("ToolResultEncodingError"),
  toolName: Schema.String,
  toolResult: Schema.Unknown,
  description: Schema.String
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Encoding errors are not retryable because they indicate a code bug.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Failed to encode result for tool '${this.toolName}': ${this.description}`
  }
}

/**
 * Error indicating a provider-defined tool was configured with invalid arguments.
 *
 * This error is not retryable because it indicates a programming error in the
 * tool configuration that must be fixed in code.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.ToolConfigurationError({
 *   toolName: "OpenAiCodeInterpreter",
 *   description: "Invalid container ID format"
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Invalid configuration for tool 'OpenAiCodeInterpreter': Invalid container ID format"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolConfigurationError extends Schema.ErrorClass<ToolConfigurationError>(
  "effect/ai/AiError/ToolConfigurationError"
)({
  _tag: Schema.tag("ToolConfigurationError"),
  toolName: Schema.String,
  description: Schema.String
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Configuration errors are not retryable because they indicate a code bug.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Invalid configuration for tool '${this.toolName}': ${this.description}`
  }
}

/**
 * Error indicating an operation requires a toolkit but none was provided.
 *
 * This error occurs when tool approval responses are present in the prompt
 * but no toolkit was provided to resolve them.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.ToolkitRequiredError({
 *   pendingApprovals: ["GetWeather", "SendEmail"]
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Toolkit required to resolve pending tool approvals: GetWeather, SendEmail"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolkitRequiredError extends Schema.ErrorClass<ToolkitRequiredError>(
  "effect/ai/AiError/ToolkitRequiredError"
)({
  _tag: Schema.tag("ToolkitRequiredError"),
  pendingApprovals: Schema.Array(Schema.String),
  description: Schema.optional(Schema.String)
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Toolkit required errors are not retryable without providing a toolkit.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    const tools = this.pendingApprovals.join(", ")
    return `Toolkit required to resolve pending tool approvals: ${tools}`
  }
}

/**
 * Error indicating the user provided invalid input in their prompt.
 *
 * This error is raised when the prompt contains content that is structurally
 * valid but not supported by the provider (e.g., unsupported media types,
 * unsupported file formats, etc.).
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = new AiError.InvalidUserInputError({
 *   description: "Unsupported media type 'video/mp4'. Supported types: image/*, application/pdf, text/plain"
 * })
 *
 * console.log(error.isRetryable) // false
 * console.log(error.message)
 * // "Invalid user input: Unsupported media type 'video/mp4'. Supported types: image/*, application/pdf, text/plain"
 * ```
 *
 * @since 1.0.0
 * @category reason
 */
export class InvalidUserInputError extends Schema.ErrorClass<InvalidUserInputError>(
  "effect/ai/AiError/InvalidUserInputError"
)({
  _tag: Schema.tag("InvalidUserInputError"),
  description: Schema.String
}) {
  /**
   * @since 1.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Invalid user input errors require fixing the input and are not retryable.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    return `Invalid user input: ${this.description}`
  }
}

// =============================================================================
// AiErrorReason Union
// =============================================================================

/**
 * Union type of all semantic error reasons that can occur during AI operations.
 *
 * Each reason type provides:
 * - Semantic categorization of the failure mode
 * - `isRetryable` getter indicating if the error is transient
 * - Optional `retryAfter` duration for rate limit/throttling errors
 * - Rich context including provider metadata and HTTP details
 *
 * @since 1.0.0
 * @category models
 */
export type AiErrorReason =
  | RateLimitError
  | QuotaExhaustedError
  | AuthenticationError
  | ContentPolicyError
  | InvalidRequestError
  | InternalProviderError
  | NetworkError
  | InvalidOutputError
  | StructuredOutputError
  | UnsupportedSchemaError
  | UnknownError
  | ToolNotFoundError
  | ToolParameterValidationError
  | InvalidToolResultError
  | ToolResultEncodingError
  | ToolConfigurationError
  | ToolkitRequiredError
  | InvalidUserInputError

/**
 * Schema for validating and parsing AI error reasons.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AiErrorReason: Schema.Union<[
  typeof RateLimitError,
  typeof QuotaExhaustedError,
  typeof AuthenticationError,
  typeof ContentPolicyError,
  typeof InvalidRequestError,
  typeof InternalProviderError,
  typeof NetworkError,
  typeof InvalidOutputError,
  typeof StructuredOutputError,
  typeof UnsupportedSchemaError,
  typeof UnknownError,
  typeof ToolNotFoundError,
  typeof ToolParameterValidationError,
  typeof InvalidToolResultError,
  typeof ToolResultEncodingError,
  typeof ToolConfigurationError,
  typeof ToolkitRequiredError,
  typeof InvalidUserInputError
]> = Schema.Union([
  RateLimitError,
  QuotaExhaustedError,
  AuthenticationError,
  ContentPolicyError,
  InvalidRequestError,
  InternalProviderError,
  NetworkError,
  InvalidOutputError,
  StructuredOutputError,
  UnsupportedSchemaError,
  UnknownError,
  ToolNotFoundError,
  ToolParameterValidationError,
  InvalidToolResultError,
  ToolResultEncodingError,
  ToolConfigurationError,
  ToolkitRequiredError,
  InvalidUserInputError
])

// =============================================================================
// Top-Level AiError
// =============================================================================

const TypeId = "~effect/unstable/ai/AiError/AiError" as const

/**
 * Top-level AI error wrapper using the `reason` pattern.
 *
 * This error wraps semantic error reasons and provides:
 * - `module` and `method` context for where the error occurred
 * - `reason` field containing the semantic error type
 * - Delegated `isRetryable` and `retryAfter` to the underlying reason
 *
 * Use with `Effect.catchReason` for ergonomic error handling:
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { AiError } from "effect/unstable/ai"
 *
 * declare const aiOperation: Effect.Effect<string, AiError.AiError>
 *
 * // Handle specific reason types
 * const handled = aiOperation.pipe(
 *   Effect.catchTag("AiError", (error) => {
 *     if (error.reason._tag === "RateLimitError") {
 *       return Effect.succeed(`Retry after ${error.retryAfter}`)
 *     }
 *     return Effect.fail(error)
 *   })
 * )
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export class AiError extends Schema.ErrorClass<AiError>(
  "effect/ai/AiError/AiError"
)({
  _tag: Schema.tag("AiError"),
  module: Schema.String,
  method: Schema.String,
  reason: AiErrorReason
}) {
  readonly [TypeId] = TypeId
  override readonly cause = this.reason

  /**
   * Delegates to the underlying reason's `isRetryable` getter.
   *
   * @since 1.0.0
   */
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }

  /**
   * Delegates to the underlying reason's `retryAfter` if present.
   *
   * @since 1.0.0
   */
  get retryAfter(): Duration.Duration | undefined {
    return "retryAfter" in this.reason ? this.reason.retryAfter : undefined
  }

  override get message(): string {
    return `${this.module}.${this.method}: ${this.reason.message}`
  }
}

/**
 * The encoded (serialized) form of an `AiError`.
 *
 * @since 1.0.0
 * @category schemas
 */
export type AiErrorEncoded = typeof AiError["Encoded"]

/**
 * Type guard to check if a value is an `AiError`.
 *
 * @param u - The value to check
 * @returns `true` if the value is an `AiError`, `false` otherwise
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const someError = new Error("generic error")
 * const aiError = AiError.make({
 *   module: "Test",
 *   method: "example",
 *   reason: new AiError.RateLimitError({})
 * })
 *
 * console.log(AiError.isAiError(someError)) // false
 * console.log(AiError.isAiError(aiError)) // true
 * ```
 *
 * @since 1.0.0
 * @category guards
 */
export const isAiError = (u: unknown): u is AiError => Predicate.hasProperty(u, TypeId)

/**
 * Type guard to check if a value is an `AiErrorReason`.
 *
 * @param u - The value to check
 * @returns `true` if the value is an `AiErrorReason`, `false` otherwise
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const rateLimitError = new AiError.RateLimitError({})
 * const genericError = new Error("generic error")
 *
 * console.log(AiError.isAiErrorReason(rateLimitError)) // true
 * console.log(AiError.isAiErrorReason(genericError)) // false
 * ```
 *
 * @since 1.0.0
 * @category guards
 */
export const isAiErrorReason = (u: unknown): u is AiErrorReason => Predicate.hasProperty(u, ReasonTypeId)

/**
 * Creates an `AiError` with the given reason.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 * import { AiError } from "effect/unstable/ai"
 *
 * const error = AiError.make({
 *   module: "OpenAI",
 *   method: "completion",
 *   reason: new AiError.RateLimitError({
 *     retryAfter: Duration.seconds(60)
 *   })
 * })
 *
 * console.log(error.message)
 * // "OpenAI.completion: Rate limit exceeded. Retry after 1 minute"
 * ```
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (params: {
  readonly module: string
  readonly method: string
  readonly reason: AiErrorReason
}): AiError => new AiError(params)

/**
 * Maps HTTP status codes to semantic error reasons.
 *
 * Provider packages can use this as a base for provider-specific mapping.
 *
 * @example
 * ```ts
 * import { AiError } from "effect/unstable/ai"
 *
 * const reason = AiError.reasonFromHttpStatus({
 *   status: 429,
 *   body: { error: "Rate limit exceeded" }
 * })
 *
 * console.log(reason._tag) // "RateLimitError"
 * ```
 *
 * @since 1.0.0
 * @category constructors
 */
export const reasonFromHttpStatus = (params: {
  readonly status: number
  readonly body?: unknown
  readonly http?: typeof HttpContext.Type
  readonly metadata?: typeof ProviderMetadata.Type
  readonly description?: string | undefined
}): AiErrorReason => {
  const { status, http, metadata, description } = params
  const common = {
    http,
    ...(metadata ? { metadata } : undefined),
    ...(description ? { description } : undefined)
  }
  switch (status) {
    case 400:
      return new InvalidRequestError(common)
    case 401:
      return new AuthenticationError({ kind: "InvalidKey", ...common })
    case 403:
      return new AuthenticationError({ kind: "InsufficientPermissions", ...common })
    case 429:
      return new RateLimitError(common)
    default:
      if (status >= 500) {
        return new InternalProviderError({ description: "Server error", ...common })
      }
      return new UnknownError(common)
  }
}
