import type { Duration } from "effect"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

export interface MapleClientConfig {
	/** The service name reported in traces, logs, and metrics. */
	readonly serviceName: string
	/** Maple ingest endpoint URL. */
	readonly endpoint: string
	/** Maple ingest key for authentication. */
	readonly ingestKey?: string | undefined
	/** Service version or commit SHA. */
	readonly serviceVersion?: string | undefined
	/** Deployment environment (e.g. "production", "staging"). */
	readonly environment?: string | undefined
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
 * configured for Maple in browser environments.
 *
 * Unlike the server layer, all configuration must be provided programmatically
 * since browsers don't have access to environment variables.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * import { Effect } from "effect"
 *
 * const TracerLive = Maple.layer({
 *   serviceName: "my-frontend",
 *   endpoint: "https://ingest.maple.dev",
 *   ingestKey: "maple_pk_...",
 * })
 *
 * const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))
 * Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
 * ```
 */
export const layer = (config: MapleClientConfig) => {
	const attributes: Record<string, unknown> = {
		"maple.sdk.type": "client",
	}
	const g = globalThis as Record<string, any>
	if (typeof g["navigator"] !== "undefined") {
		const nav = g["navigator"]
		if (nav.userAgent) attributes["browser.user_agent"] = nav.userAgent
		if (nav.language) attributes["browser.language"] = nav.language
	}
	if (typeof Intl !== "undefined") {
		try {
			attributes["browser.timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone
		} catch {}
	}
	if (config.environment) attributes["deployment.environment"] = config.environment
	if (config.serviceVersion) attributes["deployment.commit_sha"] = config.serviceVersion
	if (config.attributes) Object.assign(attributes, config.attributes)

	return Otlp.layerJson({
		baseUrl: config.endpoint,
		resource: {
			serviceName: config.serviceName,
			serviceVersion: config.serviceVersion,
			attributes,
		},
		headers: config.ingestKey ? { Authorization: `Bearer ${config.ingestKey}` } : undefined,
		maxBatchSize: config.maxBatchSize,
		loggerExportInterval: config.loggerExportInterval,
		metricsExportInterval: config.metricsExportInterval,
		tracerExportInterval: config.tracerExportInterval,
		shutdownTimeout: config.shutdownTimeout,
	}).pipe(Layer.provide(FetchHttpClient.layer))
}
