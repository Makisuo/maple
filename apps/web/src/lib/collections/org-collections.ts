import { Effect } from "effect"
import { useSyncExternalStore } from "react"
import { mapleRuntime } from "@/lib/registry"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"
import {
	createAlertDestinationsCollection,
	createAlertIncidentsCollection,
	createAlertRulesCollection,
	createAlertRuleStatesCollection,
	type AlertDestinationsCollection,
	type AlertIncidentsCollection,
	type AlertRulesCollection,
	type AlertRuleStatesCollection,
} from "./alerts"
import { createApiKeysCollection, type ApiKeysCollection } from "./api-keys"
import { createDashboardsCollection, type DashboardsCollection } from "./dashboards"

/**
 * The set of ElectricSQL-synced collections for one org. Collections are
 * org-scoped (their shape is pinned to `"org_id" = <org>` server-side and their
 * id embeds the org), so switching orgs recreates them — discarding the previous
 * org's shape handle/offset rather than colliding on it.
 */
export type OrgCollections = {
	readonly orgId: string
	readonly generation: number
	readonly apiKeys: ApiKeysCollection
	readonly dashboards: DashboardsCollection
	readonly alertRules: AlertRulesCollection
	readonly alertRuleStates: AlertRuleStatesCollection
	readonly alertIncidents: AlertIncidentsCollection
	readonly alertDestinations: AlertDestinationsCollection
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
	if (previous) scheduleOrgCollectionsCleanup(previous)
	for (const listener of generationListeners) listener()
}

// ---------------------------------------------------------------------------
// Bounded self-heal
// ---------------------------------------------------------------------------
//
// A schema error the recreated shape can't clear (e.g. a client row-schema that
// declares a column the *deployed* table doesn't have — every row fails
// validation) would otherwise loop forever: recreate → re-subscribe → same bad
// row → `collection:schema-error` → recreate, at the shape's fetch cadence
// (~30ms). That storm hammers the sync proxy + API with a flood of
// successful-but-useless requests and re-fires the page's dependent queries.
//
// Cap the recovery to a few spaced attempts. A transient post-deploy drift still
// heals (the first recreate refetches fresh rows); a persistent one degrades to
// stale/empty lists instead of an infinite loop. Bursts (several collections
// failing from one deploy) collapse into a single pending attempt, and the
// budget resets on a real org switch.
const MAX_SCHEMA_HEAL_ATTEMPTS = 3
const SCHEMA_HEAL_COOLDOWN_MS = 5_000
let schemaHealAttempts = 0
let lastSchemaHealAt = 0
let schemaHealGaveUp = false
let pendingHealTimer: ReturnType<typeof setTimeout> | null = null

const logSchemaHealGaveUp = (source: HealSource): void => {
	mapleRuntime.runFork(
		Effect.logError(
			"Electric sync self-heal exhausted its retry budget; collections left as-is " +
				"(lists may show stale/empty/errored data until reload).",
		).pipe(
			Effect.annotateLogs({ source, attempts: schemaHealAttempts, maxAttempts: MAX_SCHEMA_HEAL_ATTEMPTS }),
		),
	)
}

/** Clears the heal budget + any pending attempt. Called on a genuine org switch. */
const resetSchemaHealBudget = (): void => {
	if (pendingHealTimer !== null) {
		clearTimeout(pendingHealTimer)
		pendingHealTimer = null
	}
	schemaHealAttempts = 0
	lastSchemaHealAt = 0
	schemaHealGaveUp = false
}

/** What tripped a bounded heal — annotates the logs so dev consoles/telemetry show the cause. */
type HealSource = "schema-error" | "stuck-loading" | "auth-error"

/**
 * Schedules a bounded, spaced recreation of the org collections. Both triggers
 * (schema drift, stuck-loading) share ONE budget: once it is spent no further
 * recreations happen and we log once, so a persistent failure can no longer
 * loop the sync proxy. The budget resets on a genuine org switch.
 */
const scheduleBoundedHeal = (source: HealSource): void => {
	if (schemaHealGaveUp || pendingHealTimer !== null) return
	if (schemaHealAttempts >= MAX_SCHEMA_HEAL_ATTEMPTS) {
		schemaHealGaveUp = true
		logSchemaHealGaveUp(source)
		return
	}
	// First attempt fires immediately; later ones wait out the cooldown so the
	// storm can't re-form between recreations.
	const elapsed = Date.now() - lastSchemaHealAt
	const delay = schemaHealAttempts === 0 ? 0 : Math.max(0, SCHEMA_HEAL_COOLDOWN_MS - elapsed)
	pendingHealTimer = setTimeout(() => {
		pendingHealTimer = null
		schemaHealAttempts += 1
		lastSchemaHealAt = Date.now()
		// The schema path already logs at the effect-db layer; the stuck and auth
		// paths' recreate has no other trace, so log it here for dev consoles/telemetry.
		if (source === "stuck-loading" || source === "auth-error") {
			mapleRuntime.runFork(
				Effect.logWarning(`Electric sync self-heal: recreating org collections (${source})`).pipe(
					Effect.annotateLogs({ source, attempt: schemaHealAttempts, maxAttempts: MAX_SCHEMA_HEAL_ATTEMPTS }),
				),
			)
		}
		recreateOrgCollections()
	}, delay)
}

/**
 * Self-heal handler for `collection:schema-error`: schedules a bounded, spaced
 * recreation (see {@link scheduleBoundedHeal}). Exported for tests.
 */
export const handleSchemaError = (): void => scheduleBoundedHeal("schema-error")

/**
 * Recovery hook for a collection that sat in `loading` with no emissions past
 * the stuck timeout (`Db.fromCollectionByKey`'s `onStuck`): recreates the org
 * collections so fresh shape streams replace the wedged ones, under the same
 * bounded budget as the schema-error heal. Exported for tests.
 */
export const handleCollectionStuck = (): void => scheduleBoundedHeal("stuck-loading")

/**
 * Recovery hook for a shape stream the sync layer stopped on a 401
 * (`collection:auth-error` from @maple/effect-db): the stream's token went
 * stale (expired Clerk token on a long-lived poll, or an org switch elsewhere),
 * but the session is usually still alive. Recreating the collections refetches
 * the shape with a freshly minted token. Shares the bounded budget, so a
 * genuinely signed-out session stops after a few attempts instead of looping
 * 401s against the sync proxy. Exported for tests.
 */
export const handleCollectionAuthError = (): void => scheduleBoundedHeal("auth-error")

/** Reactive generation counter — re-runs a consumer's collection memo after a self-heal. */
export const useCollectionsGeneration = (): number =>
	useSyncExternalStore(subscribeCollectionsGeneration, getCollectionsGeneration, () => 0)

// How long a superseded collection may stay subscribed before we tear it down
// anyway. Live-query collections GC ~5s after their last subscriber leaves and
// only then release the source, so normal drain finishes well inside this.
const CLEANUP_FALLBACK_MS = 30_000

// The lifecycle surface the cleanup scheduler needs; every synced collection
// (any row type) satisfies it.
type SyncedCollectionLifecycle = Pick<DashboardsCollection, "subscriberCount" | "cleanup" | "on">

/**
 * Tears a superseded collection down once nothing depends on it. Cleaning up
 * while live queries still subscribe logs a "[Live Query Error] Source
 * collection ... was manually cleaned up" and makes TanStack DB restart sync on
 * the dead collection (zombie shape long-polls under the previous org). The
 * consumers release the old collection asynchronously — React re-renders onto
 * the new set, then the old live-query collection GCs (~5s) and unsubscribes —
 * so cleanup waits for `subscriberCount` to hit zero. The fallback timer covers
 * a leaked subscription: tearing down then still logs the live-query error
 * once, but a stale shape stream must not long-poll forever.
 */
const cleanupCollectionWhenIdle = (collection: SyncedCollectionLifecycle): void => {
	if (collection.subscriberCount === 0) {
		void collection.cleanup()
		return
	}
	let settled = false
	const settle = () => {
		if (settled) return
		settled = true
		off()
		clearTimeout(fallback)
		void collection.cleanup()
	}
	const off = collection.on("subscribers:change", (event) => {
		if (event.subscriberCount === 0) settle()
	})
	const fallback = setTimeout(settle, CLEANUP_FALLBACK_MS)
}

/** Tears down a superseded set as each collection drains (see cleanupCollectionWhenIdle). */
const scheduleOrgCollectionsCleanup = (collections: OrgCollections): void => {
	cleanupCollectionWhenIdle(collections.apiKeys)
	cleanupCollectionWhenIdle(collections.dashboards)
	cleanupCollectionWhenIdle(collections.alertRules)
	cleanupCollectionWhenIdle(collections.alertRuleStates)
	cleanupCollectionWhenIdle(collections.alertIncidents)
	cleanupCollectionWhenIdle(collections.alertDestinations)
}

// Tracks the last org we resolved collections for, independent of `current`
// (which `recreateOrgCollections` nulls) so a same-org self-heal rebuild is
// distinguishable from a genuine org switch.
let lastResolvedOrgId: string | null = null

// Signing out sets the active org to "pending" (via setActiveOrgId(null)), so
// the next getOrgCollections call swaps and tears down the prior org's streams —
// no separate teardown entry point is needed.
export const getOrgCollections = (orgId: string): OrgCollections => {
	if (current && current.orgId === orgId && current.generation === generation) return current
	// A genuine org switch (not a same-org self-heal rebuild) gets a fresh heal budget.
	if (lastResolvedOrgId !== null && lastResolvedOrgId !== orgId) resetSchemaHealBudget()
	lastResolvedOrgId = orgId
	const previous = current
	current = {
		orgId,
		generation,
		apiKeys: createApiKeysCollection(orgId),
		dashboards: createDashboardsCollection(orgId),
		alertRules: createAlertRulesCollection(orgId),
		alertRuleStates: createAlertRuleStatesCollection(orgId),
		alertIncidents: createAlertIncidentsCollection(orgId),
		alertDestinations: createAlertDestinationsCollection(orgId),
	}
	// Tear down the previous org's shape streams after swapping so an in-flight
	// read never resolves against the wrong org. Deferred (see
	// scheduleOrgCollectionsCleanup) so live queries unsubscribe first.
	if (previous) scheduleOrgCollectionsCleanup(previous)
	return current
}

// A schema-validation failure on any shape stream means the client's row schema
// has drifted from the deployed table — recreate every collection so they re-fetch
// the shape from scratch, under a bounded retry budget so a *persistent* drift
// degrades gracefully instead of looping. Guarded for SSR (no window on the server).
if (typeof window !== "undefined") {
	window.addEventListener("collection:schema-error", handleSchemaError)
	window.addEventListener("collection:auth-error", handleCollectionAuthError)
}

/** Reactive active-org id (null when signed out / org-less). Mode-agnostic — both Clerk and self-hosted auth publish via setActiveOrgId. */
export const useActiveOrgId = (): string | null =>
	useSyncExternalStore(subscribeActiveOrgId, getActiveOrgId, () => null)
