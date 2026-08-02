/**
 * A bounded load for the collections consumed through `useLiveQuery` hooks.
 *
 * The unitflow model path gets this from `Db.fromCollectionByKey`'s stuck
 * watchdog (`orgCollectionStuckOptions`), but a live query has no such guard: an
 * unreachable sync endpoint leaves the collection in `loading` and every hook
 * reports `isLoading: true` forever, so the page renders a skeleton that never
 * resolves and nothing is logged.
 *
 * The watchdog lives OUTSIDE React, keyed by collection id, for two reasons:
 * several components watch the same collection (sidebar, command palette and the
 * dashboard page all read `dashboards`) and should share one timer and one
 * verdict; and the timeout is a property of the sync stream, not of whoever
 * happens to be mounted. Components subscribe via `useSyncExternalStore`, so
 * arming and disarming ride React's own subscribe/cleanup rather than an effect.
 */

import { useCallback, useSyncExternalStore } from "react"

import {
	handleCollectionStuck,
	isCollectionSyncFailed,
	subscribeCollectionsGeneration,
	subscribeSyncFailure,
} from "./org-collections"

/**
 * How long a collection may sit in `loading` with nothing to show before we call
 * it failed. Matches `orgCollectionStuckOptions.stuckTimeoutMs` so both paths
 * give up at the same moment — a user on /dashboards and one on /alerts see the
 * error after the same wait.
 */
export const COLLECTION_LOAD_TIMEOUT_MS = 30_000

const timedOut = new Set<string>()
const listeners = new Map<string, Set<() => void>>()

const notify = (collectionId: string): void => {
	for (const listener of listeners.get(collectionId) ?? []) listener()
}

const addListener = (collectionId: string, listener: () => void): (() => void) => {
	let set = listeners.get(collectionId)
	if (!set) {
		set = new Set()
		listeners.set(collectionId, set)
	}
	set.add(listener)
	return () => {
		set.delete(listener)
		if (set.size === 0) listeners.delete(collectionId)
	}
}

// A generation bump means every collection was just recreated with a fresh
// stream (and reuses its `<shape>:<orgId>` id), so a previous verdict no longer
// describes anything live — clear it and let the new stream have its full window.
//
// Registered on first use rather than at import: a module that reaches into the
// collections registry the moment it is imported is a trap for any consumer that
// mocks that registry, and nothing here matters until something is watching.
let watchingGenerations = false
const watchGenerations = (): void => {
	if (watchingGenerations) return
	watchingGenerations = true
	subscribeCollectionsGeneration(() => {
		if (timedOut.size === 0) return
		const cleared = [...timedOut]
		timedOut.clear()
		for (const collectionId of cleared) notify(collectionId)
	})
}

/**
 * Whether this collection has failed to load: either its stream gave up for good
 * (`collection:sync-failed`) or it sat in `loading` past
 * {@link COLLECTION_LOAD_TIMEOUT_MS} while `isLoading` stayed true.
 *
 * Passing `isLoading: false` disarms the watchdog, so a collection that is simply
 * empty (a real, successful, zero-row sync) is never reported as failed.
 */
export const useCollectionLoadFailed = (collectionId: string, isLoading: boolean): boolean => {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			watchGenerations()
			const removeListener = addListener(collectionId, onStoreChange)
			const removeSyncFailure = subscribeSyncFailure(onStoreChange)
			// Nothing to wait for once loaded, and no point re-arming after a verdict.
			if (!isLoading || timedOut.has(collectionId)) {
				return () => {
					removeListener()
					removeSyncFailure()
				}
			}
			const timer = setTimeout(() => {
				timedOut.add(collectionId)
				// Same recovery the model path uses: a bounded, spaced recreate of the
				// org collections, so a merely wedged stream still gets a fresh one.
				handleCollectionStuck()
				notify(collectionId)
			}, COLLECTION_LOAD_TIMEOUT_MS)
			return () => {
				clearTimeout(timer)
				removeListener()
				removeSyncFailure()
			}
		},
		[collectionId, isLoading],
	)

	// Derived on every read (both sources are plain sets) — `subscribe` above is
	// what tells React when either of them may have changed.
	const getSnapshot = useCallback(
		() => timedOut.has(collectionId) || isCollectionSyncFailed(collectionId),
		[collectionId],
	)

	return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
