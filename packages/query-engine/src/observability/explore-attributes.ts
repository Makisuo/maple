import { Array as Arr, Effect, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { ExploreAttributesInput, AttributeKeyResult, AttributeValueResult } from "./types"
import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"

const resolveKeysPipe = (input: ExploreAttributesInput): TinybirdPipe => {
  if (input.source === "traces") {
    return input.scope === "resource" ? "resource_attribute_keys" : "span_attribute_keys"
  }
  return input.source === "metrics" ? "metric_attribute_keys" : "services_facets"
}

export const exploreAttributeKeys = (
  input: ExploreAttributesInput,
): Effect.Effect<ReadonlyArray<AttributeKeyResult>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query(resolveKeysPipe(input), {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { service_name: input.service }),
      limit: input.limit ?? 50,
    })

    return pipe(
      result.data as any[],
      Arr.map((d): AttributeKeyResult => ({
        key: d.attributeKey ?? d.key ?? d.facetKey ?? "",
        count: Number(d.count ?? 0),
      })),
    )
  })

export const exploreAttributeValues = (
  input: ExploreAttributesInput & { key: string },
): Effect.Effect<ReadonlyArray<AttributeValueResult>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const pipeName: TinybirdPipe = input.scope === "resource"
      ? "resource_attribute_values"
      : "span_attribute_values"

    const result = yield* executor.query(pipeName, {
      attribute_key: input.key,
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { service_name: input.service }),
      limit: input.limit ?? 50,
    })

    return pipe(
      result.data as any[],
      Arr.map((d): AttributeValueResult => ({
        value: d.attributeValue ?? d.value ?? "",
        count: Number(d.count ?? 0),
      })),
    )
  })
