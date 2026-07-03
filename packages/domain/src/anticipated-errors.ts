// ---------------------------------------------------------------------------
// Anticipated error tags
//
// The set of domain HTTP error `_tag`s that represent *expected* client-facing
// outcomes (4xx): validation, not-found, unauthorized, forbidden, conflict, …
//
// These are not bugs — they're normal business results. The telemetry SDK uses
// this set to record spans that fail *entirely* with one of these errors as
// OTLP status `Ok` (no `exception` event), so they stay visible as traces but
// never count toward error tracking (`error_events_mv` keys off
// `StatusCode='Error'`). Mirrors the ingest gateway's `otel_status_for_rejection`
// rule (4xx → Ok, 5xx → Error).
//
// Derived (not hand-maintained) from the error classes themselves: every
// `Schema.TaggedErrorClass` carries its `_tag` literal and an `httpApiStatus`
// annotation on its AST, so a new 4xx error is picked up automatically. A 5xx
// error (persistence/upstream failures) is intentionally excluded and keeps
// tracing.
// ---------------------------------------------------------------------------
import * as Http from "./http/index"

/** Read `obj[key]` when `obj` is an object/function that has it; `undefined` otherwise. */
const prop = (obj: unknown, key: string): unknown =>
	(typeof obj === "object" || typeof obj === "function") && obj !== null && key in obj
		? (obj as Record<string, unknown>)[key]
		: undefined

/** The `_tag` literal of a `Schema.TaggedErrorClass` (`ast.fields._tag.schema.literal`). */
const readTag = (value: unknown): string | undefined => {
	const literal = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	return typeof literal === "string" ? literal : undefined
}

/** The `httpApiStatus` annotation on a schema's AST, when present. */
const readHttpStatus = (value: unknown): number | undefined => {
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	return typeof status === "number" ? status : undefined
}

const deriveAnticipatedTags = (): ReadonlySet<string> => {
	const tags = new Set<string>()
	for (const value of Object.values(Http)) {
		if (typeof value !== "function") continue
		const tag = readTag(value)
		if (tag === undefined) continue
		const status = readHttpStatus(value)
		if (status === undefined) continue
		if (status >= 400 && status < 500) tags.add(tag)
	}
	return tags
}

/**
 * `_tag`s of all domain HTTP errors annotated with a 4xx `httpApiStatus`.
 * Pass `[...ANTICIPATED_ERROR_TAGS]` to the telemetry SDK's `anticipatedErrorTags`.
 */
export const ANTICIPATED_ERROR_TAGS: ReadonlySet<string> = deriveAnticipatedTags()

/** True when `tag` is a known anticipated (4xx) domain error tag. */
export const isAnticipatedErrorTag = (tag: string): boolean => ANTICIPATED_ERROR_TAGS.has(tag)
