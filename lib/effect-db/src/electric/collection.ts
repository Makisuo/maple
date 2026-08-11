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
 * Default backoff configuration.
 *
 * `maxRetries` is deliberately FINITE. An unreachable sync endpoint (down,
 * misconfigured `VITE_ELECTRIC_SYNC_URL`, corporate proxy) fails every shape
 * fetch, and an unlimited budget turns that into a request loop that never ends
 * and never tells anyone: the collection stays in `loading`, so the page renders
 * a skeleton forever while the browser keeps dialling. Ten attempts spans
 * ~1s+2s+4s+8s+16s+30s×4 ≈ 2.5 minutes of real recovery time — long enough to
 * ride out a redeploy or a laptop waking from sleep — after which the stream
 * stops and `collection:sync-failed` hands the app a definitive failure it can
 * render (and offer a retry for) instead of an infinite spinner.
 */
const DEFAULT_BACKOFF_CONFIG: Required<BackoffConfig> = {
	initialDelayMs: 1000,
	maxDelayMs: 30000,
	multiplier: 2,
	maxRetries: 10,
	jitter: true,
	resetTimeoutMs: 60000,
}

/**
 * Custom event name for collection error state changes
 */
export const COLLECTION_ERROR_STATE_CHANGED_EVENT = "collection:error-state-changed"

/**
 * Custom event name announcing that a shape stream has stopped retrying for
 * good — its backoff budget is spent and nothing further will be fetched until
 * the collection is recreated. Unlike {@link COLLECTION_ERROR_STATE_CHANGED_EVENT}
 * (fired on every transient error) this is terminal, so the app can render a real
 * error state with a retry affordance instead of a skeleton that never resolves.
 */
export const COLLECTION_SYNC_FAILED_EVENT = "collection:sync-failed"

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

/** Announces a terminally stopped stream (see {@link COLLECTION_SYNC_FAILED_EVENT}). */
function dispatchSyncFailed(collectionId: string | undefined): void {
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent(COLLECTION_SYNC_FAILED_EVENT, { detail: { collectionId } }))
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

	const scheduleReset = () => {
		if (resetTimeout) {
			clearTimeout(resetTimeout)
		}
		resetTimeout = setTimeout(() => {
			retryCount = 0
			currentDelay = backoffConfig.initialDelayMs
		}, backoffConfig.resetTimeoutMs)
	}

	return async (error) => {
		retryCount++

		dispatchErrorStateChanged(collectionId, true)

		// A 401 can be a stale stream token, so let the app recreate the collection
		// under its bounded retry budget instead of leaving a live-but-deaf instance.
		const errorStatus = (error as { status?: number })?.status
		if (errorStatus === 401) {
			logVia(
				runtime,
				"warning",
				"Authentication error (401), stopping stream and requesting recovery",
				{
					collectionId,
					status: 401,
				},
			)
			if (typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent("collection:auth-error", { detail: { collectionId } }))
			}
			return
		}

		// A schema mismatch usually means the client retained a pre-deploy shape.
		const errorName = (error as Error)?.name || (error as { _tag?: string })?._tag
		if (errorName === "SchemaValidationError") {
			logVia(runtime, "warning", "Schema validation error, dispatching recovery event", {
				collectionId,
				errorName,
			})
			if (typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent("collection:schema-error"))
			}
			return
		}

		if (retryCount > backoffConfig.maxRetries) {
			logVia(runtime, "error", "Max retries exceeded, stopping sync", {
				collectionId,
				maxRetries: backoffConfig.maxRetries,
				retryCount,
				cause: error,
			})
			// Terminal: nothing will refetch this shape until the collection is
			// recreated, so tell the app rather than leaving it on a skeleton.
			dispatchSyncFailed(collectionId)
			return
		}

		const delay = backoffConfig.jitter ? currentDelay * (0.5 + Math.random()) : currentDelay

		logVia(runtime, "warning", "Connection error, retrying", {
			collectionId,
			delayMs: Math.round(delay),
			retryCount,
			maxRetries:
				backoffConfig.maxRetries === Number.POSITIVE_INFINITY ? "∞" : backoffConfig.maxRetries,
			cause: error,
		})

		await new Promise((resolve) => setTimeout(resolve, delay))

		currentDelay = Math.min(currentDelay * backoffConfig.multiplier, backoffConfig.maxDelayMs)

		scheduleReset()

		if (userOnError) {
			const result = await userOnError(error)
			if (result !== undefined) {
				return result
			}
		}

		return {}
	}
}

type InferSchemaOutput<T> = T extends StandardSchemaV1
	? StandardSchemaV1.InferOutput<T> extends Row<unknown>
		? StandardSchemaV1.InferOutput<T>
		: Record<string, unknown>
	: Record<string, unknown>

/** Effect-based Electric collection utilities. */
export interface EffectElectricCollectionUtils extends ElectricCollectionUtils {
	/** Waits for a transaction to reach this collection. */
	readonly awaitTxIdEffect: (
		txid: Txid,
		timeout?: number,
	) => Effect.Effect<boolean, TxIdTimeoutError | InvalidTxIdError | AwaitTxIdError>
}

type AnyEffectElectricCollectionConfig =
	| (EffectElectricCollectionConfig<any, any, any, any, any> & {
			runtime: ManagedRuntime.ManagedRuntime<any, unknown>
	  })
	| (EffectElectricCollectionConfig<any, any, any, any, never> & { runtime?: never })

/** Creates Electric collection options with Effect-based handlers. */
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

export function effectElectricCollectionOptions(config: AnyEffectElectricCollectionConfig): CollectionConfig<
	any,
	string | number,
	any,
	any
> & {
	id?: string
	utils: EffectElectricCollectionUtils
	schema?: any
} {
	const promiseOnInsert = config.runtime
		? convertInsertHandler(config.onInsert, config.runtime)
		: convertInsertHandler(config.onInsert)
	const promiseOnUpdate = config.runtime
		? convertUpdateHandler(config.onUpdate, config.runtime)
		: convertUpdateHandler(config.onUpdate)
	const promiseOnDelete = config.runtime
		? convertDeleteHandler(config.onDelete, config.runtime)
		: convertDeleteHandler(config.onDelete)

	const backoffEnabled = config.backoff !== false
	const backoffConfig: Required<BackoffConfig> = backoffEnabled
		? { ...DEFAULT_BACKOFF_CONFIG, ...(typeof config.backoff === "object" ? config.backoff : {}) }
		: DEFAULT_BACKOFF_CONFIG

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
	} as unknown as Parameters<typeof effectElectricCollectionOptions>[0])

	const collection = tanstackCreateCollection(options as any)
	return collection as unknown as EffectCollection<A>
}
