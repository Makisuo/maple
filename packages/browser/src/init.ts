import {
	clearPendingEvents,
	clearSessionSink,
	configurePrivacy,
	getActiveSink,
	getObservedTraceIds,
	getSession,
	hasConsent,
	type IdentifyInput,
	mayPersistIdentifier,
	normalizeIdentity,
	onConsentChange,
	publishSessionSink,
	rotateSession,
	setVisitorTracking,
	startEventSink,
	startMetadataSession,
	type MetadataSessionHandle,
	type SessionEventSink,
} from "@maple/browser-session"
import {
	type ReplaySessionHandle,
	setActiveTraceIdProvider,
	startReplaySession,
} from "@maple/browser-session/replay"
import { trace } from "@opentelemetry/api"
import { type MapleBrowserConfig, type ResolvedConfig, resolveConfig } from "./config"
import { setupTracing } from "./tracing"

export interface MapleBrowserHandle {
	/** Empty until consent is granted when `requireConsent` is enabled. */
	readonly sessionId: string
	/** Tear down tracing + session capture, flushing the final buffers. */
	readonly shutdown: () => Promise<void>
}

interface BrowserRuntime {
	readonly initialSessionId: string
	readonly sink: SessionEventSink
	readonly replay?: ReplaySessionHandle | undefined
	readonly metadata?: MetadataSessionHandle | undefined
}

let active: MapleBrowserHandle | undefined
// Same object the session lifecycle's `getIdentity` reads, so `identify()`
// mutations are seen by later metadata rows.
let activeConfig: ResolvedConfig | undefined

/**
 * Initialize Maple browser telemetry. With consent gating enabled the returned
 * handle remains live while denied: granting starts capture, revoking detaches
 * it without flushing, and a later grant starts cleanly again.
 */
export function init(rawConfig: MapleBrowserConfig): MapleBrowserHandle {
	if (active) return active
	if (typeof window === "undefined") {
		return { sessionId: "", shutdown: () => Promise.resolve() }
	}

	const config = resolveConfig(rawConfig)
	activeConfig = config
	configurePrivacy(config)
	if (!hasConsent()) clearPendingEvents()
	setActiveTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId)

	const recordReplay = config.replayEnabled && Math.random() < config.replaySampleRate
	let runtime: BrowserRuntime | undefined
	let stopped = false
	let rotateOnNextStart = false
	let shutdownTracing: (() => Promise<void>) | undefined

	const startRuntime = (): void => {
		if (stopped || runtime || !hasConsent()) return
		setVisitorTracking(config.persistVisitorId && mayPersistIdentifier())
		const session = (rotateOnNextStart ? rotateSession() : undefined) ?? getSession()
		rotateOnNextStart = false
		publishSessionSink(session.id)
		const sink = startEventSink(
			{
				endpoint: config.endpoint,
				ingestKey: config.ingestKey,
				maskAllInputs: config.maskAllInputs,
				maskAllText: config.maskAllText,
			},
			session.id,
		)
		if (config.tracingEnabled && !shutdownTracing) shutdownTracing = setupTracing(config)
		const shared = {
			endpoint: config.endpoint,
			ingestKey: config.ingestKey,
			serviceName: config.serviceName,
			environment: config.environment,
			serviceVersion: config.serviceVersion,
			getIdentity: () => activeConfig?.identity,
			captureUserEmail: config.captureUserEmail,
		}
		// The replay path publishes the sink and sources trace ids itself — the
		// Effect SDK drives it with neither wired — so only the metadata path takes
		// them from here. Passing both would republish the sink twice per rotation.
		const replay = recordReplay
			? startReplaySession({
					...shared,
					maskAllInputs: config.maskAllInputs,
					maskAllText: config.maskAllText,
				})
			: undefined
		const metadata = replay
			? undefined
			: startMetadataSession({
					...shared,
					getTraceIds: getObservedTraceIds,
					onSessionChange: publishSessionSink,
				})
		runtime = { initialSessionId: session.id, sink, replay, metadata }
	}

	const stopRuntime = async (flush: boolean): Promise<void> => {
		const previous = runtime
		runtime = undefined
		if (!previous) return
		const replayShutdown = previous.replay?.shutdown({ flush })
		const metadataShutdown = previous.metadata?.shutdown({ flush })
		const currentSessionId = previous.replay?.sessionId ?? previous.metadata?.sessionId
		const liveSink = getActiveSink()
		const sink =
			liveSink && currentSessionId && liveSink.sessionId === currentSessionId ? liveSink : previous.sink
		if (flush) await sink.flush(true)
		sink.stop()
		if (sink !== previous.sink) previous.sink.stop()
		clearSessionSink(currentSessionId ?? previous.initialSessionId)
		await Promise.all([replayShutdown, metadataShutdown])
	}

	startRuntime()
	const stopConsentListener = config.requireConsent
		? onConsentChange((allowed) => {
				if (allowed) {
					startRuntime()
					return
				}
				rotateOnNextStart = runtime !== undefined
				clearPendingEvents()
				setVisitorTracking(false)
				void stopRuntime(false)
			})
		: () => {}

	const handle: MapleBrowserHandle = {
		get sessionId() {
			return (
				runtime?.replay?.sessionId ?? runtime?.metadata?.sessionId ?? runtime?.initialSessionId ?? ""
			)
		},
		shutdown: async () => {
			if (stopped) return
			stopped = true
			stopConsentListener()
			await stopRuntime(true)
			await shutdownTracing?.()
			shutdownTracing = undefined
			setActiveTraceIdProvider(() => undefined)
			active = undefined
			activeConfig = undefined
		},
	}
	active = handle
	return handle
}

/**
 * Attach, replace, or clear the end-user identity on the active session.
 * Idempotent and safe to call on every render. Future browser-created spans
 * read the id when they start, and future session metadata rows read the whole
 * identity when they post.
 *
 * Accepts a bare user id or the full object:
 *
 * ```ts
 * MapleBrowser.identify("user_123")
 * MapleBrowser.identify({ id: "user_123", email: "a@b.com", groupId: "org_1", groupName: "Acme" })
 * ```
 *
 * Each call replaces the identity rather than merging — merging would leak a
 * signed-out user's email into whoever signs in next on a shared device.
 */
export function identify(input?: IdentifyInput): void {
	if (typeof window === "undefined" || !activeConfig) return
	activeConfig.identity = normalizeIdentity(input)
}
