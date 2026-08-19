import { getActiveSink } from "../events/events-sink"
import { postSessionMetaRow } from "../events/meta-row"
import { type SessionLifecycleHandle, type SessionLifecycleOptions, startSessionLifecycle } from "./lifecycle"

export interface MetadataSessionOptions extends SessionLifecycleOptions {
	readonly endpoint: string
	readonly ingestKey: string
	/** `x-maple-sdk` value — `sdkHint(name, version)`. */
	readonly sdk: string
	/** Called after idle rotation installs the next session. */
	readonly onSessionChange?: ((sessionId: string) => void) | undefined
}

export type MetadataSessionHandle = SessionLifecycleHandle

/**
 * Metadata-only session lifecycle used whenever rrweb is disabled or unsampled.
 * It is the shared lifecycle driver with no capture of its own: the distilled
 * event sink runs on every page load regardless, so this owner only has to post
 * rows and flush that sink on the way out.
 */
export function startMetadataSession(options: MetadataSessionOptions): MetadataSessionHandle | undefined {
	return startSessionLifecycle(options, {
		recorded: false,
		post: (row, keepalive) => {
			void postSessionMetaRow(options, row, keepalive)
		},
		onSuspend: ({ flush, keepalive }) => {
			// Only on the way out: a rotation drains the outgoing sink itself, and a
			// revoke must discard rather than send.
			if (flush && keepalive) void getActiveSink()?.flush(true)
		},
		onSessionChange: options.onSessionChange,
	})
}
