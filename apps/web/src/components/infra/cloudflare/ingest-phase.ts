import type { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"

/**
 * How far a connected Cloudflare integration is from showing real numbers. Every Cloudflare
 * surface derives its banner and empty state from this one function so they can never disagree
 * about whether an empty page is normal or broken.
 *
 * The poller's shape is what makes the wait explainable: the alerting cron ticks every 5 minutes
 * and never queries buckets younger than the 10-minute safety lag, so a fresh connection is empty
 * for a quarter hour by design — and the 24h history then fills in behind it, bounded by the
 * per-tick call budget. Silence past {@link STALL_AFTER_MS} is no longer explainable that way.
 */
export type CloudflareIngestPhase =
	/** Connected, but the poller hasn't listed the account's zones and Workers yet. */
	| { readonly kind: "discovering" }
	/** Zones known, nothing queryable yet — the expected first ~15 minutes. */
	| { readonly kind: "collecting" }
	/** Some zones report data, others don't. */
	| { readonly kind: "partial"; readonly live: number; readonly total: number }
	/** Everything live, history still filling. `progress` is the fraction of the 24h window done. */
	| { readonly kind: "backfilling"; readonly progress: number }
	| { readonly kind: "live" }
	/** Connected long enough that "give it a few minutes" has stopped being the answer. */
	| { readonly kind: "stalled" }

/** Cloudflare batches analytics in 5-minute buckets; the poller reads them on the same cadence. */
export const POLL_INTERVAL_MINUTES = 5
/** Buckets younger than this are incomplete, so the poller never asks for them. */
export const SAFETY_LAG_MINUTES = 10
/** What we promise a freshly-connected org: cadence + lag, rounded up to a whole number. */
export const FIRST_DATA_MINUTES = POLL_INTERVAL_MINUTES + SAFETY_LAG_MINUTES

/** Past this with nothing ingested, the wait is a problem rather than a cadence. */
const STALL_AFTER_MS = 30 * 60_000
/** The history the poller backfills, matching `BACKFILL_MS` in `CloudflareAnalyticsService`. */
const BACKFILL_WINDOW_MS = 24 * 60 * 60_000
/** Backfill within one poll window of the floor is finished for display purposes. */
const BACKFILL_DONE_SLACK_MS = 60 * 60_000

const hasData = (usage: CloudflareUsageResponse, displayName: string): boolean =>
	usage.services.some(
		(service) =>
			service.displayName === displayName && (service.totalRequests > 0 || service.lastDataAt != null),
	)

/**
 * `usage` is the warehouse read — pass `null` while it is loading or failed, which holds the
 * phase at the poller's own view rather than reporting an absence the warehouse never confirmed.
 */
export function cloudflareIngestPhase(
	status: CloudflareIntegrationStatus,
	usage: CloudflareUsageResponse | null,
	now: number,
): CloudflareIngestPhase {
	const zones = status.zones.filter((zone) => zone.enabled)
	const stalled = status.connectedAt != null && now - status.connectedAt > STALL_AFTER_MS

	// No state rows at all: discovery hasn't run (or found nothing). The connect callback primes
	// it, so this is normally a few seconds — long enough and it's the same dead end as no data.
	if (zones.length === 0 && status.workers == null) {
		return stalled ? { kind: "stalled" } : { kind: "discovering" }
	}

	// Usage in flight: report the poller's own progress rather than guessing at the warehouse.
	if (usage == null) {
		const anySynced =
			zones.some((zone) => zone.watermarkAt != null) || status.workers?.watermarkAt != null
		return anySynced ? { kind: "live" } : { kind: "collecting" }
	}

	const live = zones.filter((zone) => hasData(usage, zone.name)).length
	const workersLive =
		status.workers != null &&
		usage.services.some(
			(service) =>
				service.kind === "worker" && (service.totalRequests > 0 || service.lastDataAt != null),
		)

	if (live === 0 && !workersLive) {
		return stalled ? { kind: "stalled" } : { kind: "collecting" }
	}
	// A zone with no traffic at all is indistinguishable from one still catching up, so only
	// call it partial while the connection is young enough for catching-up to be the likelier
	// explanation — past that, a quiet zone is just quiet and shouldn't nag forever.
	if (live < zones.length && !stalled) {
		return { kind: "partial", live, total: zones.length }
	}

	const progress = backfillProgress(status, now)
	return progress == null ? { kind: "live" } : { kind: "backfilling", progress }
}

/**
 * Fraction of the 24h history already ingested, or null when it is complete (or hasn't started —
 * the frontier is seeded by the first head poll). Zones fill independently and the frontier walks
 * DOWN, so the zone with the HIGHEST frontier is the one furthest from done — and a chart reaching
 * back a day is only as complete as that zone. Reporting the lowest instead would let one
 * finished zone (whose frontier rests at the floor) claim the whole account was caught up.
 */
function backfillProgress(status: CloudflareIntegrationStatus, now: number): number | null {
	const frontiers = [
		...status.zones.filter((zone) => zone.enabled).map((zone) => zone.backfillAt),
		status.workers?.backfillAt,
	].filter((value): value is number => value != null)
	if (frontiers.length === 0) return null
	const leastCaughtUp = Math.max(...frontiers)
	const floor = now - BACKFILL_WINDOW_MS
	const remaining = leastCaughtUp - floor
	if (remaining <= BACKFILL_DONE_SLACK_MS) return null
	return Math.min(1, Math.max(0, 1 - remaining / BACKFILL_WINDOW_MS))
}

/** Banner/empty copy for a phase. One place, so every surface says the same thing. */
export function describeCloudflareIngestPhase(phase: CloudflareIngestPhase): {
	readonly title: string
	readonly description: string
	readonly tone: "info" | "warning"
} {
	switch (phase.kind) {
		case "discovering":
			return {
				title: "Finding your zones and Workers",
				description:
					"Maple is listing everything the connected Cloudflare accounts cover. This usually takes a few seconds.",
				tone: "info",
			}
		case "collecting":
			return {
				title: "Collecting your first Cloudflare data",
				description: `Cloudflare publishes analytics in ${POLL_INTERVAL_MINUTES}-minute batches and needs about ${SAFETY_LAG_MINUTES} minutes before a batch is complete, so the first numbers usually land within ${FIRST_DATA_MINUTES} minutes of connecting. This page updates on its own.`,
				tone: "info",
			}
		case "partial":
			return {
				title: `${phase.live} of ${phase.total} zones reporting`,
				description:
					"The rest are still catching up, or had no traffic in this window. Nothing to do — they fill in as the poller works through them.",
				tone: "info",
			}
		case "backfilling":
			return {
				title: `Backfilling history — ${Math.round(phase.progress * 100)}% of the last 24 hours`,
				description:
					"Live data is already flowing. Older windows arrive a few at a time, so charts reaching further back keep filling in.",
				tone: "info",
			}
		case "stalled":
			return {
				title: "No Cloudflare data has arrived",
				description:
					"Collection has been connected for a while with nothing ingested. Check that the zones have traffic, and that the connection still has the analytics permissions — reconnecting re-grants them.",
				tone: "warning",
			}
		case "live":
			return { title: "Receiving Cloudflare data", description: "", tone: "info" }
	}
}
