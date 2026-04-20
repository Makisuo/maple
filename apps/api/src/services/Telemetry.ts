import {
  Config,
  ConfigProvider,
  type Context,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Scope,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

const readOtelConfig = Effect.gen(function* () {
  const baseUrl = yield* Config.option(Config.string("OTEL_BASE_URL"))
  const environment = yield* Config.option(Config.string("OTEL_ENVIRONMENT"))
  const ingestKey = yield* Config.option(Config.redacted("MAPLE_OTEL_INGEST_KEY"))
  const commitSha = yield* Config.option(Config.string("COMMIT_SHA"))
  const env = Option.getOrElse(environment, () => "local")
  const enabled = env !== "local" && Option.isSome(baseUrl)
  return { enabled, baseUrl, env, ingestKey, commitSha } as const
})

export const makeTelemetryLayer = (serviceName: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cfg = yield* readOtelConfig
      if (!cfg.enabled || Option.isNone(cfg.baseUrl)) return Layer.empty

      return Otlp.layerJson({
        baseUrl: cfg.baseUrl.value,
        resource: {
          serviceName,
          serviceVersion: Option.getOrElse(cfg.commitSha, () => "dev"),
          attributes: { "deployment.environment": cfg.env },
        },
        headers: Option.match(cfg.ingestKey, {
          onNone: () => undefined,
          onSome: (key) => ({ Authorization: `Bearer ${Redacted.value(key)}` }),
        }),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export const TracerLive = makeTelemetryLayer("maple-api")

const makeRequestTelemetryLayer = (serviceName: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cfg = yield* readOtelConfig
      if (!cfg.enabled || Option.isNone(cfg.baseUrl)) return Layer.empty

      return Otlp.layerJson({
        baseUrl: cfg.baseUrl.value,
        resource: {
          serviceName,
          serviceVersion: Option.getOrElse(cfg.commitSha, () => "dev"),
          attributes: { "deployment.environment": cfg.env },
        },
        headers: Option.match(cfg.ingestKey, {
          onNone: () => undefined,
          onSome: (key) => ({ Authorization: `Bearer ${Redacted.value(key)}` }),
        }),
        // The exporter's background interval fiber does not reliably progress
        // between CF Worker requests, so we rely exclusively on the scope
        // finalizer (Scope.close → runExport) to flush. Push intervals out so
        // the idle fiber never competes with the shutdown flush.
        tracerExportInterval: "1 hour",
        loggerExportInterval: "1 hour",
        metricsExportInterval: "1 hour",
        shutdownTimeout: "15 seconds",
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export interface RequestTelemetry {
  readonly services: Promise<Context.Context<never>>
  readonly dispose: () => Promise<void>
}

/**
 * Build a per-request OTLP tracer/logger/metrics bound to a fresh scope.
 * Returns the built ServiceMap (to inject into the request handler) plus a
 * `dispose` function that closes the scope — which triggers the exporter's
 * finalizer and actually flushes buffered spans/logs. Call `dispose()` from
 * inside `ctx.waitUntil` after the response resolves.
 */
export const buildRequestTelemetry = (
  serviceName: string,
  env: Record<string, unknown>,
): RequestTelemetry => {
  const scope = Scope.makeUnsafe()
  const layer = makeRequestTelemetryLayer(serviceName).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  )

  const services = Effect.runPromise(
    Layer.buildWithScope(layer, scope) as unknown as Effect.Effect<
      Context.Context<never>,
      never,
      never
    >,
  )

  const dispose = () => Effect.runPromise(Scope.close(scope, Exit.void))

  return { services, dispose }
}
