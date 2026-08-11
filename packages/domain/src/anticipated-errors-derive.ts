// Reflection-based derivation of the anticipated (4xx) error identifiers.
//
// This module imports the ENTIRE domain HTTP surface (`./http/index` and
// `./http/v2/index`) and walks every exported error class, so evaluating it
// constructs every endpoint/error schema in the package. That is exactly why it
// is split from `./anticipated-errors`: the worker entrypoint needs the
// identifier SET at isolate startup (to classify span statuses), but must not
// pay ~600KB of schema construction inside Cloudflare's startup CPU budget.
//
// The set consumed at runtime lives in `./generated/anticipated-error-identifiers.ts`
// (regenerate with `bun run gen:anticipated-errors` in packages/domain); the
// test in `anticipated-errors.test.ts` re-derives via this module and fails on
// drift, so a new 4xx error is still picked up automatically — at codegen/test
// time instead of every cold start.
import * as Http from "./http/index"
import * as HttpV2 from "./http/v2/index"

/** Read `obj[key]` when `obj` is an object/function that has it; `undefined` otherwise. */
const prop = (obj: unknown, key: string): unknown =>
	(typeof obj === "object" || typeof obj === "function") && obj !== null && key in obj
		? (obj as Record<string, unknown>)[key]
		: undefined

/** Stable runtime identifier: tagged errors use `_tag`; Schema.Error uses its class identifier/name. */
const readIdentifier = (value: unknown): string | undefined => {
	const literal = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	if (typeof literal === "string") return literal
	const identifier = prop(value, "identifier")
	return typeof identifier === "string" ? identifier : undefined
}

/** The `httpApiStatus` annotation on a schema's AST, when present. */
const readHttpStatus = (value: unknown): number | undefined => {
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	return typeof status === "number" ? status : undefined
}

/**
 * Identifiers that can't be derived from our own exports because Effect owns the
 * class. `HttpApiSchemaError` is Effect's request-decode failure — it always
 * responds 400, so by the 4xx→Ok rule it belongs here. It was also the
 * worst offender for legibility: its `message` is its `kind`, so a failed decode
 * arrived as an Error span whose entire description was the word "Payload".
 */
export const EXTERNAL_ANTICIPATED_IDENTIFIERS = ["HttpApiSchemaError"] as const

/**
 * Derive the full identifier set by reflection over the domain HTTP exports.
 * Tagged errors contribute `_tag`; v2 Schema.Error values contribute `Error.name`.
 */
export const deriveAnticipatedIdentifiers = (): ReadonlySet<string> => {
	const identifiers = new Set<string>(EXTERNAL_ANTICIPATED_IDENTIFIERS)
	for (const value of [...Object.values(Http), ...Object.values(HttpV2)]) {
		if (typeof value !== "function") continue
		const identifier = readIdentifier(value)
		if (identifier === undefined) continue
		const status = readHttpStatus(value)
		if (status === undefined) continue
		if (status >= 400 && status < 500) identifiers.add(identifier)
	}
	return identifiers
}
