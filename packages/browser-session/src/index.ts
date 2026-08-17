export type { PrivacyOptions } from "./identity/consent"
export {
	configurePrivacy,
	consentAllowedSince,
	hasConsent,
	mayPersistIdentifier,
	onConsentChange,
	// Consent state is page-global and `configurePrivacy` only ever tightens, so
	// a suite that turns the gate on needs the seam to turn it back off.
	resetConsentForTests,
	setConsent,
} from "./identity/consent"
export type { SessionEvent, SessionEventSink } from "./events/events-sink"
export {
	clearPendingEvents,
	getActiveSink,
	setActiveTraceIdProvider,
	startEventSink,
} from "./events/events-sink"
export type { IdentifyInput, MapleIdentity, ResolvedIdentity, TraitValue } from "./identity/identity"
export { normalizeIdentity } from "./identity/identity"
export type { SessionMetaRowInput } from "./events/meta-row"
export { formatCHDateTime, postSessionMetaRow } from "./events/meta-row"
export type { MetadataSessionHandle, MetadataSessionOptions } from "./session/metadata-session"
export { startMetadataSession } from "./session/metadata-session"
// The session record's mutators (counts, navigation, rotation listeners) stay
// package-internal: `startSessionLifecycle` owns those invariants, and an SDK
// reaching past it would write counts the lifecycle then overwrites.
export type { SessionRecord } from "./session/session"
export { getSession, getSessionId, rotateSession } from "./session/session"
export type { MapleBrowserSessionSink } from "./session/sink"
export { clearSessionSink } from "./session/sink"
export { getObservedTraceIds, publishSessionSink, readSessionSink, recordTraceId } from "./session/sink"
export type { TrackProps } from "./events/track"
export { track } from "./events/track"
export { parseUserAgent } from "./platform/user-agent"
export { getVisitorId, isVisitorIdPersisted, setVisitorTracking } from "./identity/visitor"
