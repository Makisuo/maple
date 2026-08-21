import { describe, expect, it } from "vitest"
import type { QuerySpec } from "@maple/domain/query-engine"
import {
	buildExecutionWindows,
	LAB_EMPTY_RANGE_STRATEGY,
	NO_EMPTY_RANGE_FALLBACK,
	resolveExecutionSpecForWindow,
	resolveFallbackStrategy,
	resolveTimeseriesBucketSpec,
} from "./bucketing"

describe("resolveTimeseriesBucketSpec", () => {
	it("resolves deterministic auto bucket seconds for timeseries specs", () => {
		const spec: QuerySpec = {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			groupBy: ["service"],
		}

		const resolved = resolveTimeseriesBucketSpec(spec, "2026-01-01 00:00:00", "2026-01-02 00:00:00")

		expect(resolved.kind).toBe("timeseries")
		if (resolved.kind !== "timeseries") return
		expect(resolved.bucketSeconds).toBe(900)
	})

	it("switches to the width model when maxDataPoints is given", () => {
		const spec: QuerySpec = { kind: "timeseries", source: "traces", metric: "count" }
		const wide = resolveTimeseriesBucketSpec(spec, "2026-01-01 00:00:00", "2026-01-01 12:00:00", {
			maxDataPoints: 1400,
		})
		const narrow = resolveTimeseriesBucketSpec(spec, "2026-01-01 00:00:00", "2026-01-01 12:00:00", {
			maxDataPoints: 300,
		})
		if (wide.kind !== "timeseries" || narrow.kind !== "timeseries") throw new Error("timeseries")
		expect(wide.bucketSeconds).toBe(60)
		expect(narrow.bucketSeconds).toBe(120)
	})

	it("does not mutate explicit bucket seconds", () => {
		const spec: QuerySpec = {
			kind: "timeseries",
			source: "logs",
			metric: "count",
			bucketSeconds: 900,
		}

		expect(resolveTimeseriesBucketSpec(spec, "2026-01-01 00:00:00", "2026-01-01 03:00:00")).toEqual(spec)
	})

	it("leaves a non-timeseries spec alone", () => {
		const spec: QuerySpec = {
			kind: "breakdown",
			source: "traces",
			metric: "count",
			groupBy: "service",
		}
		expect(resolveTimeseriesBucketSpec(spec, "2026-01-01 00:00:00", "2026-01-02 00:00:00")).toEqual(spec)
	})
})

describe("resolveExecutionSpecForWindow", () => {
	it("resolves auto bucket per execution window (primary + fallback)", () => {
		const spec: QuerySpec = { kind: "timeseries", source: "traces", metric: "count" }

		const primary = resolveExecutionSpecForWindow(spec, {
			startTime: "2026-01-02 00:00:00",
			endTime: "2026-01-02 01:00:00",
			kind: "primary",
		})
		const fallback = resolveExecutionSpecForWindow(spec, {
			startTime: "2026-01-01 01:00:00",
			endTime: "2026-01-02 01:00:00",
			kind: "fallback",
		})

		expect(primary.kind).toBe("timeseries")
		expect(fallback.kind).toBe("timeseries")
		if (primary.kind !== "timeseries" || fallback.kind !== "timeseries") return

		expect(primary.bucketSeconds).toBe(60)
		expect(fallback.bucketSeconds).toBe(900)
	})

	it("applies the width model to the fallback window too", () => {
		const spec: QuerySpec = { kind: "timeseries", source: "traces", metric: "count" }
		const fallback = resolveExecutionSpecForWindow(
			spec,
			{ startTime: "2026-01-01 01:00:00", endTime: "2026-01-02 01:00:00", kind: "fallback" },
			{ maxDataPoints: 1400 },
		)
		if (fallback.kind !== "timeseries") throw new Error("timeseries")
		// 24h @ 1400px → 62s → 1m = 1440 points, over the 1000 cap → 2m. Not the
		// 100-point policy's 15m.
		expect(fallback.bucketSeconds).toBe(120)
	})

	it("widens explicit bucket on fallback windows to stay within point budget", () => {
		const spec: QuerySpec = {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			bucketSeconds: 60,
		}

		const primary = resolveExecutionSpecForWindow(spec, {
			startTime: "2026-01-02 00:00:00",
			endTime: "2026-01-02 01:00:00",
			kind: "primary",
		})
		const fallback = resolveExecutionSpecForWindow(spec, {
			startTime: "2026-01-01 01:00:00",
			endTime: "2026-01-02 01:00:00",
			kind: "fallback",
		})

		expect(primary.kind).toBe("timeseries")
		expect(fallback.kind).toBe("timeseries")
		if (primary.kind !== "timeseries" || fallback.kind !== "timeseries") return

		// The primary keeps the author's 60s; only the wider fallback coarsens, or a
		// 31-day window at 60s would ask for ~45k points.
		expect(primary.bucketSeconds).toBe(60)
		expect(fallback.bucketSeconds).toBe(900)
	})
})

describe("buildExecutionWindows", () => {
	it("builds deterministic fallback execution windows", () => {
		const windows = buildExecutionWindows(
			"2026-01-02 00:00:00",
			"2026-01-02 01:00:00",
			{ enabled: true, windowSeconds: [86400], maxRangeSeconds: 86400 * 31 },
			true,
		)

		expect(windows).toEqual([
			{ startTime: "2026-01-02 00:00:00", endTime: "2026-01-02 01:00:00", kind: "primary" },
			{ startTime: "2026-01-01 01:00:00", endTime: "2026-01-02 01:00:00", kind: "fallback" },
		])
	})

	it("returns only the primary when the strategy is off", () => {
		expect(
			buildExecutionWindows(
				"2026-01-02 00:00:00",
				"2026-01-02 01:00:00",
				NO_EMPTY_RANGE_FALLBACK,
				true,
			),
		).toHaveLength(1)
	})

	it("returns only the primary when the caller disallows fallback", () => {
		// This is the previous-period window: widening it would compare the current
		// window against a differently-sized one.
		expect(
			buildExecutionWindows(
				"2026-01-02 00:00:00",
				"2026-01-02 01:00:00",
				LAB_EMPTY_RANGE_STRATEGY,
				false,
			),
		).toHaveLength(1)
	})

	it("only ever widens, and never past the ceiling", () => {
		const windows = buildExecutionWindows(
			"2026-01-01 00:00:00",
			"2026-01-08 00:00:00", // already 7 days
			LAB_EMPTY_RANGE_STRATEGY,
			true,
		)

		// 24h and 7d are not wider than the request; only 31d survives.
		expect(windows).toHaveLength(2)
		expect(windows[1].startTime).toBe("2025-12-08 00:00:00")
	})

	it("falls back to the primary alone for an unparseable or inverted range", () => {
		expect(
			buildExecutionWindows("nonsense", "2026-01-02 01:00:00", LAB_EMPTY_RANGE_STRATEGY, true),
		).toEqual([{ startTime: "nonsense", endTime: "2026-01-02 01:00:00", kind: "primary" }])
		expect(
			buildExecutionWindows(
				"2026-01-02 01:00:00",
				"2026-01-02 00:00:00",
				LAB_EMPTY_RANGE_STRATEGY,
				true,
			),
		).toHaveLength(1)
	})
})

describe("resolveFallbackStrategy", () => {
	it("sorts, dedupes and drops non-positive rungs", () => {
		expect(
			resolveFallbackStrategy({ windowSeconds: [7200, 60, 7200, 0, -5, Number.NaN] }).windowSeconds,
		).toEqual([60, 7200])
	})

	it("inherits from the base for absent fields", () => {
		expect(resolveFallbackStrategy(undefined)).toEqual(LAB_EMPTY_RANGE_STRATEGY)
		expect(resolveFallbackStrategy({}, NO_EMPTY_RANGE_FALLBACK).enabled).toBe(false)
	})

	it("lets an explicit `enabled: false` override an enabled base", () => {
		// Every dashboard tile relies on this: it sends `enabled: false` and must
		// not inherit the lab ladder.
		expect(resolveFallbackStrategy({ enabled: false }, LAB_EMPTY_RANGE_STRATEGY).enabled).toBe(false)
	})
})
