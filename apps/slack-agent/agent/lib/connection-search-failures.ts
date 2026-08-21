// BOUNDARY: This module owns an unparsed eve tool-result payload and narrows it before use.
/**
 * Detects and logs `connection_search` failures — the connections whose tools
 * didn't load — so they reach Maple's own telemetry instead of only Railway's
 * raw container stdout.
 *
 * eve treats "this connection's tools would not load" as a SUCCESSFUL
 * `connection_search`: the failure is a string on the result item
 * (`runtime/framework-tools/connection-search-dynamic.js`), and the only other
 * trace of it is eve's internal `logger.warn`, which goes to `console.warn` and
 * — unlike `.error()` — never records anything on the active span. So without
 * this module, a connection failing to load its tools is invisible to Maple.
 *
 * Keying on the `error` field rather than on message text also covers the two
 * neighbouring cases eve reports the same way — authorization failed, and
 * "still unauthorized after authorization".
 */
import type { HookContext, HookEvent } from "eve/hooks"
import { emitAgentLog } from "./telemetry-log.js"

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

export function teamIdOf(ctx: HookContext): string | undefined {
	const team = ctx.session.auth.current?.attributes?.team_id
	return typeof team === "string" && team.length > 0 ? team : undefined
}

/**
 * Call from an `action.result` hook handler for every result, unconditionally
 * — checked before any `failed`/`isError` gate on purpose, since eve reports
 * a connection whose tools didn't load as a SUCCESSFUL `connection_search`
 * (see the module doc above). No-ops for every other tool and result shape.
 */
export function logConnectionSearchFailures(
	result: HookEvent<"action.result">["data"]["result"],
	ctx: HookContext,
): void {
	if (result.kind !== "tool-result" || result.toolName !== CONNECTION_SEARCH_TOOL_NAME) return
	for (const failure of extractConnectionSearchFailures(result.output)) {
		emitAgentLog("error", "connection_unavailable", {
			"maple.agent.event": "connection_unavailable",
			"maple.agent.connection": failure.connection,
			"maple.agent.error_message": failure.error,
			"session.id": ctx.session.id,
			"maple.slack.team_id": teamIdOf(ctx),
		})
	}
}
