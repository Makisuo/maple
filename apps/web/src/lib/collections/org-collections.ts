import { useSyncExternalStore } from "react"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"
import {
	createAlertIncidentsCollection,
	createAlertRulesCollection,
	createAlertRuleStatesCollection,
	type AlertIncidentsCollection,
	type AlertRulesCollection,
	type AlertRuleStatesCollection,
} from "./alerts"
import { createDashboardsCollection, type DashboardsCollection } from "./dashboards"
import {
	createActorsCollection,
	createErrorIssuesCollection,
	createOpenErrorIncidentsCollection,
	type ActorsCollection,
	type ErrorIssuesCollection,
	type OpenErrorIncidentsCollection,
} from "./errors"

/**
 * The set of ElectricSQL-synced collections for one org. Collections are
 * org-scoped (their shape is pinned to `"org_id" = <org>` server-side and their
 * id embeds the org), so switching orgs recreates them — discarding the previous
 * org's shape handle/offset rather than colliding on it.
 */
export type OrgCollections = {
	readonly orgId: string
	readonly generation: number
	readonly dashboards: DashboardsCollection
	readonly alertRules: AlertRulesCollection
	readonly alertRuleStates: AlertRuleStatesCollection
	readonly alertIncidents: AlertIncidentsCollection
	readonly errorIssues: ErrorIssuesCollection
	readonly actors: ActorsCollection
	readonly openErrorIncidents: OpenErrorIncidentsCollection
}

// Single live set at a time — the app shows one org at a time, and recreating on
// switch is exactly the desired lifecycle.
let current: OrgCollections | null = null

// ---------------------------------------------------------------------------
// Self-heal generation counter
// ---------------------------------------------------------------------------
//
// When a collection's shape stream fails schema validation (a post-deploy column
// drift), the @maple/effect-db factory dispatches a `"collection:schema-error"`
// window event. We bump this generation and notify subscribers; `getOrgCollections`
// keys its singleton on BOTH orgId AND generation, so the next resolve mints fresh
// collections that re-fetch the shape from scratch. Consumers include
// `useCollectionsGeneration()` in their collection `useMemo` deps so they re-resolve
// after a bump.

let generation = 0
const generationListeners = new Set<() => void>()

export const getCollectionsGeneration = (): number => generation

export const subscribeCollectionsGeneration = (listener: () => void): (() => void) => {
	generationListeners.add(listener)
	return () => generationListeners.delete(listener)
}

/** Bumps the generation and tears down the current set so the next resolve rebuilds it. */
export const recreateOrgCollections = (): void => {
	generation += 1
	const previous = current
	current = null
	if (previous) cleanupOrgCollections(previous)
	for (const listener of generationListeners) listener()
}

/** Reactive generation counter — re-runs a consumer's collection memo after a self-heal. */
export const useCollectionsGeneration = (): number =>
	useSyncExternalStore(subscribeCollectionsGeneration, getCollectionsGeneration, () => 0)

const cleanupOrgCollections = (collections: OrgCollections): void => {
	void collections.dashboards.cleanup()
	void collections.alertRules.cleanup()
	void collections.alertRuleStates.cleanup()
	void collections.alertIncidents.cleanup()
	void collections.errorIssues.cleanup()
	void collections.actors.cleanup()
	void collections.openErrorIncidents.cleanup()
}

// Signing out sets the active org to "pending" (via setActiveOrgId(null)), so
// the next getOrgCollections call swaps and tears down the prior org's streams —
// no separate teardown entry point is needed.
export const getOrgCollections = (orgId: string): OrgCollections => {
	if (current && current.orgId === orgId && current.generation === generation) return current
	const previous = current
	current = {
		orgId,
		generation,
		dashboards: createDashboardsCollection(orgId),
		alertRules: createAlertRulesCollection(orgId),
		alertRuleStates: createAlertRuleStatesCollection(orgId),
		alertIncidents: createAlertIncidentsCollection(orgId),
		errorIssues: createErrorIssuesCollection(orgId),
		actors: createActorsCollection(orgId),
		openErrorIncidents: createOpenErrorIncidentsCollection(orgId),
	}
	// Tear down the previous org's shape streams after swapping so an in-flight
	// read never resolves against the wrong org.
	if (previous) cleanupOrgCollections(previous)
	return current
}

// A schema-validation failure on any shape stream means the client's row schema
// has drifted from the deployed table — recreate every collection so they re-fetch
// the shape from scratch. Guarded for SSR (no window during the server render).
if (typeof window !== "undefined") {
	window.addEventListener("collection:schema-error", () => recreateOrgCollections())
}

/** Reactive active-org id (null when signed out / org-less). Mode-agnostic — both Clerk and self-hosted auth publish via setActiveOrgId. */
export const useActiveOrgId = (): string | null =>
	useSyncExternalStore(subscribeActiveOrgId, getActiveOrgId, () => null)
