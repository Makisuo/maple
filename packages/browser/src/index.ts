import { type IdentifyInput, setConsent, type TrackProps, track } from "@maple/browser-session"
import { captureException } from "./errors"
import { identify, init, type MapleBrowserHandle } from "./init"

export type { IdentifyInput, MapleIdentity, TrackProps, TraitValue } from "@maple/browser-session"
export type { MapleBrowserConfig } from "./config"
export type { CaptureExceptionOptions } from "./errors"
export type { MapleBrowserHandle } from "./init"

/**
 * Maple browser SDK. One call wires up OpenTelemetry tracing and rrweb session
 * replay, both tagged with a shared session id.
 *
 * @example
 * ```ts
 * import { MapleBrowser } from "@maple-dev/browser"
 *
 * MapleBrowser.init({
 *   ingestKey: "maple_pk_...",
 *   serviceName: "acme-web",
 * })
 *
 * MapleBrowser.identify({ id: user.id, email: user.email, groupId: org.id, groupName: org.name })
 * MapleBrowser.track("checkout_completed", { plan: "pro", seats: 5 })
 * ```
 */
export const MapleBrowser: {
	init: (config: import("./config").MapleBrowserConfig) => MapleBrowserHandle
	/**
	 * Attach, replace, or clear the end-user identity on the active session.
	 * Accepts a bare user id or the full identity object. Safe to call repeatedly.
	 */
	identify: (input?: IdentifyInput) => void
	/**
	 * Record a custom product event against the active session. Safe to call
	 * before `init` — events are queued (capped) and drained once the session
	 * starts.
	 */
	track: (name: string, props?: TrackProps) => void
	/**
	 * Report an error your app already caught — the case the global handlers
	 * cannot see, because catching it is what stops it reaching them. A
	 * framework error boundary is the canonical caller.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. `captureException` narrows it before it reaches a span.
	 */
	captureException: (error: unknown, options?: import("./errors").CaptureExceptionOptions) => void
	/** Grant or revoke consent when `privacy.requireConsent` is on. */
	setConsent: (granted: boolean) => void
} = { init, identify, track, captureException, setConsent } satisfies {
	init: (config: import("./config").MapleBrowserConfig) => MapleBrowserHandle
	/**
	 * Attach, replace, or clear the end-user identity on the active session.
	 * Accepts a bare user id or the full identity object. Safe to call repeatedly.
	 */
	identify: (input?: IdentifyInput) => void
	/**
	 * Record a custom product event against the active session. Safe to call
	 * before `init` — events are queued (capped) and drained once the session
	 * starts.
	 */
	track: (name: string, props?: TrackProps) => void
	/**
	 * Report an error your app already caught — the case the global handlers
	 * cannot see, because catching it is what stops it reaching them. A
	 * framework error boundary is the canonical caller.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. `captureException` narrows it before it reaches a span.
	 */
	captureException: (error: unknown, options?: import("./errors").CaptureExceptionOptions) => void
	/** Grant or revoke consent when `privacy.requireConsent` is on. */
	setConsent: (granted: boolean) => void
}
