import type { SessionEventSink } from "../events-sink"
import { startEventSink } from "../events-sink"
import { installConsoleCapture } from "./capture/console"
import { installNetworkCapture } from "./capture/network"
import type { ReplayEngineConfig } from "./transport"

// The buffer, seq counter and event shape live in `../events-sink`, which runs
// on every page load. This module is only the *replay-only* capture half — the
// listeners that are worth installing only for a session that gets a recording
// to attach them to — and it is loaded on the sampled replay path alongside
// rrweb.
//
// Deliberately no counters: page views and errors are tallied by the sink,
// which outlives capture and runs whether or not replay is sampled, so the
// lifecycles read them off `getActiveSink()` rather than through this handle.
export interface EventCapture {
	stop: () => void
	flush: (keepalive?: boolean) => Promise<void>
}

/**
 * Install the capture modules that turn console output and network requests
 * into distilled session events.
 *
 * Navigation, errors and interactions are deliberately absent: the sink
 * installs those itself (see `startBaselineCapture`), because page views, error
 * counts and click counts have to be counted even when replay is unsampled —
 * and a second listener here would double-count every one of them.
 */
export function startEventCapture(config: ReplayEngineConfig, sessionId: string): EventCapture {
	const sink: SessionEventSink = startEventSink(config, sessionId)
	const emit = sink.emit

	const uninstall = [installConsoleCapture(emit), installNetworkCapture(emit, sink.ignoreUrl)]

	return {
		// Only the capture listeners stop here — the sink outlives them, so
		// `track()` still works after the replay recorder shuts down.
		stop: () => {
			for (const off of uninstall) off()
		},
		flush: sink.flush,
	}
}
