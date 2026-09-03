import type { AiSessionSortDir, AiSessionSortKey } from "@maple/domain/http"
import type { AiSessionsFilterInputs } from "@/hooks/use-infinite-ai-sessions"

/**
 * The URL state the agent-sessions list filters on. Structurally the decoded
 * search schema from the route, declared here so this module stays importable
 * without pulling in the route (and its component tree).
 */
export interface AgentSessionsSearchState {
	readonly vendors?: ReadonlyArray<string>
	readonly services?: ReadonlyArray<string>
	readonly environments?: ReadonlyArray<string>
	readonly models?: ReadonlyArray<string>
	readonly agents?: ReadonlyArray<string>
	readonly tools?: ReadonlyArray<string>
	/** Session or trace id prefix. */
	readonly q?: string
	readonly hasErrors?: boolean
	/** Hide the `trace:` sessions — traces whose vendor exposes no session key. */
	readonly grouped?: boolean
	/** Seconds, like the replays list; the warehouse filters in ms. */
	readonly durationMin?: number
	readonly durationMax?: number
	readonly costMin?: number
	readonly costMax?: number
	readonly tokensMin?: number
	readonly tokensMax?: number
	readonly llmCallsMin?: number
	readonly llmCallsMax?: number
	readonly toolCallsMin?: number
	readonly toolCallsMax?: number
	readonly sortBy?: AiSessionSortKey
	readonly sortDir?: AiSessionSortDir
}

/** The URL keys that are filters — everything the sidebar's Clear resets. */
export const AGENT_SESSIONS_FILTER_KEYS = [
	"vendors",
	"services",
	"environments",
	"models",
	"agents",
	"tools",
	"q",
	"hasErrors",
	"grouped",
	"durationMin",
	"durationMax",
	"costMin",
	"costMax",
	"tokensMin",
	"tokensMax",
	"llmCallsMin",
	"llmCallsMax",
	"toolCallsMin",
	"toolCallsMax",
] as const satisfies ReadonlyArray<keyof AgentSessionsSearchState>

/**
 * One row of the sort menu: the measure and the direction it makes sense in.
 * The list exposes no direction toggle — "most expensive" is the question, and
 * "least expensive" is not one anybody asks a session list.
 */
export interface AgentSessionsSortOption {
	readonly key: string
	readonly label: string
	readonly sortBy: AiSessionSortKey
	readonly sortDir: AiSessionSortDir
}

export const AGENT_SESSIONS_SORT_OPTIONS: ReadonlyArray<AgentSessionsSortOption> = [
	{ key: "newest", label: "Newest first", sortBy: "startTime", sortDir: "desc" },
	{ key: "oldest", label: "Oldest first", sortBy: "startTime", sortDir: "asc" },
	{ key: "longest", label: "Longest", sortBy: "durationMs", sortDir: "desc" },
	{ key: "cost", label: "Most expensive", sortBy: "cost", sortDir: "desc" },
	{ key: "tokens", label: "Most tokens", sortBy: "totalTokens", sortDir: "desc" },
	{ key: "errors", label: "Most errors", sortBy: "errorSpanCount", sortDir: "desc" },
	{ key: "llm-calls", label: "Most LLM calls", sortBy: "llmCalls", sortDir: "desc" },
	{ key: "tool-calls", label: "Most tool calls", sortBy: "toolCalls", sortDir: "desc" },
]

export const DEFAULT_SORT_OPTION = AGENT_SESSIONS_SORT_OPTIONS[0]!

/**
 * The menu row a URL pair names; the default when the URL names none, or a
 * pair the menu does not offer. The query is built from THIS, so what the
 * select says is always what the list is sorted by.
 */
export function sortOptionFor(
	sortBy: AiSessionSortKey | undefined,
	sortDir: AiSessionSortDir | undefined,
): AgentSessionsSortOption {
	return (
		AGENT_SESSIONS_SORT_OPTIONS.find(
			(option) => option.sortBy === (sortBy ?? "startTime") && option.sortDir === (sortDir ?? "desc"),
		) ?? DEFAULT_SORT_OPTION
	)
}

export function hasAgentSessionsFilters(search: AgentSessionsSearchState): boolean {
	return AGENT_SESSIONS_FILTER_KEYS.some((key) => {
		const value = search[key]
		return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
	})
}

/** A multi-value param, or nothing — an empty array is not a filter. */
const some = (values: ReadonlyArray<string> | undefined) => (values?.length ? values : undefined)

/**
 * Warehouse filter inputs for a given URL state and resolved window.
 *
 * The window is resolved by the caller (it is refresh-aware), and everything
 * else is a rename or a unit change: durations travel in the URL as whole
 * seconds and are filtered in milliseconds.
 */
export function agentSessionsFilterInputs(
	search: AgentSessionsSearchState,
	window: { readonly startTime: string; readonly endTime: string },
): AiSessionsFilterInputs {
	const sortOption = sortOptionFor(search.sortBy, search.sortDir)
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		vendorIds: some(search.vendors),
		serviceNames: some(search.services),
		deploymentEnvs: some(search.environments),
		models: some(search.models),
		agentNames: some(search.agents),
		toolNames: some(search.tools),
		search: search.q?.trim() || undefined,
		hasErrors: search.hasErrors === true ? true : undefined,
		excludeTraceSessions: search.grouped === true ? true : undefined,
		durationMinMs: search.durationMin !== undefined ? search.durationMin * 1000 : undefined,
		durationMaxMs: search.durationMax !== undefined ? search.durationMax * 1000 : undefined,
		costMin: search.costMin,
		costMax: search.costMax,
		tokensMin: search.tokensMin,
		tokensMax: search.tokensMax,
		llmCallsMin: search.llmCallsMin,
		llmCallsMax: search.llmCallsMax,
		toolCallsMin: search.toolCallsMin,
		toolCallsMax: search.toolCallsMax,
		// Resolved through the menu, and left off for the default so the first
		// page's SQL stays the baseline shape.
		...(sortOption === DEFAULT_SORT_OPTION
			? undefined
			: { sortBy: sortOption.sortBy, sortDir: sortOption.sortDir }),
	}
}
