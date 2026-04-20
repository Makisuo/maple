import {
  Config,
  ConfigProvider,
  type Context,
  type Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

const readOtelConfig = Effect.gen(function* () {
  const baseUrl = yield* Config.option(Config.string("OTEL_BASE_URL"))
  const environment = yield* Config.option(Config.string("OTEL_ENVIRONMENT"))
  const ingestKey = yield* Config.option(Config.redacted("MAPLE_OTEL_INGEST_KEY"))
  const commitSha = yield* Config.option(Config.string("COMMIT_SHA"))
  const env = Option.getOrElse(environment, () => "local")
  // Any non-"local" environment with a baseUrl enables export. Setting
  // OTEL_BASE_URL without an environment name is treated as intent-to-export
  // (defaults env to "unknown"), because the URL is what actually matters.
  const enabled = Option.isSome(baseUrl) && env !== "local"
  return { enabled, baseUrl, env, ingestKey, commitSha } as const
})

// Wraps globalThis.fetch so every OTLP HTTP call is visible in CF logs. This
// makes silent failure modes (401/403/network) observable without touching
// Effect's internals. Intentionally uses console.* so it shows up in CF
// tail even when the Effect logger is set to a higher level.
const loggingFetch: typeof globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  const started = Date.now()
  try {
    const res = await globalThis.fetch(input, init)
    const ms = Date.now() - started
    if (res.ok) {
      console.log(`[telemetry] ${init?.method ?? "GET"} ${url} → ${res.status} (${ms}ms)`)
    } else {
      const body = await res
        .clone()
        .text()
        .catch(() => "<no body>")
      console.error(
        `[telemetry] ${init?.method ?? "GET"} ${url} → ${res.status} (${ms}ms) body: ${body.slice(0, 500)}`,
      )
    }
    return res
  } catch (err) {
    const ms = Date.now() - started
    console.error(
      `[telemetry] ${init?.method ?? "GET"} ${url} FAILED after ${ms}ms:`,
      err,
    )
    throw err
  }
}

const LoggingFetchLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, loggingFetch)),
)

export interface MakeTelemetryLayerOptions {
  /** Push the exporter's background interval out so the shutdown finalizer
   * becomes the only flush path. Set this when the runtime is torn down per
   * unit of work (per-request, per-cron-tick). */
  readonly exportOnShutdownOnly?: boolean
  /** Upper bound on how long the shutdown finalizer (the actual OTLP POST)
   * may take before being timed out. CF `waitUntil` allows ~30s total. */
  readonly shutdownTimeout?: Duration.Input
}

const makeOtlpLayer = (
  serviceName: string,
  options: MakeTelemetryLayerOptions = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cfg = yield* readOtelConfig
      if (!cfg.enabled || Option.isNone(cfg.baseUrl)) return Layer.empty

      const interval: Duration.Input | undefined = options.exportOnShutdownOnly
        ? "1 hour"
        : undefined
      const shutdownTimeout: Duration.Input =
        options.shutdownTimeout ?? "15 seconds"
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
        tracerExportInterval: interval,
        loggerExportInterval: interval,
        metricsExportInterval: interval,
        shutdownTimeout,
      }).pipe(Layer.provide(LoggingFetchLayer))
    }),
  )

/** Default shared telemetry layer. Kept for callers (alerting worker) that
 * compose telemetry into their own ManagedRuntime — the runtime's scope
 * close (e.g. `runtime.dispose()`) is what triggers the final OTLP flush,
 * so the caller must dispose per unit of work, not cache across invocations. */
export const makeTelemetryLayer = (serviceName: string) =>
  makeOtlpLayer(serviceName, { exportOnShutdownOnly: true })

const makeRequestTelemetryLayer = (serviceName: string) =>
  makeOtlpLayer(serviceName, {
    exportOnShutdownOnly: true,
    shutdownTimeout: "15 seconds",
  })

export interface RequestTelemetry {
  readonly services: Promise<Context.Context<never>>
  readonly dispose: () => Promise<void>
}

// Log the detected config once per isolate so operators can verify env wiring.
let configLogged = false
const logConfigOnce = (env: Record<string, unknown>) => {
  if (configLogged) return
  configLogged = true
  const has = (k: string) => (env[k] != null && String(env[k]) !== "" ? "set" : "MISSING")
  console.log(
    `[telemetry] config — OTEL_BASE_URL=${has("OTEL_BASE_URL")} OTEL_ENVIRONMENT=${has("OTEL_ENVIRONMENT")} MAPLE_OTEL_INGEST_KEY=${has("MAPLE_OTEL_INGEST_KEY")} baseUrl=${env.OTEL_BASE_URL ?? "(none)"} environment=${env.OTEL_ENVIRONMENT ?? "(none)"}`,
  )
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
  logConfigOnce(env)
  const layer = makeRequestTelemetryLayer(serviceName).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  )
  // ManagedRuntime wraps Scope.makeUnsafe + Layer.buildWithMemoMap + Scope.close
  // for us. dispose() closes the runtime's internal scope → OtlpExporter's
  // `Scope.addFinalizer(runExport)` fires → OTLP POST.
  const runtime = ManagedRuntime.make(layer)

  const services = runtime.context().catch((err) => {
    console.error("[telemetry] layer build failed:", err)
    throw err
  })

  const dispose = async () => {
    try {
      await runtime.dispose()
    } catch (err) {
      console.error("[telemetry] dispose/flush failed:", err)
    }
  }

  return { services, dispose }
}
