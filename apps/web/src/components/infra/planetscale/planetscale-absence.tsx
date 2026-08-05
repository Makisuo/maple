// The vocabulary of absence for the PlanetScale surfaces.
//
// A dash on these pages has six different causes, and they have six different
// fixes: metrics were never enabled, the branch is excluded from scraping, the
// OAuth grant was revoked, the inventory poller is stalled, the window has no
// samples, or the query failed. Rendering all six as a bare "—" (which is what
// this integration did) makes an unmonitored database indistinguishable from a
// healthy idle one.
//
// Every surface — the fleet page, the drill-in, the service-map panel — reads
// its copy from here, so the same cause always reads the same way.

import { Link } from "@tanstack/react-router"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { AlertWarningIcon, CircleWarningIcon } from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

/** Metrics scraping is off. Said the same way wherever a metric would have been. */
export const METRICS_PAUSED_MESSAGE = "Branch metrics are paused — add a metrics token to collect them."

/** Short form for a table cell subline or a stat rail, where the Alert already carries the fix. */
export const METRICS_PAUSED_SHORT = "metrics paused"

/** The grant is gone; nothing will refresh until someone reconnects. */
export const GRANT_REVOKED_MESSAGE =
	"The PlanetScale authorization was revoked — reconnect to resume inventory and metrics."

const integrationLink = { to: "/integrations", search: { integration: "planetscale" } } as const

/**
 * Shown when `metricsAuth === "missing"`: the OAuth grant covers inventory,
 * query insights, and webhooks, but PlanetScale's metrics endpoints only
 * document service-token auth — so this is the one manual step, and the reason
 * every metric column is empty.
 */
export function PlanetScaleMetricsNotice() {
	return (
		<Alert variant="warning">
			<AlertWarningIcon />
			<AlertTitle>Branch metrics aren't being collected</AlertTitle>
			<AlertDescription>
				Databases and branches are up to date, and query insights still work. Connections, CPU,
				memory, storage, and replica lag need a PlanetScale service token with the
				read_metrics_endpoints permission.
			</AlertDescription>
			<AlertAction>
				<Button size="sm" variant="outline" render={<Link {...integrationLink} />}>
					Add a metrics token
				</Button>
			</AlertAction>
		</Alert>
	)
}

/** Shown when the OAuth grant has been revoked — every PlanetScale read is dead until it's renewed. */
export function PlanetScaleRevokedNotice() {
	return (
		<Alert variant="error">
			<CircleWarningIcon />
			<AlertTitle>PlanetScale authorization revoked</AlertTitle>
			<AlertDescription>
				Maple can no longer read this organization, so databases, branches, and metrics are frozen at
				their last known state. Reconnecting restores them.
			</AlertDescription>
			<AlertAction>
				<Button size="sm" render={<Link {...integrationLink} />}>
					Reconnect PlanetScale
				</Button>
			</AlertAction>
		</Alert>
	)
}

/**
 * Shown when the inventory poller last succeeded too long ago, or failed
 * outright. The database list still renders — it's just possibly stale, and
 * saying so beats letting someone trust a deleted branch.
 */
export function PlanetScaleInventoryNotice({
	lastInventoryAt,
	lastInventoryError,
}: {
	/** ISO-8601 timestamp from the API, or `null` before the first refresh. */
	lastInventoryAt: string | null
	lastInventoryError: string | null
}) {
	const failing = lastInventoryError !== null
	return (
		<Alert variant="warning">
			<AlertWarningIcon />
			<AlertTitle>
				{failing ? "Inventory refresh is failing" : "Inventory hasn't refreshed recently"}
			</AlertTitle>
			<AlertDescription>
				{failing
					? "The database and branch list may be out of date. Metrics are unaffected."
					: `The database and branch list may be out of date — last refreshed ${
							lastInventoryAt === null ? "never" : formatRelativeTime(lastInventoryAt)
						}.`}
			</AlertDescription>
		</Alert>
	)
}

/** Inventory refreshes hourly; past this the list is stale enough to caveat. */
export const INVENTORY_STALE_MS = 90 * 60 * 1000

export function inventoryIsStale(lastInventoryAt: string | null, now: number): boolean {
	return lastInventoryAt !== null && now - Date.parse(lastInventoryAt) > INVENTORY_STALE_MS
}

/**
 * The one-line reason a specific branch has no numbers. Distinct from the
 * page-level notices: these are per-row causes with per-row fixes.
 */
export const BRANCH_ABSENCE_COPY = {
	excluded: "Excluded from metrics collection by this connection's branch filters.",
	"no-data": "No metrics for this branch in the selected window.",
} as const
