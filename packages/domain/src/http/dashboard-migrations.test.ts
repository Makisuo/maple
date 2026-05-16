import { describe, expect, it } from "vitest"
import { reshapeDashboardDocumentV2 } from "./dashboard-migrations"

const tracesQuery = {
	id: "q1",
	name: "A",
	dataSource: "traces",
	aggregation: "count",
	metricName: "",
	metricType: "gauge",
	isMonotonic: false,
	signalSource: "default",
}

const metricsQueryNoType = {
	id: "q2",
	name: "B",
	dataSource: "metrics",
	aggregation: "rate",
	metricName: "http.server.requests",
}

function widget(dataSource: unknown, display: unknown = {}) {
	return { id: "w1", visualization: "chart", dataSource, display, layout: { x: 0, y: 0, w: 4, h: 4 } }
}

function queryBuilderDataSource(queries: unknown[]) {
	return { endpoint: "custom_query_builder_timeseries", params: { queries } }
}

describe("reshapeDashboardDocumentV2", () => {
	it("drops metric-only fields from traces queries", () => {
		const doc = { widgets: [widget(queryBuilderDataSource([tracesQuery]))] }
		const result = reshapeDashboardDocumentV2(doc) as any
		const q = result.widgets[0].dataSource.params.queries[0]
		expect(q.dataSource).toBe("traces")
		expect("metricName" in q).toBe(false)
		expect("metricType" in q).toBe(false)
		expect("isMonotonic" in q).toBe(false)
		expect("signalSource" in q).toBe(false)
		expect(q.aggregation).toBe("count")
	})

	it("drops metric-only fields from logs queries", () => {
		const doc = { widgets: [widget(queryBuilderDataSource([{ ...tracesQuery, dataSource: "logs" }]))] }
		const result = reshapeDashboardDocumentV2(doc) as any
		const q = result.widgets[0].dataSource.params.queries[0]
		expect("metricName" in q).toBe(false)
		expect("metricType" in q).toBe(false)
	})

	it("keeps metric fields and backfills metricType for metrics queries", () => {
		const doc = { widgets: [widget(queryBuilderDataSource([metricsQueryNoType]))] }
		const result = reshapeDashboardDocumentV2(doc) as any
		const q = result.widgets[0].dataSource.params.queries[0]
		expect(q.dataSource).toBe("metrics")
		expect(q.metricName).toBe("http.server.requests")
		expect(q.metricType).toBe("gauge")
	})

	it("reshapes query drafts nested inside a sparkline data source", () => {
		const doc = {
			widgets: [
				widget(queryBuilderDataSource([metricsQueryNoType]), {
					sparkline: { enabled: true, dataSource: queryBuilderDataSource([tracesQuery]) },
				}),
			],
		}
		const result = reshapeDashboardDocumentV2(doc) as any
		const sparkQuery = result.widgets[0].display.sparkline.dataSource.params.queries[0]
		expect("metricName" in sparkQuery).toBe(false)
	})

	it("drops the top-level variables field", () => {
		const doc = { variables: [{ name: "env" }], widgets: [] }
		const result = reshapeDashboardDocumentV2(doc) as any
		expect("variables" in result).toBe(false)
	})

	it("leaves non-query-builder data sources untouched", () => {
		const ds = { endpoint: "errors_summary", params: { service: "api" } }
		const doc = { widgets: [widget(ds)] }
		const result = reshapeDashboardDocumentV2(doc) as any
		expect(result.widgets[0].dataSource).toEqual(ds)
	})

	it("is idempotent — a current-shape document is returned equivalently", () => {
		const doc = {
			widgets: [
				widget(
					queryBuilderDataSource([
						{ id: "q1", name: "A", dataSource: "traces", aggregation: "count" },
						{
							id: "q2",
							name: "B",
							dataSource: "metrics",
							aggregation: "rate",
							metricName: "m",
							metricType: "gauge",
						},
					]),
				),
			],
		}
		const once = reshapeDashboardDocumentV2(doc)
		const twice = reshapeDashboardDocumentV2(once)
		expect(twice).toEqual(once)
	})

	it("handles documents with no widgets", () => {
		expect(reshapeDashboardDocumentV2({ widgets: [] })).toEqual({ widgets: [] })
	})
})
