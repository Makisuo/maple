import type { Duration } from "effect"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import { makeNoOpNotice } from "../shared/no-op-notice.js"
import { resolveResource } from "./resource.js"

const noOpNotice = makeNoOpNotice("[MapleServerSDK]", "set MAPLE_INGEST_KEY to enable")

export interface MapleConfig {
	/**
	 * Service name reported in traces, logs, and metrics. When omitted, falls
	 * back to `OTEL_SERVICE_NAME` env var, then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	/** Override auto-detected service version (commit SHA). */
	readonly serviceVersion?: string | undefined
	/**
	 * Canonical https URL of the source repository, emitted as
	 * `vcs.repository.url.full`. Falls back to `MAPLE_REPOSITORY_URL`, then
	 * GitHub Actions / Vercel git env metadata.
	 */
	readonly repositoryUrl?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
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
 * env vars (Railway, Vercel, Cloudflare Pages, Render).
 *
 * Returns a no-op layer when no ingest key resolves (neither `config.ingestKey`
 * nor `MAPLE_INGEST_KEY`), making it safe for local development — the same rule
 * the flushable and Cloudflare presets use. The endpoint is NOT the disable
 * signal: it always resolves, defaulting to the public Maple ingest so users
 * only have to supply a key.
 *
 * For Cloudflare Workers, prefer `@maple-dev/effect-sdk/cloudflare`'s `make()`
 * — it has no background fiber and exposes an explicit `flush` Effect that
 * `@maple/effect-cloudflare`'s `withRequestRuntime` schedules in
 * `ctx.waitUntil`. This layer's `Otlp.layerJson` background-export fiber
 * doesn't tick on Workers between invocations.
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
			const resolved = yield* resolveResource({ ...config, sdkType: "server" })
			if (!resolved.ingestKey) {
				noOpNotice()
				return Layer.empty
			}

			return Otlp.layerJson({
				baseUrl: resolved.endpoint,
				resource: resolved.resource,
				headers: { Authorization: `Bearer ${Redacted.value(resolved.ingestKey)}` },
				maxBatchSize: config.maxBatchSize,
				loggerExportInterval: config.loggerExportInterval,
				metricsExportInterval: config.metricsExportInterval,
				tracerExportInterval: config.tracerExportInterval,
				shutdownTimeout: config.shutdownTimeout,
			}).pipe(Layer.provide(FetchHttpClient.layer))
		}),
	)
