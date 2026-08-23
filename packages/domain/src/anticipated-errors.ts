// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Anticipated error identifiers
//
// The set of stable domain HTTP error identifiers that represent *expected*
// client-facing outcomes (4xx): validation, not-found, unauthorized, forbidden,
// conflict, … Tagged errors contribute `_tag`; v2 definitions contribute their
// exact public `tag`.
//
// These are not bugs — they're normal business results. The telemetry SDK uses
// this set to record spans that fail *entirely* with one of these errors as
// OTLP status `Ok` (no `exception` event), so they stay visible as traces but
// never count toward error tracking (`error_events_mv` keys off
// `StatusCode='Error'`). Mirrors the ingest gateway's `otel_status_for_rejection`
// rule (4xx → Ok, 5xx → Error).
//
// Derived (not hand-maintained) from the exported error classes and v2
// definitions, but at code-generation time rather than worker startup. Runtime
// reflection imported and evaluated the entire domain HTTP schema surface in
// every cold isolate. `anticipated-errors-derive.ts` retains that authoritative
// reflection for the generator and drift test; this hot module imports only its
// checked-in literal output.
import { ANTICIPATED_ERROR_IDENTIFIER_LIST } from "./generated/anticipated-error-identifiers"

/**
 * Stable identifiers of all domain HTTP errors annotated with a 4xx `httpApiStatus`.
 * Tagged errors and v2 definitions both contribute their exact public `_tag`.
 */
export const ANTICIPATED_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set(ANTICIPATED_ERROR_IDENTIFIER_LIST)

export const isAnticipatedErrorIdentifier = (identifier: string): boolean =>
	ANTICIPATED_ERROR_IDENTIFIERS.has(identifier)
