/**
 * @since 1.0.0
 */
import type { MetricProducer, MetricReader } from "@opentelemetry/sdk-metrics"
import type * as Arr from "effect/Array"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { MetricProducerImpl } from "./internal/metrics.ts"
import { Resource } from "./Resource.ts"

/**
 * Determines how metric values relate to the time interval over which they
 * are aggregated.
 *
 * - `cumulative`: Reports total since a fixed start time. Each data point
 *   depends on all previous measurements. This is the default behavior.
 *
 * - `delta`: Reports changes since the last export. Each interval is
 *   independent with no dependency on previous measurements.
 *
 * @since 1.0.0
 * @category Models
 */
export type TemporalityPreference = "cumulative" | "delta"

/**
 * Creates an OpenTelemetry metric producer from Effect metrics.
 *
 * @since 1.0.0
 * @category Constructors
 */
export const makeProducer = (temporality?: TemporalityPreference): Effect.Effect<MetricProducer, never, Resource> =>
  Effect.gen(function*() {
    const resource = yield* Resource
    const services = yield* Effect.services<never>()
    return new MetricProducerImpl(resource, services, temporality)
  })

/**
 * Registers a metric producer with one or more metric readers.
 *
 * @since 1.0.0
 * @category Constructors
 */
export const registerProducer = (
  self: MetricProducer,
  metricReader: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Array<any>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const reader = metricReader()
      const readers: Array<MetricReader> = Array.isArray(reader) ? reader : [reader] as any
      readers.forEach((reader) => reader.setMetricProducer(self))
      return readers
    }),
    (readers) =>
      Effect.promise(() =>
        Promise.all(
          readers.map((reader) => reader.shutdown())
        )
      ).pipe(
        Effect.ignore,
        Effect.interruptible,
        Effect.timeoutOption(options?.shutdownTimeout ?? 3000)
      )
  )

/**
 * Creates a Layer that registers a metric producer with metric readers.
 *
 * @example
 * ```ts
 * import { Metrics } from "@effect/opentelemetry"
 * import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
 * import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
 *
 * const metricExporter = new OTLPMetricExporter({ url: "<your-otel-url>" })
 *
 * // Use delta temporality for backends like Datadog or Dynatrace
 * const metricsLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({
 *     exporter: metricExporter,
 *     exportIntervalMillis: 10000
 *   }),
 *   { temporality: "delta" }
 * )
 *
 * // Use cumulative temporality for backends like Prometheus (default)
 * const cumulativeLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({ exporter: metricExporter }),
 *   { temporality: "cumulative" }
 * )
 * ```
 *
 * @since 1.0.0
 * @category Layers
 */
export const layer = (
  evaluate: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
    readonly temporality?: TemporalityPreference | undefined
  }
): Layer.Layer<never, never, Resource> =>
  Layer.effectDiscard(Effect.flatMap(
    makeProducer(options?.temporality),
    (producer) => registerProducer(producer, evaluate, options)
  ))
