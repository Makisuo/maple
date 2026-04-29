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
import { mapleApiClientLayer } from "@/lib/registry"

export const TinybirdDateTimeString = TinybirdDateTime

export class TinybirdDecodeError extends Schema.TaggedErrorClass<TinybirdDecodeError>()(
	"TinybirdDecodeError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class TinybirdQueryError extends Schema.TaggedErrorClass<TinybirdQueryError>()("TinybirdQueryError", {
	operation: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

export class TinybirdTransformError extends Schema.TaggedErrorClass<TinybirdTransformError>()(
	"TinybirdTransformError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class TinybirdInvalidInputError extends Schema.TaggedErrorClass<TinybirdInvalidInputError>()(
	"TinybirdInvalidInputError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

export type TinybirdApiError =
	| TinybirdDecodeError
	| TinybirdQueryError
	| TinybirdTransformError
	| TinybirdInvalidInputError

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

const isTaggedBackendError = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof (cause as { _tag: unknown })._tag === "string" &&
	(cause as { _tag: string })._tag.startsWith("@maple/http/errors/")

export function decodeInput<S extends Schema.Top & { readonly DecodingServices: never }>(
	schema: S,
	input: unknown,
	operation: string,
): Effect.Effect<S["Type"], TinybirdDecodeError> {
	return Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(
			(cause) =>
				new TinybirdDecodeError({
					operation,
					message: toMessage(cause, `Invalid input for ${operation}`),
					cause,
				}),
		),
	)
}

export function runTinybirdQuery<A>(
	operation: string,
	execute: () => Effect.Effect<A, unknown, MapleApiAtomClient>,
): Effect.Effect<A, unknown> {
	return Effect.suspend(execute).pipe(
		Effect.withSpan(operation),
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => {
			if (isTaggedBackendError(cause)) {
				return cause
			}
			return new TinybirdQueryError({
				operation,
				message: toMessage(cause, `Tinybird query failed for ${operation}`),
				cause,
			})
		}),
	)
}

export function invalidTinybirdInput(
	operation: string,
	message: string,
): Effect.Effect<never, TinybirdInvalidInputError> {
	return Effect.fail(
		new TinybirdInvalidInputError({
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

export function executeQueryEngine(operation: string, payload: QueryEngineExecuteRequest) {
	return executeQueryEngineEffect(payload).pipe(
		Effect.provide(mapleApiClientLayer),
		Effect.mapError((cause) => {
			if (isTaggedBackendError(cause)) {
				return cause
			}
			return new TinybirdQueryError({
				operation,
				message: toMessage(cause, "Query engine request failed"),
				cause,
			})
		}),
	)
}
