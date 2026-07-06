import type { Row } from "@electric-sql/client"
import type {
	DeleteMutationFnParams,
	InsertMutationFnParams,
	UpdateMutationFnParams,
	UtilsRecord,
} from "@tanstack/db"
import type { Txid } from "@tanstack/electric-db-collection"
import { Cause, Effect, Exit, type ManagedRuntime } from "effect"
import { DeleteError, InsertError, MissingTxIdError, UpdateError } from "./errors"
import type { EffectDeleteHandler, EffectInsertHandler, EffectUpdateHandler } from "./types"

/**
 * Converts an Effect-based insert handler to a Promise-based handler
 * that can be used with the standard electric collection options
 */
export function convertInsertHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectInsertHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, any>,
):
	| ((params: InsertMutationFnParams<T, TKey, TUtils>) => Promise<{
			txid: Txid | Array<Txid>
	  }>)
	| undefined {
	if (!handler) return undefined

	return async (params: InsertMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new InsertError({
						message: `Insert operation failed`,
						data: params.transaction.mutations[0]?.modified,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, InsertError, never>,
				)

		// Handle the Exit type
		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = cause.reasons.find(Cause.isFailReason)
			if (failReason) {
				throw failReason.error
			}
			throw new InsertError({
				message: `Insert operation failed unexpectedly`,
				data: params.transaction.mutations[0]?.modified,
				cause: cause,
			})
		}

		const result = exit.value

		if (!result.txid) {
			throw new MissingTxIdError({
				message: `Insert handler must return a txid`,
				operation: "insert",
			})
		}

		return result
	}
}

/**
 * Converts an Effect-based update handler to a Promise-based handler
 * that can be used with the standard electric collection options
 */
export function convertUpdateHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectUpdateHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, any>,
):
	| ((params: UpdateMutationFnParams<T, TKey, TUtils>) => Promise<{
			txid: Txid | Array<Txid>
	  }>)
	| undefined {
	if (!handler) return undefined

	return async (params: UpdateMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new UpdateError({
						message: `Update operation failed`,
						key: params.transaction.mutations[0]?.key,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, UpdateError, never>,
				)

		// Handle the Exit type
		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = cause.reasons.find(Cause.isFailReason)
			if (failReason) {
				throw failReason.error
			}
			throw new UpdateError({
				message: `Update operation failed unexpectedly`,
				key: params.transaction.mutations[0]?.key,
				cause: cause,
			})
		}

		const result = exit.value

		if (!result.txid) {
			throw new MissingTxIdError({
				message: `Update handler must return a txid`,
				operation: "update",
			})
		}

		return result
	}
}

/**
 * Converts an Effect-based delete handler to a Promise-based handler
 * that can be used with the standard electric collection options
 */
export function convertDeleteHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
>(
	handler: EffectDeleteHandler<T, TKey, TUtils, E, R> | undefined,
	runtime?: ManagedRuntime.ManagedRuntime<R, any>,
):
	| ((params: DeleteMutationFnParams<T, TKey, TUtils>) => Promise<{
			txid: Txid | Array<Txid>
	  }>)
	| undefined {
	if (!handler) return undefined

	return async (params: DeleteMutationFnParams<T, TKey, TUtils>) => {
		const effect = handler(params).pipe(
			Effect.catchEager((error: E) =>
				Effect.fail(
					new DeleteError({
						message: `Delete operation failed`,
						key: params.transaction.mutations[0]?.key,
						cause: error,
					}),
				),
			),
		)

		const exit = runtime
			? await runtime.runPromiseExit(effect)
			: await Effect.runPromiseExit(
					effect as Effect.Effect<{ txid: Txid | Array<Txid> }, DeleteError, never>,
				)

		// Handle the Exit type
		if (Exit.isFailure(exit)) {
			const cause = exit.cause
			const failReason = cause.reasons.find(Cause.isFailReason)
			if (failReason) {
				throw failReason.error
			}
			throw new DeleteError({
				message: `Delete operation failed unexpectedly`,
				key: params.transaction.mutations[0]?.key,
				cause: cause,
			})
		}

		const result = exit.value

		if (!result.txid) {
			throw new MissingTxIdError({
				message: `Delete handler must return a txid`,
				operation: "delete",
			})
		}

		return result
	}
}
