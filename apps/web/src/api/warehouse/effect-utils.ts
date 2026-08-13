import {
	TinybirdDateTime,
	QueryEngineExecuteBatchRequest,
	QueryEngineExecuteRequest,
	type QueryEngineExecuteResponse,
	type FacetItem,
	type DurationStats,
	type AttributeValueItem,
} from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { PublicHttpErrorBodySchema, type AnyPublicHttpErrorBody } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { mapleApiClientLayer, mapleApiV2ClientLayer, mapleRuntime } from "@/lib/registry"
import { makeClientErrorBody } from "@/lib/error-messages"
import { makeExecuteBatcher } from "./execute-batcher"

export const WarehouseDateTimeString = TinybirdDateTime

export class WarehouseDecodeError extends Schema.TaggedError<WarehouseDecodeError>()(
	"@maple/web/errors/WarehouseDecodeError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_decode_failed",
		title: "Query data could not be read",
		message: "Maple could not read the query response.",
		retryable: false,
		recovery: "contact_support",
	})
}

export class WarehouseQueryError extends Schema.TaggedError<WarehouseQueryError>()(
	"@maple/web/errors/WarehouseQueryError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_query_failed",
		title: "Warehouse query failed",
		message: "Maple could not complete the warehouse query.",
		retryable: true,
		recovery: "retry",
	})
}

export class WarehouseTransformError extends Schema.TaggedError<WarehouseTransformError>()(
	"@maple/web/errors/WarehouseTransformError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_transform_failed",
		title: "Query data could not be displayed",
		message: "Maple could not prepare the query data.",
		retryable: false,
		recovery: "contact_support",
	})
}

export class WarehouseInvalidInputError extends Schema.TaggedError<WarehouseInvalidInputError>()(
	"@maple/web/errors/WarehouseInvalidInputError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {
	readonly error = makeClientErrorBody({
		_tag: this._tag,
		code: "warehouse_input_invalid",
		title: "Invalid query",
		message: this.message,
		retryable: false,
		recovery: "fix_request",
	})
}

export type WarehouseApiError =
	| WarehouseDecodeError
	| WarehouseQueryError
	| WarehouseTransformError
	| WarehouseInvalidInputError

/** Backend failures are either a public body or an error carrying that same body. */
export type BackendError = AnyPublicHttpErrorBody | { readonly error: AnyPublicHttpErrorBody }

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

const isPublicErrorBody = Schema.is(PublicHttpErrorBodySchema)

const isPublicErrorEnvelope = (cause: unknown): cause is { readonly error: AnyPublicHttpErrorBody } => {
	if (typeof cause !== "object" || cause === null || !("error" in cause)) return false
	return isPublicErrorBody((cause as { readonly error: unknown }).error)
}

export const isBackendError = (cause: unknown): cause is BackendError =>
	isPublicErrorBody(cause) || isPublicErrorEnvelope(cause)

export const isWarehouseApiError = (cause: unknown): cause is WarehouseApiError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof cause._tag === "string" &&
	cause._tag.startsWith("@maple/web/errors/Warehouse")

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

export function runWarehouseQuery<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleApiAtomClient>,
): Effect.Effect<A, WarehouseApiError | BackendError> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		// Warehouse adapters are imperative server-function entrypoints and own this runtime layer.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => normalizeWarehouseError(operation, cause)),
	)
}

/**
 * `runWarehouseQuery` against the v2 client.
 *
 * Same span + error normalization, different client layer and a wider input
 * error type: each v2 endpoint exposes its own literal `_tag` envelope union.
 * Those envelopes pass through unchanged so the UI retains the server's exact
 * semantic tag, status, code, and remediation copy.
 */
export function runWarehouseQueryV2<A, E>(
	operation: string,
	execute: () => Effect.Effect<A, E, MapleApiV2AtomClient>,
): Effect.Effect<A, WarehouseApiError | BackendError> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		// Warehouse adapters are imperative server-function entrypoints and own this runtime layer.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
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

// One process-wide batcher: coalescing only helps if every caller shares it.
const executeBatcher = makeExecuteBatcher((requests) =>
	mapleRuntime.runPromise(
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response = yield* client.queryEngine.executeBatch({
				payload: new QueryEngineExecuteBatchRequest({ requests }),
			})
			return response.results
		}).pipe(
			Effect.withSpan("QueryEngine.executeBatch", {
				attributes: { "query.batch_size": requests.length },
			}),
		),
	),
)

const executeQueryEngineEffect = Effect.fn("QueryEngine.execute")(function* (
	payload: QueryEngineExecuteRequest,
) {
	return yield* Effect.tryPromise({
		try: () => executeBatcher.enqueue(payload),
		catch: (cause) =>
			new WarehouseQueryError({
				operation: "QueryEngine.executeBatch",
				message: toMessage(cause, "Warehouse batch request failed"),
				cause,
			}),
	})
})

// Typed result extractors for QueryEngineResult union

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
		// The client layer comes from `mapleRuntime` inside the batcher, so no
		// `Effect.provide` here — this fiber only awaits the batch's promise.
		return yield* executeQueryEngineEffect(payload)
	}).pipe(
		Effect.withSpan(operation),
		Effect.mapError((cause) => normalizeWarehouseError(operation, cause)),
	)
}
