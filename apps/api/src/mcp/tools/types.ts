import type { Effect } from "effect"
import * as Schema from "effect/Schema"

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface McpToolRegistrar {
  tool<TFields extends Schema.Struct.Fields>(
    name: string,
    description: string,
    schema: TFields,
    handler: (params: Schema.Struct.Type<TFields>) => Effect.Effect<McpToolResult, never, any>,
  ): void
}

export const requiredStringParam = (description: string) =>
  Schema.String.annotations({ description })

export const optionalStringParam = (description: string) =>
  Schema.optional(Schema.String).annotations({ description })

export const optionalNumberParam = (description: string) =>
  Schema.optional(Schema.Number).annotations({ description })

export const optionalBooleanParam = (description: string) =>
  Schema.optional(Schema.Boolean).annotations({ description })
