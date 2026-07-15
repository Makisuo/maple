import { describe, expect, it } from "vitest"
import { buildSuite, type SuiteInputs, type SuiteParams } from "./suite"

const inputs: SuiteInputs = {
	traceId: "trace_abc123",
	serviceName: "maple-api",
	searchTerm: "user login failed",
	attrKey: "http.request.method",
	attrValue: "GET",
	attrScope: "span",
}

const params: SuiteParams = {
	orgId: "org_test",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("buildSuite", () => {
	const cases = buildSuite(inputs)

	it("every case compiles to non-empty SQL scoped to the org", () => {
		for (const c of cases) {
			const sql = c.compile(params)
			expect(sql.length, `${c.name} produced empty SQL`).toBeGreaterThan(0)
			// Every query must be OrgId-scoped (the warehouse executor enforces this).
			expect(sql, `${c.name} missing OrgId scope`).toContain("OrgId = 'org_test'")
		}
	})

	it("has unique case names", () => {
		const names = cases.map((c) => c.name)
		expect(new Set(names).size).toBe(names.length)
	})

	it("the body-search case exercises the token index and the ILIKE tail", () => {
		const sql = cases.find((c) => c.name === "logs_body_search")!.compile(params)
		// "user login failed" → only the interior token "login" is index-safe.
		expect(sql).toContain("hasToken(lower(Body), 'login')")
		expect(sql).toContain("Body ILIKE '%user login failed%'")
	})

	it("the attribute-equality case exercises the items index", () => {
		const sql = cases.find((c) => c.name === "traces_list_attr_equals")!.compile(params)
		expect(sql).toContain("has(arrayMap((k, v) -> concat(k, '=', v), mapKeys(SpanAttributes)")
		expect(sql).toContain("'http.request.method=GET'")
	})

	it("the point-lookup case reads the trace-detail projection", () => {
		const sql = cases.find((c) => c.name === "trace_point_lookup")!.compile(params)
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId = 'trace_abc123'")
	})
})
