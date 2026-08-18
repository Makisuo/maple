// BOUNDARY: This module owns an unparsed eve tool-result payload and narrows it before use.
/**
 * Reads connection failures out of a `connection_search` tool result.
 *
 * eve treats "this connection's tools would not load" as a SUCCESSFUL
 * `connection_search`: the failure is a string on the result item
 * (`runtime/framework-tools/connection-search-dynamic.js`), and the only other
 * trace of it is eve's internal `logger.warn`, which goes to `console.warn` and
 * — unlike `.error()` — never records anything on the active span. So without
 * this extractor, a connection failing to load its tools is only ever visible
 * in Railway's raw container stdout, never in Maple's own telemetry.
 *
 * Keying on the `error` field rather than on message text also covers the two
 * neighbouring cases eve reports the same way — authorization failed, and
 * "still unauthorized after authorization".
 */

/** eve's framework tool name; asserted against eve's own code in the test. */
export const CONNECTION_SEARCH_TOOL_NAME = "connection_search"

/** One connection that reported a failure instead of its tools. */
export interface ConnectionSearchFailure {
	readonly connection: string | undefined
	readonly error: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * eve projects a tool result either as the bare value or wrapped in
 * `{ type, value }` depending on which reconciliation path produced it
 * (`harness/action-result-helpers.js`), so unwrap both — the same test eve's
 * own `extractDiscoveredTools` applies.
 */
function unwrapToolOutput(output: unknown): unknown {
	if (!isRecord(output)) return output
	return "type" in output && "value" in output ? output.value : output
}

export function extractConnectionSearchFailures(output: unknown): readonly ConnectionSearchFailure[] {
	const items = unwrapToolOutput(output)
	if (!Array.isArray(items)) return []

	const failures: ConnectionSearchFailure[] = []
	for (const item of items) {
		if (!isRecord(item)) continue
		const { connection, error } = item
		if (typeof error !== "string" || error.length === 0) continue
		failures.push({
			connection: typeof connection === "string" && connection.length > 0 ? connection : undefined,
			error,
		})
	}
	return failures
}
