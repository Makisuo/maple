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

export class WarehouseDecodeError extends Schema.TaggedErrorClass<WarehouseDecodeError>()(
	"@maple/web/api/warehouse/WarehouseDecodeError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseQueryError extends Schema.TaggedErrorClass<WarehouseQueryError>()(
	"@maple/web/api/warehouse/WarehouseQueryError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseTransformError extends Schema.TaggedErrorClass<WarehouseTransformError>()(
	"@maple/web/api/warehouse/WarehouseTransformError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class WarehouseInvalidInputError extends Schema.TaggedErrorClass<WarehouseInvalidInputError>()(
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

/**
 * Structural shape of a tagged backend error surfaced by the Maple API client.
 * Backend errors are a sprawling union of `@maple/http/errors/*` tagged classes;
 * we narrow on the `_tag` prefix rather than re-importing every class.
 */
export interface BackendError {
	readonly _tag: string
}

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

const isTaggedBackendError = (cause: unknown): cause is BackendError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof (cause as { _tag: unknown })._tag === "string" &&
	(cause as { _tag: string })._tag.startsWith("@maple/http/errors/")

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
		Effect.mapError((cause) => {
			if (isTaggedBackendError(cause)) {
				return cause
			}
			return new WarehouseQueryError({
				operation,
				message: toMessage(cause, `Warehouse query failed for ${operation}`),
				cause,
			})
		}),
	)
}

/**
 * `runWarehouseQuery` against the v2 client.
 *
 * Same span + error normalization, different client layer and a wider input
 * error type: the v2 endpoints fail with the public envelope union
 * (`V2InvalidRequestError`, `V2PayloadTooLargeError`, …) rather than the v1
 * warehouse tags, and all of those collapse into `WarehouseQueryError` here so
 * callers keep one error shape.
 */
export function runWarehouseQueryV2<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleApiV2AtomClient>,
): Effect.Effect<A, WarehouseApiError | BackendError> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiV2ClientLayer),
		Effect.mapError((cause) => {
			if (isTaggedBackendError(cause)) {
				return cause
			}
			return new WarehouseQueryError({
				operation,
				message: toMessage(cause, `Warehouse query failed for ${operation}`),
				cause,
			})
		}),
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
): Effect.Effect<QueryEngineExecuteResponse, WarehouseQueryError | BackendError> {
	return Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan("query.operation", operation)
		return yield* executeQueryEngineEffect(payload)
	}).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => {
			if (isTaggedBackendError(cause)) {
				return cause
			}
			return new WarehouseQueryError({
				operation,
				message: toMessage(cause, "Query engine request failed"),
				cause,
			})
		}),
	)
}
