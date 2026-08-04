import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"

/**
 * The URL state the replays list filters on. Structurally the decoded search
 * schema from the route, declared here so this module stays importable without
 * pulling in the route (and its component tree).
 */
export interface ReplaysSearchState {
	readonly startTime?: string
	readonly endTime?: string
	readonly timePreset?: string
	readonly service?: string
	readonly browser?: string
	readonly country?: string
	readonly deviceType?: string
	readonly userId?: string
	readonly visitorId?: string
	readonly hasErrors?: boolean
	readonly q?: string
	readonly durationMin?: number
	readonly durationMax?: number
	readonly activeMin?: number
	readonly activeMax?: number
}

/**
 * Warehouse filter inputs for a given URL state.
 *
 * Shared by the route's `loader` and its component so both key to the identical
 * atom-family entry — the loader's prefetch is only worth anything if the
 * component reads the same key. Atom family keys run through `encodeKey`, which
 * snaps timestamps to a 15s grid, so resolving `now` twice a few milliseconds
 * apart still lands on one entry rather than fetching twice.
 */
export const replaysFilterInputs = (search: ReplaysSearchState) => {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)
	return {
		startTime,
		endTime,
		serviceName: search.service,
		browser: search.browser,
		country: search.country,
		deviceType: search.deviceType,
		userId: search.userId,
		visitorId: search.visitorId,
		hasErrors: search.hasErrors,
		search: search.q,
		// URL params are whole seconds; the warehouse filters in ms.
		durationMinMs: search.durationMin != null ? search.durationMin * 1000 : undefined,
		durationMaxMs: search.durationMax != null ? search.durationMax * 1000 : undefined,
		activeTimeMinMs: search.activeMin != null ? search.activeMin * 1000 : undefined,
		activeTimeMaxMs: search.activeMax != null ? search.activeMax * 1000 : undefined,
	}
}
