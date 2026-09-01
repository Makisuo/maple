import { useMemo } from "react"
import { formatWarehouseDateTime } from "@maple/query-engine"
import type { NavSurface } from "@/components/dashboard/nav-items"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { infraPresenceResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * "Is it reporting now?" — an hour is long enough to survive a collector
 * restart or a scrape gap, short enough that a surface an org has switched off
 * stops padding the nav the same day.
 */
const PRESENCE_WINDOW_MS = 60 * 60 * 1000

/**
 * The window is snapped to five-minute boundaries so the atom key holds still.
 * An unrounded `Date.now()` mints a new key on every render, which turns a
 * cached read into a fresh warehouse query on every navigation — the exact cost
 * this probe exists to avoid.
 */
const BUCKET_MS = 5 * 60 * 1000

/**
 * Which Infrastructure surfaces this org actually has.
 *
 * Two sources, because the section mixes two kinds of page. The five OTel
 * surfaces come from the warehouse probe. Cloudflare and PlanetScale are
 * integration pages — you have them because you connected the integration, not
 * because a metric arrived — so they read the same two status atoms the
 * integrations hub uses. Only those two of the hub's six are mounted here: this
 * hook lives in the sidebar, so every atom it touches is a request on every
 * page.
 *
 * `null` means "don't know yet" — the probe is in flight, or it failed.
 * Callers must show their full list in that case; a nav that hides rows
 * because a query errored is worse than one that lists a page you don't use.
 */
export function useInfraSurfaces(): ReadonlySet<NavSurface> | null {
	const { startTime, endTime } = useMemo(() => {
		const end = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
		return {
			startTime: formatWarehouseDateTime(end - PRESENCE_WINDOW_MS),
			endTime: formatWarehouseDateTime(end),
		}
	}, [])

	const presenceResult = useAtomValue(infraPresenceResultAtom({ data: { startTime, endTime } }))
	const cloudflareResult = useAtomValue(
		retainedQuery("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const planetscaleResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)

	const telemetry = Result.builder(presenceResult)
		.onSuccess((response): ReadonlyArray<NavSurface> | null => response.surfaces)
		.onInitial((): ReadonlyArray<NavSurface> | null => null)
		.orElse((): ReadonlyArray<NavSurface> | null => null)

	// An integration status that hasn't landed reads as not-connected rather than
	// unknown: unlike the probe, it can't hide a page you're using, because the
	// route you're on always renders its own row.
	const cloudflare = Result.builder(cloudflareResult)
		.onSuccess((status) => status.connected)
		.orElse(() => false)
	const planetscale = Result.builder(planetscaleResult)
		.onSuccess((status) => status.connected)
		.orElse(() => false)

	return useMemo(() => {
		if (telemetry === null) return null
		const surfaces = new Set<NavSurface>(telemetry)
		if (cloudflare) surfaces.add("cloudflare")
		if (planetscale) surfaces.add("planetscale")
		return surfaces
	}, [telemetry, cloudflare, planetscale])
}
