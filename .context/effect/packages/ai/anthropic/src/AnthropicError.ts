/**
 * Anthropic error metadata augmentation.
 *
 * Provides Anthropic-specific metadata fields for AI error types through module
 * augmentation, enabling typed access to Anthropic error details.
 *
 * @since 1.0.0
 */

/**
 * Anthropic-specific error metadata fields.
 *
 * @since 1.0.0
 * @category models
 */
export type AnthropicErrorMetadata = {
  /**
   * The Anthropic error type returned by the API.
   */
  readonly errorType: string | null
  /**
   * The unique request ID for debugging with Anthropic support.
   */
  readonly requestId: string | null
}

/**
 * Anthropic-specific rate limit metadata fields.
 *
 * Extends base error metadata with rate limit specific information from
 * Anthropic's rate limit headers.
 *
 * @since 1.0.0
 * @category models
 */
export type AnthropicRateLimitMetadata = AnthropicErrorMetadata & {
  /**
   * Number of requests allowed in the current period.
   */
  readonly requestsLimit: number | null
  /**
   * Number of requests remaining in the current period.
   */
  readonly requestsRemaining: number | null
  /**
   * Time when the request rate limit resets.
   */
  readonly requestsReset: string | null
  /**
   * Number of tokens allowed in the current period.
   */
  readonly tokensLimit: number | null
  /**
   * Number of tokens remaining in the current period.
   */
  readonly tokensRemaining: number | null
  /**
   * Time when the token rate limit resets.
   */
  readonly tokensReset: string | null
}

declare module "effect/unstable/ai/AiError" {
  export interface RateLimitErrorMetadata {
    readonly anthropic?: AnthropicRateLimitMetadata | null
  }

  export interface QuotaExhaustedErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface AuthenticationErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface ContentPolicyErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface InvalidRequestErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface InternalProviderErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface InvalidOutputErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface StructuredOutputErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface UnsupportedSchemaErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }

  export interface UnknownErrorMetadata {
    readonly anthropic?: AnthropicErrorMetadata | null
  }
}
