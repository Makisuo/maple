import type { Duration } from "effect"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import * as EnvConfig from "./config.js"
import { getAutoPlatformAttributes } from "./platform.js"

export interface MapleConfig {
	/**
	 * Service name reported in traces, logs, and metrics. When omitted, falls
	 * back to `OTEL_SERVICE_NAME` env var, then `"unknown_service"`.
	 */
	readonly serviceName?: string | undefined
	/** Override auto-detected service version (commit SHA). */
	readonly serviceVersion?: string | undefined
	/** Override auto-detected deployment environment. */
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL. When omitted, falls back to `MAPLE_ENDPOINT` then
	 * `OTEL_EXPORTER_OTLP_ENDPOINT` env vars (the latter is what the
	 * maple-k8s-infra chart's operator injects into pods).
	 */
	readonly endpoint?: string | undefined
	/** Maple ingest key. Overrides MAPLE_INGEST_KEY env var. */
	readonly ingestKey?: string | undefined
	/**
	 * Additional resource attributes merged into the telemetry resource. These
	 * take precedence over `OTEL_RESOURCE_ATTRIBUTES` env-var entries with the
	 * same key.
	 */
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
export const layer = (config: MapleConfig = {}) =>
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

			const envOtelServiceName = yield* EnvConfig.otelServiceName
			const serviceName = config.serviceName ?? Option.getOrUndefined(envOtelServiceName) ?? "unknown"

			const envResourceAttributes = yield* EnvConfig.otelResourceAttributes

			// Precedence (lowest to highest):
			//   1. Auto-detected OTel platform attributes (std-env + well-known env vars)
			//   2. SDK-baked attributes (maple.sdk.type, deployment.*)
			//   3. OTEL_RESOURCE_ATTRIBUTES env var (e.g. maple-k8s-infra chart's
			//      downward-API pod metadata injection)
			//   4. Programmatic `config.attributes` (set in app code)
			// Matches the OTel spec's "later writers win" rule.
			const attributes: Record<string, unknown> = {}
			Object.assign(attributes, getAutoPlatformAttributes())
			attributes["maple.sdk.type"] = "server"
			if (environment) attributes["deployment.environment"] = environment
			if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
			Object.assign(attributes, envResourceAttributes)
			if (config.attributes) Object.assign(attributes, config.attributes)

			return Otlp.layerJson({
				baseUrl: endpoint,
				resource: {
					serviceName,
					serviceVersion,
					attributes,
				},
				headers: ingestKey ? { Authorization: `Bearer ${Redacted.value(ingestKey)}` } : undefined,
				maxBatchSize: config.maxBatchSize,
				loggerExportInterval: config.loggerExportInterval,
				metricsExportInterval: config.metricsExportInterval,
				tracerExportInterval: config.tracerExportInterval,
				shutdownTimeout: config.shutdownTimeout,
			}).pipe(Layer.provide(FetchHttpClient.layer))
		}),
	)
