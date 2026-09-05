import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { GetReleasesInput } from "@/api/warehouse/releases"

export const RELEASES_DEFAULT_PRESET = "7d"

/** The search params the releases atom input is built from. */
export interface ReleasesQuerySearch {
	readonly startTime?: string
	readonly endTime?: string
	readonly timePreset?: string
	readonly environments?: string[]
	readonly excludedEnvironments?: string[]
	readonly services?: string[]
}

/**
 * The releases atom's input, from search alone. Shared by the sidebar and the
 * page so they cannot drift onto different keys — a mismatch does not fail, it
 * fetches twice. Lives outside the route file on purpose: an export of a
 * route module stays in that route's startup shell.
 */
export function releasesQueryInput(search: ReleasesQuerySearch): GetReleasesInput {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? RELEASES_DEFAULT_PRESET,
	)
	return {
		startTime,
		endTime,
		environments: search.environments,
		excludedEnvironments: search.excludedEnvironments,
		services: search.services,
	}
}
