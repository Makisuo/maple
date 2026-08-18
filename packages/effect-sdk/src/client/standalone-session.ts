// Metadata-only session emission for the Effect client SDK. The lifecycle is
// implemented in @maple/browser-session so it stays identical to the browser
// SDK's unsampled path (including idle rotation and cumulative counters).
import { readSessionSink, startMetadataSession, type MetadataSessionHandle } from "@maple/browser-session"
import { getCurrentIdentity } from "./user.js"
import { CLIENT_SDK_HINT } from "../version.js"

/** Trace ids observed per standalone session — attached to its ended row. */
const observedBySession = new Map<string, Set<string>>()

export interface StandaloneSessionOptions {
	readonly endpoint: string
	readonly ingestKey?: string | undefined
	readonly serviceName: string
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly captureUserEmail?: boolean | undefined
}

let current: { handle: MetadataSessionHandle; references: number } | undefined

/**
 * The page-level metadata session, handed out as reference-counted leases.
 *
 * The refcount is load-bearing, not defensive scaffolding: `Maple.layer` starts
 * a client session per *runtime*, and two runtimes can overlap on one page —
 * `ManagedRuntime.dispose()` resolves asynchronously, so a React StrictMode
 * double-mount (or an HMR remount) builds the replacement runtime before the
 * outgoing one's release finalizer runs. Both then hold a lease on the same
 * singleton. Without the count, the outgoing runtime's `shutdown` posts the
 * `ended` row and clears `current` while the live runtime is still holding the
 * handle — the session dies mid-page and nothing restarts it, because
 * `setupStandaloneSession` only runs on runtime start. Two `MapleFlush.make()`
 * calls in one page reproduce the same overlap.
 *
 * Within a single `startClientSession` controller leases never overlap
 * (`stopRuntime` calls the outgoing `shutdown` synchronously, before any await,
 * and `startRuntime` refuses to run while a runtime exists), so the count only
 * ever exceeds 1 across controllers. The per-lease `released` flag keeps a
 * double `shutdown` of one lease from decrementing twice and stranding another
 * holder. Covered by the overlap cases in `standalone-session.test.ts`.
 */
const leaseCurrent = (): MetadataSessionHandle | undefined => {
	if (!current) return undefined
	current.references++
	const owned = current.handle
	let released = false
	return {
		get sessionId() {
			return owned.sessionId
		},
		shutdown: async (options) => {
			if (released) return
			released = true
			if (!current || current.handle !== owned) return
			current.references--
			if (current.references > 0) return
			current = undefined
			await owned.shutdown(options)
		},
	}
}

/** Record a span against the session resolved by the shared span decorator. */
export const noteStandaloneSpan = (sessionId: string, traceId: string): void => {
	let ids = observedBySession.get(sessionId)
	if (!ids) {
		ids = new Set()
		observedBySession.set(sessionId, ids)
	}
	ids.add(traceId)
}

/**
 * Start metadata-only emission when the browser SDK is not already the owner.
 * Idempotent per Effect client runtime.
 */
export const setupStandaloneSession = (
	options: StandaloneSessionOptions,
): MetadataSessionHandle | undefined => {
	if (typeof window === "undefined" || !options.ingestKey || readSessionSink()) return undefined
	if (current) return leaseCurrent()
	const handle = startMetadataSession({
		endpoint: options.endpoint,
		ingestKey: options.ingestKey,
		sdk: CLIENT_SDK_HINT,
		serviceName: options.serviceName,
		environment: options.environment,
		serviceVersion: options.serviceVersion,
		captureUserEmail: options.captureUserEmail,
		getIdentity: getCurrentIdentity,
		getTraceIds: (sessionId) => Array.from(observedBySession.get(sessionId) ?? []),
		// Fires after the outgoing session's `ended` row has already read its ids,
		// so the rotated-out entry is safe to drop here. Without this a tab left
		// open for a day keeps one id Set per 30-minute rotation, forever — the
		// same leak `sink.ts` prunes on the browser SDK's side.
		onSessionChange: (sessionId) => {
			for (const key of observedBySession.keys()) {
				if (key !== sessionId) observedBySession.delete(key)
			}
		},
	})
	if (!handle) return undefined
	current = { handle, references: 0 }
	return leaseCurrent()
}

/** Test-only: clear singleton state without emitting an ended row. */
export const resetStandaloneSessionForTests = (): void => {
	const active = current?.handle
	current = undefined
	void active?.shutdown({ flush: false })
	observedBySession.clear()
}
