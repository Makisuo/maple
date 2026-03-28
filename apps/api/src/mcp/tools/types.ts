import type { Effect } from "effect"
import { Schema } from "effect"

export class McpTenantError extends Schema.TaggedErrorClass<McpTenantError>()(
  "McpTenantError",
  { message: Schema.String },
) {}

export class McpAuthMissingError extends Schema.TaggedErrorClass<McpAuthMissingError>()(
  "McpAuthMissingError",
  { message: Schema.String },
) {}

export class McpAuthInvalidError extends Schema.TaggedErrorClass<McpAuthInvalidError>()(
  "McpAuthInvalidError",
  { message: Schema.String },
) {}

export class McpInvalidTenantError extends Schema.TaggedErrorClass<McpInvalidTenantError>()(
  "McpInvalidTenantError",
  { message: Schema.String, field: Schema.String },
) {}

export class McpQueryError extends Schema.TaggedErrorClass<McpQueryError>()(
  "McpQueryError",
  { message: Schema.String, pipe: Schema.String },
) {}

export type McpToolError =
  | McpTenantError
  | McpAuthMissingError
  | McpAuthInvalidError
  | McpInvalidTenantError
  | McpQueryError

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface McpToolRegistrar {
  tool<TSchema extends Schema.Decoder<unknown, never>>(
    name: string,
    description: string,
    schema: TSchema,
    handler: (params: TSchema["Type"]) => Effect.Effect<McpToolResult, McpToolError, any>,
  ): void
}

export const requiredStringParam = (description: string) =>
  Schema.String.annotate({ description })

export const optionalStringParam = (description: string) =>
  Schema.optional(Schema.String).annotate({ description })

export const optionalNumberParam = (description: string) =>
  Schema.optional(Schema.Number).annotate({ description })

export const optionalBooleanParam = (description: string) =>
  Schema.optional(Schema.Boolean).annotate({ description })
