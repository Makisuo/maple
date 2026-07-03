import { useSyncExternalStore } from "react"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"
import { createDashboardsCollection, type DashboardsCollection } from "./dashboards"

/**
 * The set of ElectricSQL-synced collections for one org. Collections are
 * org-scoped (their shape is pinned to `"org_id" = <org>` server-side and their
 * id embeds the org), so switching orgs recreates them — discarding the previous
 * org's shape handle/offset rather than colliding on it.
 */
export type OrgCollections = {
	readonly orgId: string
	readonly dashboards: DashboardsCollection
}

// Single live set at a time — the app shows one org at a time, and recreating on
// switch is exactly the desired lifecycle.
let current: OrgCollections | null = null

// Signing out sets the active org to "pending" (via setActiveOrgId(null)), so
// the next getOrgCollections call swaps and tears down the prior org's streams —
// no separate teardown entry point is needed.
export const getOrgCollections = (orgId: string): OrgCollections => {
	if (current && current.orgId === orgId) return current
	const previous = current
	current = { orgId, dashboards: createDashboardsCollection(orgId) }
	// Tear down the previous org's shape streams after swapping so an in-flight
	// read never resolves against the wrong org.
	if (previous) void previous.dashboards.cleanup()
	return current
}

/** Reactive active-org id (null when signed out / org-less). Mode-agnostic — both Clerk and self-hosted auth publish via setActiveOrgId. */
export const useActiveOrgId = (): string | null =>
	useSyncExternalStore(subscribeActiveOrgId, getActiveOrgId, () => null)
