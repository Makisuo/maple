import { describe, expect, it } from "@effect/vitest"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import {
	getSessionReplayQuery,
	sessionReplaysFacetsQuery,
	sessionReplaysListQuery,
	sessionReplayEventsQuery,
	sessionsForTraceQuery,
	sessionTraceSummariesQuery,
} from "./session-replays"

const baseParams = { orgId: "org_1" }
const sessionParams = { orgId: "org_1", sessionId: "sess_1" }
const WINDOW = { startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

// ---------------------------------------------------------------------------
// sessionTraceSummariesQuery
//
// One bar per correlated trace on the session replay timeline. The root span's
// kind + attributes ride along so the UI can render the canonical HTTP label
// (`POST /api/foo`) instead of the raw span name (e.g. `HTTP POST`).
// ---------------------------------------------------------------------------

describe("sessionTraceSummariesQuery", () => {
	it("projects the root span kind + attributes for HTTP label formatting", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["abc123"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("AS rootSpanName")
		expect(sql).toContain("anyIf(SpanKind, ParentSpanId = '') AS rootSpanKind")
		expect(sql).toContain("anyIf(toJSONString(SpanAttributes), ParentSpanId = '') AS rootSpanAttributes")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("FORMAT JSON")
	})

	it("scopes to org and the requested trace ids", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1", "t2"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("TraceId IN ('t1', 't2')")
	})

	// The table is PARTITION BY toDate(Timestamp); the session window prunes the
	// daily partitions an unbounded TraceId-IN scan would otherwise touch.
	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1"], ...WINDOW })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (deep-link path, unchanged full scan)", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})
})

describe("sessionReplayEventsQuery", () => {
	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const q = sessionReplayEventsQuery(WINDOW)
		const { sql } = compileCH(q, sessionParams)
		expect(sql).toContain("FROM session_replay_events")
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (full scan)", () => {
		const q = sessionReplayEventsQuery()
		const { sql } = compileCH(q, sessionParams)
		expect(sql).not.toContain("Timestamp >=")
	})
})

describe("sessionsForTraceQuery", () => {
	it("applies deterministic offset pagination while preserving org and time scoping", () => {
		const { sql } = compileCH(sessionsForTraceQuery({ traceId: "trace_1", limit: 21, offset: 20 }), {
			...baseParams,
			...WINDOW,
		})
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("StartTime >= '2026-06-24 04:00:00'")
		expect(sql).toContain("StartTime <= '2026-06-25 06:00:00'")
		expect(sql).toContain("ORDER BY startTime DESC, sessionId DESC")
		expect(sql).toContain("LIMIT 21")
		expect(sql).toContain("OFFSET 20")
	})
})

// ---------------------------------------------------------------------------
// UserId filter (exact match) — list + facets
//
// UserId is high-cardinality identity data, so it's an exact-match filter, not a
// facet branch. On the list it narrows to one user's sessions; on the facets it
// narrows every dimension's counts (no facet branch is excluded for it).
// ---------------------------------------------------------------------------

describe("sessionReplaysListQuery userId filter", () => {
	it("adds an exact UserId predicate when provided", () => {
		const q = sessionReplaysListQuery({ userId: "user_123" })
		const { sql } = compileCH(q, { ...baseParams, ...WINDOW })
		expect(sql).toContain("UserId = 'user_123'")
		expect(sql).not.toContain("UserId ILIKE")
	})

	it("omits the UserId predicate when absent", () => {
		const q = sessionReplaysListQuery({})
		const { sql } = compileCH(q, { ...baseParams, ...WINDOW })
		expect(sql).not.toContain("UserId =")
	})
})

describe("sessionReplaysFacetsQuery userId filter", () => {
	it("narrows every facet branch by the exact UserId", () => {
		const q = sessionReplaysFacetsQuery({ userId: "user_123" })
		const { sql } = compileUnion(q, { ...baseParams, ...WINDOW })
		// Branches: service / browser / country / device / error count — userId is
		// applied to all of them (never excluded, unlike each branch's own dimension).
		const occurrences = sql.split("UserId = 'user_123'").length - 1
		expect(occurrences).toBe(5)
	})

	it("omits the UserId predicate when absent", () => {
		const q = sessionReplaysFacetsQuery({})
		const { sql } = compileUnion(q, { ...baseParams, ...WINDOW })
		expect(sql).not.toContain("UserId =")
	})
})

describe("getSessionReplayQuery", () => {
	// session_replays is PARTITION BY toDate(StartTime); StartTime is version-
	// invariant so the window is safe alongside the ORDER BY Version DESC dedup.
	it("adds the session time window on StartTime when provided", () => {
		const q = getSessionReplayQuery(WINDOW)
		const { sql } = compileCH(q, sessionParams)
		expect(sql).toContain("StartTime >= '2026-06-24 04:00:00'")
		expect(sql).toContain("StartTime <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (full scan)", () => {
		const q = getSessionReplayQuery()
		const { sql } = compileCH(q, sessionParams)
		expect(sql).not.toContain("StartTime >=")
	})
})

// ---------------------------------------------------------------------------
// Session-time filters — duration (stored) + active time (session_events gaps)
//
// Guardrail: the default list and the duration-only filter must never touch
// session_events. Active-time filtering joins the per-session activity aggregate
// (the only path that scans the events table).
// ---------------------------------------------------------------------------

describe("sessionReplaysListQuery session-time filters", () => {
	it("keeps the fast path (no subquery, no session_events) when unfiltered", () => {
		const { sql } = compileCH(sessionReplaysListQuery({}), { ...baseParams, ...WINDOW })
		expect(sql).not.toContain("session_events")
		// No wrapping subquery: the FROM is the table directly.
		expect(sql).toContain("FROM session_replays")
		expect(sql).not.toContain("FROM (SELECT")
	})

	it("wraps in a subquery to filter on the aggregated duration, without session_events", () => {
		const { sql } = compileCH(sessionReplaysListQuery({ durationMinMs: 5000, durationMaxMs: 60000 }), {
			...baseParams,
			...WINDOW,
		})
		expect(sql).not.toContain("session_events")
		expect(sql).toContain("FROM (SELECT")
		expect(sql).toContain(") AS s")
		expect(sql).toContain("durationMs >= 5000")
		expect(sql).toContain("durationMs <= 60000")
	})

	it("LEFT JOINs the session_events activity aggregate to filter on active time", () => {
		const { sql } = compileCH(
			sessionReplaysListQuery({ activeTimeMinMs: 10000, activeTimeMaxMs: 60000 }),
			{ ...baseParams, ...WINDOW },
		)
		expect(sql).toContain("LEFT JOIN")
		expect(sql).toContain("FROM session_events")
		expect(sql).toContain("ON s.sessionId = a.sessionId")
		// Coalesce to 0 so the LEFT JOIN's NULL (sessions with no distilled events)
		// is treated as zero activity rather than silently dropped.
		expect(sql).toContain("coalesce(a.activeTimeMs, 0) >= 10000")
		expect(sql).toContain("coalesce(a.activeTimeMs, 0) <= 60000")
		// The activity aggregate scopes session_events to the same org + window.
		expect(sql).toContain("sumIf(gapMs, (gapMs > 0 AND gapMs <= 15000))")
	})

	it("keeps zero-activity (no-event) sessions under a max-only or zero bound", () => {
		// A LEFT-JOIN NULL must satisfy `<= max` and `>= 0`; coalesce(…, 0) makes
		// `0 <= max` / `0 >= 0` true so rrweb-only sessions aren't dropped. A
		// min > 0 still excludes them (0 < min), which is intended.
		const maxOnly = compileCH(sessionReplaysListQuery({ activeTimeMaxMs: 30000 }), {
			...baseParams,
			...WINDOW,
		}).sql
		expect(maxOnly).toContain("coalesce(a.activeTimeMs, 0) <= 30000")

		const zeroMin = compileCH(sessionReplaysListQuery({ activeTimeMinMs: 0 }), {
			...baseParams,
			...WINDOW,
		}).sql
		// An explicit 0 bound is still emitted (not skipped as a falsy value).
		expect(zeroMin).toContain("coalesce(a.activeTimeMs, 0) >= 0")
	})

	it("scopes the activity aggregate's session_events scan to the list window", () => {
		const { sql } = compileCH(sessionReplaysListQuery({ activeTimeMinMs: 1000 }), {
			...baseParams,
			...WINDOW,
		})
		// session_replays filters StartTime; session_events filters Timestamp — both
		// to the same bound, so the join's scan is partition-pruned identically.
		expect(sql).toContain("StartTime >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
	})
})

// ---------------------------------------------------------------------------
// Event refinement — INNER JOIN the distilled session_events match subquery
//
// Powers the search_sessions MCP tool's "by what happened inside" filtering.
// Only an event predicate triggers the join; metadata-only filters (including
// the web listReplays path) must never read session_events.
// ---------------------------------------------------------------------------

describe("sessionReplaysListQuery event refinement", () => {
	it("INNER JOINs the session_events match subquery and selects matchCount", () => {
		const { sql } = compileCH(sessionReplaysListQuery({ eventType: "network", eventMinStatus: 500 }), {
			...baseParams,
			...WINDOW,
		})
		expect(sql).toContain("INNER JOIN")
		expect(sql).toContain("FROM session_events")
		expect(sql).toContain("ON s.sessionId = e.sessionId")
		expect(sql).toContain("AS matchCount")
		// The event predicates land in the joined subquery.
		expect(sql).toContain("Type = 'network'")
		expect(sql).toContain("NetStatus >= 500")
	})

	it("keeps session-metadata filters on the base while the event predicate joins", () => {
		const { sql } = compileCH(sessionReplaysListQuery({ userId: "4632", eventType: "error" }), {
			...baseParams,
			...WINDOW,
		})
		// user filter stays on the session_replays base…
		expect(sql).toContain("UserId = '4632'")
		// …and the event predicate rides the joined session_events subquery.
		expect(sql).toContain("INNER JOIN")
		expect(sql).toContain("Type = 'error'")
	})

	it("chains the event INNER JOIN with the active-time LEFT JOIN", () => {
		const { sql } = compileCH(sessionReplaysListQuery({ eventType: "network", activeTimeMinMs: 1000 }), {
			...baseParams,
			...WINDOW,
		})
		expect(sql).toContain("INNER JOIN")
		expect(sql).toContain("LEFT JOIN")
		expect(sql).toContain("ON s.sessionId = e.sessionId")
		expect(sql).toContain("ON s.sessionId = a.sessionId")
		expect(sql).toContain("coalesce(a.activeTimeMs, 0) >= 1000")
	})

	it("never joins session_events for metadata-only filters (web listReplays path)", () => {
		const { sql } = compileCH(
			sessionReplaysListQuery({ userId: "4632", browser: "Chrome", hasErrors: true }),
			{ ...baseParams, ...WINDOW },
		)
		expect(sql).not.toContain("JOIN")
		expect(sql).not.toContain("session_events")
		expect(sql).not.toContain("matchCount")
	})
})
