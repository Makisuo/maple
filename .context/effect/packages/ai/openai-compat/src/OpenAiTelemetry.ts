/**
 * OpenAI telemetry attributes for OpenTelemetry integration.
 *
 * Provides OpenAI-specific GenAI telemetry attributes following OpenTelemetry
 * semantic conventions, extending the base GenAI attributes with OpenAI-specific
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
export type OpenAiTelemetryAttributes = Simplify<
  & Telemetry.GenAITelemetryAttributes
  & Telemetry.AttributesWithPrefix<RequestAttributes, "gen_ai.openai.request">
  & Telemetry.AttributesWithPrefix<ResponseAttributes, "gen_ai.openai.request">
>

/**
 * All telemetry attributes which are part of the GenAI specification,
 * including the OpenAi-specific attributes.
 *
 * @since 1.0.0
 * @category models
 */
export type AllAttributes = Telemetry.AllAttributes & RequestAttributes & ResponseAttributes

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.openai.request`.
 *
 * @since 1.0.0
 * @category models
 */
export interface RequestAttributes {
  /**
   * The response format that is requested.
   */
  readonly responseFormat?: (string & {}) | WellKnownResponseFormat | null | undefined
  /**
   * The service tier requested. May be a specific tier, `default`, or `auto`.
   */
  readonly serviceTier?: (string & {}) | WellKnownServiceTier | null | undefined
}

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.openai.response`.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResponseAttributes {
  /**
   * The service tier used for the response.
   */
  readonly serviceTier?: string | null | undefined
  /**
   * A fingerprint to track any eventual change in the Generative AI
   * environment.
   */
  readonly systemFingerprint?: string | null | undefined
}

/**
 * The `gen_ai.openai.request.response_format` attribute has the following
 * list of well-known values.
 *
 * If one of them applies, then the respective value **MUST** be used;
 * otherwise, a custom value **MAY** be used.
 *
 * @since 1.0.0
 * @category models
 */
export type WellKnownResponseFormat = "json_object" | "json_schema" | "text"

/**
 * The `gen_ai.openai.request.service_tier` attribute has the following
 * list of well-known values.
 *
 * If one of them applies, then the respective value **MUST** be used;
 * otherwise, a custom value **MAY** be used.
 *
 * @since 1.0.0
 * @category models
 */
export type WellKnownServiceTier = "auto" | "default"

/**
 * @since 1.0.0
 * @since models
 */
export type OpenAiTelemetryAttributeOptions = Telemetry.GenAITelemetryAttributeOptions & {
  openai?: {
    request?: RequestAttributes | undefined
    response?: ResponseAttributes | undefined
  } | undefined
}

const addOpenAiRequestAttributes = Telemetry.addSpanAttributes("gen_ai.openai.request", String.camelToSnake)<
  RequestAttributes
>
const addOpenAiResponseAttributes = Telemetry.addSpanAttributes("gen_ai.openai.response", String.camelToSnake)<
  ResponseAttributes
>

/**
 * Applies the specified OpenAi GenAI telemetry attributes to the provided
 * `Span`.
 *
 * **NOTE**: This method will mutate the `Span` **in-place**.
 *
 * @since 1.0.0
 * @since utilities
 */
export const addGenAIAnnotations: {
  (options: OpenAiTelemetryAttributeOptions): (span: Span) => void
  (span: Span, options: OpenAiTelemetryAttributeOptions): void
} = dual(2, (span: Span, options: OpenAiTelemetryAttributeOptions) => {
  Telemetry.addGenAIAnnotations(span, options)
  if (options.openai != null) {
    if (options.openai.request != null) {
      addOpenAiRequestAttributes(span, options.openai.request)
    }
    if (options.openai.response != null) {
      addOpenAiResponseAttributes(span, options.openai.response)
    }
  }
})
