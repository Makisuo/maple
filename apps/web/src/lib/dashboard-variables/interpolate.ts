// Dashboard variable interpolation lives in @maple/query-engine so the
// where-clause grammar and ClickHouse string escaping each have one owner.
// This re-export keeps the historical import path for web call sites.
export {
	ALL_VALUE,
	collectVariableRefs,
	hasUnresolvedVariableRefs,
	interpolateDisplayText,
	interpolateWidgetParams,
	type ResolvedVariable,
	type VariableValues,
} from "@maple/query-engine"
