/**
 * How a dashboard variable gets its value — the ladder and the option source.
 *
 * Both hosts that resolve variables go through this module: the signed-in
 * `DashboardVariablesProvider` (URL selections, options loaded through the
 * facet/attribute atoms) and the share API (`resolveShareVariables`, options
 * loaded server-side over the batch window). Each used to carry its own copy of
 * "URL → default → All → first option", and the share's copy stopped at
 * `submitted ?? defaultValue` and never resolved query-variable options at all
 * — so a board whose `$service` fell back to the first loaded service signed in
 * resolved to nothing on its share link, and an "All" selection expanded to
 * the real option list on the board and to `''` on the share.
 *
 * Pure. The option *query* is described here (`dashboardVariableOptionsQuery`)
 * and its result decoded here (`dashboardVariableOptionsFromResult`); running
 * it is each host's own business.
 */
import type { DashboardVariable } from "@maple/domain/http"
import type {
	AttributeValuesQuery,
	LogsFacetsQuery,
	QueryEngineExecuteResponse,
	TracesFacetsQuery,
} from "@maple/domain/query-engine"
import { ALL_VALUE } from "./interpolate"

/** The options a variable currently offers, and whether they are still arriving. */
export interface DashboardVariableOptionsState {
	readonly options: ReadonlyArray<string>
	readonly loading: boolean
}

export const NO_VARIABLE_OPTIONS: DashboardVariableOptionsState = { options: [], loading: false }
export const LOADING_VARIABLE_OPTIONS: DashboardVariableOptionsState = { options: [], loading: true }

/**
 * A variable's resolved value: selection → declared default → All (when
 * enabled) → first loaded option.
 *
 * Returns `undefined` while a query variable's options are still loading and
 * nothing else pins a value — consumers gate widget fetches on that. A textbox
 * with nothing selected and no default is the empty string, as is a custom
 * variable whose option list is permanently empty.
 */
export function resolveDashboardVariableValue(
	variable: Pick<DashboardVariable, "type" | "includeAll" | "defaultValue">,
	selected: string | undefined,
	options: DashboardVariableOptionsState,
): string | undefined {
	const allEnabled = variable.includeAll === true
	if (selected !== undefined && selected !== "") {
		if (selected === ALL_VALUE) {
			if (allEnabled) return ALL_VALUE
		} else {
			return selected
		}
	}
	if (variable.defaultValue !== undefined && variable.defaultValue !== "") {
		return variable.defaultValue
	}
	if (variable.type === "textbox") return ""
	if (allEnabled) return ALL_VALUE
	if (options.options.length > 0) return options.options[0]
	// No options yet: still loading for query variables, permanently empty for
	// custom variables with an empty options list.
	return options.loading ? undefined : ""
}

/** Variable facet id → the traces facets dimension the engine emits. */
const TRACES_FACET_BY_SOURCE = {
	service: "service",
	environment: "deploymentEnv",
	span_name: "spanName",
	http_method: "httpMethod",
	http_status_code: "httpStatus",
} as const

export type DashboardVariableOptionsQuery = TracesFacetsQuery | LogsFacetsQuery | AttributeValuesQuery

/**
 * The query-engine request that lists a `query` variable's options — one facet
 * branch or one attribute-values scan, never the full sidebar facet sweep.
 * `null` for variables whose options are stored (`custom`) or free (`textbox`).
 */
export function dashboardVariableOptionsQuery(
	variable: DashboardVariable,
): DashboardVariableOptionsQuery | null {
	if (variable.type !== "query") return null
	const source = variable.source
	if (source.kind === "attribute") {
		return {
			kind: "attributeValues",
			source: "traces",
			scope: source.scope,
			attributeKey: source.attributeKey,
		}
	}
	if (source.facet === "log_severity") {
		return { kind: "facets", source: "logs", facet: "severity" }
	}
	return { kind: "facets", source: "traces", facet: TRACES_FACET_BY_SOURCE[source.facet] }
}

/**
 * The option strings out of the response to `dashboardVariableOptionsQuery`.
 *
 * Mirrors what the browser's `getTracesFacetValues` / `getLogsFacetValues` /
 * `get*AttributeValues` server functions hand the variables provider: the
 * requested facet's rows in engine order (logs additionally drop the empty
 * severity), or the attribute values in engine order.
 */
export function dashboardVariableOptionsFromResult(
	query: DashboardVariableOptionsQuery,
	result: QueryEngineExecuteResponse["result"],
): string[] {
	if (query.kind === "attributeValues") {
		return result.kind === "attributeValues" ? result.data.map((row) => row.value) : []
	}
	if (result.kind !== "facets") return []
	const rows = result.data.filter((row) => row.facetType === query.facet)
	return (query.source === "logs" ? rows.filter((row) => row.name) : rows).map((row) => row.name)
}
