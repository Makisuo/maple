/**
 * The wall-clock time of the turn, as model-visible context.
 *
 * Nothing else in the prompt carries one. eve injects no date, the static
 * instructions are compiled at build time, and `#instructions/maple-app-url.js`
 * resolves on `session.started` — which for Slack is the *first* mention in a
 * thread, since eve keys sessions `channelId:threadTs`. So the only temporal
 * signal the model ever had was the `message_ts` values in the thread
 * transcript, and it read the oldest of those as "about now". Ask for a chart
 * or an investigation an hour into an alert thread and the window came back
 * anchored to when the alert fired, not to now.
 *
 * Hence per *turn*, not per session, and as channel `context` (a user-role
 * message appended for this turn) rather than a dynamic instruction on
 * `turn.started`. Instructions lower into the system prompt: a value that
 * changes every turn would invalidate the prompt cache at its very first token
 * and re-ingest the whole conversation each time. Appended context leaves the
 * cached prefix intact.
 *
 * Turns accumulate, so a long thread carries several of these blocks. The last
 * one is now — `agent/instructions.md` says so explicitly under "Time", because
 * a model that picks the first one is exactly the bug this fixes.
 */

/** Slack `ts` values are `"<unix seconds>.<counter>"`. */
function parseSlackTs(ts: string | undefined): number | undefined {
	if (!ts) return undefined
	const seconds = Number.parseFloat(ts)
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/** UTC ISO-8601 to the second — no millis, which say nothing here. */
function formatIsoSeconds(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

/**
 * A span as "3d 4h" / "2h 14m" / "45m" / "30s": two units, largest first, which
 * is all the precision a "how stale is this thread?" judgment needs.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000))
	if (totalSeconds < 60) return `${totalSeconds}s`
	const units: readonly (readonly [string, number])[] = [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
	]
	const parts: string[] = []
	let remaining = totalSeconds
	for (const [suffix, size] of units) {
		const value = Math.floor(remaining / size)
		remaining -= value * size
		if (value > 0 || parts.length > 0) parts.push(`${value}${suffix}`)
		if (parts.length === 2) break
	}
	return parts.join(" ")
}

/**
 * Renders the `<current_time>` block for one turn: now, plus how long the
 * thread has been running when that is not the same thing.
 *
 * `threadTs` is the thread root's timestamp (eve sets it to the message's own
 * `ts` for a non-thread event, which is why an unthreaded mention renders no
 * age line — there is no elapsed time to report).
 */
export function formatTurnTime(
	message: { readonly ts?: string; readonly threadTs?: string },
	nowMs: number = Date.now(),
): string {
	const lines = [`now: ${formatIsoSeconds(nowMs)} (unix ${Math.floor(nowMs / 1000)})`]

	const threadStartedMs = parseSlackTs(message.threadTs)
	// A minute of slack (the dispatch delay itself) is not thread age.
	if (threadStartedMs !== undefined && nowMs - threadStartedMs >= 60_000) {
		lines.push(
			`thread_started: ${formatIsoSeconds(threadStartedMs)} — ${formatElapsed(nowMs - threadStartedMs)} ago`,
		)
	}

	return ["<current_time>", ...lines, "</current_time>"].join("\n")
}
