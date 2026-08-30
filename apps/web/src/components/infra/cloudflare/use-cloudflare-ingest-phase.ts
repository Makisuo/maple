import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { cloudflareIngestPhase } from "./ingest-phase"

/**
 * Cadence for the self-updating wait. Matched to the poller's own 5-minute tick rather than made
 * snappy: the point is that someone who connects and waits sees the page fill in without touching
 * anything, not that we ask more often than there is anything new to ask for.
 */
const REFRESH_MS = 30_000

/**
 * Connection status, warehouse usage, and the ingest phase the two imply — plus the polling that
 * turns "collecting" into real numbers in place. Every Cloudflare surface reads its status through
 * this hook rather than the query directly, so they agree on what an empty page means.
 *
 * `phase` is null when the org has no usable connection; the caller's own not-connected and
 * needs-permissions states own that case.
 */
export function useCloudflareIngestPhase() {
	// Assigned through these so the value hooks and the refresh hooks address the same atoms.
	const statusQuery = retainedQuery("integrations", "cloudflareStatus", {
		reactivityKeys: ["cloudflareIntegrationStatus"],
	})
	const usageQuery = retainedQuery("integrations", "cloudflareUsage", {
		reactivityKeys: ["cloudflareIntegrationUsage"],
	})
	const statusResult = useAtomValue(statusQuery)
	const usageResult = useAtomValue(usageQuery)
	const refreshStatus = useAtomRefresh(statusQuery)
	const refreshUsage = useAtomRefresh(usageQuery)

	const status = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)
	// A failed usage read is not proof of no data — passing null holds the phase at the poller's
	// own view instead of reporting an absence the warehouse never confirmed.
	const usage = Result.builder(usageResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	// Recomputed every render (including each poll tick) so the phase advances on its own.
	const phase = status?.connected === true ? cloudflareIngestPhase(status, usage, Date.now()) : null

	// Poll only while something is expected to change; a live integration refreshes on the page's
	// own time-range controls like everything else.
	const settling = phase != null && phase.kind !== "live"
	useIntervalRefresh(refreshStatus, { intervalMs: REFRESH_MS, enabled: settling })
	useIntervalRefresh(refreshUsage, { intervalMs: REFRESH_MS, enabled: settling })

	return { statusResult, usageResult, status, usage, phase }
}
