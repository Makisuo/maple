/**
 * Shared helpers for unitflow models built over the per-org Electric-synced
 * collections: the `${orgId}:${generation}` dependency store that drives
 * `Db.fromCollectionByKey`, plus the failure-message extractor for collection
 * states.
 */

import { Registry, Store } from "@maple/unitflow"
import type * as Db from "@maple/unitflow/db"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

import { getCollectionsGeneration, subscribeCollectionsGeneration } from "@/lib/collections/org-collections"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"

export const collectionFailureMessage = <T>(state: Db.CollectionState<T>): string | null => {
	if (!AsyncResult.isFailure(state)) return null
	for (const reason of state.cause.reasons) {
		if (Cause.isFailReason(reason)) return reason.error.message
	}
	return "Collection failed to load"
}

export const orgIdOf = (key: string): string => key.slice(0, key.lastIndexOf(":"))

/**
 * `${orgId}:${generation}` — the composite the hook path encoded in its
 * useMemo deps. An org switch or a schema-self-heal generation bump changes
 * the key; `Db.fromCollectionByKey` then switches to the freshly minted
 * collections and the old subscriptions drain (`cleanupCollectionWhenIdle`
 * tears the superseded shape streams down once subscriberCount hits 0).
 */
export const makeOrgCollectionsKey: Effect.Effect<Store.Store<string>, never, Registry> = Effect.gen(function* () {
	const currentKey = () => `${getActiveOrgId() ?? "pending"}:${getCollectionsGeneration()}`
	const store = Store.make(currentKey())
	yield* Registry.run(
		Stream.callback<string>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const push = () => Queue.offerUnsafe(queue, currentKey())
					const unsubscribes = [subscribeActiveOrgId(push), subscribeCollectionsGeneration(push)]
					push()
					return unsubscribes
				}),
				(unsubscribes) =>
					Effect.sync(() => {
						for (const unsubscribe of unsubscribes) unsubscribe()
					}),
			),
		).pipe(
			// The acquire re-offers the current key to close the subscribe race, and
			// Store.set does not dedupe — dropping unchanged keys here keeps that
			// re-offer (and any same-key publish) from reloading dependent queries.
			Stream.mapEffect((key) =>
				Effect.gen(function* () {
					if ((yield* Store.get(store)) !== key) yield* Store.set(store, key)
				}),
			),
		),
	)
	return store
})
