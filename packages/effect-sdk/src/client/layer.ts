import type { Duration } from "effect"
import { Effect, Layer } from "effect"
import { Otlp } from "effect/unstable/observability"
import { browserNavigator } from "./browser-globals.js"
import { consentHttpClientLayer } from "./consent-http-client.js"
import { type ClientReplayConfig, startClientSession } from "./replay-loader.js"
import { withSessionLink } from "./session-link.js"
import { type IdentifyInput, type PrivacyOptions, type TrackProps, track as trackEvent } from "./track.js"
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
	/**
	 * Consent gating, persistent-visitor-id storage, and whether `identify()`'s
	 * email reaches the warehouse. Defaults capture everything except where a
	 * browser signals otherwise: Global Privacy Control suppresses the
	 * persistent visitor id (capture itself continues, anonymously).
	 * With `requireConsent`, this built-in OTLP layer suppresses cumulative
	 * metrics because it cannot separate pre-grant values; use `MapleFlush.make`
	 * when post-grant browser metrics are required.
	 */
	readonly privacy?: PrivacyOptions | undefined
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
	const nav = browserNavigator()
	if (nav) {
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

	const clientSessionConfig = {
		endpoint: config.endpoint,
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		environment: config.environment,
		serviceVersion: config.serviceVersion,
		replay: config.replay,
		emitSessionMeta: config.emitSessionMeta,
		privacy: config.privacy,
	} as const

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
	}).pipe(Layer.provide(consentHttpClientLayer(config.privacy?.requireConsent ?? false)))

	const lifecycle = Layer.effectDiscard(
		Effect.acquireRelease(
			Effect.sync(() => startClientSession(clientSessionConfig)),
			// `Effect.promise` turns a rejection into a defect, and this runs during
			// `ManagedRuntime.dispose()` — a transport that starts throwing would
			// crash teardown rather than lose a beacon. Shutdown is best-effort.
			(clientSession) => Effect.promise(() => clientSession.stop().catch(() => undefined)),
		),
	)
	return withSessionLink(Layer.merge(base, lifecycle))
}

/**
 * Effect-idiomatic form of `identify` — attach (or replace) the end-user
 * identity on the active Maple browser session. From this point on it is
 * written to the session's next-posted metadata row and the id is stamped as
 * `user.id` on every span the client tracer creates. Idempotent; safe to run
 * repeatedly (e.g. once a login flow resolves the user).
 *
 * Pass a bare id, or the full identity to get grouping by company/team in the
 * Sessions UI.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * yield* Maple.identify(user.id)
 * yield* Maple.identify({ id: user.id, email: user.email, groupId: org.id, groupName: org.name })
 * ```
 */
export const identify = (input?: IdentifyInput): Effect.Effect<void> => Effect.sync(() => identifyUser(input))

/**
 * Effect-idiomatic form of `track` — record a custom product event against the
 * active session. It lands as a `session_events` row, so it shows up inline in
 * the session transcript next to the clicks and requests around it.
 *
 * Safe to run before the SDK finishes initializing: events are queued (capped)
 * and drained once the session starts.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * yield* Maple.track("checkout_completed", { plan: "pro", seats: 5 })
 * ```
 */
export const track = (name: string, props?: TrackProps): Effect.Effect<void> =>
	Effect.sync(() => trackEvent(name, props))

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
