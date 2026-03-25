/**
 * @since 1.0.0
 */
import type * as OtelApi from "@opentelemetry/api"
import * as Resources from "@opentelemetry/resources"
import * as OtelSemConv from "@opentelemetry/semantic-conventions"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"

/**
 * @since 1.0.0
 * @category Services
 */
export class Resource extends ServiceMap.Service<
  Resource,
  Resources.Resource
>()("@effect/opentelemetry/Resource") {}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = (config: {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelApi.Attributes
}) =>
  Layer.succeed(
    Resource,
    Resources.resourceFromAttributes(configToAttributes(config))
  )

/**
 * @since 1.0.0
 * @category Configuration
 */
export const configToAttributes = (options: {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelApi.Attributes
}): Record<string, string> => {
  const attributes: Record<string, string> = {
    ...(options.attributes ?? undefined),
    [OtelSemConv.ATTR_SERVICE_NAME]: options.serviceName,
    [OtelSemConv.ATTR_TELEMETRY_SDK_NAME]: "@effect/opentelemetry",
    [OtelSemConv.ATTR_TELEMETRY_SDK_LANGUAGE]: typeof (globalThis as any).document === "undefined"
      ? OtelSemConv.TELEMETRY_SDK_LANGUAGE_VALUE_NODEJS
      : OtelSemConv.TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS
  }
  if (options.serviceVersion) {
    attributes[OtelSemConv.ATTR_SERVICE_VERSION] = options.serviceVersion
  }
  return attributes
}

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerFromEnv = (
  additionalAttributes?:
    | OtelApi.Attributes
    | undefined
): Layer.Layer<Resource> =>
  Layer.effect(
    Resource,
    Effect.gen(function*() {
      const serviceName = yield* Config.option(Config.string("OTEL_SERVICE_NAME"))
      const attributes = yield* Config.string("OTEL_RESOURCE_ATTRIBUTES").pipe(
        Config.withDefault(""),
        Config.map((s) => {
          const attrs = s.split(",")
          return Arr.reduce(attrs, {} as OtelApi.Attributes, (acc, attr) => {
            const parts = attr.split("=")
            if (parts.length !== 2) {
              return acc
            }
            acc[parts[0].trim()] = parts[1].trim()
            return acc
          })
        })
      )
      if (serviceName._tag === "Some") {
        attributes[OtelSemConv.ATTR_SERVICE_NAME] = serviceName.value
      }
      if (additionalAttributes) {
        Object.assign(attributes, additionalAttributes)
      }
      return Resources.resourceFromAttributes(attributes)
    }).pipe(Effect.orDie)
  )

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerEmpty = Layer.succeed(
  Resource,
  Resources.emptyResource()
)
