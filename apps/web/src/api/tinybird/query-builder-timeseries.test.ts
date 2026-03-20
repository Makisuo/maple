import { describe, expect, it } from "vitest"
import type { QuerySpec } from "@maple/domain"
import { __testables } from "@/api/tinybird/query-builder-timeseries"
import type { QueryRunResult } from "@/components/query-builder/formula-results"

function makeQueryResult(overrides: Partial<QueryRunResult> = {}): QueryRunResult {
  return {
    queryId: "q-1",
    queryName: "A",
    source: "traces",
    status: "success",
    error: null,
    warnings: [],
    data: [],
    ...overrides,
  }
}

describe("query-builder timeseries strategy", () => {
  it("resolves deterministic auto bucket seconds for timeseries specs", () => {
    const spec: QuerySpec = {
      kind: "timeseries",
      source: "traces",
      metric: "count",
      groupBy: "service",
    }

    const resolved = __testables.resolveTimeseriesBucketSpec(
      spec,
      "2026-01-01 00:00:00",
      "2026-01-02 00:00:00",
    )

    expect(resolved.kind).toBe("timeseries")
    if (resolved.kind !== "timeseries") {
      return
    }

    expect(resolved.bucketSeconds).toBe(3600)
  })

  it("does not mutate explicit bucket seconds", () => {
    const spec: QuerySpec = {
      kind: "timeseries",
      source: "logs",
      metric: "count",
      bucketSeconds: 900,
    }

    const resolved = __testables.resolveTimeseriesBucketSpec(
      spec,
      "2026-01-01 00:00:00",
      "2026-01-01 03:00:00",
    )

    expect(resolved).toEqual(spec)
  })

  it("builds deterministic fallback execution windows", () => {
    const windows = __testables.buildExecutionWindows(
      "2026-01-02 00:00:00",
      "2026-01-02 01:00:00",
      {
        enableEmptyRangeFallback: true,
        fallbackWindowSeconds: [86400],
        maxFallbackRangeSeconds: 86400 * 31,
      },
      true,
    )

    expect(windows).toEqual([
      {
        startTime: "2026-01-02 00:00:00",
        endTime: "2026-01-02 01:00:00",
        kind: "primary",
      },
      {
        startTime: "2026-01-01 01:00:00",
        endTime: "2026-01-02 01:00:00",
        kind: "fallback",
      },
    ])
  })

  it("resolves auto bucket per execution window (primary + fallback)", () => {
    const spec: QuerySpec = {
      kind: "timeseries",
      source: "traces",
      metric: "count",
    }

    const primary = __testables.resolveExecutionSpecForWindow(spec, {
      startTime: "2026-01-02 00:00:00",
      endTime: "2026-01-02 01:00:00",
      kind: "primary",
    })
    const fallback = __testables.resolveExecutionSpecForWindow(spec, {
      startTime: "2026-01-01 01:00:00",
      endTime: "2026-01-02 01:00:00",
      kind: "fallback",
    })

    expect(primary.kind).toBe("timeseries")
    expect(fallback.kind).toBe("timeseries")
    if (primary.kind !== "timeseries" || fallback.kind !== "timeseries") {
      return
    }

    expect(primary.bucketSeconds).toBe(300)
    expect(fallback.bucketSeconds).toBe(3600)
  })

  it("widens explicit bucket on fallback windows to stay within point budget", () => {
    const spec: QuerySpec = {
      kind: "timeseries",
      source: "traces",
      metric: "count",
      bucketSeconds: 60,
    }

    const primary = __testables.resolveExecutionSpecForWindow(spec, {
      startTime: "2026-01-02 00:00:00",
      endTime: "2026-01-02 01:00:00",
      kind: "primary",
    })
    const fallback = __testables.resolveExecutionSpecForWindow(spec, {
      startTime: "2026-01-01 01:00:00",
      endTime: "2026-01-02 01:00:00",
      kind: "fallback",
    })

    expect(primary.kind).toBe("timeseries")
    expect(fallback.kind).toBe("timeseries")
    if (primary.kind !== "timeseries" || fallback.kind !== "timeseries") {
      return
    }

    expect(primary.bucketSeconds).toBe(60)
    expect(fallback.bucketSeconds).toBe(3600)
  })

  it("continues fallback execution after an error and recomputes window buckets", async () => {
    const spec: QuerySpec = {
      kind: "timeseries",
      source: "traces",
      metric: "count",
    }

    const seenBucketSeconds: number[] = []
    const result = await __testables.executeTimeseriesQueryWithFallbackUsing(
      "2026-01-02 00:00:00",
      "2026-01-02 01:00:00",
      spec,
      {
        enableEmptyRangeFallback: true,
        fallbackWindowSeconds: [24 * 60 * 60, 7 * 24 * 60 * 60],
        maxFallbackRangeSeconds: 31 * 24 * 60 * 60,
      },
      true,
      async (windowStart, _windowEnd, windowSpec) => {
        if (windowSpec.kind !== "timeseries") {
          return []
        }

        seenBucketSeconds.push(windowSpec.bucketSeconds ?? -1)

        if (windowStart === "2026-01-02 00:00:00") {
          return []
        }

        if (windowStart === "2026-01-01 01:00:00") {
          return Promise.reject(new Error("Timeseries query too expensive"))
        }

        return [
          {
            bucket: "2026-01-01T00:00:00.000Z",
            series: { total: 5 },
          },
        ]
      },
    )

    expect(seenBucketSeconds).toEqual([300, 3600, 14400])
    expect(result.fallbackUsed).toBe(true)
    expect(result.attempts).toHaveLength(3)
    expect(result.attempts[1].error).toContain("too expensive")
    expect(result.points).toEqual([
      {
        bucket: "2026-01-01T00:00:00.000Z",
        series: { total: 5 },
      },
    ])
  })

  it("uses the shared coarse auto bucket ladder", () => {
    expect(__testables.computeAutoBucketSeconds("2026-01-01 00:00:00", "2026-01-01 00:30:00")).toBe(300)
    expect(__testables.computeAutoBucketSeconds("2026-01-01 00:00:00", "2026-01-01 06:00:00")).toBe(900)
    expect(__testables.computeAutoBucketSeconds("2026-01-01 00:00:00", "2026-01-08 00:00:00")).toBe(14400)
  })

  it("counts only query results with real series data", () => {
    const count = __testables.countSuccessfulQuerySeries([
      makeQueryResult({
        data: [{ bucket: "2026-01-01T00:00:00.000Z", series: {} }],
      }),
      makeQueryResult({
        queryId: "q-2",
        queryName: "B",
        data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { total: 1 } }],
      }),
    ])

    expect(count).toBe(1)
  })

  it("prefers query error message when no series data exists", () => {
    const message = __testables.noQueryDataMessage([
      makeQueryResult({
        status: "error",
        error: "Timeseries query too expensive",
      }),
      makeQueryResult({
        queryId: "q-2",
        queryName: "B",
        data: [],
      }),
    ])

    expect(message).toContain("too expensive")
  })

  it("preserves grouped series instead of summing them per query", () => {
    const merged = __testables.mergeQueryRunResults(
      [
        makeQueryResult({
          queryId: "q-1",
          queryName: "A",
          data: [
            {
              bucket: "2026-01-01T00:00:00.000Z",
              series: { checkout: 2, billing: 1 },
            },
            {
              bucket: "2026-01-01T00:05:00.000Z",
              series: { checkout: 4 },
            },
          ],
        }),
        makeQueryResult({
          queryId: "q-2",
          queryName: "B",
          data: [
            {
              bucket: "2026-01-01T00:00:00.000Z",
              series: { checkout: 5 },
            },
            {
              bucket: "2026-01-01T00:05:00.000Z",
              series: { checkout: 7 },
            },
          ],
        }),
      ],
      new Map([
        ["q-1", "Errors"],
        ["q-2", "Throughput"],
      ]),
    )

    expect(merged.seriesNames).toEqual([
      "Errors: checkout",
      "Errors: billing",
      "Throughput: checkout",
    ])

    expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
      bucket: "2026-01-01T00:00:00.000Z",
      "Errors: checkout": 2,
      "Errors: billing": 1,
      "Throughput: checkout": 5,
    })
    expect(merged.rowsByBucket.get("2026-01-01T00:05:00.000Z")).toEqual({
      bucket: "2026-01-01T00:05:00.000Z",
      "Errors: checkout": 4,
      "Errors: billing": 0,
      "Throughput: checkout": 7,
    })
  })

  it("keeps non-grouped 'all' series as the display name", () => {
    const merged = __testables.mergeQueryRunResults(
      [
        makeQueryResult({
          queryId: "q-1",
          queryName: "A",
          data: [
            {
              bucket: "2026-01-01T00:00:00.000Z",
              series: { all: 12 },
            },
          ],
        }),
      ],
      new Map([["q-1", "Requests"]]),
    )

    expect(merged.seriesNames).toEqual(["Requests"])
    expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
      bucket: "2026-01-01T00:00:00.000Z",
      Requests: 12,
    })
  })

  it("keeps formula series labels without redundant namespacing", () => {
    const merged = __testables.mergeQueryRunResults(
      [
        makeQueryResult({
          queryId: "f-1",
          queryName: "F1",
          source: "formula",
          data: [
            {
              bucket: "2026-01-01T00:00:00.000Z",
              series: { "Error ratio": 0.3 },
            },
          ],
        }),
      ],
      new Map([["f-1", "Error ratio"]]),
    )

    expect(merged.seriesNames).toEqual(["Error ratio"])
    expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
      bucket: "2026-01-01T00:00:00.000Z",
      "Error ratio": 0.3,
    })
  })

  it("computes percent change per stable grouped series", () => {
    const rows: Array<Record<string, string | number>> = [
      {
        bucket: "2026-01-01T00:00:00.000Z",
        "Errors: checkout": 20,
        "Errors: checkout (prev)": 10,
      },
    ]

    __testables.appendPercentChangeSeries(
      rows,
      new Map([["q-1::checkout", "Errors: checkout"]]),
      new Map([["q-1::checkout", "Errors: checkout (prev)"]]),
    )

    expect(rows[0]["Errors: checkout (%Δ)"]).toBe(100)
  })
})
