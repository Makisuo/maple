import { describe, expect, it } from "@effect/vitest"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import {
	agentSessionsFacetsQuery,
	agentSessionsListQuery,
	agentTracesListQuery,
} from "./agent-sessions"

const WINDOW = { orgId: "org_1", startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

describe("agentSessionsListQuery", () => {
	it("groups session-granularity spans by the key hash, org-scoped", () => {
		const { sql, tenantScope } = compileCH(agentSessionsListQuery({}), WINDOW)
		expect(tenantScope).toBe("org")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("AiSessionKeyState = 6")
		expect(sql).toContain("GROUP BY sessionKeyHash")
		expect(sql).toContain("FORMAT JSON")
	})

	// UInt64 above 2^53 corrupts as a JS number — the hash must ride the wire
	// as a string (the sql-catalog identity sweep enforces the same rule).
	it("toString-wraps the UInt64 key hash", () => {
		const { sql } = compileCH(agentSessionsListQuery({}), WINDOW)
		expect(sql).toContain("toString(AiSessionKeyHash) AS sessionKeyHash")
	})

	// The DSL's infix operators don't parenthesize, so a - b/n is one edit away.
	// Each aggregate must divide to ms BEFORE the subtraction, and Duration must
	// cast to Int64 (no UInt64/Int64 supertype to add the nano timestamp to).
	it("computes the span window with per-term division and an Int64 duration", () => {
		const { sql } = compileCH(agentSessionsListQuery({}), WINDOW)
		expect(sql).toContain(
			"max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) / 1000000 - min(toUnixTimestamp64Nano(Timestamp)) / 1000000 AS durationMs",
		)
	})

	// Vendor/service filters mean containment ("has at least one matching
	// span"). In WHERE they would silently drop the other vendors' spans from
	// the row's own vendors/counts — the multi-vendor case (CrewAI wrapping
	// openinference-openai) is the norm, not the edge.
	it("applies vendor containment in HAVING, not WHERE", () => {
		const { sql } = compileCH(
			agentSessionsListQuery({ vendors: ["crewai", "vercel_ai_sdk"] }),
			WINDOW,
		)
		const whereClause = sql.slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"))
		expect(whereClause).not.toContain("AiVendor")
		expect(sql).toContain(
			"HAVING (has(groupUniqArray(AiVendor), 'crewai') OR has(groupUniqArray(AiVendor), 'vercel_ai_sdk'))",
		)
	})

	it("filters errored sessions post-aggregation", () => {
		const { sql } = compileCH(agentSessionsListQuery({ hasErrors: true }), WINDOW)
		expect(sql).toContain("HAVING countIf(StatusCode = 'Error') > 0")
	})
})

describe("agentTracesListQuery", () => {
	it("groups every AI-classified span by trace at any key state", () => {
		const { sql, tenantScope } = compileCH(agentTracesListQuery({}), WINDOW)
		expect(tenantScope).toBe("org")
		expect(sql).toContain("GROUP BY traceId")
		const whereClause = sql.slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"))
		expect(whereClause).toContain("AiVendor != ''")
		// No key-state gate: unkeyed AI spans are exactly what this tab surfaces.
		expect(whereClause).not.toContain("AiSessionKeyState")
	})

	it("surfaces the session linkage: best state and ''-when-absent key hash", () => {
		const { sql } = compileCH(agentTracesListQuery({}), WINDOW)
		expect(sql).toContain("max(AiSessionKeyState) AS bestSessionKeyState")
		expect(sql).toContain(
			"if(maxIf(AiSessionKeyHash, AiSessionKeyState = 6) > 0, toString(maxIf(AiSessionKeyHash, AiSessionKeyState = 6)), '') AS sessionKeyHash",
		)
	})

	it("applies service containment in HAVING like the sessions list", () => {
		const { sql } = compileCH(agentTracesListQuery({ serviceNames: ["checkout"] }), WINDOW)
		expect(sql).toContain("HAVING has(groupUniqArray(ServiceName), 'checkout')")
	})
})

describe("agentSessionsFacetsQuery", () => {
	it("counts sessions on the sessions tab and traces on the traces tab", () => {
		const sessions = compileUnion(agentSessionsFacetsQuery({ tab: "sessions" }), WINDOW)
		expect(sessions.sql).toContain("toString(AiSessionKeyHash) AS groupKey")
		expect(sessions.sql).toContain("AiSessionKeyState = 6")
		const traces = compileUnion(agentSessionsFacetsQuery({ tab: "traces" }), WINDOW)
		expect(traces.sql).toContain("TraceId AS groupKey")
		expect(traces.sql).toContain("AiVendor != ''")
	})

	// Tenant scope must survive the fromQuery wrapping — the branches carry no
	// OrgId predicate of their own; it lives in the grouped subquery.
	it("stays org-scoped through the grouped subquery", () => {
		const { tenantScope } = compileUnion(agentSessionsFacetsQuery({ tab: "sessions" }), WINDOW)
		expect(tenantScope).toBe("org")
	})

	// A grouped row expands via arrayJoin, so a mixed-vendor session counts
	// once under each vendor it contains — matching the list's containment
	// filters by construction.
	it("expands the aggregated arrays with arrayJoin per branch", () => {
		const { sql } = compileUnion(agentSessionsFacetsQuery({ tab: "sessions" }), WINDOW)
		expect(sql).toContain("arrayJoin(vendors) AS name")
		expect(sql).toContain("arrayJoin(serviceNames) AS name")
	})

	it("excludes each dimension's own filter from its branch", () => {
		const { sql } = compileUnion(
			agentSessionsFacetsQuery({ tab: "sessions", vendors: ["crewai"], hasErrors: true }),
			WINDOW,
		)
		const [vendorBranch, serviceBranch, errorBranch] = sql.split("UNION ALL")
		expect(vendorBranch).not.toContain("has(vendors,")
		expect(vendorBranch).toContain("errorCount > 0")
		expect(serviceBranch).toContain("has(vendors, 'crewai')")
		expect(serviceBranch).toContain("errorCount > 0")
		// The error branch keeps the vendor filter but not its own toggle — the
		// count answers "how many WOULD match if you enabled it".
		expect(errorBranch).toContain("has(vendors, 'crewai')")
		expect(errorBranch).toContain("errorCount > 0")
	})

	it("drops empty facet values after the arrayJoin", () => {
		const { sql } = compileUnion(agentSessionsFacetsQuery({ tab: "sessions" }), WINDOW)
		expect(sql).toContain("HAVING name != ''")
	})
})
