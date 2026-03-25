/**
 * Anthropic telemetry attributes for OpenTelemetry integration.
 *
 * Provides Anthropic-specific GenAI telemetry attributes following OpenTelemetry
 * semantic conventions, extending the base GenAI attributes with Anthropic-specific
 * request and response metadata.
 *
 * @since 1.0.0
 */
import { dual } from "effect/Function"
import * as String from "effect/String"
import type { Span } from "effect/Tracer"
import type { Simplify } from "effect/Types"
import * as Telemetry from "effect/unstable/ai/Telemetry"

/**
 * The attributes used to describe telemetry in the context of Generative
 * Artificial Intelligence (GenAI) Models requests and responses.
 *
 * {@see https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/}
 *
 * @since 1.0.0
 * @category models
 */
export type AnthropicTelemetryAttributes = Simplify<
  & Telemetry.GenAITelemetryAttributes
  & Telemetry.AttributesWithPrefix<RequestAttributes, "gen_ai.anthropic.request">
  & Telemetry.AttributesWithPrefix<ResponseAttributes, "gen_ai.anthropic.response">
>

/**
 * All telemetry attributes which are part of the GenAI specification,
 * including the Anthropic-specific attributes.
 *
 * @since 1.0.0
 * @category models
 */
export type AllAttributes = Telemetry.AllAttributes & RequestAttributes & ResponseAttributes

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.anthropic.request`.
 *
 * @since 1.0.0
 * @category models
 */
export interface RequestAttributes {
  /**
   * Whether extended thinking is enabled.
   */
  readonly extendedThinking?: boolean | null | undefined
  /**
   * The budget tokens for extended thinking.
   */
  readonly thinkingBudgetTokens?: number | null | undefined
}

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.anthropic.response`.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResponseAttributes {
  /**
   * The stop reason from the response.
   */
  readonly stopReason?: string | null | undefined
  /**
   * Number of cache creation input tokens.
   */
  readonly cacheCreationInputTokens?: number | null | undefined
  /**
   * Number of cache read input tokens.
   */
  readonly cacheReadInputTokens?: number | null | undefined
}

/**
 * @since 1.0.0
 * @category models
 */
export type AnthropicTelemetryAttributeOptions = Telemetry.GenAITelemetryAttributeOptions & {
  anthropic?: {
    request?: RequestAttributes | undefined
    response?: ResponseAttributes | undefined
  } | undefined
}

const addAnthropicRequestAttributes = Telemetry.addSpanAttributes("gen_ai.anthropic.request", String.camelToSnake)<
  RequestAttributes
>
const addAnthropicResponseAttributes = Telemetry.addSpanAttributes("gen_ai.anthropic.response", String.camelToSnake)<
  ResponseAttributes
>

/**
 * Applies the specified Anthropic GenAI telemetry attributes to the provided
 * `Span`.
 *
 * **NOTE**: This method will mutate the `Span` **in-place**.
 *
 * @since 1.0.0
 * @category utilities
 */
export const addGenAIAnnotations: {
  (options: AnthropicTelemetryAttributeOptions): (span: Span) => void
  (span: Span, options: AnthropicTelemetryAttributeOptions): void
} = dual(2, (span: Span, options: AnthropicTelemetryAttributeOptions) => {
  Telemetry.addGenAIAnnotations(span, options)
  if (options.anthropic != null) {
    if (options.anthropic.request != null) {
      addAnthropicRequestAttributes(span, options.anthropic.request)
    }
    if (options.anthropic.response != null) {
      addAnthropicResponseAttributes(span, options.anthropic.response)
    }
  }
})
