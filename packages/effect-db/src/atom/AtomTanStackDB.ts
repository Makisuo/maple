/**
 * TanStack DB utilities for effect-atom.
 * Provides reactive atoms that integrate with TanStack DB collections and live queries.
 * @since 1.0.0
 */

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

/**
 * Creates an Atom from a TanStack DB collection.
 * Returns an AsyncResult that tracks the collection's lifecycle state.
 */
export const makeCollectionAtom = <T extends object, TKey extends string | number>(
	collection: Collection<T, TKey, any> & NonSingleResult,
): Atom.Atom<AsyncResult.AsyncResult<Array<T>, TanStackDBError>> => {
	return Atom.readable((get) => {
		// Start sync if not already started
		collection.startSyncImmediate()

		// Set up subscription immediately, before checking initial status
		// This ensures we get notified when async sync completes
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" })))
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" })))
				return
			}

			const newData = Array.from(collection.entries()).map(([_, value]) => value)
			get.setSelf(AsyncResult.success(newData))
		})

		// Cleanup on unmount
		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		// Return initial state based on current status
		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }))
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" }))
		}

		// Get current data
		const initialData = Array.from(collection.entries()).map(([_, value]) => value)

		return AsyncResult.success(initialData)
	})
}

/**
 * Creates an Atom from a TanStack DB collection with single result.
 * Returns an AsyncResult that contains a single item or undefined.
 */
export const makeSingleCollectionAtom = <T extends object, TKey extends string | number>(
	collection: Collection<T, TKey, any> & SingleResult,
): Atom.Atom<AsyncResult.AsyncResult<T | undefined, TanStackDBError>> => {
	return Atom.readable((get) => {
		// Start sync if not already started
		collection.startSyncImmediate()

		// Set up subscription immediately, before checking initial status
		// This ensures we get notified when async sync completes
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" })))
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" })))
				return
			}

			const entries = Array.from(collection.entries())
			const newData = entries.length > 0 ? entries[0]![1] : undefined
			get.setSelf(AsyncResult.success(newData))
		})

		// Cleanup on unmount
		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		// Return initial state based on current status
		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(new TanStackDBError({ message: "Collection failed to load", reason: "load-failed" }))
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(new TanStackDBError({ message: "Collection has been cleaned up", reason: "cleaned-up" }))
		}

		// Get current data (single result)
		const entries = Array.from(collection.entries())
		const initialData = entries.length > 0 ? entries[0]![1] : undefined

		return AsyncResult.success(initialData)
	})
}

/**
 * Creates an Atom from a TanStack DB query function.
 * Automatically creates a live query collection and manages its lifecycle.
 */
export const makeQuery = <TContext extends Context>(
	queryFn: QueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<AsyncResult.AsyncResult<InferResultType<TContext>, TanStackDBError>> => {
	return Atom.readable((get) => {
		// Create live query collection
		const collection = createLiveQueryCollection({
			query: queryFn,
			startSync: options?.startSync ?? true,
			gcTime: options?.gcTime ?? 0, // Let atom lifecycle manage GC by default
		})

		// Set up subscription immediately, before checking initial status
		// This ensures we get notified when async sync completes
		const subscription = collection.subscribeChanges(() => {
			const status: CollectionStatus = collection.status

			if (status === "error") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Query failed to load", reason: "load-failed" })))
				return
			}

			if (status === "loading" || status === "idle") {
				get.setSelf(AsyncResult.initial(true))
				return
			}

			if (status === "cleaned-up") {
				get.setSelf(AsyncResult.fail(new TanStackDBError({ message: "Query collection has been cleaned up", reason: "cleaned-up" })))
				return
			}

			// Get current data - handle both single and array results
			const isSingleResult = (collection as any).config?.singleResult === true
			const entries = Array.from(collection.entries()).map(([_, value]) => value)
			const newData = (isSingleResult ? entries[0] : entries) as unknown as InferResultType<TContext>
			get.setSelf(AsyncResult.success(newData))
		})

		// Cleanup on unmount
		get.addFinalizer(() => {
			subscription.unsubscribe()
		})

		// Return initial state based on current status
		const status: CollectionStatus = collection.status

		if (status === "error") {
			return AsyncResult.fail(new TanStackDBError({ message: "Query failed to load", reason: "load-failed" }))
		}

		if (status === "loading" || status === "idle") {
			return AsyncResult.initial(true)
		}

		if (status === "cleaned-up") {
			return AsyncResult.fail(new TanStackDBError({ message: "Query collection has been cleaned up", reason: "cleaned-up" }))
		}

		// Get current data - handle both single and array results
		const isSingleResult = (collection as any).config?.singleResult === true
		const entries = Array.from(collection.entries()).map(([_, value]) => value)
		const initialData = (isSingleResult ? entries[0] : entries) as unknown as InferResultType<TContext>

		return AsyncResult.success(initialData)
	})
}

/**
 * Creates an Atom from a TanStack DB query function (unsafe version).
 * Returns undefined instead of an AsyncResult for simpler usage when you don't need error handling.
 */
export const makeQueryUnsafe = <TContext extends Context>(
	queryFn: QueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<InferResultType<TContext> | undefined> => {
	return Atom.readable((get) => {
		const result = get(makeQuery(queryFn, options))
		return AsyncResult.getOrElse(result, constUndefined) as InferResultType<TContext> | undefined
	})
}

/**
 * Creates an Atom from a conditional TanStack DB query function.
 * The query function can return null/undefined to disable the query.
 */
export const makeQueryConditional = <TContext extends Context>(
	queryFn: ConditionalQueryFn<TContext>,
	options?: QueryOptions,
): Atom.Atom<AsyncResult.AsyncResult<InferResultType<TContext>, TanStackDBError> | undefined> => {
	return Atom.readable((get) => {
		// Create a proxy query builder to detect if the query function returns null/undefined
		// without actually executing any query methods
		let queryReturnsNull = false

		const proxyBuilder = new Proxy({} as InitialQueryBuilder, {
			get: () => {
				// If any method is accessed, the query is being built (not null)
				queryReturnsNull = false
				// Return a function that returns the proxy itself for chaining
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

		// Otherwise create the query atom
		return get(makeQuery(queryFn as QueryFn<TContext>, options))
	})
}
