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
// Derived (not hand-maintained) from the error classes themselves — but at
// CODEGEN time, not module eval: the worker entrypoint imports this module at
// isolate startup, and deriving by reflection meant evaluating the entire
// domain HTTP schema surface (~600KB of Schema construction) inside
// Cloudflare's startup CPU budget. The reflection lives in
// `./anticipated-errors-derive.ts`; its output is checked in at
// `./generated/anticipated-error-identifiers.ts` (regenerate with
// `bun run gen:anticipated-errors`), and the drift test in
// `anticipated-errors.test.ts` keeps the two in sync — so a new 4xx error is
// still picked up automatically.
import { ANTICIPATED_ERROR_IDENTIFIER_LIST } from "./generated/anticipated-error-identifiers"

/**
 * Stable identifiers of all domain HTTP errors annotated with a 4xx `httpApiStatus`.
 * Tagged errors contribute `_tag`; v2 Schema.Error values contribute `Error.name`.
 */
export const ANTICIPATED_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set(
	ANTICIPATED_ERROR_IDENTIFIER_LIST,
)

export const isAnticipatedErrorIdentifier = (identifier: string): boolean =>
	ANTICIPATED_ERROR_IDENTIFIERS.has(identifier)
