import {
	TinybirdDateTime,
	QueryEngineExecuteRequest,
	type QueryEngineExecuteResponse,
	type FacetItem,
	type DurationStats,
	type AttributeValueItem,
} from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { mapleApiClientLayer, mapleApiV2ClientLayer } from "@/lib/registry"

export const WarehouseDateTimeString = TinybirdDateTime

export class WarehouseDecodeError extends Schema.TaggedError<WarehouseDecodeError>()(
	"@maple/web/api/warehouse/WarehouseDecodeError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseQueryError extends Schema.TaggedError<WarehouseQueryError>()(
	"@maple/web/api/warehouse/WarehouseQueryError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseTransformError extends Schema.TaggedError<WarehouseTransformError>()(
	"@maple/web/api/warehouse/WarehouseTransformError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseInvalidInputError extends Schema.TaggedError<WarehouseInvalidInputError>()(
	"@maple/web/api/warehouse/WarehouseInvalidInputError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

export type WarehouseApiError =
	| WarehouseDecodeError
	| WarehouseQueryError
	| WarehouseTransformError
	| WarehouseInvalidInputError

/** Tagged v1 backend error surfaced by the Maple API client. */
export interface TaggedBackendError {
	readonly _tag: string
}

/** Public v2 error envelope. V2 deliberately has no internal `_tag`. */
export interface V2BackendError {
	readonly error: {
		readonly type: string
		readonly code: string
		readonly message: string
		readonly param?: string
		readonly doc_url?: string
	}
}

export type BackendError = TaggedBackendError | V2BackendError

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

const isTaggedBackendError = (cause: unknown): cause is TaggedBackendError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof (cause as { _tag: unknown })._tag === "string" &&
	(cause as { _tag: string })._tag.startsWith("@maple/http/errors/")

const isV2BackendError = (cause: unknown): cause is V2BackendError => {
	if (typeof cause !== "object" || cause === null || !("error" in cause)) return false
	const error = (cause as { error: unknown }).error
	return (
		typeof error === "object" &&
		error !== null &&
		"type" in error &&
		typeof error.type === "string" &&
		"code" in error &&
		typeof error.code === "string" &&
		"message" in error &&
		typeof error.message === "string"
	)
}

export const isBackendError = (cause: unknown): cause is BackendError =>
	isTaggedBackendError(cause) || isV2BackendError(cause)

export const isWarehouseApiError = (cause: unknown): cause is WarehouseApiError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof cause._tag === "string" &&
	cause._tag.startsWith("@maple/web/api/warehouse/")

/** Preserve known errors; introduce a local query error only for an unstructured failure. */
export const normalizeWarehouseError = (
	operation: string,
	cause: unknown,
): WarehouseApiError | BackendError => {
	if (isBackendError(cause) || isWarehouseApiError(cause)) return cause
	return new WarehouseQueryError({
		operation,
		message: toMessage(cause, `Warehouse query failed for ${operation}`),
		cause,
	})
}

export function decodeInput<S extends Schema.Top & { readonly DecodingServices: never }>(
	schema: S,
	input: unknown,
	operation: string,
): Effect.Effect<S["Type"], WarehouseDecodeError> {
	return Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(
			(cause) =>
				new WarehouseDecodeError({
					operation,
					message: toMessage(cause, `Invalid input for ${operation}`),
					cause,
				}),
		),
	)
}

export function runWarehouseQuery<A>(
	operation: string,
	execute: () => Effect.Effect<A, WarehouseApiError | BackendError, MapleApiAtomClient>,
): Effect.Effect<A, WarehouseApiError | BackendError> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => normalizeWarehouseError(operation, cause)),
	)
}

/**
 * `runWarehouseQuery` against the v2 client.
 *
 * Same span + error normalization, different client layer and a wider input
 * error type: the v2 endpoints fail with the public envelope union
 * (`V2InvalidRequestError`, `V2PayloadTooLargeError`, …) rather than the v1
 * warehouse tags. Both forms pass through unchanged so the UI retains the
 * server's status, code, and remediation copy.
 */
export function runWarehouseQueryV2<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleApiV2AtomClient>,
): Effect.Effect<A, WarehouseApiError | BackendError> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiV2ClientLayer),
		Effect.mapError((cause) => normalizeWarehouseError(operation, cause)),
	)
}

export function invalidWarehouseInput(
	operation: string,
	message: string,
): Effect.Effect<never, WarehouseInvalidInputError> {
	return Effect.fail(
		new WarehouseInvalidInputError({
			operation,
			message,
		}),
	)
}

const executeQueryEngineEffect = Effect.fn("QueryEngine.execute")(function* (
	payload: QueryEngineExecuteRequest,
) {
	const client = yield* MapleApiAtomClient
	return yield* client.queryEngine.execute({ payload })
})

// ---------------------------------------------------------------------------
// Typed result extractors for QueryEngineResult union
// ---------------------------------------------------------------------------

export function extractFacets(response: QueryEngineExecuteResponse): ReadonlyArray<FacetItem> {
	const r = response.result
	if (r.kind === "facets") return r.data
	return []
}

export function extractStats(response: QueryEngineExecuteResponse): DurationStats {
	const r = response.result
	if (r.kind === "stats") return r.data
	return { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 }
}

export function extractAttributeValues(
	response: QueryEngineExecuteResponse,
): ReadonlyArray<AttributeValueItem> {
	const r = response.result
	if (r.kind === "attributeValues") return r.data
	return []
}

export function extractCount(response: QueryEngineExecuteResponse): number {
	const r = response.result
	if (r.kind === "count") return r.data.total
	return 0
}

export function executeQueryEngine(
	operation: string,
	payload: QueryEngineExecuteRequest,
): Effect.Effect<QueryEngineExecuteResponse, WarehouseApiError | BackendError> {
	return Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("query.operation", operation)
		return yield* executeQueryEngineEffect(payload)
	}).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => normalizeWarehouseError(operation, cause)),
	)
}
