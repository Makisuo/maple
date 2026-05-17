import { Array as Arr, Effect, pipe } from "effect"
import type {
	SpanAttributeKeysOutput,
	SpanAttributeValuesOutput,
	ResourceAttributeValuesOutput,
} from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { ExploreAttributesInput, AttributeKeyResult, AttributeValueResult } from "./types"

// All three key endpoints (span_attribute_keys, resource_attribute_keys, metric_attribute_keys)
// share the same output shape: { attributeKey, usageCount }
type AttributeKeyRow = SpanAttributeKeysOutput

// Both value endpoints share: { attributeValue, usageCount }
type AttributeValueRow = SpanAttributeValuesOutput | ResourceAttributeValuesOutput

export const exploreAttributeKeys: (
	input: ExploreAttributesInput,
) => Effect.Effect<ReadonlyArray<AttributeKeyResult>, ObservabilityError, TinybirdExecutor> = Effect.fn(
	"Observability.exploreAttributeKeys",
)(function* (input) {
		const executor = yield* TinybirdExecutor

		const pipeName =
			input.source === "traces"
				? input.scope === "resource"
					? ("resource_attribute_keys" as const)
					: ("span_attribute_keys" as const)
				: input.source === "metrics"
					? ("metric_attribute_keys" as const)
					: ("services_facets" as const)

		if (pipeName === "services_facets") {
			// Different schema: { name, count, facetType }
			const result = yield* executor.query<{ name: string; count: number; facetType: string }>(
				pipeName,
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					limit: input.limit ?? 50,
				},
				{ profile: "discovery" },
			)
			return pipe(
				result.data,
				Arr.map((d): AttributeKeyResult => ({ key: d.name, count: Number(d.count) })),
			)
		}

		const result = yield* executor.query<AttributeKeyRow>(
			pipeName,
			{
				start_time: input.timeRange.startTime,
				end_time: input.timeRange.endTime,
				...(input.service && { service_name: input.service }),
				limit: input.limit ?? 50,
			},
			{ profile: "discovery" },
		)

		return pipe(
			result.data,
			Arr.map((d): AttributeKeyResult => ({ key: d.attributeKey, count: Number(d.usageCount) })),
		)
})

export const exploreAttributeValues: (
	input: ExploreAttributesInput & { key: string },
) => Effect.Effect<ReadonlyArray<AttributeValueResult>, ObservabilityError, TinybirdExecutor> = Effect.fn(
	"Observability.exploreAttributeValues",
)(function* (input) {
		const executor = yield* TinybirdExecutor

		const pipeName =
			input.scope === "resource"
				? ("resource_attribute_values" as const)
				: ("span_attribute_values" as const)

		const result = yield* executor.query<AttributeValueRow>(
			pipeName,
			{
				attribute_key: input.key,
				start_time: input.timeRange.startTime,
				end_time: input.timeRange.endTime,
				...(input.service && { service_name: input.service }),
				limit: input.limit ?? 50,
			},
			{ profile: "discovery" },
		)

		return pipe(
			result.data,
			Arr.map((d): AttributeValueResult => ({ value: d.attributeValue, count: Number(d.usageCount) })),
		)
})
