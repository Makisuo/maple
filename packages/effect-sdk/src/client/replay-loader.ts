// Replay bootstrap for the Effect client SDK. rrweb stays behind a dynamic
// import, while the consent-aware controller itself is always lightweight.
import {
	clearPendingEvents,
	clearSessionSink,
	configurePrivacy,
	getActiveSink,
	getSession,
	hasConsent,
	mayPersistIdentifier,
	onConsentChange,
	type PrivacyOptions,
	readSessionSink,
	rotateSession,
	setVisitorTracking,
	startEventSink,
	type SessionEventSink,
	type MetadataSessionHandle,
} from "@maple/browser-session"
import { setupStandaloneSession } from "./standalone-session.js"
import { getCurrentIdentity } from "./user.js"

export interface ClientReplayConfig {
	/** Record rrweb session replays. Default `true`. */
	readonly enabled?: boolean | undefined
	/** Fraction of sessions to record, 0–1. Default `1`. */
	readonly sampleRate?: number | undefined
	/** Mask all `<input>` values in the recording. Default `true`. */
	readonly maskAllInputs?: boolean | undefined
	/** Mask all text in the recording. Default `false`. */
	readonly maskAllText?: boolean | undefined
}

export interface ClientSessionConfig {
	readonly endpoint: string
	readonly ingestKey?: string | undefined
	readonly serviceName: string
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly replay?: ClientReplayConfig | undefined
	readonly emitSessionMeta?: boolean | undefined
	/** Consent, visitor-id persistence, and email capture. See `PrivacyOptions`. */
	readonly privacy?: PrivacyOptions | undefined
}

export interface ClientSessionHandle {
	/** Stop capture. `flush: false` is used for consent revocation. */
	readonly stop: (options?: { readonly flush?: boolean }) => Promise<void>
}

interface ReplayHandle {
	readonly sessionId: string
	readonly shutdown: (options?: { readonly flush?: boolean }) => Promise<void>
}

interface Runtime {
	readonly sink: SessionEventSink
	replay?: ReplayHandle | undefined
	metadata?: MetadataSessionHandle | undefined
}

const noOpHandle: ClientSessionHandle = { stop: () => Promise.resolve() }

/**
 * Own the complete client-session lifecycle. Consent can change after startup:
 * grant starts capture, revoke synchronously detaches producers and discards
 * buffers, and a later grant creates a clean runtime.
 */
export const startClientSession = (config: ClientSessionConfig): ClientSessionHandle => {
	configurePrivacy(config.privacy)
	if (!hasConsent()) clearPendingEvents()
	if (typeof window === "undefined" || !config.ingestKey || readSessionSink()) return noOpHandle

	const engineConfig = {
		endpoint: config.endpoint.replace(/\/$/, ""),
		ingestKey: config.ingestKey,
		maskAllInputs: config.replay?.maskAllInputs ?? true,
		maskAllText: config.replay?.maskAllText ?? false,
	}
	const replayEnabled = (config.replay?.enabled ?? true) && typeof document !== "undefined"
	const sampled = replayEnabled && Math.random() < (config.replay?.sampleRate ?? 1)
	let runtime: Runtime | undefined
	let stopped = false
	let generation = 0
	let rotateOnNextStart = false

	const stopRuntime = async (flush: boolean): Promise<void> => {
		generation++
		const previous = runtime
		runtime = undefined
		if (!previous) return
		// Calling shutdown/stop before the first await makes revocation detach all
		// producers synchronously, even if a previous network flush is in flight.
		const replayShutdown = previous.replay?.shutdown({ flush })
		const metadataShutdown = previous.metadata?.shutdown({ flush })
		const currentSessionId = previous.replay?.sessionId ?? previous.metadata?.sessionId
		const liveSink = getActiveSink()
		const sink =
			liveSink && currentSessionId && liveSink.sessionId === currentSessionId ? liveSink : previous.sink
		if (flush) await sink.flush(true)
		sink.stop()
		if (sink !== previous.sink) previous.sink.stop()
		if (currentSessionId) clearSessionSink(currentSessionId)
		await Promise.all([replayShutdown, metadataShutdown])
	}

	const startRuntime = (): void => {
		if (stopped || runtime || !hasConsent() || readSessionSink()) return
		setVisitorTracking((config.privacy?.persistVisitorId ?? true) && mayPersistIdentifier())
		const session = (rotateOnNextStart ? rotateSession() : undefined) ?? getSession()
		rotateOnNextStart = false
		const next: Runtime = { sink: startEventSink(engineConfig, session.id) }
		runtime = next
		const ownGeneration = ++generation

		if (sampled) {
			void import("./replay.js")
				.then(({ startReplaySession }) => {
					if (stopped || !hasConsent() || generation !== ownGeneration || runtime !== next) {
						return
					}
					next.replay = startReplaySession({
						endpoint: config.endpoint,
						ingestKey: config.ingestKey!,
						serviceName: config.serviceName,
						environment: config.environment,
						serviceVersion: config.serviceVersion,
						maskAllInputs: engineConfig.maskAllInputs,
						maskAllText: engineConfig.maskAllText,
						getIdentity: getCurrentIdentity,
						captureUserEmail: config.privacy?.captureUserEmail,
					})
				})
				.catch(() => {
					// A blocked/lost replay chunk should still leave a useful session row.
					if (
						(config.emitSessionMeta ?? true) &&
						!stopped &&
						hasConsent() &&
						generation === ownGeneration &&
						runtime === next
					) {
						next.metadata = setupStandaloneSession({
							endpoint: config.endpoint,
							ingestKey: config.ingestKey,
							serviceName: config.serviceName,
							environment: config.environment,
							serviceVersion: config.serviceVersion,
							captureUserEmail: config.privacy?.captureUserEmail,
						})
					}
				})
			return
		}

		if (config.emitSessionMeta ?? true) {
			next.metadata = setupStandaloneSession({
				endpoint: config.endpoint,
				ingestKey: config.ingestKey,
				serviceName: config.serviceName,
				environment: config.environment,
				serviceVersion: config.serviceVersion,
				captureUserEmail: config.privacy?.captureUserEmail,
			})
		}
	}

	startRuntime()
	const stopConsentListener = config.privacy?.requireConsent
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

	return {
		stop: async (options) => {
			if (stopped) return
			stopped = true
			stopConsentListener()
			await stopRuntime(options?.flush ?? true)
		},
	}
}
