import { Schema } from "effect"

/**
 * Schema that decodes a JSON-encoded string into a string array.
 * Handles the case where TanStack Router's parseSearch produces a string
 * (e.g. URL has `?param="[\"val\"]"` which JSON-parses to the string `["val"]`).
 */
const StringArrayFromJsonString = Schema.transform(Schema.String, Schema.Array(Schema.String), {
  strict: true,
  decode: (s) => {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed
      return [s]
    } catch {
      return [s]
    }
  },
  encode: (a) => JSON.stringify(a),
})

/**
 * Use this for URL search param array fields. Accepts both a real array
 * and a JSON-encoded string, preventing crashes from malformed URLs.
 */
export const OptionalStringArrayParam = Schema.optional(
  Schema.mutable(Schema.Union(Schema.Array(Schema.String), StringArrayFromJsonString)),
)
