import { installErrorCapture } from "./errors"
import { installInteractionCapture } from "./interactions"
import type { Emit } from "./shared"

/**
 * The capture that runs on **every** page load, sampled for replay or not.
 *
 * Errors and clicks are the analytics substrate, for the same reason navigation
 * is: `error_count` drives the Sessions UI "has errors" filter and `click_count`
 * separates a real visit from a bounce, so gating them behind replay sampling
 * makes both a sample rather than a count — and a session row that reports zero
 * errors because nothing was listening is worse than one that reports none,
 * because it looks complete.
 *
 * Console and network capture stay on the sampled replay path: they patch
 * `console.*`, `window.fetch` and `XMLHttpRequest`, which is a cost (and a
 * surface) worth paying only for sessions that get a recording to attach it to.
 *
 * Owned by the sink rather than by the replay lifecycle, which is also what
 * keeps the listeners installed exactly once — the recorder starting and
 * stopping across visibility changes must not re-register them.
 */
export function startBaselineCapture(emit: Emit, maskAllText: boolean): () => void {
	if (typeof window === "undefined" || typeof document === "undefined") return () => {}
	const uninstall = [installErrorCapture(emit), installInteractionCapture(emit, maskAllText)]
	return () => {
		for (const off of uninstall) off()
	}
}
