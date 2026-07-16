import { identify, init, type MapleBrowserHandle } from "./init"

export type { MapleBrowserConfig } from "./config"
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
 * ```
 */
export const MapleBrowser: {
	init: (config: import("./config").MapleBrowserConfig) => MapleBrowserHandle
	/** Attach, replace, or clear the user id on the active session. Safe to call repeatedly. */
	identify: (userId?: string | null) => void
} = { init, identify }
