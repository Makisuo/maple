/**
 * Type definitions for the TanStack DB × effect-atom bridge.
 * @since 1.0.0
 */

import { Schema } from "effect"
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
 * Why a TanStack DB collection/query atom failed.
 *
 * - `load-failed` — the underlying collection reported `status === "error"`.
 * - `cleaned-up` — the collection was garbage-collected / disposed while an
 *   atom still held a subscription to it.
 */
export type TanStackDBErrorReason = "load-failed" | "cleaned-up"

/**
 * Error surfaced on the `AsyncResult` error channel of the collection/query
 * atoms. Carries a `reason` so a consumer can discriminate a load failure from
 * a cleaned-up collection by tag/field rather than by parsing the message.
 */
export class TanStackDBError extends Schema.TaggedErrorClass<TanStackDBError>()("TanStackDBError", {
	message: Schema.String,
	reason: Schema.Literals(["load-failed", "cleaned-up"]),
	cause: Schema.optional(Schema.Unknown),
}) {}
