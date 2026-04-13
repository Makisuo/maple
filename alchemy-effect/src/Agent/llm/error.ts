import * as AISDKProvider from "@ai-sdk/provider";
import { DownloadError as AISDKDownloadError } from "ai";
import * as Data from "effect/Data";

/**
 * Base AI SDK error - wraps generic AI SDK errors
 */
export class AISDKError extends Data.TaggedError("AISDKError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * API call error - wraps errors from API calls to AI providers
 */
export class APICallError extends Data.TaggedError("APICallError")<{
  readonly message: string;
  readonly url: string;
  readonly requestBodyValues: unknown;
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
  readonly isRetryable: boolean;
  readonly data?: unknown;
  readonly cause?: unknown;
}> {}

/**
 * Empty response body error - thrown when the API returns an empty response
 */
export class EmptyResponseBodyError extends Data.TaggedError(
  "EmptyResponseBodyError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Invalid argument error - thrown when a function argument is invalid
 */
export class InvalidArgumentError extends Data.TaggedError(
  "InvalidArgumentError",
)<{
  readonly message: string;
  readonly argument: string;
  readonly cause?: unknown;
}> {}

/**
 * Invalid prompt error - thrown when a prompt cannot be processed
 */
export class InvalidPromptError extends Data.TaggedError("InvalidPromptError")<{
  readonly message: string;
  readonly prompt: unknown;
  readonly cause?: unknown;
}> {}

/**
 * Invalid response data error - thrown when response data cannot be parsed
 */
export class InvalidResponseDataError extends Data.TaggedError(
  "InvalidResponseDataError",
)<{
  readonly message: string;
  readonly data: unknown;
  readonly cause?: unknown;
}> {}

/**
 * JSON parse error - thrown when JSON parsing fails
 */
export class JSONParseError extends Data.TaggedError("JSONParseError")<{
  readonly message: string;
  readonly text: string;
  readonly cause?: unknown;
}> {}

/**
 * Load API key error - thrown when API key cannot be loaded
 */
export class LoadAPIKeyError extends Data.TaggedError("LoadAPIKeyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Load setting error - thrown when a setting cannot be loaded
 */
export class LoadSettingError extends Data.TaggedError("LoadSettingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * No content generated error - thrown when the AI provider fails to generate content
 */
export class NoContentGeneratedError extends Data.TaggedError(
  "NoContentGeneratedError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * No such model error - thrown when a model cannot be found
 */
export class NoSuchModelError extends Data.TaggedError("NoSuchModelError")<{
  readonly message: string;
  readonly modelId: string;
  readonly modelType: string;
  readonly cause?: unknown;
}> {}

/**
 * Too many embedding values error - thrown when too many values are passed to an embedding call
 */
export class TooManyEmbeddingValuesForCallError extends Data.TaggedError(
  "TooManyEmbeddingValuesForCallError",
)<{
  readonly message: string;
  readonly provider: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall: number;
  readonly values: Array<unknown>;
  readonly cause?: unknown;
}> {}

/**
 * Type validation error - thrown when type validation fails
 */
export class TypeValidationError extends Data.TaggedError(
  "TypeValidationError",
)<{
  readonly message: string;
  readonly value: unknown;
  readonly cause?: unknown;
}> {}

/**
 * Unsupported functionality error - thrown when a feature is not supported
 */
export class UnsupportedFunctionalityError extends Data.TaggedError(
  "UnsupportedFunctionalityError",
)<{
  readonly message: string;
  readonly functionality: string;
  readonly cause?: unknown;
}> {}

/**
 * Download error - thrown when a file download fails
 */
export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly message: string;
  readonly url: string;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly cause?: unknown;
}> {}

/**
 * Unknown error - fallback for unrecognized errors
 */
export class UnknownAISDKError extends Data.TaggedError("UnknownAISDKError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Union type of all AI SDK errors
 */
export type LLMError =
  | AISDKError
  | APICallError
  | EmptyResponseBodyError
  | InvalidArgumentError
  | InvalidPromptError
  | InvalidResponseDataError
  | JSONParseError
  | LoadAPIKeyError
  | LoadSettingError
  | NoContentGeneratedError
  | NoSuchModelError
  | TooManyEmbeddingValuesForCallError
  | TypeValidationError
  | UnsupportedFunctionalityError
  | DownloadError
  | UnknownAISDKError;

/**
 * Converts any error to a typed LLMError
 */
export const fromAnyError = (e: unknown): LLMError => {
  if (AISDKDownloadError.isInstance(e)) {
    return new DownloadError({
      message: e.message,
      url: e.url,
      statusCode: e.statusCode,
      statusText: e.statusText,
      cause: e,
    });
  }

  if (AISDKProvider.APICallError.isInstance(e)) {
    return new APICallError({
      message: e.message,
      url: e.url,
      requestBodyValues: e.requestBodyValues,
      statusCode: e.statusCode,
      responseHeaders: e.responseHeaders,
      responseBody: e.responseBody,
      isRetryable: e.isRetryable,
      data: e.data,
      cause: e,
    });
  }

  if (AISDKProvider.EmptyResponseBodyError.isInstance(e)) {
    return new EmptyResponseBodyError({
      message: e.message,
      cause: e,
    });
  }

  if (AISDKProvider.InvalidArgumentError.isInstance(e)) {
    return new InvalidArgumentError({
      message: e.message,
      argument: e.argument,
      cause: e,
    });
  }

  if (AISDKProvider.InvalidPromptError.isInstance(e)) {
    return new InvalidPromptError({
      message: e.message,
      prompt: e.prompt,
      cause: e,
    });
  }

  if (AISDKProvider.InvalidResponseDataError.isInstance(e)) {
    return new InvalidResponseDataError({
      message: e.message,
      data: e.data,
      cause: e,
    });
  }

  if (AISDKProvider.JSONParseError.isInstance(e)) {
    return new JSONParseError({
      message: e.message,
      text: e.text,
      cause: e,
    });
  }

  if (AISDKProvider.LoadAPIKeyError.isInstance(e)) {
    return new LoadAPIKeyError({
      message: e.message,
      cause: e,
    });
  }

  if (AISDKProvider.LoadSettingError.isInstance(e)) {
    return new LoadSettingError({
      message: e.message,
      cause: e,
    });
  }

  if (AISDKProvider.NoContentGeneratedError.isInstance(e)) {
    return new NoContentGeneratedError({
      message: e.message,
      cause: e,
    });
  }

  if (AISDKProvider.NoSuchModelError.isInstance(e)) {
    return new NoSuchModelError({
      message: e.message,
      modelId: e.modelId,
      modelType: e.modelType,
      cause: e,
    });
  }

  if (AISDKProvider.TooManyEmbeddingValuesForCallError.isInstance(e)) {
    return new TooManyEmbeddingValuesForCallError({
      message: e.message,
      provider: e.provider,
      modelId: e.modelId,
      maxEmbeddingsPerCall: e.maxEmbeddingsPerCall,
      values: e.values,
      cause: e,
    });
  }

  if (AISDKProvider.TypeValidationError.isInstance(e)) {
    return new TypeValidationError({
      message: e.message,
      value: e.value,
      cause: e,
    });
  }

  if (AISDKProvider.UnsupportedFunctionalityError.isInstance(e)) {
    return new UnsupportedFunctionalityError({
      message: e.message,
      functionality: e.functionality,
      cause: e,
    });
  }

  // Generic AISDKError check (should be last since it's the base class)
  if (AISDKProvider.AISDKError.isInstance(e)) {
    return new AISDKError({
      message: e.message,
      cause: e,
    });
  }

  // Fallback for unknown errors
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : "Unknown error";
  return new UnknownAISDKError({ message, cause: e });
};
