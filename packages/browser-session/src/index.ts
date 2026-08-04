export type { PrivacyOptions } from "./consent"
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
} from "./consent"
export type { SessionEvent, SessionEventSink } from "./events-sink"
export { clearPendingEvents, getActiveSink, setActiveTraceIdProvider, startEventSink } from "./events-sink"
export type { IdentifyInput, MapleIdentity, ResolvedIdentity, TraitValue } from "./identity"
export { normalizeIdentity } from "./identity"
export type { SessionMetaRowInput } from "./meta-row"
export { formatCHDateTime, postSessionMetaRow } from "./meta-row"
export type { MetadataSessionHandle, MetadataSessionOptions } from "./metadata-session"
export { startMetadataSession } from "./metadata-session"
// The session record's mutators (counts, navigation, rotation listeners) stay
// package-internal: `startSessionLifecycle` owns those invariants, and an SDK
// reaching past it would write counts the lifecycle then overwrites.
export type { SessionRecord } from "./session"
export { getSession, getSessionId, rotateSession } from "./session"
export type { MapleBrowserSessionSink } from "./sink"
export { clearSessionSink } from "./sink"
export { getObservedTraceIds, publishSessionSink, readSessionSink, recordTraceId } from "./sink"
export type { TrackProps } from "./track"
export { track } from "./track"
export { parseUserAgent } from "./user-agent"
export { getVisitorId, isVisitorIdPersisted, setVisitorTracking } from "./visitor"
