// BOUNDARY: Reflection reads heterogeneous schema/class exports and narrows every value before use.
// Reflection-based derivation of anticipated (4xx) error identifiers.
//
// This module intentionally imports the entire domain HTTP surface and must not
// be imported by a worker entrypoint. The generator and drift test pay that cost
// once outside production; runtime code consumes the generated literal list in
// `generated/anticipated-error-identifiers.ts`.
import * as Http from "./http/index"
import * as HttpV2 from "./http/v2/index"

/** Read `obj[key]` when `obj` is an object/function that has it; `undefined` otherwise. */
const prop = (obj: unknown, key: string): unknown =>
	(typeof obj === "object" || typeof obj === "function") && obj !== null && key in obj
		? (obj as Record<string, unknown>)[key]
		: undefined

/** Stable runtime identifier from a v2 definition or tagged-error class. */
const readIdentifier = (value: unknown): string | undefined => {
	const tag = prop(value, "tag")
	if (typeof tag === "string") return tag
	const literal = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	if (typeof literal === "string") return literal
	const identifier = prop(value, "identifier")
	return typeof identifier === "string" ? identifier : undefined
}

/** The `httpApiStatus` annotation on a schema's AST, when present. */
const readHttpStatus = (value: unknown): number | undefined => {
	const status = prop(value, "status")
	if (typeof status === "number") return status
	const annotation = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	return typeof annotation === "number" ? annotation : undefined
}

/**
 * Identifiers that cannot be derived from Maple exports because Effect owns the
 * class. `HttpApiSchemaError` is Effect's request-decode failure and responds
 * with 400, so the HTTP 4xx → Ok telemetry rule applies.
 */
export const EXTERNAL_ANTICIPATED_IDENTIFIERS = ["HttpApiSchemaError"] as const

const exportedValues = <Namespace extends object>(namespace: Namespace): ReadonlyArray<unknown> =>
	Object.values(namespace)

/** Derive the full 4xx identifier set from the authoritative domain contracts. */
export const deriveAnticipatedIdentifiers = (): ReadonlySet<string> => {
	const identifiers = new Set<string>(EXTERNAL_ANTICIPATED_IDENTIFIERS)
	for (const value of [...exportedValues(Http), ...exportedValues(HttpV2)]) {
		const identifier = readIdentifier(value)
		if (identifier === undefined) continue
		const status = readHttpStatus(value)
		if (status === undefined) continue
		if (status >= 400 && status < 500) identifiers.add(identifier)
	}
	return identifiers
}
