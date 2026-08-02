import type { SessionEventSink } from "../events-sink"
import { startEventSink } from "../events-sink"
import { installConsoleCapture } from "./capture/console"
import { installErrorCapture } from "./capture/errors"
import { installInteractionCapture } from "./capture/interactions"
import { installNetworkCapture } from "./capture/network"
import type { ReplayEngineConfig } from "./transport"

// The buffer, seq counter and event shape live in `../events-sink`, which runs
// on every page load. This module is only the *capture* half — the listeners
// that turn browser activity into events — and it is loaded on the sampled
// replay path alongside rrweb.
//
// `SessionEvent` and `activeTraceId` are re-exported so the capture modules keep
// importing them from one place. Everything else about the sink is reached
// through `../events-sink` directly.
export type { SessionEvent } from "../events-sink"
export { activeTraceId, setActiveTraceIdProvider } from "../events-sink"

// Deliberately no counters: page views and errors are tallied by the sink,
// which outlives capture and runs whether or not replay is sampled, so the
// lifecycles read them off `getActiveSink()` rather than through this handle.
export interface EventCapture {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
}

/**
 * Install the capture modules that turn browser activity (console, network,
 * errors, interactions) into distilled session events.
 *
 * Navigation is deliberately absent: the sink observes it, because page views
 * have to be counted even when replay is unsampled, and a second history patch
 * here would double-count every SPA transition.
 */
export function startEventCapture(config: ReplayEngineConfig, sessionId: string): EventCapture {
	const sink: SessionEventSink = startEventSink(config, sessionId)
	const emit = sink.emit

	const uninstall = [
		installInteractionCapture(emit, config.maskAllText),
		installConsoleCapture(emit),
		installNetworkCapture(emit, sink.ignoreUrl),
		installErrorCapture(emit),
	]

	return {
		// Only the capture listeners stop here — the sink outlives them, so
		// `track()` still works after the replay recorder shuts down.
		stop: () => {
			for (const off of uninstall) off()
		},
		flush: sink.flush,
	}
}
