import { createTransaction, type Collection, type Transaction } from "@tanstack/db"
import type { Txid } from "@tanstack/electric-db-collection"
import { Cause, Effect, Exit, Predicate, type ManagedRuntime } from "effect"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import {
	type AwaitTxIdError,
	type InvalidTxIdError,
	OptimisticActionError,
	SyncError,
	type TxIdTimeoutError,
} from "./errors"

/**
 * Collection with Effect-native utilities.
 * Uses `any` for row type to allow any collection to be passed.
 * The utils must have awaitTxIdEffect method for sync functionality.
 */
type EffectCollection = Collection<any, any> & {
	utils: {
		awaitTxIdEffect: (
			txid: Txid,
			timeout?: number,
		) => Effect.Effect<boolean, TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError>
	}
}

/**
 * Collection input can be single, array, or record
 */
export type CollectionInput = EffectCollection | EffectCollection[] | Record<string, EffectCollection>

/**
 * Normalized collection for internal use
 */
interface NormalizedCollection {
	name: string
	collection: EffectCollection
}

/**
 * Result returned from mutation function
 */
export interface MutationResultWithTxId<TSuccess> {
	data: TSuccess
	transactionId: Txid
}

/**
 * Context passed to mutation function
 */
export interface MutationContext<TMutateResult> {
	mutateResult: TMutateResult
	transaction: Transaction<Record<string, unknown>>
}

/**
 * Result returned from optimistic action
 */
export interface OptimisticActionResult<TSuccess, TMutateResult> {
	data: TSuccess
	mutateResult: TMutateResult
	transactionId: Txid
}

/**
 * Configuration options for optimisticAction
 */
export interface OptimisticActionConfig<
	TVariables,
	TSuccess,
	TError,
	TCollections extends CollectionInput,
	TRequires,
	TMutateResult extends Record<string, unknown>,
> {
	/**
	 * Collections involved - sync happens automatically on ALL of them
	 */
	collections: TCollections

	/**
	 * ManagedRuntime for Effect execution
	 */
	runtime: ManagedRuntime.ManagedRuntime<TRequires, unknown>

	/**
	 * Optimistic mutation - synchronous, returns IDs/metadata
	 */
	onMutate: (variables: TVariables) => TMutateResult

	/**
	 * Server mutation - Effect that returns result with transactionId
	 */
	mutate: (
		variables: TVariables,
		context: MutationContext<TMutateResult>,
	) => Effect.Effect<MutationResultWithTxId<TSuccess>, TError, TRequires>

	/** Sync timeout in milliseconds. Defaults to 30 seconds. */
	syncTimeout?: number
}

function normalizeCollections(collections: CollectionInput): NormalizedCollection[] {
	if ("state" in collections && Predicate.isFunction((collections as any).insert)) {
		return [{ name: "primary", collection: collections as EffectCollection }]
	}

	if (Array.isArray(collections)) {
		return collections.map((c, i) => ({ name: `collection_${i}`, collection: c }))
	}

	return Object.entries(collections).map(([name, collection]) => ({
		name,
		collection,
	}))
}

/** Waits for every collection to observe a transaction. */
function syncAllCollections(
	collections: NormalizedCollection[],
	txid: Txid,
	timeout: number,
): Effect.Effect<void, SyncError | TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError> {
	return Effect.gen(function* () {
		const syncEffects = collections.map(({ name, collection }) =>
			collection.utils.awaitTxIdEffect(txid, timeout).pipe(
				Effect.mapError(
					(error) =>
						new SyncError({
							message: `Failed to sync collection "${name}"`,
							txid,
							collectionName: name,
							timeout,
							cause: error,
						}),
				),
			),
		)

		yield* Effect.all(syncEffects, { concurrency: "unbounded" })
	})
}

/**
 * Creates an Effect-based optimistic action with automatic collection sync.
 *
 * The optimistic update runs synchronously; completion waits for every declared
 * collection to observe the server transaction.
 *
 * @example
 * ```typescript
 * // Single collection
 * const upsertDashboardAction = optimisticAction({
 *   collections: [dashboardsCollection],
 *   runtime: mapleRuntime,
 *   onMutate: (props) => {
 *     dashboardsCollection.update(props.id, (draft) => { draft.name = props.name })
 *     return { id: props.id }
 *   },
 *   mutate: (props, ctx) => Effect.gen(function* () {
 *     const client = yield* MapleApiAtomClient
 *     const result = yield* client.dashboards.upsert(...)
 *     // No manual sync needed! Just return the transactionId
 *     return { data: result, transactionId: Number(result.txid) }
 *   }),
 * })
 *
 * // In component:
 * const upsert = useAtomSet(upsertDashboardAction, { mode: "promiseExit" })
 * const exit = await upsert({ id, name })
 * ```
 */
export function optimisticAction<
	TVariables,
	TSuccess,
	TError,
	TCollections extends CollectionInput,
	TRequires = never,
	TMutateResult extends Record<string, unknown> = Record<string, unknown>,
>(
	config: OptimisticActionConfig<TVariables, TSuccess, TError, TCollections, TRequires, TMutateResult>,
): Atom.Writable<
	AsyncResult.AsyncResult<
		OptimisticActionResult<TSuccess, TMutateResult>,
		TError | SyncError | OptimisticActionError
	>,
	TVariables
> {
	const { collections, runtime, onMutate, mutate, syncTimeout = 30000 } = config
	const normalizedCollections = normalizeCollections(collections)

	return Atom.fn((variables: TVariables) =>
		Effect.gen(function* () {
			let mutateResult!: TMutateResult
			let mutationResult!: MutationResultWithTxId<TSuccess>

			const transaction = createTransaction({
				autoCommit: true,
				mutationFn: async (params) => {
					const mutationEffect = mutate(variables, {
						mutateResult,
						transaction: params.transaction,
					})

					const exit = await runtime.runPromiseExit(mutationEffect)

					if (Exit.isFailure(exit)) {
						const cause = exit.cause
						const failReason = cause.reasons.find(Cause.isFailReason)
						if (failReason) {
							throw failReason.error
						}
						throw new OptimisticActionError({
							message: "Mutation failed unexpectedly",
							cause: Cause.pretty(cause),
						})
					}

					mutationResult = exit.value

					const syncEffect = syncAllCollections(
						normalizedCollections,
						mutationResult.transactionId,
						syncTimeout,
					)

					const syncExit = await runtime.runPromiseExit(
						syncEffect as Effect.Effect<
							void,
							SyncError | TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError,
							never
						>,
					)

					if (Exit.isFailure(syncExit)) {
						const cause = syncExit.cause
						const syncFailReason = cause.reasons.find(Cause.isFailReason)
						if (syncFailReason) {
							throw syncFailReason.error // SyncError
						}
						throw new SyncError({
							message: "Sync failed unexpectedly",
							cause: Cause.pretty(cause),
						})
					}

					return mutationResult.data
				},
			})

			transaction.mutate(() => {
				mutateResult = onMutate(variables)
			})

			// Roll back before mapping, as its own step in the chain: the rollback is
			// best effort, and a rollback that throws must not displace the mutation
			// failure the caller is owed.
			const rollbackIfPending = Effect.ignore(
				Effect.try(() => {
					if (transaction.state !== "completed" && transaction.state !== "failed") {
						transaction.rollback()
					}
				}),
			)

			yield* Effect.tryPromise({
				try: () => transaction.isPersisted.promise,
				catch: (error) => error,
			}).pipe(
				Effect.tapError(() => rollbackIfPending),
				Effect.mapError((error) => {
					if (error && typeof error === "object" && "_tag" in error) {
						return error as TError | SyncError
					}

					return new OptimisticActionError({
						message: error instanceof Error ? error.message : "Optimistic action failed",
						cause: error,
					})
				}),
			)

			return {
				data: mutationResult.data,
				mutateResult,
				transactionId: mutationResult.transactionId,
			}
		}),
	)
}
