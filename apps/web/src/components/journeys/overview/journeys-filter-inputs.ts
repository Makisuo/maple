import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"

/**
 * The URL state the journeys list filters on. Structurally the decoded search
 * schema from the route, declared here so this module stays importable without
 * pulling in the route (and its component tree) — same split as
 * `replays-filter-inputs.ts`.
 */
export interface JourneysSearchState {
	readonly startTime?: string
	readonly endTime?: string
	readonly timePreset?: string
	readonly status?: "ok" | "error" | "running"
	readonly finishReason?: string
	readonly agent?: string
	readonly workflow?: string
	readonly model?: string
	readonly provider?: string
	readonly service?: string
	readonly hasTools?: boolean
	/** Substring over the title sample AND the journey id — the toolbar search and
	 *  the sidebar's "Journey ID" field are two surfaces on this one param. */
	readonly q?: string
	/** Whole seconds in the URL; milliseconds at the warehouse. */
	readonly durationMin?: number
	readonly durationMax?: number
	readonly turnMin?: number
	readonly turnMax?: number
	readonly tokenMin?: number
	readonly tokenMax?: number
	/** Dollars. */
	readonly costMin?: number
	readonly costMax?: number
	readonly sort?: JourneySort
	readonly sortDirection?: "asc" | "desc"
}

/** Sort keys the backend accepts, in the order the toolbar lists them. */
export type JourneySort = "startTime" | "cost" | "duration" | "turns" | "tokens"

export const JOURNEY_SORT_OPTIONS: ReadonlyArray<{
	key: JourneySort
	label: string
}> = [
	{ key: "startTime", label: "Most recent" },
	{ key: "cost", label: "Most expensive" },
	{ key: "duration", label: "Slowest" },
	{ key: "turns", label: "Most turns" },
	{ key: "tokens", label: "Most tokens" },
]

/** Default stays "most recent": cost-sorting by default would bury the in-progress
 *  journeys someone opened this page to watch. */
export const DEFAULT_JOURNEY_SORT: JourneySort = "startTime"

/**
 * The one cost figure the page treats as "expensive". It drives the amber cost
 * bar in the row and the "Over $1.00" toolbar chip, so those two surfaces can
 * never disagree about which journeys are the outliers.
 */
export const COST_OUTLIER_DOLLARS = 1

/**
 * Warehouse filter inputs for a given URL state.
 *
 * Shared by the route's `loader` and its component so both key to the identical
 * atom-family entry — the loader's prefetch is only worth anything if the
 * component reads the same key.
 */
export const journeysFilterInputs = (search: JourneysSearchState) => {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)
	return {
		startTime,
		endTime,
		status: search.status,
		finishReason: search.finishReason,
		agent: search.agent,
		workflow: search.workflow,
		model: search.model,
		provider: search.provider,
		serviceName: search.service,
		hasTools: search.hasTools,
		search: search.q,
		durationMinMs: search.durationMin != null ? search.durationMin * 1000 : undefined,
		durationMaxMs: search.durationMax != null ? search.durationMax * 1000 : undefined,
		turnMin: search.turnMin,
		turnMax: search.turnMax,
		tokenMin: search.tokenMin,
		tokenMax: search.tokenMax,
		costMin: search.costMin,
		costMax: search.costMax,
	}
}

/** The subset the facets query takes — identical filters, no sort or paging. */
export type JourneysFilterInputs = ReturnType<typeof journeysFilterInputs>

/** Sort params for the list query. Kept out of `journeysFilterInputs` so the
 *  facets atom and the list atom share one key for the filter half. */
export const journeysSortInputs = (search: JourneysSearchState) => ({
	sort: search.sort ?? DEFAULT_JOURNEY_SORT,
	sortDirection: search.sortDirection ?? ("desc" as const),
})

/** True when anything other than the time range is narrowing the list — decides
 *  whether the empty state offers "drop a filter" or "set up instrumentation". */
export const hasActiveJourneyFilters = (search: JourneysSearchState): boolean =>
	search.status != null ||
	search.finishReason != null ||
	search.agent != null ||
	search.workflow != null ||
	search.model != null ||
	search.provider != null ||
	search.service != null ||
	search.hasTools != null ||
	(search.q != null && search.q !== "") ||
	search.durationMin != null ||
	search.durationMax != null ||
	search.turnMin != null ||
	search.turnMax != null ||
	search.tokenMin != null ||
	search.tokenMax != null ||
	search.costMin != null ||
	search.costMax != null
