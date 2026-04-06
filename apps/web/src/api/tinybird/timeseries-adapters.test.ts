import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

const executeQueryEngineMock = vi.fn()
const runTinybirdQueryMock = vi.fn()

vi.mock("@/api/tinybird/effect-utils", () => ({
  TinybirdDateTimeString: {},
  TinybirdQueryError: class extends Error { _tag = "TinybirdQueryError" },
  decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
  invalidTinybirdInput: () => Effect.fail(new Error("invalid")),
  executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
  runTinybirdQuery: (...args: unknown[]) => runTinybirdQueryMock(...args),
}))

import {
  getCustomChartServiceDetail,
  getCustomChartServiceSparklines,
  getOverviewTimeSeries,
} from "@/api/tinybird/custom-charts";
import { getServiceApdexTimeSeries } from "@/api/tinybird/services";

function tsResponse(data: Array<{ bucket: string; series: Record<string, number> }>) {
  return Effect.succeed({ result: { kind: "timeseries", source: "traces", data } })
}

const emptyTs = () => tsResponse([])

describe("timeseries adapters", () => {
  beforeEach(() => {
    executeQueryEngineMock.mockReset()
    runTinybirdQueryMock.mockReset()
  })

  it("fills overview/detail buckets without flattening existing points", async () => {
    const bucket = "2026-01-01T00:00:00.000Z"

    executeQueryEngineMock.mockImplementation((operation: string) => {
      if (operation.includes("spanMetricsCalls")) return emptyTs()
      if (operation.includes("allMetrics")) {
        return tsResponse([{
          bucket,
          series: {
            count: 10,
            error_rate: 2,
            p50_duration: 11,
            p95_duration: 20,
            p99_duration: 30,
          },
        }])
      }
      return emptyTs()
    })

    const overview = await Effect.runPromise(
      getOverviewTimeSeries({
        data: {
          startTime: "2026-01-01 00:00:00",
          endTime: "2026-01-01 00:25:00",
        },
      }),
    );
    const detail = await Effect.runPromise(
      getCustomChartServiceDetail({
        data: {
          serviceName: "checkout",
          startTime: "2026-01-01 00:00:00",
          endTime: "2026-01-01 00:25:00",
        },
      }),
    );

    expect(overview.data).toHaveLength(6);
    expect(detail.data).toHaveLength(6);
    expect(overview.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 10,
      errorRate: 2,
    });
    expect(overview.data[1]).toMatchObject({
      bucket: "2026-01-01T00:05:00.000Z",
      throughput: 0,
      errorRate: 0,
    });
    expect(detail.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 10,
      p95LatencyMs: 20,
    });
  });

  it("fills service sparklines per service across the selected timeline", async () => {
    executeQueryEngineMock.mockImplementation((operation: string) => {
      if (operation.includes("spanMetricsCalls")) return emptyTs()
      if (operation.includes("count")) {
        return tsResponse([
          { bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 3 } },
          { bucket: "2026-01-01T00:10:00.000Z", series: { checkout: 5 } },
        ])
      }
      if (operation.includes("error")) {
        return tsResponse([
          { bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 1 } },
          { bucket: "2026-01-01T00:10:00.000Z", series: { checkout: 0 } },
        ])
      }
      return emptyTs()
    })

    const response = await Effect.runPromise(
      getCustomChartServiceSparklines({
        data: {
          startTime: "2026-01-01 00:00:00",
          endTime: "2026-01-01 00:10:00",
        },
      }),
    );

    expect(response.data.checkout).toHaveLength(3);
    expect(response.data.checkout[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      throughput: 3,
      errorRate: 1,
    });
    expect(response.data.checkout[1]).toMatchObject({
      bucket: "2026-01-01T00:05:00.000Z",
      throughput: 0,
      errorRate: 0,
    });
    expect(response.data.checkout[2]).toMatchObject({
      bucket: "2026-01-01T00:10:00.000Z",
      throughput: 5,
      errorRate: 0,
    });
  });

  it("fills service apdex buckets while preserving real values", async () => {
    runTinybirdQueryMock.mockReturnValue(
      Effect.succeed({
        data: [
          {
            bucket: "2026-01-01 00:00:00",
            apdexScore: 0.91,
            totalCount: 100,
          },
        ],
      }),
    );

    const response = await Effect.runPromise(
      getServiceApdexTimeSeries({
        data: {
          serviceName: "checkout",
          startTime: "2026-01-01 00:00:00",
          endTime: "2026-01-01 00:25:00",
        },
      }),
    );

    expect(response.data).toHaveLength(6);
    expect(response.data[0]).toMatchObject({
      bucket: "2026-01-01T00:00:00.000Z",
      apdexScore: 0.91,
      totalCount: 100,
    });
    expect(response.data[5]).toMatchObject({
      bucket: "2026-01-01T00:25:00.000Z",
      apdexScore: 0,
      totalCount: 0,
    });
  });
});
