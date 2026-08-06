/**
 * Display copy for the lens catalogue.
 *
 * The server sends `lens_id` and nothing else — the name and the one-line
 * question are presentation, not data, and shipping them over the wire would
 * mean a copy edit required a deploy of the API. This is the only place the
 * web knows what a lens is *called*.
 *
 * Keyed rather than ordered: dispatch order comes from the server, which returns
 * lens runs already sorted by ordinal.
 */
import type { LensId } from "@maple/domain/http"

export interface LensCopy {
	readonly name: string
	/** What this lens is actually asking — shown as the catalogue's one-liner. */
	readonly question: string
	/** The rail's short label for the same lens, phrased as a check. */
	readonly checkLabel: string
}

export const LENS_COPY: Record<LensId, LensCopy> = {
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
	config_flags: {
		name: "Config & flags",
		question: "Flag flips and config writes inside the window",
		checkLabel: "Client agent config",
	},
}

/**
 * Falls back to the raw id rather than throwing: `lens_runs` is annotated on the
 * wire as an evolving shape, so a server that learns a sixth lens must not blank
 * the page of a client that has not shipped its copy yet.
 */
export const lensCopy = (id: LensId): LensCopy => LENS_COPY[id] ?? { name: id, question: "", checkLabel: id }
