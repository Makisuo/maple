/**
 * Display copy for a lane, and the seed catalogue's static fallback.
 *
 * This file used to be the only place the web knew what a lens was called,
 * because the catalogue was fixed and a copy edit shouldn't need an API deploy.
 * Hypotheses are planner-written now, so the *name* is data: no static table can
 * say "the 14:02 payments-api rollout". The server sends `lens_name` and
 * `lens_question` and they win.
 *
 * What stays here is the fallback, and it earns its place twice — for lanes
 * written before the planner (whose `lensId` still names a catalogue entry) and
 * for the seed hypotheses a run falls back to when the planner produces nothing
 * usable.
 */
import type { SeedLensId } from "@maple/domain/http"

export interface LensCopy {
	readonly name: string
	/** What this lens is actually asking — shown as the catalogue's one-liner. */
	readonly question: string
	/** The rail's short label for the same lens, phrased as a check. */
	readonly checkLabel: string
}

export const LENS_COPY: Record<SeedLensId, LensCopy> = {
	deploy_correlation: {
		name: "Deploy correlation",
		question: "What shipped before the window, and does the onset line up",
		checkLabel: "Deploy in the window",
	},
	downstream_dependency: {
		name: "Downstream dependency",
		question: "Is a callee actually degraded, or only being blamed",
		checkLabel: "Downstream latency",
	},
	resource_saturation: {
		name: "Resource saturation",
		question: "Pools, queues, memory, connections at a ceiling",
		checkLabel: "Connection pool headroom",
	},
	traffic_shape: {
		name: "Traffic shape",
		question: "Volume and mix against the 7-day baseline for that hour",
		checkLabel: "Request volume",
	},
}

/**
 * The subset of a lane this needs. Structural rather than the full wire row, so a
 * test can pass three fields and the seed catalogue's own entries can be checked
 * against it. Field names are the *decoded* ones — `lens_name` on the wire
 * arrives here as `name`.
 */
export interface LensCopySource {
	readonly lensId: string
	readonly name?: string | null
	readonly question?: string | null
}

/**
 * Server copy where there is any, the seed catalogue where the id names one, and
 * a humanised id as the last resort.
 *
 * Takes the lane rather than its id, which is the whole change: a planner-written
 * name only exists on the row. The final fallback stays because `lens_runs` is
 * annotated on the wire as an evolving shape — an unknown id must degrade to a
 * readable label, never blank the page.
 */
export const lensCopy = (run: LensCopySource): LensCopy => {
	if (run.name) {
		return {
			name: run.name,
			question: run.question ?? "",
			// The planner's name already reads as the thing being checked, so there is
			// no shorter phrasing to reach for — a second server field for the rail
			// would be one more string per lane for a distinction nobody sees.
			checkLabel: run.name,
		}
	}
	const seeded = LENS_COPY[run.lensId as SeedLensId]
	if (seeded) return seeded
	return { name: humanise(run.lensId), question: "", checkLabel: humanise(run.lensId) }
}

/** `cache_pressure` → `Cache pressure`. Better than printing a raw token. */
const humanise = (id: string): string => id.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase())
