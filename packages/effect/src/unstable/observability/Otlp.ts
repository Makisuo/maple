/**
 * @since 4.0.0
 */
import type * as Duration from "../../Duration.ts"
import { flow } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import type * as Tracer from "../../Tracer.ts"
import type * as Headers from "../http/Headers.ts"
import type * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as OtlpLogger from "./OtlpLogger.ts"
import type { AggregationTemporality } from "./OtlpMetrics.ts"
import * as OtlpMetrics from "./OtlpMetrics.ts"
import * as OtlpSerialization from "./OtlpSerialization.ts"
import * as OtlpTracer from "./OtlpTracer.ts"

/**
 * @since 4.0.0
 * @category Layers
 */
export const layer = (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}): Layer.Layer<never, never, HttpClient.HttpClient | OtlpSerialization.OtlpSerialization> => {
  const base = HttpClientRequest.get(options.baseUrl)
  const url = (path: string) => HttpClientRequest.appendUrl(base, path).url
  return Layer.mergeAll(
    OtlpLogger.layer({
      url: url("/v1/logs"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.loggerExportInterval,
      maxBatchSize: options.maxBatchSize,
      shutdownTimeout: options.shutdownTimeout,
      excludeLogSpans: options.loggerExcludeLogSpans,
      mergeWithExisting: options.loggerMergeWithExisting
    }),
    OtlpMetrics.layer({
      url: url("/v1/metrics"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.metricsExportInterval,
      shutdownTimeout: options.shutdownTimeout,
      temporality: options.metricsTemporality
    }),
    OtlpTracer.layer({
      url: url("/v1/traces"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.tracerExportInterval,
      maxBatchSize: options.maxBatchSize,
      context: options.tracerContext,
      shutdownTimeout: options.shutdownTimeout
    })
  )
}

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerJson: (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}) => Layer.Layer<never, never, HttpClient.HttpClient> = flow(layer, Layer.provide(OtlpSerialization.layerJson))

/**
 * @since 4.0.0
 * @category Layers
 */
export const layerProtobuf: (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}) => Layer.Layer<never, never, HttpClient.HttpClient> = flow(layer, Layer.provide(OtlpSerialization.layerProtobuf))
