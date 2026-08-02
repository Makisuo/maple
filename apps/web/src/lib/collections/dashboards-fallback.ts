/**
 * The read-only escape hatch for a dead dashboards shape stream.
 *
 * Dashboards are not latency-critical to sync — the list is read far more often
 * than it is written, and `GET /v2/dashboards` returns the same rows Electric
 * would have streamed. So when the shape stream gives up (unreachable sync
 * endpoint, misconfigured `VITE_ELECTRIC_SYNC_URL`, a proxy eating the
 * long-poll), fetching the list over plain HTTP beats showing an error page for
 * data that is sitting right there.
 *
 * The snapshot is deliberately a SNAPSHOT: no live updates, and callers surface
 * it as degraded/read-only rather than pretending sync is healthy.
 *
 * One module-level store, not a per-consumer fetch: /dashboards mounts both the
 * list model and (through the sidebar) the `useDashboardsRead` hook, and a
 * failing stream must not turn into two identical HTTP reads.
 */

import { Registry, Store } from "@maple/unitflow"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { useCallback, useSyncExternalStore } from "react"

import type { Dashboard } from "@/components/dashboard-builder/types"
import { mapleRuntime } from "@/lib/registry"
import { subscribeActiveOrgId } from "@/lib/services/common/auth-headers"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { v2DashboardToDashboard } from "./dashboards"
import { subscribeCollectionsGeneration } from "./org-collections"

/** The v2 list endpoint's per-page ceiling (`LIST_LIMIT_MAX`). */
const PAGE_SIZE = 100

// A backstop, not a real limit: 20 pages is 2000 dashboards, far past any real
// org. It exists so a server that kept answering `has_more: true` could never
// spin this loop forever — the exact failure mode this module is here to fix.
const MAX_PAGES = 20

/**
 * Walks the cursor-paginated list endpoint into the web {@link Dashboard} shape.
 * Ordering (most recently updated first) comes from the endpoint and is
 * preserved across pages, matching what the Electric-backed list renders.
 */
const fetchDashboardsOverHttp = Effect.gen(function* () {
	const client = yield* MapleApiV2AtomClient
	const dashboards: Array<Dashboard> = []
	let cursor: string | undefined

	for (let page = 0; page < MAX_PAGES; page++) {
		const response = yield* client.dashboards.list({
			query: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
		})
		for (const dashboard of response.data) dashboards.push(v2DashboardToDashboard(dashboard))
		if (!response.has_more || response.next_cursor === null) break
		cursor = response.next_cursor
	}

	return dashboards as ReadonlyArray<Dashboard>
})

export type DashboardsFallbackState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly dashboards: ReadonlyArray<Dashboard> }
	| { readonly status: "failed" }

let state: DashboardsFallbackState = { status: "idle" }
const listeners = new Set<() => void>()

const setState = (next: DashboardsFallbackState): void => {
	state = next
	for (const listener of listeners) listener()
}

export const getDashboardsFallback = (): DashboardsFallbackState => state

export const subscribeDashboardsFallback = (listener: () => void): (() => void) => {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Loads the HTTP snapshot once. Idempotent: repeated calls while loading, after
 * a successful load, or after a failed one are no-ops, so the 30s stuck verdict
 * re-firing across heal attempts can't stack up requests.
 *
 * The snapshot is deliberately NOT invalidated when the collections are
 * recreated — a heal that fails again would otherwise blank the list the user is
 * reading every 30 seconds. It IS invalidated on an org switch, where the cached
 * rows belong to the wrong tenant.
 */
export const requestDashboardsFallback = (): void => {
	watchInvalidation()
	if (state.status !== "idle") return
	setState({ status: "loading" })
	mapleRuntime.runFork(
		fetchDashboardsOverHttp.pipe(
			Effect.tap((dashboards) => Effect.sync(() => setState({ status: "ready", dashboards }))),
			Effect.tapError((cause) =>
				Effect.logError("Dashboards HTTP fallback failed; sync and fallback are both down").pipe(
					Effect.annotateLogs({ cause }),
				),
			),
			Effect.catchCause(() => Effect.sync(() => setState({ status: "failed" }))),
		),
	)
}

// Registered on first request rather than at import: nothing here is worth
// invalidating until a snapshot exists, and a module that reaches into the auth
// and collections registries the moment it is imported is a trap for consumers
// that mock them.
let watchingInvalidation = false
const watchInvalidation = (): void => {
	if (watchingInvalidation) return
	watchingInvalidation = true
	// An org switch makes a cached snapshot flatly wrong — it belongs to the
	// previous tenant.
	subscribeActiveOrgId(() => {
		if (state.status !== "idle") setState({ status: "idle" })
	})
	// A recreate (heal or user retry) is a fresh chance for the HTTP read too, but
	// only a FAILED snapshot is discarded: dropping a good one would blank the
	// list a user is reading every time a heal attempt cycles.
	subscribeCollectionsGeneration(() => {
		if (state.status === "failed") setState({ status: "idle" })
	})
}

/**
 * React binding. `enabled` gates the fetch, not the subscription: components
 * pass the collection's failure verdict, and the request fires the moment it
 * flips true.
 */
export const useDashboardsFallback = (enabled: boolean): DashboardsFallbackState => {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			if (enabled) requestDashboardsFallback()
			listeners.add(onStoreChange)
			return () => {
				listeners.delete(onStoreChange)
			}
		},
		[enabled],
	)
	return useSyncExternalStore(subscribe, getDashboardsFallback, () => state)
}

/** unitflow binding — the same single store, as a model-scoped read-only Store. */
export const makeDashboardsFallbackStore: Effect.Effect<
	Store.Store<DashboardsFallbackState>,
	never,
	Registry
> = Effect.gen(function* () {
	const store = Store.make<DashboardsFallbackState>(getDashboardsFallback())
	yield* Registry.run(
		Stream.callback<DashboardsFallbackState>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const push = () => Queue.offerUnsafe(queue, getDashboardsFallback())
					const unsubscribe = subscribeDashboardsFallback(push)
					push()
					return unsubscribe
				}),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		).pipe(Stream.mapEffect((next) => Store.set(store, next))),
	)
	return store
})
