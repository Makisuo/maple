import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	productEventsFunnelQuery,
	productEventsFunnelBreakdownQuery,
	productEventNamesQuery,
	ProductEventsFunnelError,
	type FunnelStep,
} from "./product-events"

const params = { orgId: "org_1", startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

const STEPS: ReadonlyArray<FunnelStep> = [
	{ kind: "page", pagePath: "/pricing", host: "maple.dev" },
	{ kind: "event", eventName: "signup_completed" },
	{ kind: "event", eventName: "plan_started", attributeEquals: { plan: "startup" } },
]
const REFERRAL: FunnelStep = { kind: "session", dimension: "referrerHost", value: "news.ycombinator.com" }

const oneLine = (sql: string): string => sql.replace(/\s+/g, " ")

// productEventsFunnelQuery
//
// One `windowFunnel` per person over the rows matching any step, then
// `countIf(level >= n)` per step, unpacked to `{ step, count }` rows.

describe("productEventsFunnelQuery", () => {
	it("scopes every table it reads to the org and derives an org-scoped result", () => {
		const compiled = compileCH(
			productEventsFunnelQuery({ steps: [REFERRAL, ...STEPS], keyBy: "person", windowSeconds: 86_400 }),
			params,
		)
		expect(compiled.tenantScope).toBe("org")
		// product_events, session_replays (session step) and identity_links (person key).
		expect(compiled.sql).toContain("FROM product_events AS e")
		expect(compiled.sql).toContain("FROM session_replays AS s")
		expect(compiled.sql).toContain("FROM identity_links")
		expect(compiled.sql.match(/OrgId = 'org_1'/g)?.length).toBeGreaterThanOrEqual(4)
	})

	it("emits one windowFunnel condition per step and one output row per step", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 3_600 }),
			params,
		)
		// The window is passed in the timestamp's unit — epoch milliseconds — since
		// windowFunnel does not accept DateTime64.
		expect(sql).toContain("windowFunnel(3600000)(ts, s1 = 1, s2 = 1, s3 = 1) AS level")
		expect(sql).toContain("toUInt64(toUnixTimestamp64Milli(Timestamp)) AS ts")
		expect(sql).toContain("[countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts")
		expect(sql).toContain("arrayJoin([1, 2, 3]) AS step")
		expect(sql).toContain("arrayElement(counts, step) AS count")
		expect(sql).toContain("ORDER BY step ASC")
	})

	it("projects each step as a flag and only reads rows matching some step", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 3_600 }),
			params,
		)
		expect(sql).toContain(
			"toUInt8(((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev')) AS s1",
		)
		expect(sql).toContain("toUInt8(EventName = 'signup_completed') AS s2")
		expect(sql).toContain(
			"toUInt8((EventName = 'plan_started' AND Attributes['plan'] = 'startup')) AS s3",
		)
		expect(oneLine(sql)).toContain(
			"AND ((((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev') OR EventName = 'signup_completed') OR (EventName = 'plan_started' AND Attributes['plan'] = 'startup'))",
		)
	})

	it("keys by the raw column for visitor / user / session and drops empty keys", () => {
		const visitor = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 60 }),
			params,
		).sql
		expect(visitor).toContain("VisitorId AS key")
		expect(visitor).toContain("AND VisitorId != ''")
		expect(visitor).not.toContain("identity_links")

		const user = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "user", windowSeconds: 60 }),
			params,
		).sql
		expect(user).toContain("UserId AS key")
		expect(user).toContain("AND UserId != ''")

		const session = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "session", windowSeconds: 60 }),
			params,
		).sql
		expect(session).toContain("SessionId AS key")
		expect(session).toContain("AND SessionId != ''")
	})

	it("stitches the person key through identity_links aggregated per visitor", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 60 }),
			params,
		)
		expect(oneLine(sql)).toContain(
			"LEFT JOIN (SELECT VisitorId AS VisitorId, argMin(UserId, FirstSeen) AS UserId FROM identity_links WHERE OrgId = 'org_1' GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId",
		)
		expect(sql).toContain(
			"multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key",
		)
	})

	it("turns a session step 1 into a UNION ALL branch of session_replays entries", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({
				steps: [REFERRAL, ...STEPS],
				keyBy: "visitor",
				windowSeconds: 86_400,
			}),
			params,
		)
		expect(sql).toContain("UNION ALL")
		// The session branch: s1 = 1, every other step 0, at the session's StartTime.
		expect(oneLine(sql)).toContain(
			"SELECT VisitorId AS key, toUInt64(toUnixTimestamp64Milli(StartTime)) AS ts, 1 AS s1, 0 AS s2, 0 AS s3, 0 AS s4 FROM session_replays AS s",
		)
		expect(sql).toContain("AND ReferrerHost = 'news.ycombinator.com'")
		// The events branch never satisfies the session step.
		expect(oneLine(sql)).toContain(
			"SELECT VisitorId AS key, toUInt64(toUnixTimestamp64Milli(Timestamp)) AS ts, 0 AS s1,",
		)
		expect(sql).toContain("windowFunnel(86400000)(ts, s1 = 1, s2 = 1, s3 = 1, s4 = 1) AS level")
	})

	it("has no session_replays branch without a session step", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "visitor", windowSeconds: 60 }),
			params,
		)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).not.toContain("session_replays")
	})

	it("narrows the population by person, not by session, when filters are set", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({
				steps: STEPS,
				keyBy: "person",
				windowSeconds: 60,
				filters: { country: "DE", pagePath: "/" },
			}),
			params,
		)
		const flat = oneLine(sql)
		// The persons subquery resolves the key the same way as the events do…
		expect(flat).toContain(
			"IN (SELECT multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key FROM session_replays AS s LEFT JOIN",
		)
		// …applies the replays dimension directly…
		expect(flat).toContain("AND s.Country = 'DE'")
		// …and the page filter through the navigation semi-join on product_events.
		expect(flat).toContain(
			"AND s.SessionId IN (SELECT SessionId AS sessionId FROM product_events WHERE OrgId = 'org_1'",
		)
		expect(flat).toContain("AND Kind = 'navigation' AND PagePath = '/' GROUP BY sessionId)")
	})

	it("omits the population subquery when no filter is set", () => {
		const { sql } = compileCH(
			productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 60 }),
			params,
		)
		expect(sql).not.toContain(" IN (SELECT")
	})

	it("rejects funnels it cannot compile", () => {
		expect(() => productEventsFunnelQuery({ steps: [], keyBy: "person", windowSeconds: 60 })).toThrow(
			ProductEventsFunnelError,
		)
		expect(() =>
			productEventsFunnelQuery({ steps: [STEPS[0]!, REFERRAL], keyBy: "person", windowSeconds: 60 }),
		).toThrow(/only valid as step 1/)
		expect(() => productEventsFunnelQuery({ steps: STEPS, keyBy: "person", windowSeconds: 0 })).toThrow(
			/windowSeconds/,
		)
		expect(() =>
			productEventsFunnelQuery({
				steps: Array.from({ length: 11 }, () => STEPS[1]!),
				keyBy: "person",
				windowSeconds: 60,
			}),
		).toThrow(/at most 10 steps/)
	})
})

// productEventsFunnelBreakdownQuery

describe("productEventsFunnelBreakdownQuery", () => {
	it("groups persons by the first non-empty dimension value and keeps the top N by step-1 count", () => {
		const compiled = compileCH(
			productEventsFunnelBreakdownQuery({
				steps: STEPS,
				keyBy: "visitor",
				windowSeconds: 3_600,
				breakdownBy: "attribute:plan",
				limit: 5,
			}),
			params,
		)
		expect(compiled.tenantScope).toBe("org")
		const flat = oneLine(compiled.sql)
		expect(flat).toContain("Attributes['plan'] AS dim")
		expect(flat).toContain("argMinIf(dim, ts, dim != '') AS group")
		expect(flat).toContain("countIf(level >= 1) AS entered")
		expect(flat).toContain("GROUP BY group ORDER BY entered DESC, group ASC LIMIT 5")
		expect(flat).toContain(
			"SELECT group AS group, arrayJoin([1, 2, 3]) AS step, arrayElement(counts, step) AS count",
		)
		expect(flat).toContain("ORDER BY group ASC, step ASC")
	})

	it("reads a session dimension through a per-session join on session_replays", () => {
		const { sql } = compileCH(
			productEventsFunnelBreakdownQuery({
				steps: STEPS,
				keyBy: "visitor",
				windowSeconds: 3_600,
				breakdownBy: "utmSource",
			}),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toContain("coalesce(sd.Value, '') AS dim")
		expect(flat).toContain(
			"LEFT JOIN (SELECT SessionId AS SessionId, max(UtmSource) AS Value FROM session_replays WHERE OrgId = 'org_1'",
		)
		expect(flat).toContain("AS sd ON e.SessionId = sd.SessionId")
		expect(flat).toContain("LIMIT 10")
	})

	it("reads the dimension straight off the session row on the session-step branch", () => {
		const { sql } = compileCH(
			productEventsFunnelBreakdownQuery({
				steps: [REFERRAL, ...STEPS],
				keyBy: "visitor",
				windowSeconds: 3_600,
				breakdownBy: "country",
			}),
			params,
		)
		expect(oneLine(sql)).toContain("0 AS s4, Country AS dim FROM session_replays AS s")
	})

	it("uses the event Host without a join", () => {
		const { sql } = compileCH(
			productEventsFunnelBreakdownQuery({
				steps: STEPS,
				keyBy: "visitor",
				windowSeconds: 60,
				breakdownBy: "host",
			}),
			params,
		)
		expect(sql).toContain("Host AS dim")
		expect(sql).not.toContain("session_replays")
	})

	it("bounds the group limit", () => {
		expect(() =>
			productEventsFunnelBreakdownQuery({
				steps: STEPS,
				keyBy: "visitor",
				windowSeconds: 60,
				breakdownBy: "host",
				limit: 21,
			}),
		).toThrow(/1\.\.20/)
	})
})

// productEventNamesQuery

describe("productEventNamesQuery", () => {
	it("lists names with counts, sessions and persons, most frequent first", () => {
		const compiled = compileCH(productEventNamesQuery({ limit: 25 }), params)
		expect(compiled.tenantScope).toBe("org")
		const flat = oneLine(compiled.sql)
		expect(flat).toContain(
			"SELECT EventName AS eventName, Kind AS kind, count() AS count, uniqIf(SessionId, SessionId != '') AS sessions, uniq(if(UserId != '', UserId, VisitorId)) AS persons FROM product_events",
		)
		expect(flat).toContain("WHERE OrgId = 'org_1'")
		expect(flat).toContain("GROUP BY eventName, kind ORDER BY count DESC, eventName ASC LIMIT 25")
		expect(flat).not.toContain("session_replays")
	})

	it("applies host directly and other filters through the session semi-join", () => {
		const { sql } = compileCH(
			productEventNamesQuery({
				filters: { host: "maple.dev", referrerHost: "t.co", pagePath: "/pricing" },
			}),
			params,
		)
		const flat = oneLine(sql)
		expect(flat).toContain(
			"AND Host = 'maple.dev' AND SessionId IN (SELECT SessionId AS sessionId FROM session_replays",
		)
		expect(flat).toContain("AND ReferrerHost = 't.co'")
		// pagePath narrows sessions through the navigation semi-join, not the events.
		expect(flat).toContain("AND Kind = 'navigation' AND PagePath = '/pricing' GROUP BY sessionId)")
	})
})
