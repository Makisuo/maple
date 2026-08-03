export type { FlushableTelemetry, MapleClientFlushableConfig } from "./flushable.js"
export * as MapleFlush from "./flushable.js"
export type { MapleClientConfig } from "./layer.js"
export * as Maple from "./layer.js"
export type { ClientReplayConfig } from "./replay-loader.js"
export type { IdentifyInput, MapleIdentity, PrivacyOptions, TrackProps } from "./track.js"
// Identity, custom events, and consent, so this SDK and `@maple-dev/browser`
// expose the identical surface.
export { setConsent, track } from "./track.js"
export { clearIdentity, identify } from "./user.js"
