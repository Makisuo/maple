import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { MetricName } from "@maple/domain"
import { QueryEngineEvaluateRequest, type MetricsTimeseriesQuery } from "../query-engine"
import { validateEvaluate } from "./query-engine"

const makeRequest = (query: MetricsTimeseriesQuery) =>
	new QueryEngineEvaluateRequest({
		startTime: "2026-04-01 00:00:00",
		endTime: "2026-04-01 01:00:00",
		query,
		reducer: "avg",
		sampleCountStrategy: "metric_data_points",
	})

const baseFilters = { metricName: Schema.decodeUnknownSync(MetricName)("cpu.usage"), metricType: "gauge" as const }

describe("validateMetricsAttributeFilters", () => {
	it.effect("rejects groupBy=attribute when groupByAttributeKey is missing", () =>
		Effect.gen(function* () {
			const error = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["attribute"],
					filters: baseFilters,
				}),
			).pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
			if (error._tag === "@maple/http/errors/QueryEngineValidationError") {
				assert.include(error.details.join("; "), "groupBy=attribute requires filters.groupByAttributeKey")
			}
		}),
	)

	it.effect("accepts groupBy=attribute when groupByAttributeKey is present", () =>
		Effect.gen(function* () {
			const range = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["attribute"],
					filters: { ...baseFilters, groupByAttributeKey: "region" },
				}),
			)
			assert.isDefined(range)
		}),
	)

	it.effect("accepts groupBy=service without a key", () =>
		Effect.gen(function* () {
			const range = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["service"],
					filters: baseFilters,
				}),
			)
			assert.isDefined(range)
		}),
	)

	it.effect("rejects groupBy=resource_attribute when groupByResourceAttributeKey is missing", () =>
		Effect.gen(function* () {
			const error = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["resource_attribute"],
					filters: baseFilters,
				}),
			).pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
			if (error._tag === "@maple/http/errors/QueryEngineValidationError") {
				assert.include(
					error.details.join("; "),
					"groupBy=resource_attribute requires filters.groupByResourceAttributeKey",
				)
			}
		}),
	)

	it.effect("accepts groupBy=resource_attribute when groupByResourceAttributeKey is present", () =>
		Effect.gen(function* () {
			const range = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["resource_attribute"],
					filters: { ...baseFilters, groupByResourceAttributeKey: "host.name" },
				}),
			)
			assert.isDefined(range)
		}),
	)

	it.effect("rejects combining attribute and resource_attribute group-bys", () =>
		Effect.gen(function* () {
			const error = yield* validateEvaluate(
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["attribute", "resource_attribute"],
					filters: {
						...baseFilters,
						groupByAttributeKey: "region",
						groupByResourceAttributeKey: "host.name",
					},
				}),
			).pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
			if (error._tag === "@maple/http/errors/QueryEngineValidationError") {
				assert.include(error.details.join("; "), "groupBy cannot combine attribute and resource_attribute")
			}
		}),
	)
})
