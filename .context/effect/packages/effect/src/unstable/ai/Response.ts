/**
 * The `Response` module provides data structures to represent responses from
 * large language models.
 *
 * This module defines the complete structure of AI model responses, including
 * various content parts for text, reasoning, tool calls, files, and metadata,
 * supporting both streaming and non-streaming responses.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * // Create a simple text response part
 * const textResponse = Response.makePart("text", {
 *   text: "The weather is sunny today!"
 * })
 *
 * // Create a tool call response part
 * const toolCallResponse = Response.makePart("tool-call", {
 *   id: "call_123",
 *   name: "get_weather",
 *   params: { city: "San Francisco" },
 *   providerExecuted: false
 * })
 * ```
 *
 * @since 1.0.0
 */
import type * as DateTime from "../../DateTime.ts"
import { constFalse, identity } from "../../Function.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"
import type * as Tool from "./Tool.ts"
import type * as Toolkit from "./Toolkit.ts"

const PartTypeId = "~effect/ai/Content/Part" as const

const constEmptyObject = () => ({})
const constPartTypeId = () => PartTypeId

// =============================================================================
// All Parts
// =============================================================================

/**
 * Type guard to check if a value is a Response Part.
 *
 * @since 1.0.0
 * @category guards
 */
export const isPart = (u: unknown): u is AnyPart => Predicate.hasProperty(u, PartTypeId)

/**
 * Union type representing all possible response content parts.
 *
 * @since 1.0.0
 * @category models
 */
export type AnyPart =
  | TextPart
  | TextStartPart
  | TextDeltaPart
  | TextEndPart
  | ReasoningPart
  | ReasoningStartPart
  | ReasoningDeltaPart
  | ReasoningEndPart
  | ToolParamsStartPart
  | ToolParamsDeltaPart
  | ToolParamsEndPart
  | ToolCallPart<any, any>
  | ToolResultPart<any, any, any>
  | ToolApprovalRequestPart
  | FilePart
  | DocumentSourcePart
  | UrlSourcePart
  | ResponseMetadataPart
  | FinishPart
  | ErrorPart

/**
 * Encoded representation of all possible response content parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export type AnyPartEncoded =
  | TextPartEncoded
  | TextStartPartEncoded
  | TextDeltaPartEncoded
  | TextEndPartEncoded
  | ReasoningPartEncoded
  | ReasoningStartPartEncoded
  | ReasoningDeltaPartEncoded
  | ReasoningEndPartEncoded
  | ToolParamsStartPartEncoded
  | ToolParamsDeltaPartEncoded
  | ToolParamsEndPartEncoded
  | ToolCallPartEncoded
  | ToolResultPartEncoded
  | ToolApprovalRequestPartEncoded
  | FilePartEncoded
  | DocumentSourcePartEncoded
  | UrlSourcePartEncoded
  | ResponseMetadataPartEncoded
  | FinishPartEncoded
  | ErrorPartEncoded

/**
 * Union type for all response parts with tool-specific typing.
 *
 * @since 1.0.0
 * @category models
 */
export type AllParts<Tools extends Record<string, Tool.Any>> =
  | TextPart
  | TextStartPart
  | TextDeltaPart
  | TextEndPart
  | ReasoningPart
  | ReasoningStartPart
  | ReasoningDeltaPart
  | ReasoningEndPart
  | ToolParamsStartPart
  | ToolParamsDeltaPart
  | ToolParamsEndPart
  | ToolCallParts<Tools>
  | ToolResultParts<Tools>
  | ToolApprovalRequestPart
  | FilePart
  | DocumentSourcePart
  | UrlSourcePart
  | ResponseMetadataPart
  | FinishPart
  | ErrorPart

/**
 * Encoded representation of all response parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export type AllPartsEncoded =
  | TextPartEncoded
  | TextStartPartEncoded
  | TextDeltaPartEncoded
  | TextEndPartEncoded
  | ReasoningPartEncoded
  | ReasoningStartPartEncoded
  | ReasoningDeltaPartEncoded
  | ReasoningEndPartEncoded
  | ToolParamsStartPartEncoded
  | ToolParamsDeltaPartEncoded
  | ToolParamsEndPartEncoded
  | ToolCallPartEncoded
  | ToolResultPartEncoded
  | ToolApprovalRequestPartEncoded
  | FilePartEncoded
  | DocumentSourcePartEncoded
  | UrlSourcePartEncoded
  | ResponseMetadataPartEncoded
  | FinishPartEncoded
  | ErrorPartEncoded

/**
 * Creates a Schema for all response parts based on a toolkit.
 *
 * Generates a schema that includes all possible response parts, with tool call
 * and tool result parts dynamically created based on the provided toolkit.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Response, Tool, Toolkit } from "effect/unstable/ai"
 *
 * const myToolkit = Toolkit.make(
 *   Tool.make("GetWeather", {
 *     parameters: Schema.Struct({ city: Schema.String }),
 *     success: Schema.Struct({ temperature: Schema.Number })
 *   })
 * )
 *
 * const allPartsSchema = Response.AllParts(myToolkit)
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export const AllParts = <T extends Toolkit.Any | Toolkit.WithHandler<any>>(
  toolkit: T
): Schema.Codec<
  AllParts<T extends Toolkit.Any ? Toolkit.Tools<T> : Toolkit.WithHandlerTools<T>>,
  AllPartsEncoded,
  Tool.ResultDecodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>,
  Tool.ResultEncodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>
> => {
  const toolCalls: Array<Schema.Top> = []
  const toolResults: Array<Schema.Top> = []
  for (const tool of Object.values(toolkit.tools as Record<string, Tool.Any>)) {
    const toolCall = ToolCallPart(tool.name, tool.parametersSchema)
    const toolResult = ToolResultPart(tool.name, tool.successSchema, tool.failureSchema)
    toolCalls.push(toolCall)
    toolResults.push(toolResult)
  }
  return Schema.Union([
    TextPart,
    TextStartPart,
    TextDeltaPart,
    TextEndPart,
    ReasoningPart,
    ReasoningStartPart,
    ReasoningDeltaPart,
    ReasoningEndPart,
    ToolParamsStartPart,
    ToolParamsDeltaPart,
    ToolParamsEndPart,
    ToolApprovalRequestPart,
    FilePart,
    DocumentSourcePart,
    UrlSourcePart,
    ResponseMetadataPart,
    FinishPart,
    ErrorPart,
    ...toolCalls,
    ...toolResults
  ]) as any
}

// =============================================================================
// Parts
// =============================================================================

/**
 * A type for representing non-streaming response parts with tool-specific
 * typing.
 *
 * @since 1.0.0
 * @category models
 */
export type Part<Tools extends Record<string, Tool.Any>> =
  | TextPart
  | ReasoningPart
  | ToolCallParts<Tools>
  | ToolResultParts<Tools>
  | ToolApprovalRequestPart
  | FilePart
  | DocumentSourcePart
  | UrlSourcePart
  | ResponseMetadataPart
  | FinishPart

/**
 * Encoded representation of non-streaming response parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export type PartEncoded =
  | TextPartEncoded
  | ReasoningPartEncoded
  | ReasoningDeltaPartEncoded
  | ReasoningEndPartEncoded
  | ToolCallPartEncoded
  | ToolResultPartEncoded
  | ToolApprovalRequestPartEncoded
  | FilePartEncoded
  | DocumentSourcePartEncoded
  | UrlSourcePartEncoded
  | ResponseMetadataPartEncoded
  | FinishPartEncoded

/**
 * Creates a Schema for non-streaming response parts based on a toolkit.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Part = <T extends Toolkit.Any | Toolkit.WithHandler<any>>(
  toolkit: T
): Schema.Codec<
  Part<T extends Toolkit.Any ? Toolkit.Tools<T> : Toolkit.WithHandlerTools<T>>,
  PartEncoded,
  Tool.ResultDecodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>,
  Tool.ResultEncodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>
> => {
  const toolCalls: Array<Schema.Top> = []
  const toolResults: Array<Schema.Top> = []
  for (const tool of Object.values(toolkit.tools as Record<string, Tool.Any>)) {
    const toolCall = ToolCallPart(tool.name, tool.parametersSchema)
    const toolResult = ToolResultPart(tool.name, tool.successSchema, tool.failureSchema)
    toolCalls.push(toolCall)
    toolResults.push(toolResult)
  }
  return Schema.Union([
    TextPart,
    ReasoningPart,
    ToolApprovalRequestPart,
    FilePart,
    DocumentSourcePart,
    UrlSourcePart,
    ResponseMetadataPart,
    FinishPart,
    ...toolCalls,
    ...toolResults
  ]) as any
}

// =============================================================================
// Stream Parts
// =============================================================================

/**
 * A type for representing streaming response parts with tool-specific typing.
 *
 * @since 1.0.0
 * @category models
 */
export type StreamPart<Tools extends Record<string, Tool.Any>> =
  | TextStartPart
  | TextDeltaPart
  | TextEndPart
  | ReasoningStartPart
  | ReasoningDeltaPart
  | ReasoningEndPart
  | ToolParamsStartPart
  | ToolParamsDeltaPart
  | ToolParamsEndPart
  | ToolCallParts<Tools>
  | ToolResultParts<Tools>
  | ToolApprovalRequestPart
  | FilePart
  | DocumentSourcePart
  | UrlSourcePart
  | ResponseMetadataPart
  | FinishPart
  | ErrorPart

/**
 * Encoded representation of streaming response parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export type StreamPartEncoded =
  | TextStartPartEncoded
  | TextDeltaPartEncoded
  | TextEndPartEncoded
  | ReasoningStartPartEncoded
  | ReasoningDeltaPartEncoded
  | ReasoningEndPartEncoded
  | ToolParamsStartPartEncoded
  | ToolParamsDeltaPartEncoded
  | ToolParamsEndPartEncoded
  | ToolCallPartEncoded
  | ToolResultPartEncoded
  | ToolApprovalRequestPartEncoded
  | FilePartEncoded
  | DocumentSourcePartEncoded
  | UrlSourcePartEncoded
  | ResponseMetadataPartEncoded
  | FinishPartEncoded
  | ErrorPartEncoded

/**
 * Creates a Schema for streaming response parts based on a toolkit.
 *
 * @since 1.0.0
 * @category schemas
 */
export const StreamPart = <T extends Toolkit.Any | Toolkit.WithHandler<any>>(
  toolkit: T
): Schema.Codec<
  StreamPart<T extends Toolkit.Any ? Toolkit.Tools<T> : Toolkit.WithHandlerTools<T>>,
  StreamPartEncoded,
  Tool.ResultDecodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>,
  Tool.ResultEncodingServices<Toolkit.Tools<T>[keyof Toolkit.Tools<T>]>
> => {
  const toolCalls: Array<Schema.Top> = []
  const toolResults: Array<Schema.Top> = []
  for (const tool of Object.values(toolkit.tools as Record<string, Tool.Any>)) {
    const toolCall = ToolCallPart(tool.name, tool.parametersSchema)
    const toolResult = ToolResultPart(tool.name, tool.successSchema, tool.failureSchema)
    toolCalls.push(toolCall)
    toolResults.push(toolResult)
  }
  return Schema.Union([
    TextStartPart,
    TextDeltaPart,
    TextEndPart,
    ReasoningStartPart,
    ReasoningDeltaPart,
    ReasoningEndPart,
    ToolParamsStartPart,
    ToolParamsDeltaPart,
    ToolParamsEndPart,
    ToolApprovalRequestPart,
    FilePart,
    DocumentSourcePart,
    UrlSourcePart,
    ResponseMetadataPart,
    FinishPart,
    ErrorPart,
    ...toolCalls,
    ...toolResults
  ]) as any
}

// =============================================================================
// utility types
// =============================================================================

/**
 * Utility type that extracts tool call parts from a set of tools.
 *
 * @since 1.0.0
 * @category utility types
 */
export type ToolCallParts<Tools extends Record<string, Tool.Any>> = {
  [Name in keyof Tools]: Name extends string ? ToolCallPart<Name, Tool.Parameters<Tools[Name]>>
    : never
}[keyof Tools]

/**
 * Utility type that extracts tool result parts from a set of tools.
 *
 * @since 1.0.0
 * @category utility types
 */
export type ToolResultParts<Tools extends Record<string, Tool.Any>> = {
  [Name in keyof Tools]: Name extends string
    ? ToolResultPart<Name, Tool.Success<Tools[Name]>, Tool.FailureResult<Tools[Name]>>
    : never
}[keyof Tools]

// =============================================================================
// Base Part
// =============================================================================

/**
 * Schema for provider-specific metadata which can be attached to response parts.
 *
 * Provider-specific metadata is namespaced by provider and has the structure:
 *
 * ```
 * {
 *   "<provider-specific-key>": {
 *     // Provider-specific metadata
 *   }
 * }
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export const ProviderMetadata: Schema.$Record<
  Schema.String,
  Schema.NullOr<Schema.Codec<Schema.Json>>
> = Schema.Record(Schema.String, Schema.NullOr(Schema.Json))

/**
 * @since 1.0.0
 * @category models
 */
export type ProviderMetadata = typeof ProviderMetadata.Type

/**
 * Base interface for all response content parts.
 *
 * Provides common structure including type identifier and optional metadata.
 *
 * @since 1.0.0
 * @category models
 */
export interface BasePart<Type extends string, Metadata extends ProviderMetadata> {
  readonly [PartTypeId]: typeof PartTypeId
  /**
   * The type of this response part.
   */
  readonly type: Type
  /**
   * Optional provider-specific metadata for this part.
   */
  readonly metadata: Metadata
}

/**
 * Base interface for encoded response content parts.
 *
 * @since 1.0.0
 * @category models
 */
export interface BasePartEncoded<Type extends string, Metadata extends ProviderMetadata> {
  /**
   * The type of this response part.
   */
  readonly type: Type
  /**
   * Optional provider-specific metadata for this part.
   */
  readonly metadata?: Metadata | undefined
}

const BasePart = Schema.Struct({
  [PartTypeId]: Schema.tag(PartTypeId).pipe(
    Schema.withDecodingDefaultKey(constPartTypeId, { encodingStrategy: "omit" })
  ),
  metadata: ProviderMetadata.pipe(
    Schema.withDecodingDefault(constEmptyObject)
  )
})

/**
 * Creates a new response content part of the specified type.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const textPart = Response.makePart("text", {
 *   text: "Hello, world!"
 * })
 *
 * const toolCallPart = Response.makePart("tool-call", {
 *   id: "call_123",
 *   name: "get_weather",
 *   params: { city: "San Francisco" },
 *   providerExecuted: false
 * })
 * ```
 *
 * @since 1.0.0
 * @category constructors
 */
export const makePart = <const Type extends AnyPart["type"]>(
  /**
   * The type of part to create.
   */
  type: Type,
  /**
   * Parameters specific to the part type being created.
   */
  params: Omit<Extract<AnyPart, { type: Type }>, typeof PartTypeId | "type" | "metadata"> & {
    /**
     * Optional provider-specific metadata for this part.
     */
    readonly metadata?: Extract<AnyPart, { type: Type }>["metadata"] | undefined
  }
): Extract<AnyPart, { type: Type }> =>
  ({
    ...params,
    [PartTypeId]: PartTypeId,
    type,
    metadata: params.metadata ?? {}
  }) as any

/**
 * A utility type for specifying the parameters required to construct a
 * specific response part.
 *
 * @since 1.0.0
 * @category utility types
 */
export type ConstructorParams<Part extends AnyPart> =
  & Omit<Part, typeof PartTypeId | "type" | "sourceType" | "metadata">
  & {
    /**
     * Optional provider-specific metadata for this part.
     */
    readonly metadata?: Part["metadata"] | undefined
  }

// =============================================================================
// Text Part
// =============================================================================

/**
 * Response part representing plain text content.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const textPart: Response.TextPart = Response.makePart("text", {
 *   text: "The answer to your question is 42."
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface TextPart extends BasePart<"text", TextPartMetadata> {
  /**
   * The text content.
   */
  readonly text: string
}

/**
 * Encoded representation of text parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextPartEncoded extends BasePartEncoded<"text", TextPartMetadata> {
  /**
   * The text content.
   */
  readonly text: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `TextPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface TextPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of text parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TextPart: Schema.Struct<{
  readonly type: Schema.tag<"text">
  readonly text: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("text"),
  text: Schema.String
}).annotate({ identifier: "TextPart" }) satisfies Schema.Codec<TextPart, TextPartEncoded>

// =============================================================================
// Text Start Part
// =============================================================================

/**
 * Response part indicating the start of streaming text content.
 *
 * Marks the beginning of a text chunk with a unique identifier.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextStartPart extends BasePart<"text-start", TextStartPartMetadata> {
  /**
   * Unique identifier for this text chunk.
   */
  readonly id: string
}

/**
 * Encoded representation of text start parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextStartPartEncoded extends BasePartEncoded<"text-start", TextStartPartMetadata> {
  /**
   * Unique identifier for this text chunk.
   */
  readonly id: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `TextStartPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface TextStartPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of text start parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TextStartPart: Schema.Struct<{
  readonly type: Schema.tag<"text-start">
  readonly id: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("text-start"),
  id: Schema.String
}).annotate({ identifier: "TextStartPart" }) satisfies Schema.Codec<TextStartPart, TextStartPartEncoded>

// =============================================================================
// Text Delta Part
// =============================================================================

/**
 * Response part containing incremental text content to be added to the existing
 * text chunk with the same unique identifier.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextDeltaPart extends BasePart<"text-delta", TextDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding text chunk.
   */
  readonly id: string
  /**
   * The incremental text content to add.
   */
  readonly delta: string
}

/**
 * Encoded representation of text delta parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextDeltaPartEncoded extends BasePartEncoded<"text-delta", TextDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding text chunk.
   */
  readonly id: string
  /**
   * The incremental text content to add.
   */
  readonly delta: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `TextDeltaPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface TextDeltaPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of text delta parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TextDeltaPart: Schema.Struct<{
  readonly type: Schema.tag<"text-delta">
  readonly id: Schema.String
  readonly delta: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("text-delta"),
  id: Schema.String,
  delta: Schema.String
}).annotate({ identifier: "TextDeltaPart" }) satisfies Schema.Codec<TextDeltaPart, TextDeltaPartEncoded>

// =============================================================================
// Text End Part
// =============================================================================

/**
 * Response part indicating the end of streaming text content.
 *
 * Marks the completion of a text chunk.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextEndPart extends BasePart<"text-end", TextEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding text chunk.
   */
  readonly id: string
}

/**
 * Encoded representation of text end parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface TextEndPartEncoded extends BasePartEncoded<"text-end", TextEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding text chunk.
   */
  readonly id: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `TextEndPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface TextEndPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of text end parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TextEndPart: Schema.Struct<{
  readonly type: Schema.tag<"text-end">
  readonly id: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("text-end"),
  id: Schema.String
}).annotate({ identifier: "TextEndPart" }) satisfies Schema.Codec<TextEndPart, TextEndPartEncoded>

// =============================================================================
// Reasoning Part
// =============================================================================

/**
 * Response part representing reasoning or chain-of-thought content.
 *
 * Contains the internal reasoning process or explanation from the large
 * language model.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const reasoningPart: Response.ReasoningPart = Response.makePart("reasoning", {
 *   text:
 *     "Let me think step by step: First I need to analyze the user's question..."
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningPart extends BasePart<"reasoning", ReasoningPartMetadata> {
  /**
   * The reasoning or thought process text.
   */
  readonly text: string
}

/**
 * Encoded representation of reasoning parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningPartEncoded extends BasePartEncoded<"reasoning", ReasoningPartMetadata> {
  /**
   * The reasoning or thought process text.
   */
  readonly text: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ReasoningPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ReasoningPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of reasoning parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReasoningPart: Schema.Struct<{
  readonly type: Schema.tag<"reasoning">
  readonly text: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("reasoning"),
  text: Schema.String
}).annotate({ identifier: "ReasoningPart" }) satisfies Schema.Codec<ReasoningPart, ReasoningPartEncoded>

// =============================================================================
// Reasoning Start Part
// =============================================================================

/**
 * Response part indicating the start of streaming reasoning content.
 *
 * Marks the beginning of a reasoning chunk with a unique identifier.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningStartPart extends BasePart<"reasoning-start", ReasoningStartPartMetadata> {
  /**
   * Unique identifier for this reasoning chunk.
   */
  readonly id: string
}

/**
 * Encoded representation of reasoning start parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningStartPartEncoded extends BasePartEncoded<"reasoning-start", ReasoningStartPartMetadata> {
  /**
   * Unique identifier for this reasoning stream.
   */
  readonly id: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ReasoningStartPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ReasoningStartPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of reasoning start parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReasoningStartPart: Schema.Struct<{
  readonly type: Schema.tag<"reasoning-start">
  readonly id: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("reasoning-start"),
  id: Schema.String
}).annotate({ identifier: "ReasoningStartPart" }) satisfies Schema.Codec<ReasoningStartPart, ReasoningStartPartEncoded>

// =============================================================================
// Reasoning Delta Part
// =============================================================================

/**
 * Response part containing incremental reasoning content to be added to the
 * existing chunk of reasoning text with the same unique identifier.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningDeltaPart extends BasePart<"reasoning-delta", ReasoningDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding reasoning chunk.
   */
  readonly id: string
  /**
   * The incremental reasoning content to add.
   */
  readonly delta: string
}

/**
 * Encoded representation of reasoning delta parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningDeltaPartEncoded extends BasePartEncoded<"reasoning-delta", ReasoningDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding reasoning chunk.
   */
  readonly id: string
  /**
   * The incremental reasoning content to add.
   */
  readonly delta: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ReasoningDeltaPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ReasoningDeltaPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of reasoning delta parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReasoningDeltaPart: Schema.Struct<{
  readonly type: Schema.tag<"reasoning-delta">
  readonly id: Schema.String
  readonly delta: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("reasoning-delta"),
  id: Schema.String,
  delta: Schema.String
}).annotate({ identifier: "ReasoningDeltaPart" }) satisfies Schema.Codec<ReasoningDeltaPart, ReasoningDeltaPartEncoded>

// =============================================================================
// Reasoning End Part
// =============================================================================

/**
 * Response part indicating the end of streaming reasoning content.
 *
 * Marks the completion of a chunk of reasoning content.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningEndPart extends BasePart<"reasoning-end", ReasoningEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding reasoning chunk.
   */
  readonly id: string
}

/**
 * Encoded representation of reasoning end parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReasoningEndPartEncoded extends BasePartEncoded<"reasoning-end", ReasoningEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding reasoning chunk.
   */
  readonly id: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ReasoningEndPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ReasoningEndPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of reasoning end parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReasoningEndPart: Schema.Struct<{
  readonly type: Schema.tag<"reasoning-end">
  readonly id: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("reasoning-end"),
  id: Schema.String
}).annotate({ identifier: "ReasoningEndPart" }) satisfies Schema.Codec<ReasoningEndPart, ReasoningEndPartEncoded>

// =============================================================================
// Tool Params Start Part
// =============================================================================

/**
 * Response part indicating the start of streaming tool parameters.
 *
 * Marks the beginning of tool parameter streaming with metadata about the tool
 * call.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsStartPart extends BasePart<"tool-params-start", ToolParamsStartPartMetadata> {
  /**
   * Unique identifier for this tool parameter chunk.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: string
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted: boolean
}

/**
 * Encoded representation of tool params start parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsStartPartEncoded extends BasePartEncoded<"tool-params-start", ToolParamsStartPartMetadata> {
  /**
   * Unique identifier for this tool parameter chunk.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: string
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted?: boolean
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolParamsStartPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolParamsStartPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of tool params start parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolParamsStartPart: Schema.Struct<{
  readonly type: Schema.tag<"tool-params-start">
  readonly id: Schema.String
  readonly name: Schema.String
  readonly providerExecuted: Schema.withDecodingDefaultKey<Schema.Boolean>
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("tool-params-start"),
  id: Schema.String,
  name: Schema.String,
  providerExecuted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(constFalse))
}).annotate({ identifier: "ToolParamsStartPart" }) satisfies Schema.Codec<
  ToolParamsStartPart,
  ToolParamsStartPartEncoded
>

// =============================================================================
// Tool Params Delta Part
// =============================================================================

/**
 * Response part containing incremental tool parameter content.
 *
 * Represents a chunk of tool parameters being streamed, containing the
 * incremental JSON content that forms the tool parameters.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsDeltaPart extends BasePart<"tool-params-delta", ToolParamsDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding tool parameter chunk.
   */
  readonly id: string
  /**
   * The incremental parameter content (typically JSON fragment) to add.
   */
  readonly delta: string
}

/**
 * Encoded representation of tool params delta parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsDeltaPartEncoded extends BasePartEncoded<"tool-params-delta", ToolParamsDeltaPartMetadata> {
  /**
   * Unique identifier matching the corresponding tool parameter chunk.
   */
  readonly id: string
  /**
   * The incremental parameter content (typically JSON fragment) to add.
   */
  readonly delta: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolParamsDeltaPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolParamsDeltaPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of tool params delta parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolParamsDeltaPart: Schema.Struct<{
  readonly type: Schema.tag<"tool-params-delta">
  readonly id: Schema.String
  readonly delta: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("tool-params-delta"),
  id: Schema.String,
  delta: Schema.String
}).annotate({ identifier: "ToolParamsDeltaPart" }) satisfies Schema.Codec<
  ToolParamsDeltaPart,
  ToolParamsDeltaPartEncoded
>

// =============================================================================
// Tool Params End Part
// =============================================================================

/**
 * Response part indicating the end of streaming tool parameters.
 *
 * Marks the completion of a tool parameter stream, indicating that all
 * parameter data has been sent and the tool call is ready to be executed.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsEndPart extends BasePart<"tool-params-end", ToolParamsEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding tool parameter chunk.
   */
  readonly id: string
}

/**
 * Encoded representation of tool params end parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolParamsEndPartEncoded extends BasePartEncoded<"tool-params-end", ToolParamsEndPartMetadata> {
  /**
   * Unique identifier matching the corresponding tool parameter stream.
   */
  readonly id: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolParamsEndPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolParamsEndPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of tool params end parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolParamsEndPart: Schema.Struct<{
  readonly type: Schema.tag<"tool-params-end">
  readonly id: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("tool-params-end"),
  id: Schema.String
}).annotate({ identifier: "ToolParamsEndPart" }) satisfies Schema.Codec<ToolParamsEndPart, ToolParamsEndPartEncoded>

// =============================================================================
// Tool Call Part
// =============================================================================

/**
 * Response part representing a tool call request.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Response } from "effect/unstable/ai"
 *
 * const weatherParams = Schema.Struct({
 *   city: Schema.String,
 *   units: Schema.optional(Schema.Literals(["celsius", "fahrenheit"]))
 * })
 *
 * const toolCallPart: Response.ToolCallPart<
 *   "get_weather",
 *   {
 *     readonly city: string
 *     readonly units?: "celsius" | "fahrenheit"
 *   }
 * > = Response.makePart("tool-call", {
 *   id: "call_123",
 *   name: "get_weather",
 *   params: { city: "San Francisco", units: "celsius" },
 *   providerExecuted: false
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolCallPart<Name extends string, Params> extends BasePart<"tool-call", ToolCallPartMetadata> {
  /**
   * Unique identifier for this tool call.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: Name
  /**
   * Parameters to pass to the tool.
   */
  readonly params: Params
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted: boolean
}

/**
 * Encoded representation of tool call parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolCallPartEncoded extends BasePartEncoded<"tool-call", ToolCallPartMetadata> {
  /**
   * Unique identifier for this tool call.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: string
  /**
   * Parameters to pass to the tool.
   */
  readonly params: unknown
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted?: boolean | undefined
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolCallPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolCallPartMetadata extends ProviderMetadata {}

/**
 * Creates a Schema for tool call parts with specific tool name and parameters.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolCallPart: <const Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params
) => Schema.Struct<
  {
    readonly type: Schema.Literal<"tool-call">
    readonly id: Schema.String
    readonly name: Schema.Literal<Name>
    readonly params: Params
    readonly providerExecuted: Schema.withDecodingDefaultKey<Schema.Boolean>
    readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
    readonly metadata: Schema.withDecodingDefault<
      Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
    >
  }
> = <const Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params
) =>
  Schema.Struct({
    ...BasePart.fields,
    type: Schema.Literal("tool-call"),
    id: Schema.String,
    name: Schema.Literal(name),
    params,
    providerExecuted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(constFalse))
  }).annotate({ identifier: "ToolCallPart" }) as any

/**
 * Constructs a new tool call part.
 *
 * @since 1.0.0
 * @category constructors
 */
export const toolCallPart = <const Name extends string, Params>(
  params: ConstructorParams<ToolCallPart<Name, Params>>
): ToolCallPart<Name, Params> => makePart("tool-call", params)

// =============================================================================
// Tool Call Result Part
// =============================================================================

/**
 * The base fields of a tool result part.
 *
 * @since 1.0.0
 * @category models
 */
export interface BaseToolResult<Name extends string> extends BasePart<"tool-result", ToolResultPartMetadata> {
  /**
   * Unique identifier matching the original tool call.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: Name
  /**
   * The encoded result for serialization purposes.
   */
  readonly encodedResult: unknown
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted: boolean
  /**
   * Whether this is a preliminary (intermediate) result.
   *
   * Preliminary results represent progress updates during streaming tool
   * execution. Only the final result (where `preliminary` is `false` or
   * `undefined`) should be used as the authoritative output.
   *
   * Only applicable for framework-executed tools during streaming.
   */
  readonly preliminary: boolean
}

/**
 * Represents a successful tool call result.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolResultSuccess<Name extends string, Success> extends BaseToolResult<Name> {
  /**
   * The decoded success returned by the tool execution.
   */
  readonly result: Success
  /**
   * Whether or not the result of executing the tool call handler was an error.
   */
  readonly isFailure: false
}

/**
 * Represents a failed tool call result.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolResultFailure<Name extends string, Failure> extends BaseToolResult<Name> {
  /**
   * The decoded failure returned by the tool execution.
   */
  readonly result: Failure
  /**
   * Whether or not the result of executing the tool call handler was an error.
   */
  readonly isFailure: true
}

/**
 * Response part representing the result of a tool call.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * interface WeatherData {
 *   temperature: number
 *   condition: string
 *   humidity: number
 * }
 *
 * const toolResultPart: Response.ToolResultPart<
 *   "get_weather",
 *   WeatherData,
 *   never
 * > = Response.toolResultPart({
 *   id: "call_123",
 *   name: "get_weather",
 *   isFailure: false,
 *   result: {
 *     temperature: 22,
 *     condition: "sunny",
 *     humidity: 65
 *   },
 *   encodedResult: {
 *     temperature: 22,
 *     condition: "sunny",
 *     humidity: 65
 *   },
 *   providerExecuted: false,
 *   preliminary: false
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export type ToolResultPart<Name extends string, Success, Failure> =
  | ToolResultSuccess<Name, Success>
  | ToolResultFailure<Name, Failure>

/**
 * Encoded representation of tool result parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolResultPartEncoded extends BasePartEncoded<"tool-result", ToolResultPartMetadata> {
  /**
   * Unique identifier matching the original tool call.
   */
  readonly id: string
  /**
   * Name of the tool being called, which corresponds to the name of the tool
   * in the `Toolkit` included with the request.
   */
  readonly name: string
  /**
   * The result returned by the tool execution.
   */
  readonly result: unknown
  /**
   * Whether or not the result of executing the tool call handler was an error.
   */
  readonly isFailure: boolean
  /**
   * Whether the tool was executed by the provider (true) or framework (false).
   */
  readonly providerExecuted?: boolean | undefined
  /**
   * Whether this is a preliminary (intermediate) result.
   *
   * Only applicable for framework-executed tools during streaming.
   */
  readonly preliminary?: boolean | undefined
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolResultPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolResultPartMetadata extends ProviderMetadata {}

/**
 * Creates a Schema for tool result parts with specific tool name and result type.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolResultPart: <const Name extends string, Success extends Schema.Top, Failure extends Schema.Top>(
  name: Name,
  success: Success,
  failure: Failure
) => Schema.decodeTo<
  Schema.Struct<
    {
      readonly "~effect/ai/Content/Part": Schema.Literal<"~effect/ai/Content/Part">
      readonly result: Schema.Union<readonly [Success, Failure]>
      readonly providerExecuted: Schema.Boolean
      readonly metadata: Schema.$Record<
        Schema.String,
        Schema.NullOr<Schema.Codec<Schema.Json>>
      >
      readonly encodedResult: Schema.toEncoded<Schema.Union<readonly [Success, Failure]>>
      readonly preliminary: Schema.Boolean
      readonly id: Schema.String
      readonly type: Schema.Literal<"tool-result">
      readonly isFailure: Schema.Boolean
      readonly name: Schema.Literal<Name>
    }
  >,
  Schema.Struct<
    {
      readonly result: Schema.toEncoded<Schema.Union<readonly [Success, Failure]>>
      readonly providerExecuted: Schema.optional<Schema.Boolean>
      readonly metadata: Schema.optional<
        Schema.$Record<Schema.String, Schema.NullOr<Schema.Codec<Schema.Json>>>
      >
      readonly preliminary: Schema.optional<Schema.Boolean>
      readonly id: Schema.String
      readonly type: Schema.Literal<"tool-result">
      readonly isFailure: Schema.Boolean
      readonly name: Schema.Literal<Name>
    }
  >
> = <
  const Name extends string,
  Success extends Schema.Top,
  Failure extends Schema.Top
>(
  name: Name,
  success: Success,
  failure: Failure
) => {
  const ResultSchema = Schema.Union([success, failure])
  const Common = {
    id: Schema.String,
    type: Schema.Literal("tool-result"),
    isFailure: Schema.Boolean,
    name: Schema.Literal(name)
  }
  const Decoded = Schema.Struct({
    ...Common,
    [PartTypeId]: Schema.Literal(PartTypeId),
    result: ResultSchema,
    providerExecuted: Schema.Boolean,
    metadata: ProviderMetadata,
    encodedResult: Schema.toEncoded(ResultSchema),
    preliminary: Schema.Boolean
  })
  const Encoded = Schema.Struct({
    ...Common,
    result: Schema.toEncoded(ResultSchema),
    providerExecuted: Schema.optional(Schema.Boolean),
    metadata: Schema.optional(ProviderMetadata),
    preliminary: Schema.optional(Schema.Boolean)
  })
  return Decoded.pipe(Schema.encodeTo(
    Encoded,
    SchemaTransformation.transform({
      decode: (encoded) => ({
        ...encoded,
        [PartTypeId]: PartTypeId,
        providerExecuted: encoded.providerExecuted ?? false,
        metadata: encoded.metadata ?? {},
        encodedResult: encoded.result,
        preliminary: encoded.preliminary ?? false
      }),
      encode: identity
    })
  )).annotate({ identifier: `ToolResultPart(${name})` }) satisfies Schema.Codec<
    ToolResultPart<Name, Success["Type"], Failure["Type"]>,
    ToolResultPartEncoded,
    Success["EncodingServices"] | Failure["EncodingServices"],
    Success["DecodingServices"] | Failure["DecodingServices"]
  >
}

/**
 * Constructs a new tool result part.
 *
 * @since 1.0.0
 * @category constructors
 */
export const toolResultPart = <const Params extends ConstructorParams<ToolResultPart<string, unknown, unknown>>>(
  params: Params
): Params extends {
  readonly name: infer Name extends string
  readonly isFailure: false
  readonly result: infer Success
} ? ToolResultPart<Name, Success, never>
  : Params extends {
    readonly name: infer Name extends string
    readonly isFailure: true
    readonly result: infer Failure
  } ? ToolResultPart<Name, never, Failure>
  : never => makePart("tool-result", params) as any

// =============================================================================
// Tool Approval Request Part
// =============================================================================

/**
 * Response part representing a tool approval request.
 *
 * Emitted when a tool requires user approval before execution. The framework
 * checks the tool's `needsApproval` property and emits this part instead of
 * executing the tool when approval is required.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const approvalRequest: Response.ToolApprovalRequestPart = Response.makePart(
 *   "tool-approval-request",
 *   {
 *     approvalId: "approval_123",
 *     toolCallId: "call_456"
 *   }
 * )
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolApprovalRequestPart extends BasePart<"tool-approval-request", ToolApprovalRequestPartMetadata> {
  /**
   * Unique identifier for this approval flow.
   */
  readonly approvalId: string
  /**
   * The tool call ID requiring approval.
   */
  readonly toolCallId: string
}

/**
 * Encoded representation of tool approval request parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ToolApprovalRequestPartEncoded
  extends BasePartEncoded<"tool-approval-request", ToolApprovalRequestPartMetadata>
{
  /**
   * Unique identifier for this approval flow.
   */
  readonly approvalId: string
  /**
   * The tool call ID requiring approval.
   */
  readonly toolCallId: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ToolApprovalRequestPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ToolApprovalRequestPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of tool approval request parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToolApprovalRequestPart: Schema.Struct<{
  readonly type: Schema.tag<"tool-approval-request">
  readonly approvalId: Schema.String
  readonly toolCallId: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("tool-approval-request"),
  approvalId: Schema.String,
  toolCallId: Schema.String
}).annotate({ identifier: "ToolApprovalRequestPart" }) satisfies Schema.Codec<
  ToolApprovalRequestPart,
  ToolApprovalRequestPartEncoded
>

/**
 * Constructs a new tool approval request part.
 *
 * @since 1.0.0
 * @category constructors
 */
export const toolApprovalRequestPart = (
  params: ConstructorParams<ToolApprovalRequestPart>
): ToolApprovalRequestPart => makePart("tool-approval-request", params as any)

// =============================================================================
// File Part
// =============================================================================

/**
 * Response part representing a file attachment.
 *
 * Supports various file types including images, documents, and binary data.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const imagePart: Response.FilePart = Response.makePart("file", {
 *   mediaType: "image/jpeg",
 *   data: new Uint8Array([1, 2, 3])
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface FilePart extends BasePart<"file", FilePartMetadata> {
  /**
   * MIME type of the file (e.g., "image/jpeg", "application/pdf").
   */
  readonly mediaType: string
  /**
   * File data as a byte array.
   */
  readonly data: Uint8Array
}

/**
 * Encoded representation of file parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface FilePartEncoded extends BasePartEncoded<"file", FilePartMetadata> {
  /**
   * MIME type of the file (e.g., "image/jpeg", "application/pdf").
   */
  readonly mediaType: string
  /**
   * File data as a base64 string.
   */
  readonly data: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `FilePart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface FilePartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of file parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FilePart: Schema.Struct<{
  readonly type: Schema.tag<"file">
  readonly mediaType: Schema.String
  readonly data: Schema.Uint8ArrayFromBase64
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("file"),
  mediaType: Schema.String,
  data: Schema.Uint8ArrayFromBase64
}).annotate({ identifier: "FilePart" }) satisfies Schema.Codec<FilePart, FilePartEncoded>

// =============================================================================
// Document Source Part
// =============================================================================

/**
 * Response part representing a document source reference.
 *
 * Used to reference documents that were used in generating the response.
 *
 * @since 1.0.0
 * @category models
 */
export interface DocumentSourcePart extends BasePart<"source", DocumentSourcePartMetadata> {
  /**
   * Type discriminator for document sources.
   */
  readonly sourceType: "document"
  /**
   * Unique identifier for the document.
   */
  readonly id: string
  /**
   * MIME type of the document.
   */
  readonly mediaType: string
  /**
   * Display title of the document.
   */
  readonly title: string
  /**
   * Optional filename of the document.
   */
  readonly fileName?: string
}

/**
 * Encoded representation of document source parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface DocumentSourcePartEncoded extends BasePartEncoded<"source", DocumentSourcePartMetadata> {
  /**
   * Type discriminator for document sources.
   */
  readonly sourceType: "document"
  /**
   * Unique identifier for the document.
   */
  readonly id: string
  /**
   * MIME type of the document.
   */
  readonly mediaType: string
  /**
   * Display title of the document.
   */
  readonly title: string
  /**
   * Optional filename of the document.
   */
  readonly fileName?: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `DocumentSourcePart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface DocumentSourcePartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of document source parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const DocumentSourcePart: Schema.Struct<{
  readonly type: Schema.tag<"source">
  readonly sourceType: Schema.tag<"document">
  readonly id: Schema.String
  readonly mediaType: Schema.String
  readonly title: Schema.String
  readonly fileName: Schema.optionalKey<Schema.String>
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("source"),
  sourceType: Schema.tag("document"),
  id: Schema.String,
  mediaType: Schema.String,
  title: Schema.String,
  fileName: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "DocumentSourcePart" }) satisfies Schema.Codec<DocumentSourcePart, DocumentSourcePartEncoded>

// =============================================================================
// Url Source Part
// =============================================================================

/**
 * Response part representing a URL source reference.
 *
 * Used to reference web URLs that were used in generating the response.
 *
 * @since 1.0.0
 * @category models
 */
export interface UrlSourcePart extends BasePart<"source", UrlSourcePartMetadata> {
  /**
   * Type discriminator for URL sources.
   */
  readonly sourceType: "url"
  /**
   * Unique identifier for the URL.
   */
  readonly id: string
  /**
   * The URL that was referenced.
   */
  readonly url: URL
  /**
   * Display title of the URL content.
   */
  readonly title: string
}

/**
 * Encoded representation of URL source parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface UrlSourcePartEncoded extends BasePartEncoded<"source", UrlSourcePartMetadata> {
  /**
   * Type discriminator for URL sources.
   */
  readonly sourceType: "url"
  /**
   * Unique identifier for the URL.
   */
  readonly id: string
  /**
   * The URL that was referenced as a string.
   */
  readonly url: string
  /**
   * Display title of the URL content.
   */
  readonly title: string
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `UrlSourcePart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface UrlSourcePartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of url source parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const UrlSourcePart: Schema.Struct<{
  readonly type: Schema.tag<"source">
  readonly sourceType: Schema.tag<"url">
  readonly id: Schema.String
  readonly url: Schema.URLFromString
  readonly title: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("source"),
  sourceType: Schema.tag("url"),
  id: Schema.String,
  url: Schema.URLFromString,
  title: Schema.String
}).annotate({ identifier: "UrlSourcePart" }) satisfies Schema.Codec<UrlSourcePart, UrlSourcePartEncoded>

// =============================================================================
// HTTP Details
// =============================================================================

/**
 * Schema for HTTP request details associated with an AI response.
 *
 * Captures comprehensive information about the HTTP request made to the
 * AI provider, enabling inspection of request metadata for debugging and
 * observability purposes.
 *
 * @example
 * ```ts
 * import type { Response } from "effect/unstable/ai"
 *
 * const requestDetails: typeof Response.HttpRequestDetails.Type = {
 *   method: "POST",
 *   url: "https://api.openai.com/v1/responses",
 *   urlParams: [],
 *   hash: undefined,
 *   headers: { "Content-Type": "application/json" }
 * }
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export const HttpRequestDetails = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS", "TRACE"]),
  url: Schema.String,
  urlParams: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  hash: Schema.UndefinedOr(Schema.String),
  headers: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Redacted(Schema.String)
    ])
  )
}).annotate({ identifier: "HttpRequestDetails" })

/**
 * Schema for HTTP response details associated with an AI response.
 *
 * Captures essential information about the HTTP response received from
 * the AI provider, including status codes and headers for debugging and
 * observability purposes.
 *
 * @example
 * ```ts
 * import type { Response } from "effect/unstable/ai"
 *
 * const responseDetails: typeof Response.HttpResponseDetails.Type = {
 *   status: 200,
 *   headers: {
 *     "Content-Type": "application/json",
 *     "X-Request-Id": "req_abc123"
 *   }
 * }
 * ```
 *
 * @since 1.0.0
 * @category schemas
 */
export const HttpResponseDetails = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Redacted(Schema.String)
    ])
  )
}).annotate({ identifier: "HttpResponseDetails" })

// =============================================================================
// Response Metadata Part
// =============================================================================

/**
 * Response part containing metadata about the large language model response.
 *
 * @example
 * ```ts
 * import { DateTime } from "effect"
 * import { Response } from "effect/unstable/ai"
 *
 * const metadataPart: Response.ResponseMetadataPart = Response.makePart(
 *   "response-metadata",
 *   {
 *     id: "resp_123",
 *     modelId: "gpt-4",
 *     timestamp: DateTime.nowUnsafe(),
 *     request: undefined
 *   }
 * )
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface ResponseMetadataPart extends BasePart<"response-metadata", ResponseMetadataPartMetadata> {
  /**
   * Optional unique identifier for this specific response.
   */
  readonly id: string | undefined
  /**
   * Optional identifier of the AI model that generated the response.
   */
  readonly modelId: string | undefined
  /**
   * Optional timestamp when the response was generated.
   */
  readonly timestamp: DateTime.Utc | undefined
  /**
   * Optional HTTP request details for the request made to the AI provider.
   */
  readonly request: typeof HttpRequestDetails.Type | undefined
}

/**
 * Encoded representation of response metadata parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResponseMetadataPartEncoded
  extends BasePartEncoded<"response-metadata", ResponseMetadataPartMetadata>
{
  /**
   * Optional unique identifier for this specific response.
   */
  readonly id?: string | undefined
  /**
   * Optional identifier of the AI model that generated the response.
   */
  readonly modelId?: string | undefined
  /**
   * Optional timestamp when the response was generated.
   */
  readonly timestamp?: string | undefined
  /**
   * Optional HTTP request details for the request made to the AI provider.
   */
  readonly request?: typeof HttpRequestDetails.Encoded | undefined
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ResponseMetadataPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ResponseMetadataPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of response metadata parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ResponseMetadataPart: Schema.Struct<{
  readonly type: Schema.tag<"response-metadata">
  readonly id: Schema.UndefinedOr<Schema.String>
  readonly modelId: Schema.UndefinedOr<Schema.String>
  readonly timestamp: Schema.UndefinedOr<Schema.DateTimeUtcFromString>
  readonly request: Schema.UndefinedOr<typeof HttpRequestDetails>
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("response-metadata"),
  id: Schema.UndefinedOr(Schema.String),
  modelId: Schema.UndefinedOr(Schema.String),
  timestamp: Schema.UndefinedOr(Schema.DateTimeUtcFromString),
  request: Schema.UndefinedOr(HttpRequestDetails)
}).annotate({ identifier: "ResponseMetadataPart" }) satisfies Schema.Codec<
  ResponseMetadataPart,
  ResponseMetadataPartEncoded
>

// =============================================================================
// Finish Part
// =============================================================================

/**
 * Represents the reason why a model finished generation of a response.
 *
 * Possible finish reasons:
 * - `"stop"`: The model generated a stop sequence.
 * - `"length"`: The model exceeded its token budget.
 * - `"content-filter"`: The model generated content which violated a content filter.
 * - `"tool-calls"`: The model triggered a tool call.
 * - `"error"`: The model encountered an error.
 * - `"pause"`: The model requested to pause execution.
 * - `"other"`: The model stopped for a reason not supported by this protocol.
 * - `"unknown"`: The model did not specify a finish reason.
 *
 * @since 1.0.0
 * @category models
 */
export const FinishReason: Schema.Literals<[
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "pause",
  "other",
  "unknown"
]> = Schema.Literals([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "pause",
  "other",
  "unknown"
])

/**
 * @since 1.0.0
 * @category models
 */
export type FinishReason = typeof FinishReason.Type

/**
 * Represents usage information for a request to a large language model provider.
 *
 * If the model provider returns additional usage information than what is
 * specified here, you can generally find that information under the provider
 * metadata of the finish part of the response.
 *
 * @since 1.0.0
 * @category models
 */
export class Usage extends Schema.Class<Usage>("effect/ai/AiResponse/Usage")({
  /**
   * Information about input (i.e. prompt) token utilization.
   */
  inputTokens: Schema.Struct({
    /**
     * The number of non-cached input (i.e. prompt) tokens used.
     */
    uncached: Schema.UndefinedOr(Schema.Number),
    /**
     * The total of number of input (i.e. prompt) tokens used.
     */
    total: Schema.UndefinedOr(Schema.Number),
    /**
     * The number of cached input (i.e. prompt) tokens read.
     */
    cacheRead: Schema.UndefinedOr(Schema.Number),
    /**
     * The number of cached input (i.e. prompt) tokens written.
     */
    cacheWrite: Schema.UndefinedOr(Schema.Number)
  }),
  /**
   * Information about the output (i.e. response) tokens used.
   */
  outputTokens: Schema.Struct({
    /**
     * The total of number of output (i.e. response) tokens used.
     */
    total: Schema.UndefinedOr(Schema.Number),
    /**
     * The number of text tokens used.
     */
    text: Schema.UndefinedOr(Schema.Number),
    /**
     * The number of reasoning tokens used.
     */
    reasoning: Schema.UndefinedOr(Schema.Number)
  })
}) {}

/**
 * Response part indicating the completion of a response generation.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const finishPart: Response.FinishPart = Response.makePart("finish", {
 *   reason: "stop",
 *   usage: new Response.Usage({
 *     inputTokens: {
 *       uncached: undefined,
 *       total: 50,
 *       cacheRead: undefined,
 *       cacheWrite: undefined
 *     },
 *     outputTokens: {
 *       total: 25,
 *       text: undefined,
 *       reasoning: undefined
 *     }
 *   }),
 *   response: undefined
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface FinishPart extends BasePart<"finish", FinishPartMetadata> {
  /**
   * The reason why the model finished generating the response.
   */
  readonly reason: FinishReason
  /**
   * Token usage statistics for the request.
   */
  readonly usage: Usage
  /**
   * Optional HTTP response details from the AI provider.
   */
  readonly response: typeof HttpResponseDetails.Type | undefined
}

/**
 * Encoded representation of finish parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface FinishPartEncoded extends BasePartEncoded<"finish", FinishPartMetadata> {
  /**
   * The reason why the model finished generating the response.
   */
  readonly reason: typeof FinishReason.Encoded
  /**
   * Token usage statistics for the request.
   */
  readonly usage: typeof Usage.Encoded
  /**
   * Optional HTTP response details from the AI provider.
   */
  readonly response?: typeof HttpResponseDetails.Encoded | undefined
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `FinishPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface FinishPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of finish parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FinishPart: Schema.Struct<{
  readonly type: Schema.tag<"finish">
  readonly reason: Schema.Literals<[
    "stop",
    "length",
    "content-filter",
    "tool-calls",
    "error",
    "pause",
    "other",
    "unknown"
  ]>
  readonly usage: typeof Usage
  readonly response: Schema.UndefinedOr<typeof HttpResponseDetails>
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("finish"),
  reason: FinishReason,
  usage: Usage,
  response: Schema.UndefinedOr(HttpResponseDetails)
}).annotate({ identifier: "FinishPart" }) satisfies Schema.Codec<FinishPart, FinishPartEncoded>

// =============================================================================
// Error Part
// =============================================================================

/**
 * Response part indicating that an error occurred generating the response.
 *
 * @example
 * ```ts
 * import { Response } from "effect/unstable/ai"
 *
 * const errorPart: Response.ErrorPart = Response.makePart("error", {
 *   error: new Error("boom")
 * })
 * ```
 *
 * @since 1.0.0
 * @category models
 */
export interface ErrorPart extends BasePart<"error", ErrorPartMetadata> {
  readonly error: unknown
}

/**
 * Encoded representation of error parts for serialization.
 *
 * @since 1.0.0
 * @category models
 */
export interface ErrorPartEncoded extends BasePartEncoded<"error", ErrorPartMetadata> {
  readonly error: unknown
}

/**
 * Represents provider-specific metadata that can be associated with a
 * `ErrorPart` through module augmentation.
 *
 * @since 1.0.0
 * @category provider options
 */
export interface ErrorPartMetadata extends ProviderMetadata {}

/**
 * Schema for validation and encoding of error parts.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ErrorPart: Schema.Struct<{
  readonly type: Schema.tag<"error">
  readonly error: Schema.Unknown
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<
    Schema.$Record<Schema.String, Schema.Codec<Schema.Json>>
  >
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("error"),
  error: Schema.Unknown
}).annotate({ identifier: "ErrorPart" }) satisfies Schema.Codec<ErrorPart, ErrorPartEncoded>
