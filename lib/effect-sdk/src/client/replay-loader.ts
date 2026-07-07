// Replay bootstrap for the Effect client SDK. The engine (rrweb + event
// capture + session rows, shared with `@maple-dev/browser` via
// `@maple/browser-session/replay`) is pulled in through a dynamic import so it
// lands in a code-split chunk — apps that disable replay never download rrweb.
import { readSessionSink } from "@maple/browser-session"
import { setupStandaloneSession } from "./standalone-session.js"
import { getCurrentUserId } from "./user.js"

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
}

let replayStarted = false

/**
 * Start the session side of the client SDK: a (sampled) rrweb replay session,
 * or — when replay is off, unsampled, or impossible — plain session metadata
 * rows so the session still appears in Maple's Sessions UI with its linked
 * traces. No-ops during SSR, without an ingest key, or when
 * `@maple-dev/browser` already owns the page's session.
 */
export const startClientSession = (config: ClientSessionConfig): void => {
	if (typeof window === "undefined") return
	if (!config.ingestKey) return
	if (readSessionSink()) return // `@maple-dev/browser` owns the session.

	// Recording needs a real DOM (`document`); metadata rows below don't.
	const replayEnabled = (config.replay?.enabled ?? true) && typeof document !== "undefined"
	const sampled = replayEnabled && Math.random() < (config.replay?.sampleRate ?? 1)
	if (sampled && !replayStarted) {
		replayStarted = true
		const ingestKey = config.ingestKey
		void import("./replay.js").then(({ startReplaySession }) => {
			// Re-check after the async chunk load: `@maple-dev/browser` may have
			// initialized in the meantime, and two recorders on one page would
			// double-capture the session.
			if (readSessionSink()) return
			return startReplaySession({
				endpoint: config.endpoint,
				ingestKey,
				serviceName: config.serviceName,
				environment: config.environment,
				serviceVersion: config.serviceVersion,
				maskAllInputs: config.replay?.maskAllInputs ?? true,
				maskAllText: config.replay?.maskAllText ?? false,
				getUserId: getCurrentUserId,
			})
		})
		return
	}
	if (config.emitSessionMeta ?? true) {
		setupStandaloneSession({
			endpoint: config.endpoint,
			ingestKey: config.ingestKey,
			serviceName: config.serviceName,
			environment: config.environment,
			serviceVersion: config.serviceVersion,
		})
	}
}
