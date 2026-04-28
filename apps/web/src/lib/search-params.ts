import { Schema } from "effect"

/**
 * Schema that decodes a JSON-encoded string into a string array.
 * Handles the case where TanStack Router's parseSearch produces a string
 * (e.g. URL has `?param="[\"val\"]"` which JSON-parses to the string `["val"]`).
 */
const MutableStringArray = Schema.mutable(Schema.Array(Schema.String))
const StringArrayFromJsonString = Schema.mutable(Schema.fromJsonString(Schema.Array(Schema.String)))

export const BooleanFromStringParam = Schema.fromJsonString(Schema.Boolean)

/**
 * Use this for URL search param array fields. Accepts both a real array
 * and a JSON-encoded string, preventing crashes from malformed URLs.
 */
export const OptionalStringArrayParam = Schema.optional(
	Schema.Union([MutableStringArray, StringArrayFromJsonString]),
)
