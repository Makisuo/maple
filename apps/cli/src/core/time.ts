// Time-range resolution for the CLI commands. Emits ClickHouse-style
// `YYYY-MM-DD HH:mm:ss` UTC strings, matching what the query engine expects.

import { Clock, Effect, Option, Schema } from "effect"

export interface Range {
	readonly startTime: string
	readonly endTime: string
}

/** A bad `--since` / time-range input, surfaced to the user with a hint. */
export class TimeRangeError extends Schema.TaggedError<TimeRangeError>()("@maple/cli/TimeRangeError", {
	message: Schema.String,
}) {}

const pad = (n: number): string => String(n).padStart(2, "0")

const formatDateTimeUTC = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
	`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

const SINCE_RE = /^(\d+)(m|h|d)$/

/** Parse a relative window like `30m`, `6h`, `7d` to milliseconds. Returns
 *  `null` for anything that doesn't match — the caller turns that into an
 *  error rather than silently widening the window. */
const sinceToMs = (since: string): number | null => {
	const match = since.match(SINCE_RE)
	if (!match) return null
	const n = Number(match[1])
	switch (match[2]) {
		case "m":
			return n * 60 * 1000
		case "d":
			return n * 24 * 60 * 60 * 1000
		default:
			return n * 60 * 60 * 1000
	}
}

/**
 * Resolve a `{ since, start, end }` flag set to an absolute `Range`, failing
 * with a `TimeRangeError` when `--since` is malformed. Absolute `--start/--end`
 * (both present) win; otherwise the window is `now - since … now`, with either
 * bound overridable on its own.
 */
export const resolveRangeChecked = (a: {
	readonly since: string
	readonly start: Option.Option<string>
	readonly end: Option.Option<string>
}): Effect.Effect<Range, TimeRangeError> =>
	Effect.gen(function* () {
		const start = Option.getOrUndefined(a.start)
		const end = Option.getOrUndefined(a.end)
		if (start && end) return { startTime: start, endTime: end }

		const ms = sinceToMs(a.since)
		if (ms === null) {
			return yield* new TimeRangeError({
				message: `unrecognized --since "${a.since}" — use Nm, Nh, or Nd (e.g. 30m, 6h, 7d)`,
			})
		}
		const nowMs = yield* Clock.currentTimeMillis
		return {
			startTime: start ?? formatDateTimeUTC(new Date(nowMs - ms)),
			endTime: end ?? formatDateTimeUTC(new Date(nowMs)),
		}
	})
