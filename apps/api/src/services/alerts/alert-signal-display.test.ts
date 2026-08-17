import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { resolveSignalDisplay } from "./alert-signal-display"

type TracesDraft = Extract<QueryBuilderQueryDraftPayload, { dataSource: "traces" }>
type LogsDraft = Extract<QueryBuilderQueryDraftPayload, { dataSource: "logs" }>
type MetricsDraft = Extract<QueryBuilderQueryDraftPayload, { dataSource: "metrics" }>

const base = { id: "q1", name: "Query A" }

const tracesDraft = (fields: Omit<TracesDraft, "id" | "name" | "dataSource">): TracesDraft => ({
	...base,
	dataSource: "traces",
	...fields,
})

const logsDraft = (fields: Omit<LogsDraft, "id" | "name" | "dataSource">): LogsDraft => ({
	...base,
	dataSource: "logs",
	...fields,
})

const metricsDraft = (fields: Omit<MetricsDraft, "id" | "name" | "dataSource">): MetricsDraft => ({
	...base,
	dataSource: "metrics",
	...fields,
})

describe("resolveSignalDisplay", () => {
	describe("preset signals", () => {
		it("keeps their established labels and attaches their units", () => {
			assert.deepStrictEqual(resolveSignalDisplay({ signalType: "error_rate" }), {
				label: "Error Rate",
				unit: "ratio",
			})
			assert.deepStrictEqual(resolveSignalDisplay({ signalType: "p95_latency" }), {
				label: "P95 Latency",
				unit: "ms",
			})
			assert.deepStrictEqual(resolveSignalDisplay({ signalType: "throughput" }), {
				label: "Throughput",
				unit: "rpm",
			})
			assert.deepStrictEqual(resolveSignalDisplay({ signalType: "apdex" }), {
				label: "Apdex",
				unit: "apdex",
			})
		})
	})

	describe("builder_query", () => {
		it("names a metrics query as aggregation(metricName), unit unknown", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: metricsDraft({
						aggregation: "sum",
						metricName: "db.query.duration",
					}),
				}),
				{ label: "sum(db.query.duration)", unit: "plain" },
			)
		})

		it("drops the parens when the metrics draft has no metric name", () => {
			assert.strictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: metricsDraft({ aggregation: "avg" }),
				}).label,
				"avg",
			)
		})

		it("reuses the query builder's own aggregation labels for traces", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: tracesDraft({ aggregation: "p95_duration" }),
				}),
				{ label: "p95(duration)", unit: "ms" },
			)
		})

		it("carries the ratio unit for a traces error_rate query", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: tracesDraft({ aggregation: "error_rate" }),
				}),
				{ label: "error_rate", unit: "ratio" },
			)
		})

		it("names the span attribute when the traces query aggregates a valueField", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: tracesDraft({
						aggregation: "sum",
						valueField: "attr.result.rowCount",
					}),
				}),
				{ label: "sum(attr.result.rowCount)", unit: "plain" },
			)
		})

		it("names a logs count query", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({
					signalType: "builder_query",
					queryBuilderDraft: logsDraft({ aggregation: "count" }),
				}),
				{ label: "Log count", unit: "count" },
			)
		})

		it("falls back to the humanized enum when the rule row is gone", () => {
			assert.deepStrictEqual(resolveSignalDisplay({ signalType: "builder_query" }), {
				label: "Builder query",
				unit: "plain",
			})
		})
	})

	describe("raw_query", () => {
		it("names the reducer when one is applied", () => {
			assert.deepStrictEqual(
				resolveSignalDisplay({ signalType: "raw_query", rawQueryReducer: "sum" }),
				{ label: "SQL result (sum)", unit: "plain" },
			)
		})

		it("omits the reducer for identity and for a missing reducer", () => {
			assert.strictEqual(
				resolveSignalDisplay({ signalType: "raw_query", rawQueryReducer: "identity" }).label,
				"SQL result",
			)
			assert.strictEqual(resolveSignalDisplay({ signalType: "raw_query" }).label, "SQL result")
		})
	})

	it("never returns a raw snake_case enum for an unmapped signal type", () => {
		assert.strictEqual(
			resolveSignalDisplay({ signalType: "some_future_signal" }).label,
			"Some future signal",
		)
	})
})
