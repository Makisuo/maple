/**
 * @since 1.0.0
 */
import * as Otel from "@opentelemetry/sdk-logs"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as Predicate from "effect/Predicate"
import * as References from "effect/References"
import * as ServiceMap from "effect/ServiceMap"
import * as Tracer from "effect/Tracer"
import { nanosToHrTime, unknownToAttributeValue } from "./internal/attributes.ts"
import { Resource } from "./Resource.ts"

/**
 * @since 1.0.0
 * @category Services
 */
export class OtelLoggerProvider extends ServiceMap.Service<
  OtelLoggerProvider,
  Otel.LoggerProvider
>()("@effect/opentelemetry/Logger/OtelLoggerProvider") {}

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make: Effect.Effect<
  Logger.Logger<unknown, void>,
  never,
  OtelLoggerProvider
> = Effect.gen(function*() {
  const loggerProvider = yield* OtelLoggerProvider
  const clock = yield* Clock.Clock
  const otelLogger = loggerProvider.getLogger("@effect/opentelemetry")

  return Logger.make((options) => {
    const attributes: Record<string, any> = {
      fiberId: options.fiber.id
    }

    const span = ServiceMap.getOrUndefined(options.fiber.services, Tracer.ParentSpan)

    if (Predicate.isNotUndefined(span)) {
      attributes.spanId = span.spanId
      attributes.traceId = span.traceId
    }

    for (const [key, value] of Object.entries(options.fiber.getRef(References.CurrentLogAnnotations))) {
      attributes[key] = unknownToAttributeValue(value)
    }
    const now = options.date.getTime()
    for (const [label, startTime] of options.fiber.getRef(References.CurrentLogSpans)) {
      attributes[`logSpan.${label}`] = `${now - startTime}ms`
    }

    const message = Arr.ensure(options.message).map(unknownToAttributeValue)
    const hrTime = nanosToHrTime(clock.currentTimeNanosUnsafe())
    otelLogger.emit({
      body: message.length === 1 ? message[0] : message,
      severityText: options.logLevel,
      severityNumber: LogLevel.getOrdinal(options.logLevel),
      timestamp: hrTime,
      observedTimestamp: hrTime,
      attributes
    })
  })
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = (options: {
  /**
   * If set to `true`, the OpenTelemetry logger will be merged with existing
   * loggers in the application.
   *
   * If set to `false`, the OpenTelemetry logger will replace all existing
   * loggers in the application.
   *
   * Defaults to `true`.
   */
  readonly mergeWithExisting?: boolean | undefined
}): Layer.Layer<never, never, OtelLoggerProvider> =>
  Logger.layer([make], {
    mergeWithExisting: options.mergeWithExisting ?? true
  })

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerLoggerProvider = (
  processor: Otel.LogRecordProcessor | NonEmptyReadonlyArray<Otel.LogRecordProcessor>,
  config?: Omit<Otel.LoggerProviderConfig, "resource"> & {
    readonly shutdownTimeout?: Duration.Input | undefined
  }
): Layer.Layer<OtelLoggerProvider, never, Resource> =>
  Layer.effect(
    OtelLoggerProvider,
    Effect.gen(function*() {
      const resource = yield* Resource
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          new Otel.LoggerProvider({
            ...(config ?? undefined),
            processors: Arr.ensure(processor),
            resource
          })
        ),
        (provider) =>
          Effect.promise(() => provider.forceFlush().then(() => provider.shutdown())).pipe(
            Effect.ignore,
            Effect.interruptible,
            Effect.timeoutOption(config?.shutdownTimeout ?? 3000)
          )
      )
    })
  )
