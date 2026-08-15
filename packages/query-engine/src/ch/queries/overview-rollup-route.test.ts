// Routing guard for the service-overview rollup tiers.
//
// `canUseAnnualServiceOverview` decides whether an all-metrics timeseries can
// be answered from `service_overview_minutely`/`_hourly` instead of raw
// `traces`. The rollups aggregate SpanName, SpanKind and every attribute away,
// so a filter the predicate forgets to check is not a slow query — it is a
// SILENTLY WRONG one: service-wide numbers returned under an endpoint's name,
// with no error anywhere.
//
// These tests exist because exactly that shipped: the predicate checked the
// singular `spanName` but not the plural `spanNames`, which is the spelling
// every modern caller uses.

import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { canUseAnnualServiceOverview, tracesTimeseriesQuery } from "./traces"

/** The shape that legitimately routes to the rollup — each test spoils one thing. */
const routable = {
	allMetrics: true as const,
	rootOnly: true,
	bucketSeconds: 300,
	metric: "count" as const,
	needsSampling: true,
}

describe("canUseAnnualServiceOverview", () => {
	it("routes a plain service-scoped all-metrics query to the rollup", () => {
		expect(canUseAnnualServiceOverview({ ...routable, serviceName: "api" })).toBe(true)
	})

	it("refuses BOTH spellings of the span-name filter", () => {
		// The rollups have no SpanName column, so either spelling routed here
		// returns the whole service's traffic under one endpoint's name.
		expect(canUseAnnualServiceOverview({ ...routable, spanName: "GET /v1/users" })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, spanNames: ["GET /v1/users"] })).toBe(false)
	})

	it("treats an empty spanNames array as no filter", () => {
		expect(canUseAnnualServiceOverview({ ...routable, spanNames: [] })).toBe(true)
	})

	it("refuses the other filters the rollups aggregate away", () => {
		expect(canUseAnnualServiceOverview({ ...routable, excludedSpanNames: ["x"] })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, statusCode: "Error" })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, errorsOnly: true })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, minDurationMs: 100 })).toBe(false)
		expect(
			canUseAnnualServiceOverview({
				...routable,
				attributeFilters: [{ key: "http.route", value: "/x", mode: "equals" }],
			}),
		).toBe(false)
	})

	it("refuses a non-rootOnly query, whose population the rollup does not match", () => {
		expect(canUseAnnualServiceOverview({ ...routable, rootOnly: false })).toBe(false)
	})

	it("refuses a sub-minute bucket, and a sub-hour bucket on the hour-only tier", () => {
		expect(canUseAnnualServiceOverview({ ...routable, bucketSeconds: 30 })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, bucketSeconds: 300, overviewTiers: "hour" })).toBe(
			false,
		)
		expect(canUseAnnualServiceOverview({ ...routable, bucketSeconds: 3600, overviewTiers: "hour" })).toBe(
			true,
		)
	})

	it("refuses a non-default apdex threshold, which the rollup baked in", () => {
		expect(canUseAnnualServiceOverview({ ...routable, apdexThresholdMs: 250 })).toBe(false)
		expect(canUseAnnualServiceOverview({ ...routable, apdexThresholdMs: 500 })).toBe(true)
	})
})

// The predicate is internal; what a caller actually gets is the SQL. These
// assert the end result — that an endpoint-scoped chart really does read raw
// traces and really does carry its filter.
describe("tracesTimeseriesQuery routing under a span-name filter", () => {
	const params = {
		orgId: "org_1",
		startTime: "2026-08-14 00:00:00",
		endTime: "2026-08-14 12:00:00",
		bucketSeconds: 300,
	}

	it("reads the overview rollup when nothing blocks it", () => {
		const { sql } = compileCH(tracesTimeseriesQuery({ ...routable, serviceName: "api" }), params)
		expect(sql).toContain("service_overview")
	})

	it("falls back to raw traces and applies the filter when spanNames is set", () => {
		const { sql } = compileCH(
			tracesTimeseriesQuery({
				...routable,
				serviceName: "api",
				spanNames: ["GET /v1/users/:id/entitlements"],
			}),
			params,
		)
		expect(sql).not.toContain("service_overview")
		expect(sql).toContain("FROM traces")
		// The filter must actually reach the WHERE clause — routing to raw without
		// emitting the predicate would be the same wrong number by another path.
		expect(sql).toContain("GET /v1/users/:id/entitlements")
	})
})
