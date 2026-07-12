// ---------------------------------------------------------------------------
// Standalone session emission — sessions in the Sessions UI without
// `@maple-dev/browser`.
//
// The Sessions UI is backed by `session_replays` metadata rows, which only the
// browser SDK used to post. When the Effect client SDK runs alone it now posts
// those rows itself (active on setup / tab-visible, ended with the observed
// trace ids on tab-hidden / pagehide), so a session appears in Maple — as a
// session-grouped list entry with linked traces, just without an rrweb
// recording to play back.
//
// When the `@maple-dev/browser` sink is published, that SDK owns the session
// rows (it has the replay recorder, click counts, and `identify()`); every
// post here re-checks the sink and stands down, matching `withSessionLink`,
// which routes span linking through the sink in the same situation.
// ---------------------------------------------------------------------------
import {
	buildSessionMetaRow,
	getSession,
	nextMetaVersion,
	postSessionMetaRow,
	readSessionSink,
} from "@maple/browser-session"
import { getCurrentUserId } from "./user.js"

/** Trace ids observed per standalone session — attached to its ended rows. */
const observedBySession = new Map<string, Set<string>>()

export interface StandaloneSessionOptions {
	readonly endpoint: string
	readonly ingestKey?: string | undefined
	readonly serviceName: string
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
}

let current: { sessionId: string; startedAt: Date; options: StandaloneSessionOptions } | undefined
let listenersInstalled = false

const post = (status: "active" | "ended", keepalive: boolean): void => {
	if (!current) return
	if (readSessionSink()) return // `@maple-dev/browser` owns the session rows.
	const { sessionId, startedAt, options } = current
	void postSessionMetaRow(
		options.endpoint,
		options.ingestKey!,
		buildSessionMetaRow({
			sessionId,
			startedAt,
			version: nextMetaVersion(),
			status,
			serviceName: options.serviceName,
			userId: getCurrentUserId(),
			environment: options.environment,
			serviceVersion: options.serviceVersion,
			traceIds: status === "ended" ? Array.from(observedBySession.get(sessionId) ?? []) : undefined,
		}),
		keepalive,
	)
}

/**
 * Record a span created while no browser-SDK sink is published. Called by
 * `withSessionLink` per span; rotation is detected here (a span landing on a
 * new session id after the idle window) so the old session gets its ended row
 * and the new one its active row without any timer of our own.
 */
export const noteStandaloneSpan = (sessionId: string, traceId: string): void => {
	let ids = observedBySession.get(sessionId)
	if (!ids) {
		ids = new Set()
		observedBySession.set(sessionId, ids)
	}
	ids.add(traceId)
	if (current && sessionId !== current.sessionId) {
		post("ended", false)
		const record = getSession()
		current = { ...current, sessionId: record.id, startedAt: new Date(record.startedAt) }
		post("active", false)
	}
}

/**
 * Start posting session metadata rows for the standalone session. No-ops
 * outside a browser, without an ingest key, or when the browser SDK's sink is
 * already published. Idempotent per page load — the client presets call it on
 * construction and tests reset via `resetStandaloneSessionForTests`.
 */
export const setupStandaloneSession = (options: StandaloneSessionOptions): void => {
	if (typeof window === "undefined") return
	if (!options.ingestKey) return
	if (current) return
	if (readSessionSink()) return
	const record = getSession()
	current = { sessionId: record.id, startedAt: new Date(record.startedAt), options }
	post("active", false)
	if (!listenersInstalled && typeof globalThis.addEventListener === "function") {
		listenersInstalled = true
		globalThis.addEventListener("pagehide", () => post("ended", true))
		globalThis.addEventListener("visibilitychange", () => {
			const doc = (globalThis as Record<string, any>)["document"]
			if (!doc) return
			if (doc.visibilityState === "hidden") post("ended", true)
			else post("active", false)
		})
	}
}

/** Test-only: clear the singleton so each test starts from a fresh page state. */
export const resetStandaloneSessionForTests = (): void => {
	current = undefined
	observedBySession.clear()
	// Listeners stay installed (they no-op with `current` unset in a fresh
	// setup), matching a real page where they live for the page lifetime.
}
