import { Schema } from "effect"

// Dashboard-variable selections live in the URL as `var-<name>` search params
// (Grafana-style) so views are shareable/deep-linkable. This module is the one
// owner of that prefix and the pick helper, shared by the dashboard route, the
// widget-editor route (which round-trips them so back-navigation preserves the
// user's selections), and the actions context that opens the editor.
export const VARIABLE_PARAM_PREFIX = "var-"

export type VariableSearchParams = Record<`${typeof VARIABLE_PARAM_PREFIX}${string}`, unknown>

/**
 * Schema fragment that retains `var-*` keys on a route's search. Values are
 * `Unknown` on purpose: TanStack JSON-parses each value, and a hand-edited URL
 * must never crash the route — non-strings are coerced or ignored when read.
 */
export const variableSearchRest = Schema.Record(
	Schema.TemplateLiteral([VARIABLE_PARAM_PREFIX, Schema.String]),
	Schema.Unknown,
)

/** Pick only the `var-*` selection keys out of an arbitrary search object. */
export function pickVariableParams(search: Record<string, unknown>): VariableSearchParams {
	const params: VariableSearchParams = {}
	for (const [key, value] of Object.entries(search)) {
		if (key.startsWith(VARIABLE_PARAM_PREFIX)) {
			params[key as keyof VariableSearchParams] = value
		}
	}
	return params
}
