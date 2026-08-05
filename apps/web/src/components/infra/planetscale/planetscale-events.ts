// How PlanetScale lifecycle events read in Maple.
//
// This table mirrors the server-side classifier
// (`apps/api/src/services/integrations/planetscale/webhook-events.ts`) event for
// event. Both are deliberately forward-compatible — an event neither side knows
// still renders, as a neutral row, rather than disappearing.
//
// Pure: no React, no atoms, so the vocabulary is testable and shared by the
// chart markers and the activity feed.

import type { PlanetScaleEventEntry } from "@/api/warehouse/planetscale-infra"
import type { ChartEventMarker, ChartEventTone } from "@/components/infra/primitives/chart-event-markers"

export type PlanetScaleEventKind = "deploy" | "branch" | "incident" | "maintenance"

export interface PlanetScaleEventPresentation {
	readonly kind: PlanetScaleEventKind
	readonly tone: ChartEventTone
	/** Short chart-marker label. The row's own `title` carries the long form. */
	readonly short: string
	/**
	 * Whether this event is worth a mark on the chart. Every event shows in the
	 * feed; only the ones that explain a shape in the data get a line, or a
	 * 30-branch database's `branch.ready` churn buries the deploys that matter.
	 */
	readonly onChart: boolean
}

const DEFAULT: PlanetScaleEventPresentation = {
	kind: "branch",
	tone: "neutral",
	short: "Event",
	onChart: false,
}

const PRESENTATION: Record<string, PlanetScaleEventPresentation> = {
	// Deploys: `schema_applied` is the one that matters for correlation — it is
	// the moment the shape of the data changed.
	"deploy_request.opened": { kind: "deploy", tone: "neutral", short: "DR opened", onChart: false },
	"deploy_request.queued": { kind: "deploy", tone: "neutral", short: "DR queued", onChart: false },
	"deploy_request.in_progress": { kind: "deploy", tone: "neutral", short: "Deploying", onChart: true },
	"deploy_request.pending_cutover": {
		kind: "deploy",
		tone: "neutral",
		short: "Cutover",
		onChart: true,
	},
	"deploy_request.schema_applied": { kind: "deploy", tone: "neutral", short: "Deploy", onChart: true },
	"deploy_request.errored": { kind: "deploy", tone: "crit", short: "Deploy failed", onChart: true },
	"deploy_request.reverted": { kind: "deploy", tone: "warn", short: "Reverted", onChart: true },
	"deploy_request.closed": { kind: "deploy", tone: "neutral", short: "DR closed", onChart: false },

	// Branch lifecycle. A promote changes which branch serves production, so it
	// is worth a line; routine ready/sleeping churn is not.
	"branch.ready": { kind: "branch", tone: "neutral", short: "Ready", onChart: false },
	"branch.sleeping": { kind: "branch", tone: "neutral", short: "Asleep", onChart: false },
	"branch.primary_promoted": { kind: "branch", tone: "warn", short: "Promoted", onChart: true },
	"branch.start_maintenance": {
		kind: "maintenance",
		tone: "warn",
		short: "Maintenance",
		onChart: true,
	},

	// Health. These also open a triage issue; the marker is what explains the
	// cliff sitting next to it.
	"branch.out_of_memory": { kind: "incident", tone: "crit", short: "OOM", onChart: true },
	"branch.anomaly": { kind: "incident", tone: "crit", short: "Anomaly", onChart: true },
	"cluster.storage": { kind: "incident", tone: "warn", short: "Storage", onChart: true },
	"keyspace.storage": { kind: "incident", tone: "warn", short: "Storage", onChart: true },

	"database.access_request": {
		kind: "branch",
		tone: "neutral",
		short: "Access request",
		onChart: false,
	},
}

export const presentEvent = (eventType: string): PlanetScaleEventPresentation =>
	PRESENTATION[eventType] ?? DEFAULT

/**
 * The subset of a window's events worth drawing, as chart markers.
 *
 * Deploy requests carry no single branch, so a branch-scoped chart still shows
 * them — a schema change applies to the database, and hiding it from the branch
 * whose latency it moved would defeat the point.
 */
export function eventsToChartMarkers(
	events: ReadonlyArray<PlanetScaleEventEntry>,
): ReadonlyArray<ChartEventMarker> {
	const markers: ChartEventMarker[] = []
	for (const event of events) {
		const presentation = presentEvent(event.eventType)
		if (!presentation.onChart) continue
		markers.push({
			id: event.id,
			at: new Date(event.occurredAt).toISOString(),
			label: presentation.short,
			tone: presentation.tone,
		})
	}
	return markers
}
