import type { GetExtensions, Row, ShapeStreamOptions } from "@electric-sql/client"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
	DeleteMutationFnParams,
	InsertMutationFnParams,
	UpdateMutationFnParams,
	UtilsRecord,
} from "@tanstack/db"
import type { Txid } from "@tanstack/electric-db-collection"
import type { Effect, ManagedRuntime } from "effect"

/**
 * Effect-based insert handler.
 * Note: When using with a runtime, handlers can require services (R parameter).
 * Otherwise, use Effect.provideService or Layer.provide to inject dependencies before returning.
 */
export type EffectInsertHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
> = (params: InsertMutationFnParams<T, TKey, TUtils>) => Effect.Effect<{ txid: Txid | Array<Txid> }, E, R>

/**
 * Effect-based update handler.
 * Note: When using with a runtime, handlers can require services (R parameter).
 * Otherwise, use Effect.provideService or Layer.provide to inject dependencies before returning.
 */
export type EffectUpdateHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
> = (params: UpdateMutationFnParams<T, TKey, TUtils>) => Effect.Effect<{ txid: Txid | Array<Txid> }, E, R>

/**
 * Effect-based delete handler.
 * Note: When using with a runtime, handlers can require services (R parameter).
 * Otherwise, use Effect.provideService or Layer.provide to inject dependencies before returning.
 */
export type EffectDeleteHandler<
	T extends Row<unknown>,
	TKey extends string | number,
	TUtils extends UtilsRecord,
	E = never,
	R = never,
> = (params: DeleteMutationFnParams<T, TKey, TUtils>) => Effect.Effect<{ txid: Txid | Array<Txid> }, E, R>

/**
 * Configuration for exponential backoff on connection errors
 */
export interface BackoffConfig {
	/**
	 * Initial delay in milliseconds before first retry
	 * @default 1000
	 */
	initialDelayMs?: number

	/**
	 * Maximum delay in milliseconds between retries
	 * @default 30000
	 */
	maxDelayMs?: number

	/**
	 * Multiplier for exponential backoff (delay = delay * multiplier)
	 * @default 2
	 */
	multiplier?: number

	/**
	 * Maximum number of retries before giving up. Set to Infinity for unlimited retries.
	 * @default Infinity
	 */
	maxRetries?: number

	/**
	 * Whether to add random jitter to delays (helps prevent thundering herd)
	 * @default true
	 */
	jitter?: boolean

	/**
	 * Time in milliseconds after which the backoff state resets to initial values
	 * when no errors occur. This prevents indefinitely long delays after recovery.
	 * @default 60000
	 */
	resetTimeoutMs?: number
}

/**
 * Configuration for an Electric collection with Effect-based handlers
 */
export interface EffectElectricCollectionConfig<
	T extends Row<unknown> = Row<unknown>,
	TKey extends string | number = string | number,
	TSchema extends StandardSchemaV1 = never,
	TUtils extends UtilsRecord = Record<string, never>,
	R = never,
> {
	/**
	 * Unique identifier for the collection
	 */
	id?: string

	/**
	 * Configuration options for the ElectricSQL ShapeStream
	 */
	shapeOptions: ShapeStreamOptions<GetExtensions<T>>

	/**
	 * Function to extract the key from an item
	 */
	getKey: (item: T) => TKey

	/**
	 * Optional schema for validation
	 */
	schema?: TSchema

	/**
	 * Optional ManagedRuntime that provides dependencies for handlers.
	 * When provided, handlers can use services without needing to provide them manually.
	 */
	runtime?: ManagedRuntime.ManagedRuntime<R, unknown>

	/**
	 * Effect-based insert handler.
	 * When runtime is provided, can require services (R parameter).
	 * Each handler can have its own error type.
	 */
	onInsert?: EffectInsertHandler<T, TKey, TUtils, any, R>

	/**
	 * Effect-based update handler.
	 * When runtime is provided, can require services (R parameter).
	 * Each handler can have its own error type.
	 */
	onUpdate?: EffectUpdateHandler<T, TKey, TUtils, any, R>

	/**
	 * Effect-based delete handler.
	 * When runtime is provided, can require services (R parameter).
	 * Each handler can have its own error type.
	 */
	onDelete?: EffectDeleteHandler<T, TKey, TUtils, any, R>

	/**
	 * Time in milliseconds after which the collection will be garbage collected
	 */
	gcTime?: number

	/**
	 * Whether to eagerly start syncing on collection creation
	 */
	startSync?: boolean

	/**
	 * Auto-indexing mode for the collection
	 */
	autoIndex?: `off` | `eager`

	/**
	 * Sync mode for the collection
	 * - `eager`: Sync all data immediately during preload
	 * - `on-demand`: Sync data incrementally when queries execute
	 */
	syncMode?: `eager` | `on-demand`

	/**
	 * Optional function to compare two items
	 */
	compare?: (x: T, y: T) => number

	/**
	 * Configuration for exponential backoff on connection errors.
	 * When enabled (default), errors will be retried with increasing delays
	 * instead of immediately retrying.
	 *
	 * Set to `false` to disable backoff entirely.
	 *
	 * @default { initialDelayMs: 1000, maxDelayMs: 30000, multiplier: 2, maxRetries: Infinity, jitter: true }
	 */
	backoff?: BackoffConfig | false
}
