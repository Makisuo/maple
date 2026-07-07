import { trace } from "@opentelemetry/api"
import { getSession, publishSessionSink } from "@maple/browser-session"
import {
	setActiveTraceIdProvider,
	startReplaySession,
	type ReplaySessionHandle,
} from "@maple/browser-session/replay"
import { type MapleBrowserConfig, type ResolvedConfig, resolveConfig } from "./config"
import { setupTracing } from "./tracing"

export interface MapleBrowserHandle {
	readonly sessionId: string
	/** Tear down tracing + replay (flushing the final chunk). */
	readonly shutdown: () => Promise<void>
}

let active: MapleBrowserHandle | undefined
// Same object the replay engine's `getUserId` reads, so `identify()` mutations
// are seen by the ended-metadata rows posted on suspend/unload.
let activeConfig: ResolvedConfig | undefined

/**
 * Initialize Maple browser telemetry: OTel tracing + (sampled) rrweb session
 * replay, both tagged with one shared session id so a trace can link to its
 * replay and vice versa. Idempotent — repeated calls return the live handle.
 *
 * The replay lifecycle (suspend on tab-hidden, resume on visible, session
 * metadata rows) lives in `@maple/browser-session` and is shared with the
 * Effect client SDK's `replay` option.
 */
export function init(rawConfig: MapleBrowserConfig): MapleBrowserHandle {
	if (active) return active
	if (typeof window === "undefined") {
		// SSR / non-browser: no-op handle so isomorphic apps can call init freely.
		return { sessionId: "", shutdown: () => Promise.resolve() }
	}

	const config = resolveConfig(rawConfig)
	activeConfig = config

	// Resolve + publish the session up front so external tracers (Effect client
	// SDK) link spans to it even when replay is disabled or unsampled.
	const session = getSession()
	publishSessionSink(session.id)

	// Distilled session events tag themselves with the active OTel trace id.
	setActiveTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId)

	const shutdownTracing = config.tracingEnabled ? setupTracing(config, session.id) : undefined

	const recordReplay = config.replayEnabled && Math.random() < config.replaySampleRate
	let replay: ReplaySessionHandle | undefined
	if (recordReplay) {
		replay = startReplaySession({
			endpoint: config.endpoint,
			ingestKey: config.ingestKey,
			serviceName: config.serviceName,
			environment: config.environment,
			serviceVersion: config.serviceVersion,
			maskAllInputs: config.maskAllInputs,
			maskAllText: config.maskAllText,
			getUserId: () => activeConfig?.userId,
		})
	}

	const handle: MapleBrowserHandle = {
		sessionId: session.id,
		shutdown: async () => {
			await replay?.shutdown()
			replay = undefined
			await shutdownTracing?.()
			active = undefined
			activeConfig = undefined
		},
	}
	active = handle
	return handle
}

/**
 * Attach (or replace) the user id on the active session. Idempotent and safe to
 * call on every render. The session's authoritative row is the latest-version
 * "ended" row posted on suspend/unload, which reads `config.userId` at that
 * moment — so an id set here before the session ends is what the session is
 * tagged with.
 */
export function identify(userId: string): void {
	if (typeof window === "undefined") return
	if (!activeConfig) return
	if (!userId) return
	if (activeConfig.userId === userId) return
	activeConfig.userId = userId
}
