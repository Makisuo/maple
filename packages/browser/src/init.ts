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
import { setupTracing } from "./tracing"

export interface MapleBrowserHandle {
	/** Empty until consent is granted when `requireConsent` is enabled. */
	readonly sessionId: string
	/** Tear down tracing + session capture, flushing the final buffers. */
	readonly shutdown: () => Promise<void>
}

interface BrowserRuntime {
	readonly initialSessionId: string
	/** Absent when the sample rate excluded this visitor — see `captureSession`. */
	readonly sink: SessionEventSink | undefined
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

	// One draw, two decisions. `captureSession` governs everything that produces a
	// session — the metadata rows, which are the billed unit, and the distilled
	// event sink that gives them their contents. `recordReplay` is a strict subset:
	// there is no such thing as recording a session you are not capturing.
	//
	// Sampling deliberately reaches the metadata rows. It used to gate only the
	// rrweb chunk, which meant an org on `sampleRate: 0.1` was billed for 100% of
	// its sessions and had no way to buy less — the one lever named "sample" moved
	// only the part we don't charge for. The cost is that unsampled traffic is
	// absent from session analytics rather than present-but-unrecorded; that is the
	// trade a sample rate is supposed to make.
	//
	// `replayEnabled: false` must not suppress capture: turning off video is not
	// the same request as turning off analytics.
	const sampledIn = Math.random() < config.replaySampleRate
	const captureSession = sampledIn
	const recordReplay = config.replayEnabled && sampledIn
	let runtime: BrowserRuntime | undefined
	let stopped = false
	let rotateOnNextStart = false
	let shutdownTracing: (() => Promise<void>) | undefined
	// Bumped by every start and stop, so a replay chunk that lands after a
	// consent revoke (or a rotation) never attaches a recorder to a dead runtime.
	let generation = 0

	const startRuntime = (): void => {
		if (stopped || runtime || !hasConsent()) return
		setVisitorTracking(config.persistVisitorId && mayPersistIdentifier())
		const session = (rotateOnNextStart ? rotateSession() : undefined) ?? getSession()
		rotateOnNextStart = false
		if (config.tracingEnabled && !shutdownTracing) shutdownTracing = setupTracing(config)

		// Unsampled: no sink published, so `TraceIdCollector` finds none and spans
		// carry no `session.id`. A link to a session row that was never written is
		// worse than no link — it dead-ends in the trace UI. Tracing itself is
		// untouched; spans are billed as traces and sampled by their own tracer.
		if (!captureSession) {
			runtime = { initialSessionId: session.id, sink: undefined }
			return
		}

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
		// Both are absent for an unsampled runtime, which never started a sink.
		if (sink) {
			if (flush) await sink.flush(true)
			sink.stop()
		}
		if (sink !== previous.sink) previous.sink?.stop()
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
