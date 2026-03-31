import type { Duration } from "effect"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import { runtime, provider } from "std-env"
import * as EnvConfig from "./config.js"

export interface MapleConfig {
  /** The service name reported in traces, logs, and metrics. */
  readonly serviceName: string
  /** Override auto-detected service version (commit SHA). */
  readonly serviceVersion?: string | undefined
  /** Override auto-detected deployment environment. */
  readonly environment?: string | undefined
  /** Maple ingest endpoint URL. Overrides MAPLE_ENDPOINT env var. */
  readonly endpoint?: string | undefined
  /** Maple ingest key. Overrides MAPLE_INGEST_KEY env var. */
  readonly ingestKey?: string | undefined
  /** Additional resource attributes merged into the telemetry resource. */
  readonly attributes?: Record<string, unknown> | undefined
  readonly maxBatchSize?: number | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}

/**
 * Create an Effect Layer that provides OpenTelemetry traces, logs, and metrics
 * configured for Maple.
 *
 * Auto-detects commit SHA and deployment environment from common platform
 * env vars (Railway, Vercel, Cloudflare Pages, Render). Returns a no-op layer
 * when no endpoint is configured, making it safe for local development.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/server"
 * import { Effect } from "effect"
 *
 * const TracerLive = Maple.layer({ serviceName: "my-app" })
 *
 * const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))
 * Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
 * ```
 */
export const layer = (config: MapleConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const envEndpoint = yield* EnvConfig.endpoint
      const endpoint = config.endpoint ?? Option.getOrUndefined(envEndpoint)
      if (!endpoint) return Layer.empty

      const envIngestKey = yield* EnvConfig.ingestKey
      const ingestKey = config.ingestKey
        ? Redacted.make(config.ingestKey)
        : Option.getOrUndefined(envIngestKey)

      const envServiceVersion = yield* EnvConfig.serviceVersion
      const serviceVersion = config.serviceVersion ?? Option.getOrUndefined(envServiceVersion)

      const envEnvironment = yield* EnvConfig.environment
      const environment = config.environment ?? Option.getOrUndefined(envEnvironment)

      const attributes: Record<string, unknown> = {
        "maple.sdk.type": "server",
      }
      if (runtime) attributes["maple.runtime"] = runtime
      if (provider) attributes["maple.provider"] = provider
      if (environment) attributes["deployment.environment"] = environment
      if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
      if (config.attributes) Object.assign(attributes, config.attributes)

      return Otlp.layerJson({
        baseUrl: endpoint,
        resource: {
          serviceName: config.serviceName,
          serviceVersion,
          attributes,
        },
        headers: ingestKey
          ? { Authorization: `Bearer ${Redacted.value(ingestKey)}` }
          : undefined,
        maxBatchSize: config.maxBatchSize,
        loggerExportInterval: config.loggerExportInterval,
        metricsExportInterval: config.metricsExportInterval,
        tracerExportInterval: config.tracerExportInterval,
        shutdownTimeout: config.shutdownTimeout,
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )
