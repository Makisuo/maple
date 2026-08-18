import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "./fake-warehouse"
import { makeEvalRuntime, runToolDirect, type EvalRuntime } from "./eval-runtime"
import {
	LARGE_TRACE_SPAN_COUNT,
	makeLargeTraceSpans,
	makeSmallTraceSpans,
	makeSpanDetailRows,
	makeTraceLogs,
	MISSING_SPAN_ID,
	SMALL_TRACE_ID,
	SPAN_DETAIL_SPAN_ID,
	SPAN_DETAIL_TRACE_ID,
} from "./fixtures"
import { FIXTURES } from "./utils"

// Deterministic full-execution regression guards for the Part-1 work. These run
// the REAL tool handlers + renderer against a fake warehouse (no LLM — tool
// SELECTION is covered by the prediction evals; here we lock in the rendered
// OUTPUT). They run in the normal `test` suite, so they're always-on and need no
// API key. Fixtures route by the trace/span id literal baked into the compiled
// SQL (see fake-warehouse.ts), so one rule set serves every scenario.

// Order matters — first match wins. Specific ids before the table fallbacks.
const regressionFixtures: FixtureRule[] = [
	// inspect_span not-found: point lookup whose span id has no row.
	{ match: (sql) => sql.includes(MISSING_SPAN_ID), rows: [] },
	// inspect_span found: point lookup returns one fully-attributed row.
	{ match: (sql) => sql.includes(SPAN_DETAIL_SPAN_ID), rows: makeSpanDetailRows() },
	// Small trace (≤ overview budget) → renders in full.
	{
		match: (sql) => sql.includes(SMALL_TRACE_ID) && sql.includes("trace_detail_spans"),
		rows: makeSmallTraceSpans(),
	},
	// Large trace (> budget) → bounded overview. Fallback for any other span tree.
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: makeLargeTraceSpans() },
	{ match: (sql) => /\bfrom\s+logs\b/i.test(sql), rows: makeTraceLogs() },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderedText = (toolResult: any): string => {
	const content = toolResult?.content
	if (!Array.isArray(content)) return ""
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return content.map((c: any) => c?.text ?? "").join("\n")
}

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(regressionFixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

describe("inspect_trace bounded-overview rendering", () => {
	it("renders a small trace in full (no truncation note)", async () => {
		const result = await runToolDirect(rt, "inspect_trace", { trace_id: SMALL_TRACE_ID })
		const text = renderedText(result)
		expect(text).not.toContain("Showing")
		expect(text).toContain("GET /api/orders")
		// Span ids are surfaced at the end of each line for follow-up lookups.
		expect(text).toContain("span=")
	})

	it("caps a large trace and keeps the error span + omitted marker", async () => {
		const result = await runToolDirect(rt, "inspect_trace", { trace_id: FIXTURES.traceId })
		const text = renderedText(result)
		// Bounded overview note.
		expect(text).toContain(`of ${LARGE_TRACE_SPAN_COUNT} spans (errors and longest first)`)
		// The single error span survives selection even though it's low-duration.
		expect(text).toContain("[Error]")
		expect(text).toContain("db.query users")
		// Dropped siblings are surfaced, not silently hidden.
		expect(text).toContain("more spans")
		// Full span ids remain available for inspect_span pivots.
		expect(text).toContain("span=")
	})
})

describe("inspect_span drill-down", () => {
	it("returns the full attribute set for a known span", async () => {
		const result = await runToolDirect(rt, "inspect_span", {
			trace_id: SPAN_DETAIL_TRACE_ID,
			span_id: SPAN_DETAIL_SPAN_ID,
		})
		const text = renderedText(result)
		expect(text).toContain("http.method")
		expect(text).toContain("POST")
		expect(text).toContain("/api/checkout")
	})

	it("reports a friendly message for an unknown span (no crash)", async () => {
		const result = await runToolDirect(rt, "inspect_span", {
			trace_id: SPAN_DETAIL_TRACE_ID,
			span_id: MISSING_SPAN_ID,
		})
		const text = renderedText(result)
		expect(text.toLowerCase()).toContain("not found")
	})
})

// Every one of these reproduces a failure observed in production traces over the
// 8 days to 2026-08-17. They run the REAL handler through the REAL dispatcher, so
// they assert the message an agent actually receives — the thing that decides
// whether it recovers or retries the same mistake.
describe("agent-recoverable error messages", () => {
	// error_detail: 15 failures, 100% of that tool's errors. `list_error_issues`
	// rendered an 8-char slice of a Postgres issue id and `find_errors` claimed the
	// two ids were "the same identity", so agents fed an issue id into a UInt64
	// column and got a raw ClickHouse parse error back.
	it("rejects a truncated issue id with the tool that actually produces fingerprints", async () => {
		const text = renderedText(await runToolDirect(rt, "error_detail", { fingerprint: "2b11d788" }))
		expect(text).toContain("find_errors")
		expect(text).toMatch(/decimal/i)
		// The old behaviour: the value reached the SQL and CH complained.
		expect(text).not.toMatch(/toUInt64|syntax error/i)
	})

	it("rejects a full issue UUID rather than querying with it", async () => {
		const text = renderedText(
			await runToolDirect(rt, "error_detail", {
				fingerprint: "2b11d788-6f3a-4c21-9f0e-51c4a8d7e930",
			}),
		)
		expect(text).toMatch(/UUID|issue id/i)
		expect(text).not.toMatch(/toUInt64|syntax error/i)
	})

	// The `alert:<uuid>:<scope>` form is an incident id in a third identity space.
	it("routes an alert incident id to the incident tools", async () => {
		const text = renderedText(
			await runToolDirect(rt, "error_detail", {
				fingerprint: "alert:c797a165-b518-4d13-9963-c542401431a9:all",
			}),
		)
		expect(text).toContain("incident")
		expect(text).toMatch(/list_alert_incidents|get_incident_timeline/)
	})

	it("accepts a genuine decimal fingerprint", async () => {
		const text = renderedText(
			await runToolDirect(rt, "error_detail", { fingerprint: "11640295108927840024" }),
		)
		expect(text).not.toMatch(/Invalid fingerprint/i)
	})

	// query_data: 22 failures, 100% of that tool's errors — all a token that is
	// valid for one source/kind combination rejected by another, reported as a bare
	// SchemaError that named neither the combination nor the alternatives.
	it("names the valid metrics when the token is only valid for the other kind", async () => {
		const text = renderedText(
			await runToolDirect(rt, "query_data", {
				source: "metrics",
				kind: "breakdown",
				metric: "rate",
				metric_name: "http.server.duration",
				metric_type: "histogram",
			}),
		)
		expect(text).toContain('"avg", "sum", "count"')
		expect(text).toContain('kind="timeseries"')
		expect(text).not.toContain("SchemaError")
	})

	it("names the valid group_by values for the chosen source", async () => {
		const text = renderedText(
			await runToolDirect(rt, "query_data", {
				source: "logs",
				kind: "breakdown",
				metric: "count",
				group_by: "http_method",
			}),
		)
		expect(text).toContain('"service", "severity"')
		expect(text).not.toContain("SchemaError")
	})
})
