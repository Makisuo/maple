import { describe, expect, it } from "bun:test"
import { Effect, Exit, Option, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain"
import type {
  QueryEngineEvaluateRequest,
  QueryEngineExecuteRequest,
} from "@maple/query-engine"
import {
  makeQueryEngineEvaluate,
  makeQueryEngineEvaluateGrouped,
  makeQueryEngineExecute,
} from "./QueryEngineService"
import type { TenantContext } from "./AuthService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const tenant: TenantContext = {
  orgId: asOrgId("org_test"),
  userId: asUserId("user_test"),
  roles: [],
  authMode: "self_hosted",
}

const makeTraceTimeseriesRow = (
  overrides: Partial<{
    bucket: string
    groupName: string
    count: number
    avgDuration: number
    p50Duration: number
    p95Duration: number
    p99Duration: number
    errorRate: number
    satisfiedCount: number
    toleratingCount: number
    apdexScore: number
    sampledSpanCount: number
    unsampledSpanCount: number
    dominantThreshold: string
  }> = {},
) => ({
  bucket: "2026-01-01 00:00:00",
  groupName: "checkout",
  count: 0,
  avgDuration: 0,
  p50Duration: 0,
  p95Duration: 0,
  p99Duration: 0,
  errorRate: 0,
  satisfiedCount: 0,
  toleratingCount: 0,
  apdexScore: 0,
  sampledSpanCount: 0,
  unsampledSpanCount: 0,
  dominantThreshold: "",
  ...overrides,
})

function makeTinybirdStub(overrides: Partial<Parameters<typeof makeQueryEngineExecute>[0]> = {}) {
  const unexpected = (name: string) =>
    () =>
      Effect.die(
        new Error(`Unexpected tinybird call in test: ${name}`),
      )

  return {
    customTracesTimeseriesQuery: unexpected("customTracesTimeseriesQuery"),
    customLogsTimeseriesQuery: unexpected("customLogsTimeseriesQuery"),
    metricTimeSeriesSumQuery: unexpected("metricTimeSeriesSumQuery"),
    metricTimeSeriesGaugeQuery: unexpected("metricTimeSeriesGaugeQuery"),
    metricTimeSeriesHistogramQuery: unexpected("metricTimeSeriesHistogramQuery"),
    metricTimeSeriesExpHistogramQuery: unexpected("metricTimeSeriesExpHistogramQuery"),
    customTracesBreakdownQuery: unexpected("customTracesBreakdownQuery"),
    customLogsBreakdownQuery: unexpected("customLogsBreakdownQuery"),
    customMetricsBreakdownQuery: unexpected("customMetricsBreakdownQuery"),
    alertTracesAggregateQuery: unexpected("alertTracesAggregateQuery"),
    alertMetricsAggregateQuery: unexpected("alertMetricsAggregateQuery"),
    alertLogsAggregateQuery: unexpected("alertLogsAggregateQuery"),
    alertTracesAggregateByServiceQuery: unexpected("alertTracesAggregateByServiceQuery"),
    alertMetricsAggregateByServiceQuery: unexpected("alertMetricsAggregateByServiceQuery"),
    alertLogsAggregateByServiceQuery: unexpected("alertLogsAggregateByServiceQuery"),
    ...overrides,
  } satisfies Parameters<typeof makeQueryEngineExecute>[0]
}

describe("makeQueryEngineExecute", () => {
  const getFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
    Option.getOrUndefined(Exit.findErrorOption(exit))

  it("fills missing buckets while preserving existing traces values", async () => {
    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        customTracesTimeseriesQuery: () =>
          Effect.succeed([
            makeTraceTimeseriesRow({ count: 2 }),
            makeTraceTimeseriesRow({
              bucket: "2026-01-01 00:10:00",
              count: 5,
            }),
          ]),
      }),
    )

    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:15:00",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["service"],
        bucketSeconds: 300,
      },
    }

    const response = await Effect.runPromise(execute(tenant, request))

    expect(response.result.kind).toBe("timeseries")
    expect(response.result.source).toBe("traces")
    expect(response.result.data).toHaveLength(4)
    expect(response.result.data[0]).toEqual({
      bucket: "2026-01-01T00:00:00.000Z",
      series: { checkout: 2 },
    })
    expect(response.result.data[1]).toEqual({
      bucket: "2026-01-01T00:05:00.000Z",
      series: {},
    })
    expect(response.result.data[2]).toEqual({
      bucket: "2026-01-01T00:10:00.000Z",
      series: { checkout: 5 },
    })
    expect(response.result.data[3]).toEqual({
      bucket: "2026-01-01T00:15:00.000Z",
      series: {},
    })
  })

  it("preserves traces series when Tinybird buckets are datetime strings", async () => {
    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        customTracesTimeseriesQuery: () =>
          Effect.succeed([
            makeTraceTimeseriesRow({ count: 2 }),
            makeTraceTimeseriesRow({
              bucket: "2026-01-01 00:10:00",
              count: 5,
            }),
          ]),
      }),
    )

    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:15:00",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["service"],
        bucketSeconds: 300,
      },
    }

    const response = await Effect.runPromise(execute(tenant, request))

    expect(response.result.kind).toBe("timeseries")
    expect(response.result.source).toBe("traces")
    expect(response.result.data).toHaveLength(4)
    expect(response.result.data[0]).toEqual({
      bucket: "2026-01-01T00:00:00.000Z",
      series: { checkout: 2 },
    })
    expect(response.result.data[1]).toEqual({
      bucket: "2026-01-01T00:05:00.000Z",
      series: {},
    })
    expect(response.result.data[2]).toEqual({
      bucket: "2026-01-01T00:10:00.000Z",
      series: { checkout: 5 },
    })
    expect(response.result.data[3]).toEqual({
      bucket: "2026-01-01T00:15:00.000Z",
      series: {},
    })
  })

  it("rejects timeseries requests that exceed the point budget", async () => {
    const execute = makeQueryEngineExecute(makeTinybirdStub())
    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:33:21",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        bucketSeconds: 1,
      },
    }

    const exit = await Effect.runPromiseExit(execute(tenant, request))
    const failure = getFailure(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toMatchObject({
      _tag: "QueryEngineValidationError",
      message: "Timeseries query too expensive",
    })
  })

  it("rejects invalid traces attribute grouping when attribute key is missing", async () => {
    const execute = makeQueryEngineExecute(makeTinybirdStub())
    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["attribute"],
      },
    }

    const exit = await Effect.runPromiseExit(execute(tenant, request))
    const failure = getFailure(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toMatchObject({
      _tag: "QueryEngineValidationError",
      message: "Invalid traces attribute filters",
    })
  })

  it("forwards http method grouping for traces timeseries", async () => {
    let receivedParams: Record<string, unknown> | undefined

    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        customTracesTimeseriesQuery: (_tenant, params) => {
          receivedParams = params as Record<string, unknown>
          return Effect.succeed([
            makeTraceTimeseriesRow({
              groupName: "GET",
              count: 3,
            }),
          ])
        },
      }),
    )

    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["http_method"],
        bucketSeconds: 300,
      },
    }

    const response = await Effect.runPromise(execute(tenant, request))

    expect(receivedParams).toMatchObject({
      group_by_http_method: "1",
    })
    expect(response.result).toEqual({
      kind: "timeseries",
      source: "traces",
      data: [
        {
          bucket: "2026-01-01T00:00:00.000Z",
          series: { GET: 3 },
        },
        {
          bucket: "2026-01-01T00:05:00.000Z",
          series: {},
        },
      ],
    })
  })

  it("maps apdex traces execution and forwards the apdex threshold", async () => {
    let receivedParams: Record<string, unknown> | undefined

    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        customTracesTimeseriesQuery: (_tenant, params) => {
          receivedParams = params as Record<string, unknown>
          return Effect.succeed([
            makeTraceTimeseriesRow({
              count: 20,
              satisfiedCount: 15,
              toleratingCount: 2,
              apdexScore: 0.8,
            }),
          ])
        },
      }),
    )

    const response = await Effect.runPromise(execute(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "apdex",
        groupBy: ["service"],
        bucketSeconds: 300,
        apdexThresholdMs: 300,
      },
    }))

    expect(receivedParams).toMatchObject({
      apdex_threshold_ms: 300,
    })
    expect(response.result).toEqual({
      kind: "timeseries",
      source: "traces",
      data: [
        {
          bucket: "2026-01-01T00:00:00.000Z",
          series: { checkout: 0.8 },
        },
        {
          bucket: "2026-01-01T00:05:00.000Z",
          series: {},
        },
      ],
    })
  })

  it("aggregates metrics timeseries into an all series when groupBy=none", async () => {
    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        metricTimeSeriesHistogramQuery: () =>
          Effect.succeed([
            {
              bucket: "2026-01-01 00:00:00",
              serviceName: "api",
              avgValue: 10,
              minValue: 5,
              maxValue: 20,
              sumValue: 30,
              dataPointCount: 3,
            },
            {
              bucket: "2026-01-01 00:00:00",
              serviceName: "worker",
              avgValue: 20,
              minValue: 10,
              maxValue: 40,
              sumValue: 40,
              dataPointCount: 2,
            },
          ]),
      }),
    )

    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      query: {
        kind: "timeseries",
        source: "metrics",
        metric: "avg",
        groupBy: ["none"],
        bucketSeconds: 300,
        filters: {
          metricName: "request.duration",
          metricType: "histogram",
        },
      },
    }

    const response = await Effect.runPromise(execute(tenant, request))

    expect(response.result).toEqual({
      kind: "timeseries",
      source: "metrics",
      data: [
        {
          bucket: "2026-01-01T00:00:00.000Z",
          series: { all: 14 },
        },
        {
          bucket: "2026-01-01T00:05:00.000Z",
          series: {},
        },
      ],
    })
  })

  it("preserves per-service metrics timeseries when groupBy=service", async () => {
    const execute = makeQueryEngineExecute(
      makeTinybirdStub({
        metricTimeSeriesGaugeQuery: () =>
          Effect.succeed([
            {
              bucket: "2026-01-01 00:00:00",
              serviceName: "api",
              avgValue: 10,
              minValue: 10,
              maxValue: 10,
              sumValue: 10,
              dataPointCount: 1,
            },
            {
              bucket: "2026-01-01 00:00:00",
              serviceName: "worker",
              avgValue: 20,
              minValue: 20,
              maxValue: 20,
              sumValue: 20,
              dataPointCount: 1,
            },
          ]),
      }),
    )

    const request: QueryEngineExecuteRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      query: {
        kind: "timeseries",
        source: "metrics",
        metric: "avg",
        groupBy: ["service"],
        bucketSeconds: 300,
        filters: {
          metricName: "cpu.usage",
          metricType: "gauge",
        },
      },
    }

    const response = await Effect.runPromise(execute(tenant, request))

    expect(response.result).toEqual({
      kind: "timeseries",
      source: "metrics",
      data: [
        {
          bucket: "2026-01-01T00:00:00.000Z",
          series: { api: 10, worker: 20 },
        },
        {
          bucket: "2026-01-01T00:05:00.000Z",
          series: {},
        },
      ],
    })
  })
})

describe("makeQueryEngineEvaluate", () => {
  it("evaluates traces error rate alerts from the aggregate path", async () => {
    const evaluate = makeQueryEngineEvaluate(
      makeTinybirdStub({
        alertTracesAggregateQuery: () =>
          Effect.succeed([
            {
              count: 200,
              avgDuration: 12,
              p50Duration: 10,
              p95Duration: 120,
              p99Duration: 240,
              errorRate: 7.5,
              satisfiedCount: 180,
              toleratingCount: 10,
              apdexScore: 0.925,
            },
          ]),
      }),
    )

    const request: QueryEngineEvaluateRequest = {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "trace_count",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "error_rate",
        groupBy: ["none"],
      },
    }

    const response = await Effect.runPromise(evaluate(tenant, request))

    expect(response).toMatchObject({
      value: 7.5,
      sampleCount: 200,
      hasData: true,
      reducer: "identity",
    })
  })

  it("evaluates traces apdex alerts and forwards the apdex threshold", async () => {
    let receivedParams: Record<string, unknown> | undefined

    const evaluate = makeQueryEngineEvaluate(
      makeTinybirdStub({
        alertTracesAggregateQuery: (_tenant, params) => {
          receivedParams = params as Record<string, unknown>
          return Effect.succeed([
            {
              count: 40,
              avgDuration: 0,
              p50Duration: 0,
              p95Duration: 0,
              p99Duration: 0,
              errorRate: 0,
              satisfiedCount: 30,
              toleratingCount: 6,
              apdexScore: 0.825,
            },
          ])
        },
      }),
    )

    const response = await Effect.runPromise(evaluate(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "trace_count",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "apdex",
        groupBy: ["none"],
        apdexThresholdMs: 350,
      },
    }))

    expect(receivedParams).toMatchObject({
      apdex_threshold_ms: 350,
    })
    expect(response.value).toBe(0.825)
    expect(response.sampleCount).toBe(40)
  })

  it("evaluates metrics alerts with metric data point sample counts", async () => {
    const evaluate = makeQueryEngineEvaluate(
      makeTinybirdStub({
        alertMetricsAggregateQuery: () =>
          Effect.succeed([
            {
              avgValue: 18,
              minValue: 5,
              maxValue: 40,
              sumValue: 90,
              dataPointCount: 5,
            },
          ]),
      }),
    )

    const response = await Effect.runPromise(evaluate(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "metric_data_points",
      query: {
        kind: "timeseries",
        source: "metrics",
        metric: "avg",
        groupBy: ["none"],
        filters: {
          metricName: "cpu.usage",
          metricType: "gauge",
        },
      },
    }))

    expect(response).toMatchObject({
      value: 18,
      sampleCount: 5,
      hasData: true,
    })
  })

  it("returns hasData=false when the aggregate response has zero samples", async () => {
    const evaluate = makeQueryEngineEvaluate(
      makeTinybirdStub({
        alertMetricsAggregateQuery: () =>
          Effect.succeed([
            {
              avgValue: 0,
              minValue: 0,
              maxValue: 0,
              sumValue: 0,
              dataPointCount: 0,
            },
          ]),
      }),
    )

    const response = await Effect.runPromise(evaluate(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "metric_data_points",
      query: {
        kind: "timeseries",
        source: "metrics",
        metric: "sum",
        groupBy: ["none"],
        filters: {
          metricName: "requests",
          metricType: "sum",
        },
      },
    }))

    expect(response).toMatchObject({
      value: null,
      sampleCount: 0,
      hasData: false,
    })
  })

  it("evaluates logs alerts with log-count sample counts", async () => {
    const evaluate = makeQueryEngineEvaluate(
      makeTinybirdStub({
        alertLogsAggregateQuery: () =>
          Effect.succeed([
            {
              count: 42,
            },
          ]),
      }),
    )

    const response = await Effect.runPromise(evaluate(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "log_count",
      query: {
        kind: "timeseries",
        source: "logs",
        metric: "count",
        groupBy: ["none"],
        filters: {
          serviceName: "checkout",
          severity: "error",
        },
      },
    }))

    expect(response).toMatchObject({
      value: 42,
      sampleCount: 42,
      hasData: true,
      reducer: "identity",
    })
  })

  it("rejects grouped queries for alert evaluation", async () => {
    const evaluate = makeQueryEngineEvaluate(makeTinybirdStub())

    const exit = await Effect.runPromiseExit(evaluate(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "trace_count",
      query: {
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["service"],
      },
    }))

    const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toMatchObject({
      _tag: "QueryEngineValidationError",
      message: "Unsupported alert evaluation query",
    })
  })
})

describe("makeQueryEngineEvaluateGrouped", () => {
  it("evaluates grouped logs alerts by service", async () => {
    const evaluateGrouped = makeQueryEngineEvaluateGrouped(
      makeTinybirdStub({
        alertLogsAggregateByServiceQuery: () =>
          Effect.succeed([
            {
              serviceName: "checkout",
              count: 11,
            },
            {
              serviceName: "billing",
              count: 3,
            },
          ]),
      }),
    )

    const response = await Effect.runPromise(evaluateGrouped(tenant, {
      startTime: "2026-01-01 00:00:00",
      endTime: "2026-01-01 00:05:00",
      reducer: "identity",
      sampleCountStrategy: "log_count",
      query: {
        kind: "timeseries",
        source: "logs",
        metric: "count",
        groupBy: ["none"],
        filters: {
          severity: "error",
        },
      },
    }, "service"))

    expect(response).toEqual([
      {
        groupKey: "checkout",
        value: 11,
        sampleCount: 11,
        hasData: true,
      },
      {
        groupKey: "billing",
        value: 3,
        sampleCount: 3,
        hasData: true,
      },
    ])
  })
})
