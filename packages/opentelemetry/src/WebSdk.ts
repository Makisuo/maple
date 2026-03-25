/**
 * @since 1.0.0
 */
import type * as Otel from "@opentelemetry/api"
import type { LoggerProviderConfig, LogRecordProcessor } from "@opentelemetry/sdk-logs"
import type { MetricReader } from "@opentelemetry/sdk-metrics"
import type { SpanProcessor, TracerConfig } from "@opentelemetry/sdk-trace-base"
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Effect from "effect/Effect"
import { constant, type LazyArg } from "effect/Function"
import * as Layer from "effect/Layer"
import { isNonEmpty } from "./internal/utilities.ts"
import * as Logger from "./Logger.ts"
import * as Metrics from "./Metrics.ts"
import * as Resource from "./Resource.ts"
import * as Tracer from "./Tracer.ts"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Configuration {
  readonly spanProcessor?: SpanProcessor | ReadonlyArray<SpanProcessor> | undefined
  readonly tracerConfig?: Omit<TracerConfig, "resource">
  readonly metricReader?: MetricReader | ReadonlyArray<MetricReader> | undefined
  readonly metricTemporality?: Metrics.TemporalityPreference | undefined
  readonly logRecordProcessor?: LogRecordProcessor | ReadonlyArray<LogRecordProcessor> | undefined
  readonly loggerProviderConfig?: Omit<LoggerProviderConfig, "resource"> | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly resource: {
    readonly serviceName: string
    readonly serviceVersion?: string
    readonly attributes?: Otel.Attributes
  }
}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerTracerProvider = (
  processor: SpanProcessor | NonEmptyReadonlyArray<SpanProcessor>,
  config?: Omit<TracerConfig, "resource">
): Layer.Layer<Tracer.OtelTracerProvider, never, Resource.Resource> =>
  Layer.effect(
    Tracer.OtelTracerProvider,
    Effect.gen(function*() {
      const resource = yield* Resource.Resource
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const provider = new WebTracerProvider({
            ...(config ?? undefined),
            resource,
            spanProcessors: Array.isArray(processor) ? (processor as any) : [processor]
          })
          return provider
        }),
        (provider) =>
          Effect.ignore(
            Effect.promise(() => provider.forceFlush().then(() => provider.shutdown()))
          )
      )
    })
  )

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer: {
  (evaluate: LazyArg<Configuration>): Layer.Layer<Resource.Resource>
  <E, R>(evaluate: Effect.Effect<Configuration, E, R>): Layer.Layer<Resource.Resource, E, R>
} = (
  evaluate: LazyArg<Configuration> | Effect.Effect<Configuration, any, any>
): Layer.Layer<Resource.Resource> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* Effect.isEffect(evaluate)
        ? evaluate as Effect.Effect<Configuration>
        : Effect.sync(evaluate)

      const ResourceLive = Resource.layer(config.resource)

      const TracerLive = isNonEmpty(config.spanProcessor)
        ? Layer.provide(
          Tracer.layer,
          layerTracerProvider(config.spanProcessor, config.tracerConfig)
        )
        : Layer.empty

      const LoggerLive = isNonEmpty(config.logRecordProcessor)
        ? Layer.provide(
          Logger.layer({ mergeWithExisting: config.loggerMergeWithExisting }),
          Logger.layerLoggerProvider(config.logRecordProcessor, config.loggerProviderConfig)
        )
        : Layer.empty

      const MetricsLive = isNonEmpty(config.metricReader)
        ? Metrics.layer(constant(config.metricReader), {
          temporality: config.metricTemporality
        })
        : Layer.empty

      return Layer.mergeAll(TracerLive, MetricsLive, LoggerLive).pipe(
        Layer.provideMerge(ResourceLive)
      )
    })
  )
