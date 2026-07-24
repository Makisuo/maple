import type { Row, ShapeStreamOptions } from "@electric-sql/client"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Collection, CollectionConfig } from "@tanstack/db"
import { BTreeIndex } from "@tanstack/db"
import type { ElectricCollectionUtils, Txid } from "@tanstack/electric-db-collection"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { createCollection as tanstackCreateCollection } from "@tanstack/react-db"
import { Effect, type ManagedRuntime, Schema } from "effect"
import { AwaitTxIdError, InvalidTxIdError, TxIdTimeoutError } from "./errors"
import { convertDeleteHandler, convertInsertHandler, convertUpdateHandler } from "./handlers"
import type { BackoffConfig, EffectElectricCollectionConfig } from "./types"

// Re-export CollectionStatus from @tanstack/db
export type { CollectionStatus } from "@tanstack/db"

/**
 * Type for the ShapeStream onError handler.
 * Returns void to stop syncing, or an object to continue with modified params/headers.
 */
type OnErrorHandler = NonNullable<ShapeStreamOptions<unknown>["onError"]>

/**
 * Default backoff configuration
 */
const DEFAULT_BACKOFF_CONFIG: Required<BackoffConfig> = {
	initialDelayMs: 1000,
	maxDelayMs: 30000,
	multiplier: 2,
	maxRetries: Number.POSITIVE_INFINITY,
	jitter: true,
	resetTimeoutMs: 60000,
}

/**
 * Custom event name for collection error state changes
 */
export const COLLECTION_ERROR_STATE_CHANGED_EVENT = "collection:error-state-changed"

/**
 * Dispatch an event when collection error state changes
 */
function dispatchErrorStateChanged(collectionId: string | undefined, isError: boolean): void {
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent(COLLECTION_ERROR_STATE_CHANGED_EVENT, {
				detail: { collectionId, isError },
			}),
		)
	}
}

/**
 * Run a fire-and-forget structured log Effect. Prefers the caller's runtime so
 * logs flow through Maple's tracer/log pipeline; when the `runtime`-less
 * `createEffectCollection` overload is used, falls back to Effect's default
 * runtime (`Effect.runFork`) rather than a raw `console.*` so the log stays a
 * structured, exportable Effect log instead of an untraced console write.
 */
function logVia(
	runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined,
	level: "warning" | "error" | "debug",
	message: string,
	annotations: Record<string, unknown>,
): void {
	const log = (
		level === "warning"
			? Effect.logWarning(message)
			: level === "error"
				? Effect.logError(message)
				: Effect.logDebug(message)
	).pipe(Effect.annotateLogs(annotations))
	if (runtime) {
		runtime.runFork(log)
		return
	}
	Effect.runFork(log)
}

/**
 * Creates an onError handler with exponential backoff.
 */
function createBackoffOnError(
	collectionId: string | undefined,
	backoffConfig: Required<BackoffConfig>,
	runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined,
	userOnError?: OnErrorHandler,
): OnErrorHandler {
	let retryCount = 0
	let currentDelay = backoffConfig.initialDelayMs
	let resetTimeout: ReturnType<typeof setTimeout> | null = null

	// Reset backoff state after a period of successful operation
	const scheduleReset = () => {
		if (resetTimeout) {
			clearTimeout(resetTimeout)
		}
		// Reset after configured timeout of no errors
		resetTimeout = setTimeout(() => {
			retryCount = 0
			currentDelay = backoffConfig.initialDelayMs
		}, backoffConfig.resetTimeoutMs)
	}

	return async (error) => {
		retryCount++

		// Dispatch error state changed event
		dispatchErrorStateChanged(collectionId, true)

		// Check if this is a 401 auth error - stop this stream and hand recovery to
		// the app. A 401 here is usually a transient token problem (expired Clerk
		// token on a long-lived stream, or a stale-org stream after an org switch),
		// NOT proof the session is gone — permanently killing sync would leave the
		// collection alive but deaf, so every later optimistic write would await a
		// txid that can never arrive and time out. The recovery listener recreates
		// the collections (minting a fresh token via the auth-headers provider)
		// under a bounded retry budget, so a genuinely dead session degrades to a
		// stopped stream instead of a loop.
		const errorStatus = (error as { status?: number })?.status
		if (errorStatus === 401) {
			logVia(runtime, "warning", "Authentication error (401), stopping stream and requesting recovery", {
				collectionId,
				status: 401,
			})
			if (typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent("collection:auth-error", { detail: { collectionId } }),
				)
			}
			// Return undefined to stop syncing this (stale-token) stream
			return
		}

		// Check if this is a schema validation error - likely a stale cache after a deploy
		const errorName = (error as Error)?.name || (error as { _tag?: string })?._tag
		if (errorName === "SchemaValidationError") {
			logVia(runtime, "warning", "Schema validation error, dispatching recovery event", {
				collectionId,
				errorName,
			})
			if (typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent("collection:schema-error"))
			}
			// Return undefined to stop syncing — the layout will handle recovery
			return
		}

		// Check if max retries exceeded
		if (retryCount > backoffConfig.maxRetries) {
			logVia(runtime, "error", "Max retries exceeded, stopping sync", {
				collectionId,
				maxRetries: backoffConfig.maxRetries,
				retryCount,
				cause: error,
			})
			// Return undefined to stop syncing
			return
		}

		// Calculate delay with optional jitter
		const delay = backoffConfig.jitter
			? currentDelay * (0.5 + Math.random()) // Jitter between 50-150% of delay
			: currentDelay

		logVia(runtime, "warning", "Connection error, retrying", {
			collectionId,
			delayMs: Math.round(delay),
			retryCount,
			maxRetries:
				backoffConfig.maxRetries === Number.POSITIVE_INFINITY ? "∞" : backoffConfig.maxRetries,
			cause: error,
		})

		// Wait for the delay
		await new Promise((resolve) => setTimeout(resolve, delay))

		// Increase delay for next retry (exponential backoff)
		currentDelay = Math.min(currentDelay * backoffConfig.multiplier, backoffConfig.maxDelayMs)

		// Schedule reset of backoff state
		scheduleReset()

		// Call user's onError handler if provided
		if (userOnError) {
			const result = await userOnError(error)
			// If user handler returns a result, use it
			if (result !== undefined) {
				return result
			}
		}

		// Return empty object to continue syncing with same params
		return {}
	}
}

type InferSchemaOutput<T> = T extends StandardSchemaV1
	? StandardSchemaV1.InferOutput<T> extends Row<unknown>
		? StandardSchemaV1.InferOutput<T>
		: Record<string, unknown>
	: Record<string, unknown>

/**
 * Effect-based utilities for Electric collections.
 */
export interface EffectElectricCollectionUtils extends ElectricCollectionUtils {
	/**
	 * Wait for a specific transaction ID to be synced (Effect version).
	 */
	readonly awaitTxIdEffect: (
		txid: Txid,
		timeout?: number,
	) => Effect.Effect<boolean, TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError>
}

/**
 * Creates Electric collection options with Effect-based handlers
 */

// With schema + with runtime (R inferred from runtime)
export function effectElectricCollectionOptions<T extends StandardSchemaV1, R>(
	config: EffectElectricCollectionConfig<
		InferSchemaOutput<T>,
		string | number,
		T,
		Record<string, never>,
		R
	> & {
		schema: T
		runtime: ManagedRuntime.ManagedRuntime<R, unknown>
	},
): CollectionConfig<InferSchemaOutput<T>, string | number, T> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema: T
}

// With schema + without runtime (R must be never)
export function effectElectricCollectionOptions<T extends StandardSchemaV1>(
	config: EffectElectricCollectionConfig<
		InferSchemaOutput<T>,
		string | number,
		T,
		Record<string, never>,
		never
	> & {
		schema: T
		runtime?: never
	},
): CollectionConfig<InferSchemaOutput<T>, string | number, T> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema: T
}

// Without schema + with runtime (R inferred from runtime)
export function effectElectricCollectionOptions<T extends Row<unknown>, R>(
	config: EffectElectricCollectionConfig<T, string | number, never, Record<string, never>, R> & {
		schema?: never
		runtime: ManagedRuntime.ManagedRuntime<R, unknown>
	},
): CollectionConfig<T, string | number> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema?: never
}

// Without schema + without runtime (R must be never)
export function effectElectricCollectionOptions<T extends Row<unknown>>(
	config: EffectElectricCollectionConfig<T, string | number, never, Record<string, never>, never> & {
		schema?: never
		runtime?: never
	},
): CollectionConfig<T, string | number> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema?: never
}

export function effectElectricCollectionOptions(
	config: EffectElectricCollectionConfig<any, any, any, any, any>,
): CollectionConfig<any, string | number, any, any> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema?: any
} {
	const promiseOnInsert = convertInsertHandler(config.onInsert, config.runtime)
	const promiseOnUpdate = convertUpdateHandler(config.onUpdate, config.runtime)
	const promiseOnDelete = convertDeleteHandler(config.onDelete, config.runtime)

	// Handle backoff configuration
	const backoffEnabled = config.backoff !== false
	const backoffConfig: Required<BackoffConfig> = backoffEnabled
		? { ...DEFAULT_BACKOFF_CONFIG, ...(typeof config.backoff === "object" ? config.backoff : {}) }
		: DEFAULT_BACKOFF_CONFIG // Won't be used when disabled

	// Create modified shapeOptions with backoff-wrapped onError
	const modifiedShapeOptions = backoffEnabled
		? {
				...config.shapeOptions,
				onError: createBackoffOnError(
					config.id,
					backoffConfig,
					config.runtime,
					config.shapeOptions.onError,
				),
			}
		: config.shapeOptions

	const standardConfig = electricCollectionOptions({
		autoIndex: "eager",
		defaultIndexType: BTreeIndex,
		...config,
		shapeOptions: modifiedShapeOptions,
		onInsert: promiseOnInsert,
		onUpdate: promiseOnUpdate,
		onDelete: promiseOnDelete,
	})
	const awaitTxIdEffect = (
		txid: Txid,
		timeout: number = 30000,
	): Effect.Effect<boolean, TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError> => {
		if (typeof txid !== "number") {
			return Effect.fail(
				new InvalidTxIdError({
					message: `Expected txid to be a number, got ${typeof txid}`,
					receivedType: typeof txid,
				}),
			)
		}

		return Effect.tryPromise({
			try: () => standardConfig.utils.awaitTxId(txid, timeout),
			catch: (error) => {
				if (error instanceof Error && error.message.toLowerCase().includes("timeout")) {
					return new TxIdTimeoutError({
						message: `Timeout waiting for txid ${txid}`,
						txid,
						timeout,
					})
				}
				return new AwaitTxIdError({
					message: `awaitTxId failed for txid ${txid}: ${error instanceof Error ? error.message : String(error)}`,
					txid,
					collectionId: config.id,
					cause: error,
				})
			},
		}).pipe(
			Effect.withSpan("EffectElectricCollection.awaitTxId", {
				attributes: {
					"maple.collection.id": config.id ?? "unknown",
					"maple.electric.txid": txid,
					"maple.electric.timeout_ms": timeout,
				},
			}),
		)
	}

	return {
		...standardConfig,
		utils: {
			...standardConfig.utils,
			awaitTxIdEffect,
		},
	}
}

/**
 * A collection created with Effect-native utilities.
 * Extends the base Collection with awaitTxIdEffect on utils.
 */
export type EffectCollection<
	T extends Row<unknown>,
	TKey extends string | number = string | number,
> = Collection<T, TKey> & {
	utils: EffectElectricCollectionUtils
}

/**
 * Creates a collection with Effect-native utilities.
 * Accepts an Effect Schema directly and converts to StandardSchemaV1 internally.
 *
 * @example
 * ```typescript
 * const dashboardsCollection = createEffectCollection({
 *   id: "dashboards",
 *   runtime: mapleRuntime,
 *   shapeOptions: { url: shapeProxyUrl, params: { shape: "dashboards" } },
 *   schema: DashboardRowSchema, // Direct Effect Schema!
 *   getKey: (row) => row.id,
 *   onUpdate: ({ transaction }) => Effect.gen(function* () { ... }),
 * })
 *
 * // dashboardsCollection.utils.awaitTxIdEffect is properly typed!
 * ```
 */
export function createEffectCollection<A extends Row<unknown>, TRuntime>(
	config: Omit<
		EffectElectricCollectionConfig<A, string | number, never, Record<string, never>, TRuntime>,
		"schema"
	> & {
		schema: Schema.Schema<A>
		runtime: ManagedRuntime.ManagedRuntime<TRuntime, unknown>
	},
): EffectCollection<A> {
	// Convert Effect Schema to StandardSchemaV1 internally.
	// `Schema.Schema<A>` defaults `DecodingServices` to `unknown`, but the helper
	// requires `Decoder<unknown, never>`. The Schemas we accept never carry real
	// decoding services at runtime, so narrow via `Schema.Codec` to make the
	// services explicit.
	const standardSchema = Schema.toStandardSchemaV1(config.schema as Schema.Codec<A, A>)

	// Overload resolution can't discriminate the four signatures from this generic
	// call site, so cast through `Parameters` to pick the "with schema, with runtime"
	// overload explicitly.
	const options = effectElectricCollectionOptions({
		...config,
		schema: standardSchema,
	} as Parameters<typeof effectElectricCollectionOptions>[0])

	const collection = tanstackCreateCollection(options as any)
	return collection as unknown as EffectCollection<A>
}
