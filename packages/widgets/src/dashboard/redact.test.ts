import { describe, expect, it } from "vitest"
import { redactForShare } from "./redact"

const SECRET_SQL = "SELECT customer_revenue FROM internal_billing WHERE tier = 'enterprise'"
const SECRET_CLAUSE = "service.name = 'unreleased-project'"

const document = {
	id: "dash-1",
	name: "Ops",
	description: "public enough",
	timeRange: { type: "relative" as const, value: "12h" },
	tags: ["internal-only"],
	createdBy: "user_alice",
	updatedBy: "user_bob",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	widgets: [
		{
			id: "w-sql",
			visualization: "table",
			display: { title: "Revenue" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
			dataSource: { kind: "raw_sql", sql: SECRET_SQL, transform: { limit: 10 } },
		},
		{
			id: "w-query",
			visualization: "line",
			display: { title: "Latency" },
			layout: { x: 6, y: 0, w: 6, h: 4 },
			sectionId: "sec-1",
			tabId: "tab-1",
			dataSource: {
				kind: "query",
				resultShape: "timeseries",
				queries: [
					{
						id: "q1",
						name: "A",
						aggregation: "count",
						dataSource: "traces",
						whereClause: SECRET_CLAUSE,
					},
				],
			},
		},
		{
			id: "w-route",
			visualization: "list",
			display: { title: "Traces" },
			layout: { x: 0, y: 4, w: 12, h: 4 },
			dataSource: { kind: "route", endpoint: "list_traces", params: { service: "unreleased-project" } },
		},
	],
	sections: [{ id: "sec-1", title: "Latency" }],
	variables: [{ name: "service", type: "textbox" as const }],
	refreshIntervalSeconds: 60,
}

describe("redactForShare", () => {
	it("publishes no stored query text, in any field, at any depth", () => {
		const redacted = redactForShare(document)
		const serialized = JSON.stringify(redacted)

		// Asserted as a property over the whole encoded payload rather than
		// field-by-field: a field-by-field check passes the day someone adds a new
		// one and forgets it here, which is precisely the failure this guards.
		expect(serialized).not.toContain(SECRET_SQL)
		expect(serialized).not.toContain(SECRET_CLAUSE)
		expect(serialized).not.toContain("list_traces")
		expect(serialized).not.toContain("unreleased-project")
		expect(serialized).not.toContain("user_alice")
		expect(serialized).not.toContain("user_bob")
		expect(serialized).not.toContain("internal-only")
	})

	it("keeps what a renderer genuinely needs", () => {
		const redacted = redactForShare(document)

		expect(redacted?.name).toBe("Ops")
		expect(redacted?.widgets).toHaveLength(3)
		// Result shape survives because a timeseries and a breakdown draw
		// differently; it describes the response, not the query.
		expect(redacted?.widgets[1]).toMatchObject({
			id: "w-query",
			visualization: "line",
			dataSource: { kind: "query", resultShape: "timeseries" },
		})
		// Transform survives: it is applied client-side to rows the server already
		// returned, so withholding it would change the chart, not the disclosure.
		expect(redacted?.widgets[0]?.dataSource.transform).toEqual({ limit: 10 })
		expect(redacted?.refreshIntervalSeconds).toBe(60)
	})

	it("narrows a single-chart share to exactly one widget", () => {
		const redacted = redactForShare(document, "w-query")

		expect(redacted?.widgets).toHaveLength(1)
		expect(redacted?.widgets[0]?.id).toBe("w-query")
		// A chart link must not enumerate the rest of the board, nor the names of
		// sections and tabs its viewer cannot open.
		expect(JSON.stringify(redacted)).not.toContain("w-sql")
		expect(JSON.stringify(redacted)).not.toContain("w-route")
		expect(redacted?.sections).toBeUndefined()
		expect(redacted?.widgets[0]?.sectionId).toBeUndefined()
		expect(redacted?.widgets[0]?.tabId).toBeUndefined()
	})

	it("reports an absent widget as no share rather than an empty board", () => {
		expect(redactForShare(document, "w-missing")).toBeNull()
	})

	it("classifies a legacy v2 data source rather than silently calling it static", () => {
		// A v2 document stores `{ endpoint, params }` with no `kind`. Falling
		// through to "static" would render a live tile as an inert one.
		const legacy = redactForShare({
			...document,
			widgets: [
				{
					id: "w-legacy",
					visualization: "stat",
					display: {},
					layout: { x: 0, y: 0, w: 3, h: 4 },
					dataSource: { endpoint: "errors_summary", params: { rootOnly: true } },
				},
			],
		})

		expect(legacy?.widgets[0]?.dataSource.kind).toBe("route")
		expect(JSON.stringify(legacy)).not.toContain("errors_summary")
	})
})
