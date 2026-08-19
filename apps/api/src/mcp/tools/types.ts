import type { Effect } from "effect"
import { Schema, SchemaTransformation } from "effect"
import type { McpToolRequirements } from "./runtime-requirements"

class McpTenantError extends Schema.TaggedError<McpTenantError>()("@maple/mcp/errors/McpTenantError", {
	message: Schema.String,
}) {}

export class McpAuthMissingError extends Schema.TaggedError<McpAuthMissingError>()(
	"@maple/mcp/errors/McpAuthMissingError",
	{ message: Schema.String, header: Schema.optionalKey(Schema.String) },
) {}

export class McpAuthInvalidError extends Schema.TaggedError<McpAuthInvalidError>()(
	"@maple/mcp/errors/McpAuthInvalidError",
	{ message: Schema.String, reason: Schema.optionalKey(Schema.String) },
) {}

export class McpAuthUnavailableError extends Schema.TaggedError<McpAuthUnavailableError>()(
	"@maple/mcp/errors/McpAuthUnavailableError",
	{ message: Schema.String },
) {}

export class McpInvalidTenantError extends Schema.TaggedError<McpInvalidTenantError>()(
	"@maple/mcp/errors/McpInvalidTenantError",
	{ message: Schema.String, field: Schema.String },
) {}

export class McpQueryError extends Schema.TaggedError<McpQueryError>()("@maple/mcp/errors/McpQueryError", {
	message: Schema.String,
	pipeName: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type McpToolError =
	| McpTenantError
	| McpAuthMissingError
	| McpAuthInvalidError
	| McpAuthUnavailableError
	| McpInvalidTenantError
	| McpQueryError

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>
	isError?: boolean
}

export interface McpToolRegistrar {
	tool<TSchema extends Schema.Codec<unknown, unknown, never, unknown>, R extends McpToolRequirements>(
		name: string,
		description: string,
		schema: TSchema,
		handler: (params: TSchema["Type"]) => Effect.Effect<McpToolResult, McpToolError, R>,
	): void
}

export const requiredStringParam = (description: string) => Schema.String.annotate({ description })

export const optionalStringParam = (description: string) =>
	Schema.optional(Schema.String).annotate({ description })

/**
 * Numeric parameters accept a number OR a numeric string, and publish as
 * `anyOf: [{type: "number"}, {type: "string"}]`.
 *
 * Two defects, fixed together because they share one cause — how `Schema.Number`
 * renders:
 *
 *  1. `Schema.Number` has to encode `Infinity`/`NaN`, which JSON cannot hold, so
 *     it published every numeric parameter as
 *     `anyOf: [{type: "number"}, {type: "string", enum: ["Infinity", "-Infinity", "NaN"]}]`.
 *     A model reading that sees a numeric parameter whose type is "number or
 *     string" and reasonably emits `"1500"` — which the decoder then rejected
 *     with `Expected number | undefined at ["max_duration_ms"]`. The published
 *     schema invited the exact input it refused. `Schema.Finite` renders as a
 *     plain `{type: "number"}` and drops the non-finite branch, which none of
 *     these parameters (durations, limits, offsets, HTTP statuses) can use
 *     anyway — an infinite limit reaching the warehouse is a bug, not a value.
 *  2. Accepting only a raw number was needlessly strict for callers that are
 *     LLMs, including our own auto-investigation agent (`investigation.hypothesis`
 *     spans produced most of these). `NumberFromString` still rejects anything
 *     that is not a number ("soon", "1500ms", ""), so this widens the accepted
 *     encodings, not the accepted values.
 *
 * Both checks on the string branch are load-bearing, not belt-and-braces:
 * `NumberFromString` is `Number(s)`, which does not validate. Without `isFinite`,
 * `"soon"` decodes to `NaN`; without the blank guard, `""` and `"   "` decode to
 * `0` — a model's way of saying "no value" would silently become `limit: 0` or
 * `max_duration_ms: 0` and return an empty result set instead of an error.
 */
const NumericString = Schema.String.check(
	Schema.makeFilter((value: string) => value.trim().length > 0, {
		title: "nonBlankNumericString",
		description: "a non-blank string that will be decoded as a finite number",
		// Without `expected` the failure renders as the useless `Expected <filter>`.
		// These messages are read by models mid-tool-call and are their only chance
		// to self-correct, so the blank case has to name the fix — `Schema.Finite`
		// already supplies "Expected a finite number" for the non-numeric case.
		expected: "a number, or omit the parameter (an empty string is not a number)",
	}),
).pipe(Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString))

export const optionalNumberParam = (description: string) =>
	Schema.optional(Schema.Union([Schema.Finite, NumericString])).annotate({ description })

export const optionalBooleanParam = (description: string) =>
	Schema.optional(Schema.Boolean).annotate({ description })

export const requiredBooleanParam = (description: string) => Schema.Boolean.annotate({ description })

/**
 * Create a validation error response with an optional usage example.
 * Including examples helps LLMs self-correct on retry.
 */
export function validationError(message: string, example?: string): McpToolResult {
	const text = example ? `${message}\n\nExample:\n  ${example}` : message
	return { isError: true, content: [{ type: "text", text }] }
}
