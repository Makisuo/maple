import { describe, expect, test } from "bun:test"
import { formatElapsed, formatTurnTime } from "./turn-time.js"

const NOW = Date.UTC(2026, 7, 5, 14, 23, 11)
/** Slack `ts` for a moment `ms` before NOW. */
const tsBefore = (ms: number) => `${((NOW - ms) / 1000).toFixed(6)}`

describe("formatTurnTime", () => {
	test("states now in UTC and unix seconds", () => {
		const block = formatTurnTime({ ts: tsBefore(0), threadTs: tsBefore(0) }, NOW)
		expect(block).toContain("now: 2026-08-05T14:23:11Z (unix 1785939791)")
		expect(block.startsWith("<current_time>")).toBe(true)
		expect(block.endsWith("</current_time>")).toBe(true)
	})

	test("reports how long an older thread has been open", () => {
		const block = formatTurnTime(
			{ ts: tsBefore(0), threadTs: tsBefore(2 * 3_600_000 + 14 * 60_000) },
			NOW,
		)
		expect(block).toContain("thread_started: 2026-08-05T12:09:11Z — 2h 14m ago")
	})

	test("omits thread age for a mention that starts its own thread", () => {
		// eve sets threadTs to the message's own ts when the event is not in a thread.
		const ts = tsBefore(0)
		expect(formatTurnTime({ ts, threadTs: ts }, NOW)).not.toContain("thread_started")
	})

	test("omits thread age when the only gap is dispatch latency", () => {
		expect(formatTurnTime({ ts: tsBefore(0), threadTs: tsBefore(9_000) }, NOW)).not.toContain(
			"thread_started",
		)
	})

	test("survives a missing or unparseable threadTs", () => {
		expect(formatTurnTime({}, NOW)).toContain("now: 2026-08-05T14:23:11Z")
		expect(formatTurnTime({ threadTs: "not-a-ts" }, NOW)).not.toContain("thread_started")
	})

	test("moves with the clock — the whole point of being per turn", () => {
		const message = { ts: tsBefore(0), threadTs: tsBefore(3_600_000) }
		expect(formatTurnTime(message, NOW)).not.toBe(formatTurnTime(message, NOW + 600_000))
	})
})

describe("formatElapsed", () => {
	test("renders the two largest units, largest first", () => {
		expect(formatElapsed(45_000)).toBe("45s")
		expect(formatElapsed(45 * 60_000)).toBe("45m")
		expect(formatElapsed(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m")
		expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000 + 30 * 60_000)).toBe("3d 4h")
	})

	test("keeps a zero middle unit rather than skipping to the next one down", () => {
		expect(formatElapsed(2 * 86_400_000 + 30 * 60_000)).toBe("2d 0h")
	})
})
