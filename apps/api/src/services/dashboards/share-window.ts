/**
 * Bounding the window a share viewer may ask for.
 *
 * A viewer chooses the time range — that is what makes a share live rather than
 * a snapshot — so the range is untrusted input on an unauthenticated path, and
 * every query the share issues is priced by it.
 *
 * Absolute timestamps only. The authenticated app accepts relative shorthand
 * ("12h", "today") and resolves it client-side; accepting both here would mean
 * two parsers on the public surface for no gain, since the share page resolves
 * its own picker before it asks.
 */
import { MAX_QUERY_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"

/**
 * Widest window a shared-dashboard viewer may request.
 *
 * Held at the general query ceiling rather than something tighter: a share is a
 * read-only view of a dashboard its author already curated, so narrowing it
 * further would make shared boards show less than the same board does signed
 * in, for no security gain — the cost ceiling is enforced by the per-shape caps
 * and the cost profile, not by this number.
 *
 * Named here rather than in `limits.ts` because a bare alias of another export
 * is indistinguishable from a duplicate: one value, one exported name, and the
 * policy documented where it is enforced.
 */
const SHARE_MAX_RANGE_SECONDS = MAX_QUERY_RANGE_SECONDS
import { ShareRangeInvalidError } from "@maple/domain/http"
import { Clock, Effect } from "effect"

/** `YYYY-MM-DD HH:MM:SS`, the warehouse datetime format. */
const WAREHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * Clocks drift, and a viewer's picker is set from their own. A few minutes of
 * slack keeps "now" from being rejected on a machine running slightly fast,
 * while still refusing a window pointed at next year.
 */
const FUTURE_SKEW_SECONDS = 5 * 60

const invalid = (message: string) => Effect.fail(new ShareRangeInvalidError({ message }))

const parse = (value: string): number => Date.parse(`${value}Z`)

export interface ShareWindow {
	readonly startTime: string
	readonly endTime: string
}

export const resolveShareWindow = Effect.fn("resolveShareWindow")(function* (requested: ShareWindow) {
	if (!WAREHOUSE_DATETIME.test(requested.startTime) || !WAREHOUSE_DATETIME.test(requested.endTime)) {
		return yield* invalid("Time range must be absolute timestamps as 'YYYY-MM-DD HH:MM:SS'.")
	}

	const start = parse(requested.startTime)
	const end = parse(requested.endTime)
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		return yield* invalid("Time range could not be parsed.")
	}
	if (start >= end) {
		return yield* invalid("Time range must start before it ends.")
	}

	const nowMs = yield* Clock.currentTimeMillis
	if (end > nowMs + FUTURE_SKEW_SECONDS * 1000) {
		return yield* invalid("Time range must not end in the future.")
	}

	const spanSeconds = (end - start) / 1000
	if (spanSeconds > SHARE_MAX_RANGE_SECONDS) {
		// Rejected, not clamped. A board-wide range is the viewer's explicit
		// choice, and silently serving them a different window than their picker
		// shows would misreport what they are looking at. The per-widget list cap
		// is the opposite case — there the widget, not the viewer, is the reason.
		return yield* invalid(
			`Time range exceeds the maximum of ${formatRangeSeconds(SHARE_MAX_RANGE_SECONDS)}.`,
		)
	}

	return requested satisfies ShareWindow
})
