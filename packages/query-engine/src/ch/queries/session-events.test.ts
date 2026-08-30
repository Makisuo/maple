import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { sessionActivityQuery, IDLE_GAP_THRESHOLD_MS } from "./session-events"

const sessionParams = { orgId: "org_1", sessionId: "sess_1" }
const WINDOW = { startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

// sessionActivityQuery
//
// Active/idle time from gaps between distilled events: a lagInFrame window
// measures each event's gap to its predecessor, then sumIf splits the gaps at
// the idle threshold. One row per session.

describe("sessionActivityQuery", () => {
	it("computes per-event gaps with a lagInFrame window ordered by Timestamp, Seq", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain("FROM session_events")
		expect(sql).toContain(
			"lagInFrame(Timestamp, 1, Timestamp) OVER (PARTITION BY SessionId ORDER BY Timestamp ASC, Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)",
		)
		// Nanosecond subtraction → milliseconds.
		expect(sql).toContain("toUnixTimestamp64Nano(Timestamp)")
		expect(sql).toContain("/ 1000000 AS gapMs")
	})

	it("splits gaps into active / idle at the idle threshold", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain(
			`sumIf(gapMs, (gapMs > 0 AND gapMs <= ${IDLE_GAP_THRESHOLD_MS})) AS activeTimeMs`,
		)
		expect(sql).toContain(`sumIf(gapMs, gapMs > ${IDLE_GAP_THRESHOLD_MS}) AS idleTimeMs`)
		expect(sql).toContain("GROUP BY sessionId")
	})

	it("scopes to the org + session and returns a single row", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("SessionId = 'sess_1'")
		expect(sql).toContain("LIMIT 1")
		expect(sql).toContain("FORMAT JSON")
	})

	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(WINDOW), sessionParams)
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (deep-link path, full scan)", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})
})
