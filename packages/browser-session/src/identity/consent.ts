/**
 * Consent gating for session capture.
 *
 * The posture, deliberately:
 *
 * - `requireConsent` defaults to **false**. Flipping that default would
 *   silently stop telemetry for every existing install — an availability
 *   incident dressed up as a privacy win. Apps that need a consent gate opt in.
 * - Global Privacy Control **is** honored by default, but only against the
 *   persistent visitor id, not the session itself. GPC is a legally recognized
 *   signal in several US states and it maps exactly onto the one cross-session
 *   identifier this SDK stores; the session-scoped capture that powers replay
 *   and error triage is unaffected.
 * - `doNotTrack` is **not** honored by default. It is deprecated, removed from
 *   Safari, and ignored across the industry, so respecting it would mostly mean
 *   dropping data from users who never intended to opt out. Apps can turn it on.
 */

import { configureVisitorCookie } from "./visitor"

export interface PrivacyOptions {
	/** Capture nothing until `setConsent(true)`. Default false. */
	readonly requireConsent?: boolean
	/** Store a persistent visitor id. Default true. */
	readonly persistVisitorId?: boolean
	/**
	 * Scope the visitor-id cookie to the registered domain so a marketing site
	 * and an app on sibling subdomains resolve to the same visitor. Default true.
	 * Set false to keep the cookie host-only.
	 */
	readonly crossSubdomainCookie?: boolean
	/**
	 * Explicit cookie `Domain=` (without the leading dot), e.g. `"example.com"`.
	 * Defaults to the broadest domain the browser accepts, discovered by probing.
	 * `""` forces a host-only cookie.
	 */
	readonly cookieDomain?: string
	/** Send `identify()`'s email through to the warehouse. Default true. */
	readonly captureUserEmail?: boolean
	/** Treat `navigator.doNotTrack` like GPC. Default false. */
	readonly respectDoNotTrack?: boolean
}

type ConsentListener = (allowed: boolean) => void

interface ConsentState {
	requireConsent: boolean
	granted: boolean
	respectDoNotTrack: boolean
	allowedSince: number
	readonly listeners: Set<ConsentListener>
}

/**
 * Consent lives on `globalThis`, for the same reason the event sink does
 * (`events/events-sink.ts`): an app that bundles both `@maple-dev/browser` and the
 * Effect SDK gets **two copies** of this module, and per-copy state would mean
 * `setConsent(true)` on one never releases the other copy's exporters — or, the
 * other way round, one copy capturing while the other believes consent is
 * required. There is one user and one decision, so there is one state.
 */
const CONSENT_KEY = "__MAPLE_BROWSER_CONSENT__"

function consentState(): ConsentState {
	const owner = globalThis as Record<string, unknown>
	const existing = owner[CONSENT_KEY] as ConsentState | undefined
	if (existing) return existing
	const fresh: ConsentState = {
		allowedSince: 0,
		granted: false,
		listeners: new Set(),
		requireConsent: false,
		respectDoNotTrack: false,
	}
	owner[CONSENT_KEY] = fresh
	return fresh
}

function updateEffectiveConsent(previous: boolean): void {
	const state = consentState()
	const allowed = hasConsent()
	if (allowed === previous) return
	state.allowedSince = allowed ? Date.now() : Number.POSITIVE_INFINITY
	for (const listener of state.listeners) {
		try {
			listener(allowed)
		} catch {
			// Telemetry controls must never throw into the host application or
			// prevent the remaining capture owners from observing the transition.
		}
	}
}

/**
 * Apply the host app's privacy config. Call before anything captures.
 *
 * Both SDKs call this at startup, and an app can init one of them without a
 * `privacy` block — so the gates only ever **tighten**. Letting the second
 * caller's absent option reset `requireConsent` back to false would silently
 * disable a gate the first caller asked for, and the resulting
 * denied→allowed transition would start capture on a user who never consented.
 * To genuinely relax a gate, reload without it.
 */
export function configurePrivacy(options: PrivacyOptions | undefined): void {
	const state = consentState()
	const previous = hasConsent()
	state.requireConsent = state.requireConsent || (options?.requireConsent ?? false)
	state.respectDoNotTrack = state.respectDoNotTrack || (options?.respectDoNotTrack ?? false)
	configureVisitorCookie({
		crossSubdomainCookie: options?.crossSubdomainCookie,
		cookieDomain: options?.cookieDomain,
	})
	updateEffectiveConsent(previous)
}

/** Record the user's consent decision. No-op unless `requireConsent` is set. */
export function setConsent(nextGranted: boolean): void {
	const previous = hasConsent()
	consentState().granted = nextGranted
	updateEffectiveConsent(previous)
}

/** Whether capture may proceed at all. */
export function hasConsent(): boolean {
	const state = consentState()
	return !state.requireConsent || state.granted
}

/**
 * Subscribe to effective capture permission changes. The listener is invoked
 * only when capture actually transitions between allowed and denied; changing
 * the stored decision while `requireConsent` is off is deliberately silent.
 */
export function onConsentChange(listener: ConsentListener): () => void {
	const { listeners } = consentState()
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Earliest epoch-ms timestamp telemetry may export for the current grant.
 * `Infinity` means capture is denied. Exporters use this to discard anything
 * buffered before a late grant or across a revoke/re-grant cycle.
 */
export function consentAllowedSince(): number {
	return hasConsent() ? consentState().allowedSince : Number.POSITIVE_INFINITY
}

/**
 * Whether a *persistent* identifier may be stored. Separate from `hasConsent`
 * because GPC/DNT suppress the cross-session id without suppressing capture.
 */
export function mayPersistIdentifier(): boolean {
	if (!hasConsent()) return false
	if (typeof navigator === "undefined") return true
	const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
	if (nav.globalPrivacyControl === true) return false
	if (consentState().respectDoNotTrack && nav.doNotTrack === "1") return false
	return true
}

/** Test seam. */
export function resetConsentForTests(): void {
	const state = consentState()
	state.requireConsent = false
	state.granted = false
	state.respectDoNotTrack = false
	state.allowedSince = 0
	state.listeners.clear()
}
