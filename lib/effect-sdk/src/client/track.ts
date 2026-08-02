// Thin wrappers over the shared capture engine.
//
// These are locally-declared re-exports rather than `export … from
// "@maple/browser-session"`: that package is private and bundled from source,
// and the dts bundler cannot emit a declaration for a bare re-export of it.
import {
	type IdentifyInput as EngineIdentifyInput,
	type MapleIdentity as EngineMapleIdentity,
	type PrivacyOptions as EnginePrivacyOptions,
	type TrackProps as EngineTrackProps,
	setConsent as setConsentEngine,
	track as trackEngine,
} from "@maple/browser-session"

export type MapleIdentity = EngineMapleIdentity
export type IdentifyInput = EngineIdentifyInput
export type TrackProps = EngineTrackProps
export type PrivacyOptions = EnginePrivacyOptions

/**
 * Record a custom product event against the active session.
 *
 * It lands as a `session_events` row with `Type='custom'`, so it shows up
 * inline in the session transcript next to the clicks and requests around it,
 * rather than in a separate analytics silo.
 *
 * Safe to call before the SDK finishes initializing — events are queued (capped
 * at 100 / 64 KB) and drained once the session starts. Never throws.
 *
 * @example
 * ```typescript
 * import { track } from "@maple-dev/effect-sdk/client"
 * track("checkout_completed", { plan: "pro", seats: 5 })
 * ```
 */
export const track = (name: string, props?: TrackProps): void => {
	trackEngine(name, props)
}

/**
 * Grant or revoke consent. Only meaningful when `privacy.requireConsent` is on;
 * until it is granted, nothing is captured and no visitor id is minted.
 */
export const setConsent = (granted: boolean): void => {
	setConsentEngine(granted)
}
