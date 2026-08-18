import { Effect } from "effect"

/**
 * MCP failures that are expected 4xx client outcomes, not bugs: a bad or absent
 * credential, or a tool call whose parameters do not decode. Per CLAUDE.md only
 * 5xx is an `Error` span, so these must leave the span status Ok — with the
 * outcome recorded as attributes and a Warn log — instead of an exception event.
 *
 * The mechanism is the same one `@maple/domain/anticipated-errors` drives for
 * HTTP: the SDK's tracer exports a span whose failure is caused *entirely* by an
 * anticipated identifier as OTLP `Ok` with no `exception` event. That set is
 * derived by reflection over the domain HTTP exports and cannot see these
 * classes — they live in `apps/api/src/mcp` — so they are listed here and spread
 * into the runtime telemetry configs alongside it.
 *
 * `McpAuthUnavailableError` (503) and `McpQueryError` are deliberately absent:
 * they are real failures and keep their Error spans.
 */
const MCP_EXPECTED_FAILURE_STATUS = {
	"@maple/mcp/decode-error": 400,
	"@maple/mcp/errors/McpAuthMissingError": 401,
	"@maple/mcp/errors/McpAuthInvalidError": 401,
} satisfies Record<string, number>

// Keyed by a plain string so a `_tag` off any failure can be looked up without
// narrowing it into the literal union first.
const expectedStatusByTag = new Map<string, number>(Object.entries(MCP_EXPECTED_FAILURE_STATUS))

/** Spread into `anticipatedErrorIdentifiers` next to `ANTICIPATED_ERROR_IDENTIFIERS`. */
export const MCP_ANTICIPATED_ERROR_IDENTIFIERS: ReadonlyArray<string> = [...expectedStatusByTag.keys()]

/**
 * Record an expected MCP 4xx on the current span and log it at Warn.
 *
 * A no-op for any other failure, so it is safe to hang off a broad `tapError`:
 * genuine failures keep their Error span and are logged by their own handler.
 * The error itself stays in the typed Effect error channel either way — only
 * span recording changes here.
 */
export const recordExpectedMcpFailure = (
	error: { readonly _tag: string; readonly message: string },
	logMessage: string,
): Effect.Effect<void> => {
	const status = expectedStatusByTag.get(error._tag)
	if (status === undefined) return Effect.void
	return Effect.annotateCurrentSpan({
		"error.type": error._tag,
		"http.response.status_code": status,
	}).pipe(
		Effect.andThen(
			Effect.logWarning(logMessage).pipe(
				Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
			),
		),
	)
}
