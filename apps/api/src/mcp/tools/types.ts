import type { Effect } from "effect"
import { Schema } from "effect"

export class McpTenantError extends Schema.TaggedErrorClass<McpTenantError>()(
  "McpTenantError",
  { message: Schema.String },
) {}

export class McpQueryError extends Schema.TaggedErrorClass<McpQueryError>()(
  "McpQueryError",
  { message: Schema.String, pipe: Schema.String },
) {}

export type McpToolError = McpTenantError | McpQueryError

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface McpToolRegistrar {
  tool<TSchema extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    description: string,
    schema: TSchema,
    handler: (params: Schema.Schema.Type<TSchema>) => Effect.Effect<McpToolResult, McpToolError, any>,
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
