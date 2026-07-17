/**
 * TanStack DB adapter for unitflow — Maple addition, not part of upstream.
 *
 * Bridges TanStack DB collections (framework-agnostic `@tanstack/db` layer)
 * into unitflow Stores: a collection becomes a read-only
 * `Store<CollectionState<T>>` whose subscription lives exactly as long as the
 * enclosing model instance (or registry) scope. Snapshots are pushed on every
 * data change AND every status transition — the status listener is what keeps
 * an empty collection from being stuck on `loading` forever (an empty sync
 * emits no change events, only `loading → ready`).
 *
 * Mutations need no adapter: `Mutation.make` accepts any Effect handler, so a
 * model wraps its write (e.g. `@maple/effect-db`'s `optimisticAction`)
 * directly.
 */

import {
	type Collection,
	type Context,
	createLiveQueryCollection,
	type GetResult,
	type InitialQueryBuilder,
	type QueryBuilder,
} from "@tanstack/db"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { Registry } from "../core/registry.js"
import * as Store from "../core/store.js"

/**
 * Why a collection store failed.
 * - `load-failed` — the collection reported `status === "error"`.
 * - `cleaned-up` — the collection was disposed while the store still watched it.
 */
export class CollectionError extends Data.TaggedError("unitflow/db/CollectionError")<{
	readonly reason: "load-failed" | "cleaned-up"
	readonly message: string
}> {}

/** The renderable state of a watched collection. */
export type CollectionState<T> = AsyncResult.AsyncResult<ReadonlyArray<T>, CollectionError>

const snapshot = <T extends object>(collection: Collection<T, any, any>): CollectionState<T> => {
	switch (collection.status) {
		case "error":
			return AsyncResult.fail(new CollectionError({ reason: "load-failed", message: "Collection failed to load" }))
		case "cleaned-up":
			return AsyncResult.fail(new CollectionError({ reason: "cleaned-up", message: "Collection has been cleaned up" }))
		case "idle":
		case "loading":
			return AsyncResult.initial(true)
		default:
			return AsyncResult.success(collection.toArray)
	}
}

/**
 * A stream of collection snapshots: the current state on subscribe, then one
 * per data change and per status transition. The TanStack DB subscription is
 * acquired when the stream starts and released with the stream's scope — pipe
 * it through `Registry.run` inside a model and teardown follows the instance.
 *
 * `startSync` (default true) forces the collection to begin syncing when the
 * stream starts; pass false to leave a lazily-synced collection idle (honoured
 * by {@link liveQuery}'s `startSync` option).
 */
export const changes = <T extends object>(
	collection: Collection<T, any, any>,
	startSync = true,
): Stream.Stream<CollectionState<T>> =>
	Stream.callback<CollectionState<T>>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				if (startSync) collection.startSyncImmediate()
				let closed = false
				let scheduled = false
				const offer = () => Queue.offerUnsafe(queue, snapshot(collection))
				// A sync transaction that touches N rows fires N change callbacks;
				// snapshotting each one queues N O(collection) `toArray` copies and N
				// downstream recomputations for what is one observable state change.
				// Coalesce same-tick bursts into a single microtask-deferred snapshot.
				const offerCoalesced = () => {
					if (scheduled) return
					scheduled = true
					queueMicrotask(() => {
						scheduled = false
						if (!closed) offer()
					})
				}
				const subscription = collection.subscribeChanges(offerCoalesced)
				const offStatus = collection.on("status:change", offerCoalesced)
				offer()
				return {
					subscription,
					offStatus,
					markClosed: () => {
						closed = true
					},
				}
			}),
			({ markClosed, offStatus, subscription }) =>
				Effect.sync(() => {
					markClosed()
					offStatus()
					subscription.unsubscribe()
				}),
		),
	)

/**
 * A read-only Store tracking a synced collection. The subscription is forked
 * into the enclosing model instance's scope (the registry scope outside a
 * model): disposing the instance unsubscribes, letting the collection's own
 * GC / idle cleanup take over.
 */
export const fromCollection = <T extends object>(
	collection: Collection<T, any, any>,
): Effect.Effect<Store.Store<CollectionState<T>>, never, Registry> =>
	Effect.gen(function* () {
		const store = Store.make<CollectionState<T>>(AsyncResult.initial(true))
		yield* Registry.run(changes(collection).pipe(Stream.mapEffect((state) => Store.set(store, state))))
		return store
	})

/**
 * A read-only Store over a keyed family of collections: watches
 * `collectionFor(key)` for the key store's current value and SWITCHES when the
 * key changes — the previous collection's subscription is released before the
 * next one is acquired (interruption closes the inner stream's scope). This is
 * how org-scoped collections flow through a model: key on
 * `"<orgId>:<generation>"` and hand back the org-collection singleton.
 */
export const fromCollectionByKey = <K, T extends object>(
	key: Store.Source<K>,
	collectionFor: (key: K) => Collection<T, any, any>,
): Effect.Effect<Store.Store<CollectionState<T>>, never, Registry> =>
	Effect.gen(function* () {
		const store = Store.make<CollectionState<T>>(AsyncResult.initial(true))
		yield* Registry.run(
			Store.stream(key).pipe(
				// Only genuine key CHANGES switch — a re-published equal key must not
				// tear down and resubscribe the same collection.
				Stream.changes,
				Stream.switchMap((current) => changes(collectionFor(current))),
				Stream.mapEffect((state) => Store.set(store, state)),
			),
		)
		return store
	})

/** Options for {@link liveQuery}. */
export interface LiveQueryOptions {
	/** Start syncing immediately (default true). */
	readonly startSync?: boolean
}

/** A query function over the framework-agnostic live-query builder. */
export type QueryFn<TContext extends Context> = (q: InitialQueryBuilder) => QueryBuilder<TContext>

/**
 * A read-only Store over a derived live query. The derived collection is
 * created when the pipeline starts (`gcTime: 0` — the model scope IS the GC
 * boundary) and `cleanup()` runs when the scope closes.
 */
export const liveQuery = <TContext extends Context>(
	queryFn: QueryFn<TContext>,
	options?: LiveQueryOptions,
): Effect.Effect<Store.Store<CollectionState<GetResult<TContext>>>, never, Registry> =>
	Effect.gen(function* () {
		const store = Store.make<CollectionState<GetResult<TContext>>>(AsyncResult.initial(true))
		const collectionChanges = Stream.unwrap(
			Effect.acquireRelease(
				Effect.sync(() =>
					createLiveQueryCollection({
						query: queryFn,
						startSync: options?.startSync ?? true,
						gcTime: 0,
					}),
				),
				(collection) => Effect.promise(() => collection.cleanup()),
			).pipe(Effect.map((collection) => changes<GetResult<TContext>>(collection, options?.startSync ?? true))),
		)
		yield* Registry.run(collectionChanges.pipe(Stream.mapEffect((state) => Store.set(store, state))))
		return store
	})
