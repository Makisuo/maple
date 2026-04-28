import type { Effect } from "effect"
import { Schema } from "effect"

export class McpTenantError extends Schema.TaggedErrorClass<McpTenantError>()(
	"@maple/mcp/errors/McpTenantError",
	{ message: Schema.String },
) {}

export class McpAuthMissingError extends Schema.TaggedErrorClass<McpAuthMissingError>()(
	"@maple/mcp/errors/McpAuthMissingError",
	{ message: Schema.String, header: Schema.optionalKey(Schema.String) },
) {}

export class McpAuthInvalidError extends Schema.TaggedErrorClass<McpAuthInvalidError>()(
	"@maple/mcp/errors/McpAuthInvalidError",
	{ message: Schema.String, reason: Schema.optionalKey(Schema.String) },
) {}

export class McpInvalidTenantError extends Schema.TaggedErrorClass<McpInvalidTenantError>()(
	"@maple/mcp/errors/McpInvalidTenantError",
	{ message: Schema.String, field: Schema.String },
) {}

export class McpQueryError extends Schema.TaggedErrorClass<McpQueryError>()(
	"@maple/mcp/errors/McpQueryError",
	{ message: Schema.String, pipe: Schema.String, cause: Schema.optionalKey(Schema.Defect) },
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

export const requiredStringParam = (description: string) => Schema.String.annotate({ description })

export const optionalStringParam = (description: string) =>
	Schema.optional(Schema.String).annotate({ description })

export const optionalNumberParam = (description: string) =>
	Schema.optional(Schema.Number).annotate({ description })

export const optionalBooleanParam = (description: string) =>
	Schema.optional(Schema.Boolean).annotate({ description })

/**
 * Create a validation error response with an optional usage example.
 * Including examples helps LLMs self-correct on retry.
 */
export function validationError(message: string, example?: string): McpToolResult {
	const text = example ? `${message}\n\nExample:\n  ${example}` : message
	return { isError: true, content: [{ type: "text", text }] }
}
