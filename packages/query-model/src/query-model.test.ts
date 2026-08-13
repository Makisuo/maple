import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	ALERT_REDUCER_TO_SERIES_REDUCER,
	ALERT_REDUCERS,
	QuerySetSchema,
	QueryBuilderQueryDraftSchema,
	SERIES_REDUCER_TO_ALERT_REDUCER,
	SERIES_REDUCERS,
	TimeRangeSchema,
} from "./index"

const decodeDraft = Schema.decodeUnknownSync(QueryBuilderQueryDraftSchema)
const decodeQuerySet = Schema.decodeUnknownSync(QuerySetSchema)
const decodeTimeRange = Schema.decodeUnknownSync(TimeRangeSchema)

describe("QueryBuilderQueryDraftSchema", () => {
	it("decodes a minimal draft for every data source", () => {
		for (const dataSource of ["traces", "logs", "metrics"] as const) {
			const decoded = decodeDraft({ id: "a", name: "A", aggregation: "count", dataSource })
			expect(decoded.dataSource).toBe(dataSource)
		}
	})

	it("keeps every optional field absent rather than defaulting it", () => {
		// The stored shape is partial on purpose — the editor-state type in
		// `@maple/query-engine/query-builder` is the total one. A default here
		// would write fields the user never set back into their document.
		const decoded = decodeDraft({ id: "a", name: "A", aggregation: "count", dataSource: "traces" })
		expect(decoded).toEqual({ id: "a", name: "A", aggregation: "count", dataSource: "traces" })
	})

	it("round-trips a fully-populated metrics draft", () => {
		const draft = {
			id: "q1",
			name: "A",
			enabled: true,
			hidden: false,
			whereClause: "service.name = 'api'",
			aggregation: "rate",
			stepInterval: "1m",
			orderByDirection: "desc" as const,
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
			groupBy: ["service.name"],
			having: "",
			orderBy: "",
			limit: "10",
			seriesLimit: "5",
			legend: "{{service.name}}",
			dataSource: "metrics" as const,
			signalSource: "default" as const,
			metricName: "http.server.duration",
			metricType: "histogram" as const,
			isMonotonic: false,
		}
		expect(decodeDraft(draft)).toEqual(draft)
	})

	it("rejects an unknown data source", () => {
		expect(() => decodeDraft({ id: "a", name: "A", aggregation: "count", dataSource: "spans" })).toThrow()
	})

	it("carries the traces-only valueField", () => {
		const traces = decodeDraft({
			id: "a",
			name: "A",
			aggregation: "avg",
			dataSource: "traces",
			valueField: "attr.result.rowCount",
		})
		expect(traces).toMatchObject({ valueField: "attr.result.rowCount" })
	})

	it("drops an unknown key instead of rejecting the draft", () => {
		// Leniency is deliberate for a STORED schema: a draft written by a newer
		// client, or one carrying a field since removed, must still decode — a
		// rejection here propagates up to `parseStoredDashboard` and locks the
		// whole dashboard out of editing. Unknown keys are dropped, not kept, so
		// the next read-modify-write doesn't persist them back.
		const decoded = decodeDraft({
			id: "a",
			name: "A",
			aggregation: "avg",
			dataSource: "logs",
			valueField: "x",
			somethingFromTheFuture: 1,
		})
		expect(decoded).not.toHaveProperty("valueField")
		expect(decoded).not.toHaveProperty("somethingFromTheFuture")
	})
})

describe("QuerySetSchema", () => {
	it("decodes a bare list of queries", () => {
		const set = decodeQuerySet({
			queries: [{ id: "a", name: "A", aggregation: "count", dataSource: "traces" }],
		})
		expect(set.queries).toHaveLength(1)
		expect(set.formulas).toBeUndefined()
		expect(set.comparison).toBeUndefined()
	})

	it("decodes formulas and a comparison window", () => {
		const set = decodeQuerySet({
			queries: [
				{ id: "a", name: "A", aggregation: "count", dataSource: "traces" },
				{ id: "b", name: "B", aggregation: "count", dataSource: "traces" },
			],
			formulas: [{ id: "f1", name: "F1", expression: "A / B", legend: "ratio" }],
			comparison: { mode: "previous_period", includePercentChange: true },
		})
		expect(set.formulas?.[0]?.expression).toBe("A / B")
		expect(set.comparison?.mode).toBe("previous_period")
	})

	it("accepts an empty query list", () => {
		// A widget mid-edit can legitimately have no queries, and a stored schema
		// that rejects is a stored schema that locks the document out of editing.
		expect(decodeQuerySet({ queries: [] }).queries).toEqual([])
	})
})

describe("series reducers", () => {
	it("maps every alert reducer onto a series reducer", () => {
		for (const reducer of ALERT_REDUCERS) {
			expect(SERIES_REDUCERS).toContain(ALERT_REDUCER_TO_SERIES_REDUCER[reducer])
		}
	})

	it("keeps the two spellings distinct where they genuinely differ", () => {
		// Merging these sets would rewrite stored values: widgets persist "first",
		// alert rules persist "identity", and they coincide only on one bucket.
		expect(ALERT_REDUCER_TO_SERIES_REDUCER.identity).toBe("first")
		expect(SERIES_REDUCERS).toContain("count")
		expect(ALERT_REDUCERS).not.toContain("count" as never)
	})

	it("round-trips every alert reducer through the series spelling and back", () => {
		for (const reducer of ALERT_REDUCERS) {
			expect(SERIES_REDUCER_TO_ALERT_REDUCER[ALERT_REDUCER_TO_SERIES_REDUCER[reducer]]).toBe(reducer)
		}
	})

	it("leaves the widget-only reducer unmapped rather than defaulting it", () => {
		// The whole point of the partial map: "create alert from chart" must be
		// able to tell that a count tile has no alert equivalent, instead of
		// silently sending `identity`.
		expect(SERIES_REDUCER_TO_ALERT_REDUCER.count).toBeUndefined()
		expect(SERIES_REDUCER_TO_ALERT_REDUCER.first).toBe("identity")
		expect(SERIES_REDUCER_TO_ALERT_REDUCER.max).toBe("max")
	})
})

describe("TimeRangeSchema", () => {
	it("decodes both variants", () => {
		expect(decodeTimeRange({ type: "relative", value: "24h" })).toEqual({
			type: "relative",
			value: "24h",
		})
		const absolute = decodeTimeRange({
			type: "absolute",
			startTime: "2026-08-01T00:00:00.000Z",
			endTime: "2026-08-02T00:00:00.000Z",
		})
		expect(absolute.type).toBe("absolute")
	})

	it("rejects an absolute range whose instants are not ISO date-times", () => {
		expect(() =>
			decodeTimeRange({ type: "absolute", startTime: "yesterday", endTime: "today" }),
		).toThrow()
	})
})
