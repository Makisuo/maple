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
	sdkHint,
	setActiveTraceIdProvider,
	setVisitorTracking,
	startEventSink,
	startMetadataSession,
	type MetadataSessionHandle,
	type SessionEventSink,
} from "@maple/browser-session"
// Type-only: the replay entry pulls rrweb, so it may only be reached through the
// dynamic import in `startRuntime`.
import type { ReplaySessionHandle } from "@maple/browser-session/replay"
import { trace } from "@opentelemetry/api"
import { type MapleBrowserConfig, type ResolvedConfig, resolveConfig } from "./config"
import { setupErrorCapture } from "./errors"
import { setupTracing } from "./tracing"
import { SDK_NAME, SDK_VERSION } from "./version"

/** `x-maple-sdk` value for every request this build makes to ingest. */
const SDK_HINT = sdkHint(SDK_NAME, SDK_VERSION)

export interface MapleBrowserHandle {
	/** Empty until consent is granted when `requireConsent` is enabled. */
	readonly sessionId: string
	/** Tear down tracing + session capture, flushing the final buffers. */
	readonly shutdown: () => Promise<void>
}

interface BrowserRuntime {
	readonly initialSessionId: string
	readonly sink: SessionEventSink
	replay?: ReplaySessionHandle | undefined
	metadata?: MetadataSessionHandle | undefined
	/** Settles when the lazy replay chunk resolved; absent on the metadata path. */
	replayPending?: Promise<void> | undefined
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
	let stopErrorCapture: (() => void) | undefined
	// Bumped by every start and stop, so a replay chunk that lands after a
	// consent revoke (or a rotation) never attaches a recorder to a dead runtime.
	let generation = 0

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
				sdk: SDK_HINT,
				maskAllInputs: config.maskAllInputs,
				maskAllText: config.maskAllText,
			},
			session.id,
		)
		if (config.tracingEnabled && !shutdownTracing) shutdownTracing = setupTracing(config)
		// After `setupTracing`: the handlers span through the global provider it
		// registers, so registering them first would drop the errors of the very
		// first moments into a no-op tracer.
		if (config.tracingEnabled && config.tracingCaptureErrors && !stopErrorCapture) {
			stopErrorCapture = setupErrorCapture()
		}
		const shared = {
			endpoint: config.endpoint,
			ingestKey: config.ingestKey,
			sdk: SDK_HINT,
			serviceName: config.serviceName,
			environment: config.environment,
			serviceVersion: config.serviceVersion,
			getIdentity: () => activeConfig?.identity,
			captureUserEmail: config.captureUserEmail,
		}
		// The replay path publishes the sink and sources trace ids itself — the
		// Effect SDK drives it with neither wired — so only the metadata path takes
		// them from here. Passing both would republish the sink twice per rotation.
		const startMetadata = (): MetadataSessionHandle | undefined =>
			startMetadataSession({
				...shared,
				getTraceIds: getObservedTraceIds,
				onSessionChange: publishSessionSink,
			})

		if (!recordReplay) {
			runtime = { initialSessionId: session.id, sink, metadata: startMetadata() }
			return
		}

		// Sampled in: rrweb rides in a code-split chunk so the ~90% of visitors a
		// sample rate excludes never download it. The sampling decision above is
		// synchronous — only the recorder handle arrives late.
		const next: BrowserRuntime = { initialSessionId: session.id, sink }
		runtime = next
		const ownGeneration = ++generation
		const stale = (): boolean =>
			stopped || !hasConsent() || generation !== ownGeneration || runtime !== next
		next.replayPending = import("@maple/browser-session/replay")
			.then(({ startReplaySession }) => {
				if (stale()) return
				next.replay = startReplaySession({
					...shared,
					maskAllInputs: config.maskAllInputs,
					maskAllText: config.maskAllText,
				})
			})
			.catch(() => {
				// A blocked or failed chunk should still leave a session row behind.
				if (stale()) return
				next.metadata = startMetadata()
			})
	}

	const stopRuntime = async (flush: boolean): Promise<void> => {
		// Before the first await, so an in-flight replay chunk sees a stale
		// generation and never starts a recorder behind the teardown.
		generation++
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
		// Awaiting the import too keeps `shutdown()` a real quiescence point: it
		// resolves with no replay work still scheduled behind it.
		await Promise.all([replayShutdown, metadataShutdown, previous.replayPending])
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
			stopErrorCapture?.()
			stopErrorCapture = undefined
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
