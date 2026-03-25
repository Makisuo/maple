/**
 * @since 1.0.0
 */

/**
 * OpenAI-specific error metadata fields.
 *
 * @since 1.0.0
 * @category models
 */
export type OpenAiErrorMetadata = {
  /**
   * The OpenAI error code returned by the API.
   */
  readonly errorCode: string | null
  /**
   * The OpenAI error type returned by the API.
   */
  readonly errorType: string | null
  /**
   * The unique request ID for debugging with OpenAI support.
   */
  readonly requestId: string | null
}

/**
 * OpenAI-specific rate limit metadata fields.
 *
 * Extends base error metadata with rate limit specific information from
 * OpenAI's rate limit headers.
 *
 * @since 1.0.0
 * @category models
 */
export type OpenAiRateLimitMetadata = OpenAiErrorMetadata & {
  /**
   * The rate limit type (e.g. "requests", "tokens").
   */
  readonly limit: string | null
  /**
   * Number of remaining requests in the current window.
   */
  readonly remaining: number | null
  /**
   * Time until the request rate limit resets.
   */
  readonly resetRequests: string | null
  /**
   * Time until the token rate limit resets.
   */
  readonly resetTokens: string | null
}

declare module "effect/unstable/ai/AiError" {
  export interface RateLimitErrorMetadata {
    readonly openai?: OpenAiRateLimitMetadata | null
  }

  export interface QuotaExhaustedErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface AuthenticationErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface ContentPolicyErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface InvalidRequestErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface InternalProviderErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface InvalidOutputErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface StructuredOutputErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface UnsupportedSchemaErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }

  export interface UnknownErrorMetadata {
    readonly openai?: OpenAiErrorMetadata | null
  }
}
