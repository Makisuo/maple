import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { ExploreAttributesInput, AttributeKeyResult, AttributeValueResult } from "./types"
import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"

export const exploreAttributeKeys = (
  input: ExploreAttributesInput,
): Effect.Effect<ReadonlyArray<AttributeKeyResult>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    let pipe: TinybirdPipe
    if (input.source === "traces") {
      pipe = input.scope === "resource" ? "resource_attribute_keys" : "span_attribute_keys"
    } else if (input.source === "metrics") {
      pipe = "metric_attribute_keys"
    } else {
      pipe = "services_facets"
    }

    const result = yield* executor.query(pipe, {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { service_name: input.service }),
      limit: input.limit ?? 50,
    })

    return (result.data as any[]).map((d): AttributeKeyResult => ({
      key: d.attributeKey ?? d.key ?? d.facetKey ?? "",
      count: Number(d.count ?? 0),
    }))
  })

export const exploreAttributeValues = (
  input: ExploreAttributesInput & { key: string },
): Effect.Effect<ReadonlyArray<AttributeValueResult>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const pipe: TinybirdPipe = input.scope === "resource"
      ? "resource_attribute_values"
      : "span_attribute_values"

    const result = yield* executor.query(pipe, {
      attribute_key: input.key,
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { service_name: input.service }),
      limit: input.limit ?? 50,
    })

    return (result.data as any[]).map((d): AttributeValueResult => ({
      value: d.attributeValue ?? d.value ?? "",
      count: Number(d.count ?? 0),
    }))
  })
