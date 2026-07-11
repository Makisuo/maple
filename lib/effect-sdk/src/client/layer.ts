import type { Duration } from "effect"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import { withSessionLink } from "./session-link.js"
import { type ClientReplayConfig, startClientSession } from "./replay-loader.js"
import { clearIdentity as clearIdentityUser, identify as identifyUser } from "./user.js"

export interface MapleClientConfig {
	/** The service name reported in traces, logs, and metrics. */
	readonly serviceName: string
	/** Maple ingest endpoint URL. */
	readonly endpoint: string
	/** Maple ingest key for authentication. */
	readonly ingestKey?: string | undefined
	/** Service version or commit SHA. */
	readonly serviceVersion?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	/** Deployment environment (e.g. "production", "staging"). */
	readonly environment?: string | undefined
	/** Additional resource attributes merged into the telemetry resource. */
	readonly attributes?: Record<string, unknown> | undefined
	/**
	 * Post session metadata rows for the standalone session so it appears in
	 * Maple's Sessions UI (list entry + linked traces, no replay recording).
	 * Default `true`; no-ops when `@maple-dev/browser` is on the page (it owns
	 * the session rows), during SSR, or without an ingest key.
	 */
	readonly emitSessionMeta?: boolean | undefined
	/**
	 * rrweb session replay for this app, recorded by the shared Maple replay
	 * engine (loaded lazily in a code-split chunk). Default enabled with
	 * sampleRate 1 and inputs masked — set `{ enabled: false }` to opt out.
	 */
	readonly replay?: ClientReplayConfig | undefined
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
	if (config.environment) {
		// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + the canonical
		// resource attribute. Keep both until the MVs coalesce them.
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}
	if (config.serviceVersion) attributes["deployment.commit_sha"] = config.serviceVersion
	if (config.serviceNamespace) attributes["service.namespace"] = config.serviceNamespace
	if (config.attributes) Object.assign(attributes, config.attributes)

	startClientSession({
		endpoint: config.endpoint,
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		environment: config.environment,
		serviceVersion: config.serviceVersion,
		replay: config.replay,
		emitSessionMeta: config.emitSessionMeta,
	})

	const base = Otlp.layerJson({
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

	return withSessionLink(base)
}

/**
 * Effect-idiomatic form of `identify` — attach (or replace) the end-user id on
 * the active Maple browser session. From this point on the id is written to the
 * session's next-posted metadata row and stamped as `user.id` on every span the
 * client tracer creates. Idempotent; safe to run repeatedly (e.g. once a login
 * flow resolves the user).
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * yield* Maple.identify(user.id)
 * ```
 */
export const identify = (userId?: string | null): Effect.Effect<void> =>
	Effect.sync(() => identifyUser(userId))

/**
 * Effect-idiomatic form of `clearIdentity` — drop the end-user id from the
 * active Maple browser session (the inverse of `identify`). From this point on
 * metadata rows and spans go back to anonymous (no `user.id` stamp). Call this
 * when a login flow signs the user out; the session itself continues.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * yield* Maple.clearIdentity
 * ```
 */
export const clearIdentity: Effect.Effect<void> = Effect.sync(() => clearIdentityUser())
