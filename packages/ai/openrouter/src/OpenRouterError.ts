/**
 * OpenRouter error metadata augmentation.
 *
 * Provides OpenRouter-specific metadata fields for AI error types through
 * module augmentation, enabling typed access to OpenRouter error details.
 *
 * @since 1.0.0
 */

/**
 * OpenRouter-specific error metadata fields.
 *
 * @since 1.0.0
 * @category models
 */
export type OpenRouterErrorMetadata = {
  /**
   * The error code returned by the API.
   */
  readonly errorCode: string | number | null
  /**
   * The error type returned by the API.
   */
  readonly errorType: string | null
  /**
   * The unique request ID for debugging.
   */
  readonly requestId: string | null
}

/**
 * OpenRouter-specific rate limit metadata fields.
 *
 * @since 1.0.0
 * @category models
 */
export type OpenRouterRateLimitMetadata = OpenRouterErrorMetadata & {
  readonly limit: string | null
  readonly remaining: number | null
  readonly resetRequests: string | null
  readonly resetTokens: string | null
}

declare module "effect/unstable/ai/AiError" {
  export interface RateLimitErrorMetadata {
    readonly openrouter?: OpenRouterRateLimitMetadata | null
  }

  export interface QuotaExhaustedErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface AuthenticationErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface ContentPolicyErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface InvalidRequestErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface InternalProviderErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface InvalidOutputErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface StructuredOutputErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface UnsupportedSchemaErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }

  export interface UnknownErrorMetadata {
    readonly openrouter?: OpenRouterErrorMetadata | null
  }
}
