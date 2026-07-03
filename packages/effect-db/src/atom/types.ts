/**
 * Type definitions for the TanStack DB × effect-atom bridge.
 * @since 1.0.0
 */

import type { Context, GetResult, InitialQueryBuilder, QueryBuilder, SingleResult } from "@tanstack/db"

/**
 * Options for creating a query atom
 */
export interface QueryOptions {
	/**
	 * Garbage collection time in milliseconds
	 * @default 0 (collection managed by atom lifecycle)
	 */
	gcTime?: number

	/**
	 * Whether to start sync immediately
	 * @default true
	 */
	startSync?: boolean

	/**
	 * Whether to suspend on waiting state when used with Atom.result()
	 * @default false
	 */
	suspendOnWaiting?: boolean
}

/**
 * Infer the result type from a context, handling single result vs array
 */
export type InferCollectionResult<TContext extends Context> = TContext extends SingleResult
	? GetResult<TContext> | undefined
	: Array<GetResult<TContext>>

/**
 * Query function type that returns a QueryBuilder
 */
export type QueryFn<TContext extends Context> = (q: InitialQueryBuilder) => QueryBuilder<TContext>

/**
 * Conditional query function that can return null/undefined
 */
export type ConditionalQueryFn<TContext extends Context> = (
	q: InitialQueryBuilder,
) => QueryBuilder<TContext> | null | undefined

/**
 * Collection subscription cleanup function
 */
export type UnsubscribeFn = () => void

/**
 * Status of a collection
 */
export type CollectionStatus = "idle" | "loading" | "ready" | "error" | "cleaned-up"

/**
 * Error type for TanStack DB operations
 */
export class TanStackDBError extends Error {
	readonly _tag = "TanStackDBError"
	constructor(message: string) {
		super(message)
		this.name = "TanStackDBError"
	}
}
