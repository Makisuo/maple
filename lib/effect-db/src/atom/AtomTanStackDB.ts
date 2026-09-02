/** TanStack DB adapters for effect-atom. @since 1.0.0 */

import {
	type Collection,
	type Context,
	createLiveQueryCollection,
	type InferResultType,
	type InitialQueryBuilder,
	type NonSingleResult,
	type SingleResult,
} from "@tanstack/db"
import { constUndefined } from "effect/Function"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { CollectionStatus, ConditionalQueryFn, QueryFn, QueryOptions } from "./types"
import { TanStackDBError } from "./types"

/** Creates an atom that tracks a collection's lifecycle and rows. */
export const makeCollectionAtom = <T extends object, TKey extends string | number>(
	collection: Collection<T, TKey, any> & NonSingleResult,
): Atom.Atom<AsyncResult.AsyncResult<Array<T>, TanStackDBError>> => {
	return Atom.readable((get) => {
		collection.startSyncImmediate()

		// Subscribe before reading status so an async completion cannot be missed.
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }),
					),
				)
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({
							message: "Collection has been cleaned up",
							reason: "cleaned-up",
						}),
					),
				)
				return
			}

			const newData = Array.from(collection.entries()).map(([_, value]) => value)
			get.setSelf(AsyncResult.success(newData))
		})

		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(
				new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }),
			)
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(
				new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" }),
			)
		}

		const initialData = Array.from(collection.entries()).map(([_, value]) => value)

		return AsyncResult.success(initialData)
	})
}

/** Creates an atom for a single-result collection. */
export const makeSingleCollectionAtom = <T extends object, TKey extends string | number>(
	collection: Collection<T, TKey, any> & SingleResult,
): Atom.Atom<AsyncResult.AsyncResult<T | undefined, TanStackDBError>> => {
	return Atom.readable((get) => {
		collection.startSyncImmediate()

		// Subscribe before reading status so an async completion cannot be missed.
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }),
					),
				)
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({
							message: "Collection has been cleaned up",
							reason: "cleaned-up",
						}),
					),
				)
				return
			}

			const entries = Array.from(collection.entries())
			const newData = entries[0]?.[1]
			get.setSelf(AsyncResult.success(newData))
		})

		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(
				new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }),
			)
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(
				new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" }),
			)
		}

		const entries = Array.from(collection.entries())
		const initialData = entries[0]?.[1]

		return AsyncResult.success(initialData)
	})
}

/** Creates an atom backed by a managed live-query collection. */
export const makeQuery = <TContext extends Context>(
	queryFn: QueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<AsyncResult.AsyncResult<InferResultType<TContext>, TanStackDBError>> => {
	return Atom.readable((get) => {
		const collection = createLiveQueryCollection({
			query: queryFn,
			startSync: options?.startSync ?? true,
			gcTime: options?.gcTime ?? 0, // The atom owns the collection lifetime by default.
		})

		// Subscribe before reading status so an async completion cannot be missed.
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({ message: "Query failed to load", reason: "load-failed" }),
					),
				)
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(
					AsyncResult.fail(
						new TanStackDBError({
							message: "Query collection has been cleaned up",
							reason: "cleaned-up",
						}),
					),
				)
				return
			}

			const isSingleResult = (collection as any).config?.singleResult === true
			const entries = Array.from(collection.entries()).map(([_, value]) => value)
			// SAFETY: `singleResult` is the runtime discriminator for InferResultType's scalar/array branch.
			const newData = (isSingleResult ? entries[0] : entries) as unknown as InferResultType<TContext>
			get.setSelf(AsyncResult.success(newData))
		})

		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(
				new TanStackDBError({ message: "Query failed to load", reason: "load-failed" }),
			)
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(
				new TanStackDBError({
					message: "Query collection has been cleaned up",
					reason: "cleaned-up",
				}),
			)
		}

		const isSingleResult = (collection as any).config?.singleResult === true
		const entries = Array.from(collection.entries()).map(([_, value]) => value)
		// SAFETY: `singleResult` is the runtime discriminator for InferResultType's scalar/array branch.
		const initialData = (isSingleResult ? entries[0] : entries) as unknown as InferResultType<TContext>

		return AsyncResult.success(initialData)
	})
}

/** Creates a query atom that discards loading and error details. */
export const makeQueryUnsafe = <TContext extends Context>(
	queryFn: QueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<InferResultType<TContext> | undefined> => {
	return Atom.readable((get) => {
		const result = get(makeQuery(queryFn, options))
		return AsyncResult.getOrElse(result, constUndefined) as InferResultType<TContext> | undefined
	})
}

/** Creates a query atom that is disabled when its query returns nullish. */
export const makeQueryConditional = <TContext extends Context>(
	queryFn: ConditionalQueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<AsyncResult.AsyncResult<InferResultType<TContext>, TanStackDBError> | undefined> => {
	return Atom.readable((get) => {
		// Probe whether the callback builds a query without executing builder methods.
		let queryReturnsNull = false

		const proxyBuilder = new Proxy({} as InitialQueryBuilder, {
			get: () => {
				queryReturnsNull = false
				return () => proxyBuilder
			},
		})

		const query = queryFn(proxyBuilder)

		if (query === null || query === undefined) {
			queryReturnsNull = true
		}

		if (queryReturnsNull) {
			return undefined
		}

		return get(makeQuery(queryFn as QueryFn<TContext>, options))
	})
}
