/**
 * @since 1.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 1.0.0
 */
export * as Generated from "./Generated.ts"

/**
 * OpenAI Client module for interacting with OpenAI's API.
 *
 * Provides a type-safe, Effect-based client for OpenAI operations including
 * completions, embeddings, and streaming responses.
 *
 * @since 1.0.0
 */
export * as OpenAiClient from "./OpenAiClient.ts"

/**
 * @since 1.0.0
 */
export * as OpenAiConfig from "./OpenAiConfig.ts"

/**
 * OpenAI Embedding Model implementation.
 *
 * Provides an EmbeddingModel implementation for OpenAI's embeddings API.
 *
 * @since 1.0.0
 */
export * as OpenAiEmbeddingModel from "./OpenAiEmbeddingModel.ts"

/**
 * OpenAI error metadata augmentation.
 *
 * Provides OpenAI-specific metadata fields for AI error types through module
 * augmentation, enabling typed access to OpenAI error details.
 *
 * @since 1.0.0
 */
export * as OpenAiError from "./OpenAiError.ts"

/**
 * OpenAI Language Model implementation.
 *
 * Provides a LanguageModel implementation for OpenAI's responses API,
 * supporting text generation, structured output, tool calling, and streaming.
 *
 * @since 1.0.0
 */
export * as OpenAiLanguageModel from "./OpenAiLanguageModel.ts"

/**
 * OpenAI telemetry attributes for OpenTelemetry integration.
 *
 * Provides OpenAI-specific GenAI telemetry attributes following OpenTelemetry
 * semantic conventions, extending the base GenAI attributes with OpenAI-specific
 * request and response metadata.
 *
 * @since 1.0.0
 */
export * as OpenAiTelemetry from "./OpenAiTelemetry.ts"

/**
 * OpenAI provider-defined tools for use with the LanguageModel.
 *
 * Provides tools that are natively supported by OpenAI's API, including
 * code interpreter, file search, and web search functionality.
 *
 * @since 1.0.0
 */
export * as OpenAiTool from "./OpenAiTool.ts"
