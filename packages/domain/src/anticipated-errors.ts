// Anticipated error identifiers
//
// The set of stable domain HTTP error identifiers that represent *expected*
// client-facing outcomes (4xx): validation, not-found, unauthorized, forbidden,
// conflict, … Tagged errors contribute `_tag`; v2 Error values contribute
// their class identifier / `Error.name`.
//
// These are not bugs — they're normal business results. The telemetry SDK uses
// this set to record spans that fail *entirely* with one of these errors as
// OTLP status `Ok` (no `exception` event), so they stay visible as traces but
// never count toward error tracking (`error_events_mv` keys off
// `StatusCode='Error'`). Mirrors the ingest gateway's `otel_status_for_rejection`
// rule (4xx → Ok, 5xx → Error).
//
// Derived (not hand-maintained) from the error classes themselves: every
// Both `Schema.TaggedError` and `Schema.Error` carry a stable
// identifier plus an `httpApiStatus` annotation, so a new 4xx error is picked
// up automatically. A 5xx error (persistence/upstream failures) is intentionally
// excluded and keeps tracing.
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
 * responds 400, so by the 4xx→Ok rule above it belongs here. It was also the
 * worst offender for legibility: its `message` is its `kind`, so a failed decode
 * arrived as an Error span whose entire description was the word "Payload".
 */
const EXTERNAL_ANTICIPATED_IDENTIFIERS = ["HttpApiSchemaError"] as const
const exportedValues = (namespace: object): ReadonlyArray<unknown> => Object.values(namespace)

const deriveAnticipatedIdentifiers = (): ReadonlySet<string> => {
	const identifiers = new Set<string>(EXTERNAL_ANTICIPATED_IDENTIFIERS)
	for (const value of [...exportedValues(Http), ...exportedValues(HttpV2)]) {
		if (typeof value !== "function") continue
		const identifier = readIdentifier(value)
		if (identifier === undefined) continue
		const status = readHttpStatus(value)
		if (status === undefined) continue
		if (status >= 400 && status < 500) identifiers.add(identifier)
	}
	return identifiers
}

/**
 * Stable identifiers of all domain HTTP errors annotated with a 4xx `httpApiStatus`.
 * Tagged errors contribute `_tag`; v2 Schema.Error values contribute `Error.name`.
 */
export const ANTICIPATED_ERROR_IDENTIFIERS: ReadonlySet<string> = deriveAnticipatedIdentifiers()

export const isAnticipatedErrorIdentifier = (identifier: string): boolean =>
	ANTICIPATED_ERROR_IDENTIFIERS.has(identifier)
